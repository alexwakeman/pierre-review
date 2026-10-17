import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  SEQUENCE_DIAGRAM_STORY_MAX_PRS,
  parseTicketIdent,
  type PrSequenceDiagramsResponse,
  type RedrawSequenceDiagramResponse,
  type RedrawStoryDiagramBody,
  type SequenceDiagramKind,
  type SequenceDiagramSlot,
  type StorySequenceDiagramSlot,
  type TicketSequenceDiagramResponse,
} from '@pierre-review/shared';
import { getTicketSource } from '../../tracker/ticket-source.js';
import type { AgentContext } from '../agent-context.js';
import { AGENTIC_AI_ENABLED } from '../claude-review/manager.js';
import { prDiagramFingerprint, storedCodeAnswer, storyDiagramFingerprint } from './fingerprint.js';
import { liveStoryMembers, startDiagram } from './manager.js';
import {
  getDiagramPrContext,
  latestDiagram,
  latestSucceededDiagram,
  toDiagramView,
} from './persist.js';
import { MAX_TICKETS, toDiagramMembers } from './trigger.js';

// THE DESIGN-DIAGRAM API (CORE, free, LOCAL ONLY; paths keep "sequence-diagrams") — docs/API.md § Design diagrams. Registered by
// `registerAgenticRoutes` (review/agentic.ts), so absent in cloud and under LIMN_AI_DISABLED; the
// AGENTIC_AI_ENABLED checks are the second guard. Every read is the STORED rows (no model, no GitHub,
// no tracker call); the two Redraw POSTs queue ONE Sonnet 5 run each.
//
//   GET  /api/prs/:id/sequence-diagrams            the PR's diagram + its tickets' story diagrams → read
//   POST /api/prs/:id/sequence-diagrams/redraw     queue the PR's diagram                       → ai + ai_hourly
//   GET  /api/sequence-diagrams/story?ident=       one ticket's story diagram                   → read
//   POST /api/sequence-diagrams/story/redraw       queue one ticket's story diagram             → ai + ai_hourly
//
// Tenancy: a PR id is resolved within the account (404 otherwise); a ticket ident has no row to own,
// so its members are read within the account — another account's ident simply has no members here.

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};
const storyQuery = {
  querystring: {
    type: 'object',
    required: ['ident'],
    properties: { ident: { type: 'string', minLength: 1, maxLength: 512 } },
  },
};
const storyBody = {
  body: {
    type: 'object',
    required: ['ident'],
    additionalProperties: false,
    properties: { ident: { type: 'string', minLength: 1, maxLength: 512 } },
  },
};

function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: 'Design diagrams are off here. They run on your machine: npx limn-review' };
}

/** What to draw and, beside it, the newest run when that is another one. `liveFp` null ⇒ not current. */
export async function slotFor(
  ctx: AgentContext,
  accountId: number,
  kind: SequenceDiagramKind,
  subject: string,
  liveFp: string | null,
): Promise<SequenceDiagramSlot> {
  const latest = await latestDiagram(ctx, accountId, kind, subject);
  if (latest == null) return { diagram: null, latest: null };
  const good = latest.status === 'succeeded' ? latest : await latestSucceededDiagram(ctx, accountId, kind, subject);
  const view = (r: typeof latest) => toDiagramView(r, liveFp != null && r.fingerprint === liveFp);
  return {
    diagram: good != null ? view(good) : null,
    latest: good != null && good.id === latest.id ? null : view(latest),
  };
}

async function storySlot(
  ctx: AgentContext,
  accountId: number,
  ident: string,
  ticketKey: string | null,
): Promise<StorySequenceDiagramSlot> {
  const members = await liveStoryMembers(ctx, accountId, ident);
  const liveFp = members.length >= 2 ? storyDiagramFingerprint(ident, members) : null;
  const slot = await slotFor(ctx, accountId, 'story', ident, liveFp);
  return {
    ident,
    ticketKey: ticketKey ?? slot.diagram?.ticketKey ?? slot.latest?.ticketKey ?? null,
    memberCount: members.length,
    ...slot,
  };
}

async function preflight(
  ctx: AgentContext,
  accountId: number,
  reply: FastifyReply,
): Promise<{ error: string; message: string } | null> {
  const auth = ctx.llm.detectAuth();
  if (auth.status === 'none') {
    reply.status(400);
    return { error: 'NoClaudeAuth', message: auth.message ?? 'No Claude credential found.' };
  }
  if ((await ctx.aiCredits.check(accountId)).agentBlocked) {
    reply.status(402);
    return { error: 'CreditsExhausted', message: 'Out of monthly agentic AI credits — resets on the 1st.' };
  }
  return null;
}

export function registerSequenceDiagramRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // ---- the PR pane ----
  app.get(
    '/api/prs/:id/sequence-diagrams',
    { schema: idParam },
    async (req, reply): Promise<PrSequenceDiagramsResponse | { error: string; message: string }> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { id } = req.params as { id: number };
      const accountId = ctx.accountIdOf(req);
      const pr = await getDiagramPrContext(ctx, accountId, id);
      if (!pr) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      const prSlot = await slotFor(ctx, accountId, 'pr', String(id), pr.headSha ? prDiagramFingerprint(id, pr.headSha) : null);
      const tickets = (await getTicketSource().ticketsForPr(accountId, id).catch(() => []))
        .filter((t) => {
          const p = parseTicketIdent(t.ident);
          return p != null && p.kind !== 'manual';
        })
        .slice(0, MAX_TICKETS);
      const stories: StorySequenceDiagramSlot[] = [];
      for (const t of tickets) {
        const slot = await storySlot(ctx, accountId, t.ident, t.ticket.key ?? null);
        if (slot.memberCount >= 2 || slot.diagram != null || slot.latest != null) stories.push(slot);
      }
      return { prId: id, pr: prSlot, stories };
    },
  );

  app.post(
    '/api/prs/:id/sequence-diagrams/redraw',
    { schema: idParam },
    async (req, reply): Promise<RedrawSequenceDiagramResponse | { error: string; message: string }> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { id } = req.params as { id: number };
      const accountId = ctx.accountIdOf(req);
      const pr = await getDiagramPrContext(ctx, accountId, id);
      if (!pr) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      if (!pr.headSha) {
        reply.status(409);
        return { error: 'NoHead', message: 'This PR has not been synced yet.' };
      }
      const pre = await preflight(ctx, accountId, reply);
      if (pre) return pre;
      if (storedCodeAnswer(pr) === 'no') return { outcome: 'refused', diagramId: null, refusal: 'no_code' };
      const r = await startDiagram(ctx, {
        accountId,
        kind: 'pr',
        subject: String(id),
        prId: id,
        ticketKey: null,
        fingerprint: prDiagramFingerprint(id, pr.headSha),
        headSha: pr.headSha,
        members: null,
        trigger: 'manual',
      });
      if (r.outcome === 'disabled') return featureOff(reply);
      if (r.outcome === 'busy') {
        reply.status(409);
        return { error: 'Busy', message: 'Too many diagrams are waiting. Try again once some finish.' };
      }
      reply.status(202);
      return { outcome: r.outcome, diagramId: r.diagramId };
    },
  );

  // ---- a ticket (Activity → This Sprint's ticket drawer) ----
  app.get(
    '/api/sequence-diagrams/story',
    { schema: storyQuery },
    async (req, reply): Promise<TicketSequenceDiagramResponse | { error: string; message: string }> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { ident } = req.query as { ident: string };
      const parsed = parseTicketIdent(ident);
      if (parsed == null || parsed.kind === 'manual') {
        reply.status(400);
        return { error: 'BadIdent', message: 'Not a tracker ticket.' };
      }
      return storySlot(ctx, ctx.accountIdOf(req), ident, null);
    },
  );

  app.post(
    '/api/sequence-diagrams/story/redraw',
    { schema: storyBody },
    async (req, reply): Promise<RedrawSequenceDiagramResponse | { error: string; message: string }> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { ident } = req.body as RedrawStoryDiagramBody;
      const parsed = parseTicketIdent(ident);
      if (parsed == null || parsed.kind === 'manual') {
        reply.status(400);
        return { error: 'BadIdent', message: 'Not a tracker ticket.' };
      }
      const accountId = ctx.accountIdOf(req);
      const members = await liveStoryMembers(ctx, accountId, ident);
      if (members.length < 2) return { outcome: 'refused', diagramId: null, refusal: 'too_few_prs' };
      if (members.length > SEQUENCE_DIAGRAM_STORY_MAX_PRS) {
        return { outcome: 'refused', diagramId: null, refusal: 'too_many_prs' };
      }
      const pre = await preflight(ctx, accountId, reply);
      if (pre) return pre;
      const existing = await latestDiagram(ctx, accountId, 'story', ident);
      const r = await startDiagram(ctx, {
        accountId,
        kind: 'story',
        subject: ident,
        prId: null,
        ticketKey: existing?.ticketKey ?? parsed.key,
        fingerprint: storyDiagramFingerprint(ident, members),
        headSha: null,
        members: toDiagramMembers(members),
        trigger: 'manual',
      });
      if (r.outcome === 'disabled') return featureOff(reply);
      if (r.outcome === 'busy') {
        reply.status(409);
        return { error: 'Busy', message: 'Too many diagrams are waiting. Try again once some finish.' };
      }
      reply.status(202);
      return { outcome: r.outcome, diagramId: r.diagramId };
    },
  );
}
