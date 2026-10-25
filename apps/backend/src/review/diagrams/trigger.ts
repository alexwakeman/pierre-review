import { parseTicketIdent, type SequenceDiagramKind, type SequenceDiagramMember } from '@pierre-review/shared';
import { config } from '../../config.js';
import { getTicketSource } from '../../tracker/ticket-source.js';
import type { AgentContext } from '../agent-context.js';
import { automaticRunAllowed } from '../budget-gate.js';
import {
  diagramSkipReason,
  prDiagramFingerprint,
  storedCodeAnswer,
  storyDiagramFingerprint,
  type CodeAnswer,
  type DiagramSkip,
} from './fingerprint.js';
import type { LiveMember } from '../ticket-review/fingerprint.js';
import type { StartDiagramArgs, StartDiagramResult } from './manager.js';
import {
  countReviewDiagramsSince,
  diagramExistsAt,
  diagramsSwitchedOnForPr,
  getDiagramPrContext,
  getPrFileStats,
  markDiagramRefused,
  insertQueuedDiagram,
} from './persist.js';

// "A REVIEW JUST FINISHED — DRAW ITS DIAGRAMS?" The one hook between Claude Review and this process.
// claude-review/manager.ts calls it fire-and-forget after EVERY succeeded run, MANUAL OR AUTO, and
// nothing it does can reach the review: it never throws (every error is logged and swallowed) and it
// only QUEUES — the drawing runs later in the shared slot pool.
//
// For the PR:      queue a 'pr' diagram unless the change has no CODE (stored file list through the
//                  existing classifier; unknown ⇒ the pipeline decides from the diff), a diagram
//                  already exists at this head (any status — a click redraws), one is in flight, or
//                  the daily cap (SEQUENCE_DIAGRAM_DAILY_CAP, review-started rows per account per UTC
//                  day) is spent.
// For each ticket: the PR's tracker tickets (core tracker, STORED rows only — tracker/ticket-source.ts),
//                  at most MAX_TICKETS. A ticket with MORE THAN ONE open or merged PR queues ONE
//                  'story' diagram under the same rules, its fingerprint over every member's head and
//                  state — so a push to ANY member redraws it after that member's next review.
//
// ⚠ THE PER-WORKSPACE SWITCH (`workspaces.auto_diagrams_enabled`, migration 0126, ON by default):
// switched off for the PR's workspace ⇒ 'switched_off' and nothing is queued or stored. It gates
// THIS automatic draw only — the reader's own Draw / Redraw (routes.ts → startDiagram) still works.

export const MAX_TICKETS = 3;

/** 00:00 UTC of the day `nowMs` falls in (the cap's day — the same rule as claude-review/auto.ts). */
export function utcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface TriggerDeps {
  prContext: typeof getDiagramPrContext;
  // The PR's workspace switch (ON by default; only a stored false is off).
  switchedOn: typeof diagramsSwitchedOnForPr;
  exists: typeof diagramExistsAt;
  usedToday: typeof countReviewDiagramsSince;
  held(accountId: number, kind: SequenceDiagramKind, subject: string): Promise<boolean>;
  ticketsForPr(accountId: number, prId: number): Promise<Array<{ ident: string; key: string | null }>>;
  storyMembers(ctx: AgentContext, accountId: number, ident: string): Promise<StoryMember[]>;
  fileStats: typeof getPrFileStats;
  enqueue(ctx: AgentContext, a: StartDiagramArgs): Promise<StartDiagramResult>;
  // A no-code change is STORED as a refused row (no model, no cost), so the pane can say why there is
  // no diagram and the same head is never judged twice.
  refuseNoCode(ctx: AgentContext, a: StartDiagramArgs): Promise<void>;
  dailyCap: number;
  enabled: boolean;
}

export type StoryMember = LiveMember & { owner: string; name: string };

// The manager is reached LAZILY: it registers a slot peer and pulls in the review manager, which a
// unit test of these rules must not load.
const manager = () => import('./manager.js');

const defaultDeps: TriggerDeps = {
  prContext: getDiagramPrContext,
  switchedOn: diagramsSwitchedOnForPr,
  exists: diagramExistsAt,
  usedToday: countReviewDiagramsSince,
  held: async (accountId, kind, subject) => (await manager()).diagramHeld(accountId, kind, subject),
  ticketsForPr: async (accountId, prId) =>
    (await getTicketSource().ticketsForPr(accountId, prId)).map((t) => ({ ident: t.ident, key: t.ticket.key ?? null })),
  storyMembers: async (ctx, accountId, ident) => (await manager()).liveStoryMembers(ctx, accountId, ident),
  fileStats: getPrFileStats,
  enqueue: async (ctx, a) => (await manager()).startDiagram(ctx, a),
  refuseNoCode: async (ctx, a) => {
    const id = await insertQueuedDiagram(ctx, { ...a, model: 'claude-sonnet-5' });
    await markDiagramRefused(ctx, a.accountId, id, 'no_code');
  },
  dailyCap: config.sequenceDiagramDailyCap,
  // The ONE agentic switch (config.aiEnabled); the routes and the manager check it too.
  enabled: config.aiEnabled,
};

/** The wire members of a story (also the manager's, kept here so the rules need no manager). */
export function toDiagramMembers(members: readonly StoryMember[]): SequenceDiagramMember[] {
  return members.map((m) => ({
    prId: m.prId,
    repo: `${m.owner}/${m.name}`,
    number: m.number,
    title: m.title,
    state: m.state,
    headSha: m.headSha,
  }));
}

// 'over_budget': the Claude spend budget is reached (ai/budget.ts) — nothing queued; the next review
// (or Redraw) asks again.
// 'switched_off': the PR's workspace turned automatic diagrams off (Settings) — nothing queued.
export type TriggerOutcome =
  | 'queued'
  | 'busy'
  | 'already_running'
  | 'disabled'
  | 'switched_off'
  | DiagramSkip
  | 'no_head'
  | 'over_budget';

export interface TriggerResult {
  pr: TriggerOutcome;
  stories: Array<{ ident: string; outcome: TriggerOutcome }>;
}

function fold(codes: readonly CodeAnswer[]): CodeAnswer {
  if (codes.includes('yes')) return 'yes';
  if (codes.includes('unknown')) return 'unknown';
  return 'no';
}

/** Never throws. Manual and auto reviews both draw; `reviewTrigger` decides only whether the Claude
 *  spend budget is asked (auto only). */
export async function maybeDrawDiagramsAfterReview(
  ctx: AgentContext,
  a: { accountId: number; prId: number; reviewTrigger: 'manual' | 'auto' },
  deps: TriggerDeps = defaultDeps,
  nowMs: number = Date.now(),
): Promise<TriggerResult> {
  const result: TriggerResult = { pr: 'disabled', stories: [] };
  if (!deps.enabled) return result;
  const { accountId, prId } = a;
  try {
    // The workspace switch first: off means no budget read, no PR read, nothing stored.
    if (!(await deps.switchedOn(ctx, accountId, prId))) {
      result.pr = 'switched_off';
      return result;
    }
    // THE CLAUDE SPEND BUDGET asks only after an AUTO review: a diagram after a review the reader
    // started is part of that run (the reader already chose it, past the over-budget confirm).
    if (a.reviewTrigger === 'auto' && !(await automaticRunAllowed(ctx, accountId, 'diagrams'))) {
      result.pr = 'over_budget';
      return result;
    }
    const pr = await deps.prContext(ctx, accountId, prId);
    if (!pr || !pr.headSha) {
      result.pr = 'no_head';
      return result;
    }
    let used = await deps.usedToday(ctx, accountId, utcDayStartMs(nowMs));

    // ---- the PR's own diagram ----
    const prSubject = String(prId);
    const prFp = prDiagramFingerprint(prId, pr.headSha);
    const prDrawn = await deps.exists(ctx, accountId, 'pr', prSubject, prFp);
    const prArgs: StartDiagramArgs = {
      accountId,
      kind: 'pr',
      subject: prSubject,
      prId,
      ticketKey: null,
      fingerprint: prFp,
      headSha: pr.headSha,
      members: null,
      trigger: 'review',
    };
    const prSkip = diagramSkipReason({
      code: storedCodeAnswer(pr),
      drawnAtFingerprint: prDrawn,
      inFlight: await deps.held(accountId, 'pr', prSubject),
      usedToday: used,
      dailyCap: deps.dailyCap,
    });
    if (prSkip != null) {
      result.pr = prSkip;
      if (prSkip === 'no_code' && !prDrawn) await deps.refuseNoCode(ctx, prArgs);
    } else {
      const r = await deps.enqueue(ctx, prArgs);
      result.pr = r.outcome;
      if (r.outcome === 'queued') used += 1;
    }

    // ---- the story diagrams of its tickets ----
    const tickets = (await deps.ticketsForPr(accountId, prId).catch(() => []))
      .filter((t) => {
        const p = parseTicketIdent(t.ident);
        return p != null && p.kind !== 'manual';
      })
      .slice(0, MAX_TICKETS);
    for (const t of tickets) {
      const members = await deps.storyMembers(ctx, accountId, t.ident);
      const stats = await deps.fileStats(ctx, accountId, members.map((m) => m.prId));
      const code = fold(members.map((m) => (stats.has(m.prId) ? storedCodeAnswer(stats.get(m.prId)!) : 'unknown')));
      const fp = storyDiagramFingerprint(t.ident, members);
      const drawn = members.length >= 2 && (await deps.exists(ctx, accountId, 'story', t.ident, fp));
      const storyArgs: StartDiagramArgs = {
        accountId,
        kind: 'story',
        subject: t.ident,
        prId: null,
        ticketKey: t.key,
        fingerprint: fp,
        headSha: null,
        members: toDiagramMembers(members),
        trigger: 'review',
      };
      const skip = diagramSkipReason({
        code,
        drawnAtFingerprint: drawn,
        inFlight: await deps.held(accountId, 'story', t.ident),
        usedToday: used,
        dailyCap: deps.dailyCap,
        memberCount: members.length,
      });
      if (skip != null) {
        result.stories.push({ ident: t.ident, outcome: skip });
        if (skip === 'no_code' && !drawn) await deps.refuseNoCode(ctx, storyArgs);
        continue;
      }
      const r = await deps.enqueue(ctx, storyArgs);
      result.stories.push({ ident: t.ident, outcome: r.outcome });
      if (r.outcome === 'queued') used += 1;
    }
    return result;
  } catch (err) {
    ctx.log.warn(
      `sequence diagrams after ${a.reviewTrigger} review of pr ${prId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
}
