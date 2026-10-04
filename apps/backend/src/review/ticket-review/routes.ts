import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  CLAUDE_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_PRS,
  TICKET_REVIEW_STATES_MAX,
  checkClaudeReviewTickets,
  parseTicketIdent,
  storyOneLine,
  type ClaudeReviewTicket,
  type PostTicketItemBody,
  type PostTicketItemResponse,
  type PrTicketReviewsResponse,
  type StartTicketReviewResponse,
  type TicketReviewState,
  type TicketReviewStatesBody,
  type TicketReviewStatesResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { AGENTIC_AI_ENABLED } from '../claude-review/manager.js';
import { getReviewPrContext } from '../claude-review/persist.js';
import { buildAnchorIndex, fetchPrDiff, isFindingAnchored, stripNoiseFromDiff } from '../post-review.js';
import { isNoiseFile } from '../prepare.js';
import { getAgenticProviders } from '../plugin-providers.js';
import { settlePrAfterWrite } from '../../sync/resync-after-write.js';
import { deriveTicketReviewState, manualTicketIdent, readLiveMembers, ticketHash } from './fingerprint.js';
import {
  getLatestTicketReview,
  getTicketIdentsForPr,
  getTicketItemPostContext,
  getTicketReviewById,
  getTicketReviewRow,
  getTicketStateInputs,
  markTicketItemPosted,
} from './persist.js';
import { jiraMemberIds, jiraStoryFor, workspaceOfPr } from './prepare.js';
import { statusWords } from './prompts.js';
import { getTicketRunStatus, startTicketReview, subscribeTicketReviewStream } from './manager.js';

// THE TICKET REVIEW API (CORE, free, LOCAL ONLY) — docs/API.md § Ticket review. Registered by
// `registerAgenticRoutes` (review/agentic.ts), so absent in cloud and under LIMN_AI_DISABLED; the
// AGENTIC_AI_ENABLED checks are the second guard. Every id-addressed route answers 404 for another
// account's id. Rate-limit tiers: the start route is `ai` + `ai_hourly`, the post route
// `github_write`, everything else `read` (api/plugins/rate-limit.ts) — which holds because no
// route here reads Jira: the plugin's seam answers from its STORED rows only (Jira is read when a
// PR is received, never when it is viewed).

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const TICKET_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    acceptanceCriteria: { type: 'string' },
    source: { type: 'string', enum: ['jira', 'manual'] },
    key: { type: 'string' },
    url: { type: 'string' },
    fetchedAt: { type: 'string' },
  },
} as const;
const startSchema = {
  body: {
    type: 'object',
    required: ['prId'],
    additionalProperties: false,
    properties: {
      prId: { type: 'integer' },
      ident: { type: 'string' },
      // No maxItems: the count answers with our own message (checkClaudeReviewTickets).
      tickets: { type: 'array', items: TICKET_INPUT_SCHEMA },
    },
  },
};
const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};
const statesSchema = {
  body: {
    type: 'object',
    required: ['idents'],
    additionalProperties: false,
    properties: { idents: { type: 'array', items: { type: 'string' } } },
  },
};
const postSchema = {
  params: {
    type: 'object',
    required: ['id', 'itemId'],
    properties: { id: { type: 'integer' }, itemId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    required: ['viewedPrId'],
    additionalProperties: false,
    properties: { viewedPrId: { type: 'integer' } },
  },
};

function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: 'Ticket review is off here. It runs on your machine: npx limn-review' };
}

async function defaultWorkspaceId(ctx: AgentContext, accountId: number): Promise<number | null> {
  const w = s(ctx).workspaces;
  const rows = (await ctx.db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.accountId, accountId), eq(w.isDefault, true)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

/** The plugin's detected tickets of one PR, from its stored rows ([] with no plugin). Never throws. */
async function detectedTickets(
  accountId: number,
  prId: number,
): Promise<Array<{ ident: string; ticket: ClaudeReviewTicket }>> {
  const f = getAgenticProviders().ticketsForPr;
  if (!f) return [];
  try {
    return (await f(accountId, prId)).map((t) => ({ ident: t.ident, ticket: t.ticket }));
  } catch {
    return [];
  }
}

/**
 * Server-computed currency per ident (fingerprint.ts `deriveTicketReviewState`). The live story is
 * `jiraStoryFor`'s — the SAME text the run and the sweeper hash, whichever PR is being viewed. With
 * no answer for the live half (no plugin, no stored story) the latest run reads as current —
 * nothing shows it moved.
 */
async function statesFor(
  ctx: AgentContext,
  accountId: number,
  idents: readonly string[],
): Promise<Map<string, TicketReviewState>> {
  const inputs = await getTicketStateInputs(ctx, accountId, idents);
  const out = new Map<string, TicketReviewState>();
  const hasPlugin = getAgenticProviders().ticketMembers != null;
  for (const ident of idents) {
    const inp = inputs.get(ident);
    const parsed = parseTicketIdent(ident);
    let live: { ticketHash: string; members: Awaited<ReturnType<typeof readLiveMembers>> } | null = null;
    if (parsed?.kind === 'manual' && inp?.latest?.ticketHash) {
      live = { ticketHash: inp.latest.ticketHash, members: await readLiveMembers(ctx, accountId, [parsed.prId]) };
    } else if (parsed?.kind === 'jira' && hasPlugin) {
      const memberIds = await jiraMemberIds(accountId, ident);
      const story = await jiraStoryFor(accountId, ident, memberIds);
      if (story) live = { ticketHash: ticketHash(story), members: await readLiveMembers(ctx, accountId, memberIds) };
    }
    out.set(
      ident,
      deriveTicketReviewState({
        ident,
        latest: inp?.latest ?? null,
        runningRunId: inp?.runningRunId ?? null,
        live,
      }),
    );
  }
  return out;
}

// Items being posted right now, by id — the synchronous claim that keeps two clicks from both
// passing the "already posted?" check and posting twice. ⚠ Claimed BEFORE that check, and the item
// is re-read inside the claim: a check made before the claim can be answered by a request that has
// since posted and released it.
const posting = new Set<number>();

/**
 * Has this item, or any earlier item it re-raises (`prior_item_id`, followed back), reached GitHub?
 * A re-raise inherits the posting when its run is saved; this also covers an older item posted
 * AFTER that.
 */
async function postedInChain(ctx: AgentContext, accountId: number, priorItemId: number | null): Promise<boolean> {
  const tri = s(ctx).ticketReviewItems;
  let next = priorItemId;
  for (let hops = 0; next != null && hops < 50; hops += 1) {
    const rows = (await ctx.db
      .select({ priorItemId: tri.priorItemId, postedCommentId: tri.postedCommentId })
      .from(tri)
      .where(and(eq(tri.id, next), eq(tri.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ priorItemId: number | null; postedCommentId: string | null }>;
    const row = rows[0];
    if (!row) return false;
    if (row.postedCommentId != null) return true;
    next = row.priorItemId;
  }
  return false;
}

export function registerTicketReviewRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // ---- start ----
  app.post('/api/ticket-reviews', { schema: startSchema }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const body = req.body as { prId: number; ident?: string; tickets?: unknown[] };
    const accountId = ctx.accountIdOf(req);

    let pasted: ClaudeReviewTicket[] | null = null;
    if (body.tickets !== undefined) {
      const checked = checkClaudeReviewTickets(body.tickets as Parameters<typeof checkClaudeReviewTickets>[0]);
      if (!checked.ok) {
        reply.status(400);
        return { error: 'TicketInvalid', index: checked.index, field: checked.field, message: checked.message };
      }
      pasted = checked.tickets;
    }
    if (body.ident !== undefined && parseTicketIdent(body.ident) == null) {
      reply.status(400);
      return { error: 'InvalidIdent', message: 'That ticket name is not valid.' };
    }
    const pr = await getReviewPrContext(ctx, body.prId, accountId);
    if (!pr) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${body.prId} not found` };
    }
    const auth = ctx.llm.detectAuth();
    if (auth.status === 'none') {
      reply.status(400);
      return { error: 'NoClaudeAuth', message: auth.message };
    }
    if ((await ctx.aiCredits.check(accountId)).agentBlocked) {
      reply.status(402);
      return { error: 'CreditsExhausted', message: 'Out of monthly agentic AI credits — resets on the 1st.' };
    }
    const workspaceId =
      (await workspaceOfPr(ctx, accountId, body.prId)) ?? (await defaultWorkspaceId(ctx, accountId)) ?? 0;

    // ---- which tickets ----
    const targets: Array<{ ident: string; ticket: ClaudeReviewTicket | null; manual: boolean }> = [];
    if (pasted) {
      for (const t of pasted) targets.push({ ident: manualTicketIdent(body.prId, t), ticket: t, manual: true });
    } else if (body.ident !== undefined) {
      const ident = body.ident;
      const parsed = parseTicketIdent(ident)!;
      if (parsed.kind === 'manual') {
        // Re-checking a pasted story: its text is the latest run's snapshot, and only its own PR.
        const latest = parsed.prId === body.prId ? await getLatestTicketReview(ctx, accountId, ident) : null;
        if (!latest?.ticket) {
          reply.status(404);
          return { error: 'NotFound', message: 'This PR is not on that ticket.' };
        }
        targets.push({ ident, ticket: latest.ticket, manual: true });
      } else {
        const detected = await detectedTickets(accountId, body.prId);
        const known = detected.some((d) => d.ident === ident) || (await getTicketIdentsForPr(ctx, accountId, body.prId)).includes(ident);
        if (!known) {
          reply.status(404);
          return { error: 'NotFound', message: 'This PR is not on that ticket.' };
        }
        targets.push({ ident, ticket: detected.find((d) => d.ident === ident)?.ticket ?? null, manual: false });
      }
    } else {
      for (const d of (await detectedTickets(accountId, body.prId)).slice(0, CLAUDE_REVIEW_MAX_TICKETS)) {
        targets.push({ ident: d.ident, ticket: d.ticket, manual: false });
      }
    }

    const out: StartTicketReviewResponse = { runs: [] };
    for (const t of targets) {
      // Over the member cap a run would only refuse: answer now, with the count, and write nothing.
      if (!t.manual) {
        const members = await readLiveMembers(ctx, accountId, await jiraMemberIds(accountId, t.ident));
        if (members.length > TICKET_REVIEW_MAX_PRS) {
          out.runs.push({
            ident: t.ident,
            ticketReviewId: null,
            outcome: 'refused',
            refused: { reason: 'too_many_prs', prCount: members.length },
          });
          continue;
        }
      }
      const r = await startTicketReview(ctx, {
        accountId,
        workspaceId,
        ident: t.ident,
        ticketKey: t.ticket?.key ?? null,
        ticketTitle: t.ticket?.title ?? null,
        manualTicket: t.manual ? t.ticket : null,
        originPrId: body.prId,
        trigger: 'manual',
      });
      if (r.outcome === 'disabled') return featureOff(reply);
      if (r.outcome === 'busy') {
        if (out.runs.length > 0) break;
        reply.status(409);
        return { error: 'Busy', message: 'Too many story checks are waiting. Try again once some finish.' };
      }
      out.runs.push({ ident: t.ident, ticketReviewId: r.runId, outcome: r.outcome, refused: null });
    }
    reply.status(202);
    return out;
  });

  // ---- the PR pane: every ticket the PR is on, with its latest run and currency ----
  app.get('/api/prs/:id/ticket-reviews', { schema: idParam }, async (req, reply): Promise<PrTicketReviewsResponse | { error: string; message: string }> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    if (!(await getReviewPrContext(ctx, id, accountId))) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    const detected = await detectedTickets(accountId, id);
    const idents = [...new Set([...detected.map((d) => d.ident), ...(await getTicketIdentsForPr(ctx, accountId, id))])];
    const stories = new Map(detected.map((d) => [d.ident, d.ticket]));
    const states = await statesFor(ctx, accountId, idents);
    const tickets: PrTicketReviewsResponse['tickets'] = [];
    for (const ident of idents) {
      const review = await getLatestTicketReview(ctx, accountId, ident);
      const story = stories.get(ident);
      const parsed = parseTicketIdent(ident);
      tickets.push({
        ident,
        ticketKey: story?.key ?? review?.ticketKey ?? (parsed?.kind === 'jira' ? parsed.key : null),
        ticketTitle: story?.title ?? review?.ticketTitle ?? null,
        review,
        state: states.get(ident)!,
      });
    }
    return { prId: id, tickets };
  });

  // ---- one run ----
  app.get('/api/ticket-reviews/:id', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const run = await getTicketReviewById(ctx, ctx.accountIdOf(req), id);
    if (!run) {
      reply.status(404);
      return { error: 'NotFound', message: `Ticket review ${id} not found` };
    }
    return run;
  });

  // ---- live progress (SSE, a GET: `req.raw.on('close')` is the right signal here) ----
  app.get('/api/ticket-reviews/:id/stream', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    // OWNERSHIP BEFORE hijack: the subscription keys on the run id alone.
    if (!AGENTIC_AI_ENABLED || !(await getTicketReviewRow(ctx, accountId, id))) {
      return reply.code(404).send({ error: 'NotFound', message: `Ticket review ${id} not found` });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: unknown): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!raw.writableEnded) raw.end();
    };
    // Subscribe BEFORE the snapshot so a terminal `done` during setup is not missed.
    unsubscribe = subscribeTicketReviewStream(id, (e) => {
      send(e);
      if (e.type === 'done') cleanup();
    });
    req.raw.on('close', cleanup);
    const snap = await getTicketRunStatus(ctx, accountId, id);
    const status = snap?.status ?? 'failed';
    send({ type: 'snapshot', status, ticketReviewId: id, progress: snap?.progress ?? null });
    if (status !== 'running' && status !== 'queued') {
      const run = await getTicketReviewById(ctx, accountId, id).catch(() => null);
      send({
        type: 'done',
        status,
        ticketReviewId: id,
        memberPrIds: [...new Set([...(run?.members.map((m) => m.prId) ?? []), ...(run?.originPrId != null ? [run.originPrId] : [])])],
      });
      cleanup();
    }
  });

  // ---- batched currency for Open PRs' ticket stacks ----
  app.post('/api/ticket-reviews/states', { schema: statesSchema }, async (req, reply): Promise<TicketReviewStatesResponse | { error: string; message: string }> => {
    const { idents } = req.body as TicketReviewStatesBody;
    const unique = [...new Set(idents)];
    if (unique.length > TICKET_REVIEW_STATES_MAX) {
      reply.status(400);
      return { error: 'TooManyIdents', message: `At most ${TICKET_REVIEW_STATES_MAX} tickets per request; got ${unique.length}.` };
    }
    if (unique.some((i) => parseTicketIdent(i) == null)) {
      reply.status(400);
      return { error: 'InvalidIdent', message: 'A ticket name is not valid.' };
    }
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const states = await statesFor(ctx, ctx.accountIdOf(req), unique);
    return { states: idents.map((i) => states.get(i)!) };
  });

  // ---- post one item to GitHub ----
  app.post('/api/ticket-reviews/:id/items/:itemId/post', { schema: postSchema }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id, itemId } = req.params as { id: number; itemId: number };
    const { viewedPrId } = req.body as PostTicketItemBody;
    const accountId = ctx.accountIdOf(req);
    // Ownership first (an id is only claimed for its own account), then the claim, synchronously.
    if (!(await getTicketItemPostContext(ctx, accountId, id, itemId))) {
      reply.status(404);
      return { error: 'NotFound', message: 'Item not found' };
    }
    if (posting.has(itemId)) {
      reply.status(409);
      return { error: 'AlreadyPosted', message: 'Already being posted.' };
    }
    posting.add(itemId);
    try {
      return await postItem(ctx, reply, accountId, id, itemId, viewedPrId);
    } finally {
      posting.delete(itemId);
    }
  });
}

/** The post route's body, run inside the item's claim. */
async function postItem(
  ctx: AgentContext,
  reply: FastifyReply,
  accountId: number,
  id: number,
  itemId: number,
  viewedPrId: number,
): Promise<unknown> {
  // Re-read INSIDE the claim: this is the read the "already posted?" check trusts.
  const pctx = await getTicketItemPostContext(ctx, accountId, id, itemId);
  if (!pctx) {
    reply.status(404);
    return { error: 'NotFound', message: 'Item not found' };
  }
  const { run, item } = pctx;
  // Only the ticket's LATEST check speaks for it: posting an older run's item could repeat what
  // the newer run's copy already posted.
  const latest = (await getTicketStateInputs(ctx, accountId, [run.ident])).get(run.ident)?.latest;
  if (run.status !== 'succeeded' || latest?.id !== run.id) {
    reply.status(409);
    return { error: 'Superseded', message: 'A newer story check replaced this one.' };
  }
  if (item.posted != null || (await postedInChain(ctx, accountId, item.priorItemId))) {
    reply.status(409);
    return { error: 'AlreadyPosted', message: 'Already posted to GitHub.' };
  }
  const targetPrId = item.ownerPrId ?? viewedPrId;
  const member = run.members.find((m) => m.prId === targetPrId);
  if (!member) {
    reply.status(400);
    return { error: 'NotAMember', message: 'That PR is not on this ticket.' };
  }
  const pr = await getReviewPrContext(ctx, targetPrId, accountId);
  if (!pr) {
    reply.status(404);
    return { error: 'NotFound', message: `PR ${targetPrId} not found` };
  }
  const name = run.ticketKey ?? 'Story';
  const lead = `${name} · ${item.ref} (${statusWords(item.status)}): ${storyOneLine(item.title)}`;
  const path = item.ownerPrId === targetPrId && item.path ? item.path : '';
  const line = path ? item.line : null;
  let anchored = false;
  let fileInDiff = false;
  if (path) {
    try {
      const { diff } = stripNoiseFromDiff(await fetchPrDiff(pr.owner, pr.name, pr.number), isNoiseFile);
      const index = buildAnchorIndex(diff);
      fileInDiff = index.has(path);
      anchored = line != null && isFindingAnchored(index, path, line, 'RIGHT');
    } catch {
      /* postFinding re-reads the diff itself when not anchored */
    }
  }
  let outcome;
  try {
    outcome = await ctx.review.postFinding({
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      // The head this run judged: a PR pushed since gets 409, so a stale verdict is never posted.
      reviewHeadSha: member.headSha,
      finding: {
        id: item.id,
        path,
        line,
        side: 'RIGHT',
        anchored,
        fileInDiff,
        body: item.body,
        suggestion: null,
        // Carries the finding marker `<!-- pierre:claude-review-finding v=1 -->`, so
        // `isLimnPostedComment` never lets it trigger an auto PR review.
        storyLead: lead,
      },
    });
  } catch (err) {
    reply.status(502);
    return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.headMoved) {
    reply.status(409);
    return { error: 'HeadMoved', message: 'This PR changed since the story check. Check the story again first.' };
  }
  // GitHub has 201'd: from here the route may not fail.
  await markTicketItemPosted(ctx, accountId, item.id, { prId: targetPrId, commentId: outcome.commentId }).catch(
    () => false,
  );
  let visible = false;
  try {
    visible = (await settlePrAfterWrite({ accountId, prId: targetPrId, log: ctx.log })).visible;
  } catch {
    visible = false;
  }
  const fresh = await getTicketItemPostContext(ctx, accountId, id, itemId).catch(() => null);
  const res: PostTicketItemResponse = {
    item: fresh?.item ?? {
      ...item,
      posted: { prId: targetPrId, commentId: outcome.commentId, postedAt: new Date().toISOString(), carried: false },
    },
    visible,
    commentId: outcome.commentId,
  };
  return res;
}
