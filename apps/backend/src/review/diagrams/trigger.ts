import {
  SEQUENCE_DIAGRAM_SUBJECT_DAILY_DRAWS,
  parseTicketIdent,
  type SequenceDiagramAutoSkip,
  type SequenceDiagramKind,
  type SequenceDiagramMember,
} from '@pierre-review/shared';
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
  subjectDrawHistory,
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
// ⚠ A REDRAW IS LIMITED (2026-10-28: one story drawn 11 times and one PR 9 times spent the cap of 30
//                  by 14:52, and every later review drew nothing, silently). A subject drawn before —
//                  a story with the SAME pull requests — is drawn at most SEQUENCE_DIAGRAM_SUBJECT_DAILY_DRAWS
//                  (2) times a UTC day, its first draw included, and never takes the cap's last slots
//                  (shared `repeatRunLimit`). A first draw, or a story whose PRs changed, is held only
//                  by the cap. A skip for a limit is LOGGED (`logTriggerLimits`) and kept in memory
//                  for the slot (`diagramAutoSkip` → `autoSkipped`), so the pane can say why.
// After a TICKET REVIEW succeeds (`maybeDrawStoryDiagramAfterTicketReview`), its story is asked again
// under the same rules: a PR's ticket link can land after that PR's own review ended.
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
  // The subject's draws today and its last drawn members (the REDRAW rule).
  history: typeof subjectDrawHistory;
  held(accountId: number, kind: SequenceDiagramKind, subject: string): Promise<boolean>;
  ticketsForPr(accountId: number, prId: number): Promise<Array<{ ident: string; key: string | null }>>;
  storyMembers(ctx: AgentContext, accountId: number, ident: string): Promise<StoryMember[]>;
  fileStats: typeof getPrFileStats;
  enqueue(ctx: AgentContext, a: StartDiagramArgs): Promise<StartDiagramResult>;
  // A no-code change is STORED as a refused row (no model, no cost), so the pane can say why there is
  // no diagram and the same head is never judged twice.
  refuseNoCode(ctx: AgentContext, a: StartDiagramArgs): Promise<void>;
  dailyCap: number;
  // Automatic draws of one subject per UTC day, its first draw included (shared SEQUENCE_DIAGRAM_SUBJECT_DAILY_DRAWS).
  subjectCap: number;
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
  history: subjectDrawHistory,
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
  subjectCap: SEQUENCE_DIAGRAM_SUBJECT_DAILY_DRAWS,
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

// ---- why a design was not redrawn (show the wait) ----
// `${accountId}|${kind}|${subject}` → the skip and the fingerprint it was skipped at. The slot reads it
// only while that fingerprint is still the live one (routes.ts `slotFor`), so a later draw or a new
// head clears it by itself. In memory: a restart forgets it, and the next review asks again.
const autoSkips = new Map<string, { skip: SequenceDiagramAutoSkip; fingerprint: string }>();

const skipKey = (accountId: number, kind: SequenceDiagramKind, subject: string): string => `${accountId}|${kind}|${subject}`;

function noteSkip(accountId: number, kind: SequenceDiagramKind, subject: string, fp: string, outcome: TriggerOutcome): void {
  const k = skipKey(accountId, kind, subject);
  if (outcome === 'daily_cap') autoSkips.set(k, { skip: 'daily_limit', fingerprint: fp });
  else if (outcome === 'redraw_limit') autoSkips.set(k, { skip: 'redraw_limit', fingerprint: fp });
  else if (outcome === 'queued' || outcome === 'drawn') autoSkips.delete(k);
}

/** Why the last finished review did not draw this subject at `liveFp`; null when it did, or nothing is known. */
export function diagramAutoSkip(
  accountId: number,
  kind: SequenceDiagramKind,
  subject: string,
  liveFp: string | null,
): SequenceDiagramAutoSkip | null {
  const s = autoSkips.get(skipKey(accountId, kind, subject));
  return s != null && liveFp != null && s.fingerprint === liveFp ? s.skip : null;
}

export function _resetDiagramSkipsForTest(): void {
  autoSkips.clear();
}

/** The redraw rule's input for one subject: null for a FIRST draw (never drawn, or a story whose
 *  pull requests changed since its last design). */
async function redrawOf(
  ctx: AgentContext,
  deps: TriggerDeps,
  accountId: number,
  kind: SequenceDiagramKind,
  subject: string,
  dayStartMs: number,
  memberIds: readonly number[] | null,
): Promise<{ subjectDrawsToday: number; subjectCap: number } | null> {
  const h = await deps.history(ctx, accountId, kind, subject, dayStartMs);
  if (!h.drawnBefore) return null;
  if (memberIds != null) {
    const before = new Set(h.lastMemberIds ?? []);
    const same = h.lastMemberIds != null && before.size === memberIds.length && memberIds.every((id) => before.has(id));
    if (!same) return null;
  }
  return { subjectDrawsToday: h.drawsToday, subjectCap: deps.subjectCap };
}

/** One ticket's story design, after a review of one of its PRs or after its ticket review. */
async function drawStory(
  ctx: AgentContext,
  deps: TriggerDeps,
  accountId: number,
  t: { ident: string; key: string | null },
  used: { n: number },
  dayStartMs: number,
): Promise<TriggerOutcome> {
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
  const redraw =
    members.length >= 2 && !drawn
      ? await redrawOf(ctx, deps, accountId, 'story', t.ident, dayStartMs, members.map((m) => m.prId))
      : null;
  const skip = diagramSkipReason({
    code,
    drawnAtFingerprint: drawn,
    inFlight: await deps.held(accountId, 'story', t.ident),
    usedToday: used.n,
    dailyCap: deps.dailyCap,
    memberCount: members.length,
    redraw,
  });
  if (skip != null) {
    noteSkip(accountId, 'story', t.ident, fp, skip);
    if (skip === 'no_code' && !drawn) await deps.refuseNoCode(ctx, storyArgs);
    return skip;
  }
  const r = await deps.enqueue(ctx, storyArgs);
  noteSkip(accountId, 'story', t.ident, fp, r.outcome);
  if (r.outcome === 'queued') used.n += 1;
  return r.outcome;
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
    const dayStartMs = utcDayStartMs(nowMs);
    const used = { n: await deps.usedToday(ctx, accountId, dayStartMs) };

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
      usedToday: used.n,
      dailyCap: deps.dailyCap,
      redraw: prDrawn ? null : await redrawOf(ctx, deps, accountId, 'pr', prSubject, dayStartMs, null),
    });
    if (prSkip != null) {
      result.pr = prSkip;
      noteSkip(accountId, 'pr', prSubject, prFp, prSkip);
      if (prSkip === 'no_code' && !prDrawn) await deps.refuseNoCode(ctx, prArgs);
    } else {
      const r = await deps.enqueue(ctx, prArgs);
      result.pr = r.outcome;
      noteSkip(accountId, 'pr', prSubject, prFp, r.outcome);
      if (r.outcome === 'queued') used.n += 1;
    }

    // ---- the story diagrams of its tickets ----
    const tickets = (await deps.ticketsForPr(accountId, prId).catch(() => []))
      .filter((t) => {
        const p = parseTicketIdent(t.ident);
        return p != null && p.kind !== 'manual';
      })
      .slice(0, MAX_TICKETS);
    for (const t of tickets) {
      result.stories.push({ ident: t.ident, outcome: await drawStory(ctx, deps, accountId, t, used, dayStartMs) });
    }
    return result;
  } catch (err) {
    ctx.log.warn(
      `sequence diagrams after ${a.reviewTrigger} review of pr ${prId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
}

/**
 * Never throws. A TICKET REVIEW of a tracker ticket just succeeded: draw its story design under the
 * same rules. It closes a race the PR trigger cannot: a PR's ticket link is read when the PR is
 * received, and can land AFTER that PR's review ended — then the PR review saw a one-PR ticket and
 * drew no story. A ticket review runs once the link exists (a PR joining is what re-runs it).
 * `viaPrId` is any member, for the workspace switch.
 */
export async function maybeDrawStoryDiagramAfterTicketReview(
  ctx: AgentContext,
  a: { accountId: number; ident: string; ticketKey: string | null; viaPrId: number; reviewTrigger: 'manual' | 'auto' },
  deps: TriggerDeps = defaultDeps,
  nowMs: number = Date.now(),
): Promise<TriggerOutcome> {
  if (!deps.enabled) return 'disabled';
  const p = parseTicketIdent(a.ident);
  if (p == null || p.kind === 'manual') return 'disabled';
  try {
    if (!(await deps.switchedOn(ctx, a.accountId, a.viaPrId))) return 'switched_off';
    if (a.reviewTrigger === 'auto' && !(await automaticRunAllowed(ctx, a.accountId, 'diagrams'))) return 'over_budget';
    const dayStartMs = utcDayStartMs(nowMs);
    const used = { n: await deps.usedToday(ctx, a.accountId, dayStartMs) };
    return await drawStory(ctx, deps, a.accountId, { ident: a.ident, key: a.ticketKey }, used, dayStartMs);
  } catch (err) {
    ctx.log.warn(`story design after the ticket review of ${a.ident}: ${err instanceof Error ? err.message : String(err)}`);
    return 'disabled';
  }
}

/** One log line when a finished review drew nothing because of a limit (silent otherwise). */
export function logTriggerLimits(ctx: AgentContext, prId: number, r: TriggerResult): void {
  const limited = [
    r.pr === 'daily_cap' || r.pr === 'redraw_limit' ? `pr ${prId}: ${r.pr}` : null,
    ...r.stories.filter((s) => s.outcome === 'daily_cap' || s.outcome === 'redraw_limit').map((s) => `${s.ident}: ${s.outcome}`),
  ].filter((x): x is string => x != null);
  if (limited.length > 0) ctx.log.info(`sequence diagrams not drawn (${limited.join(', ')})`);
}
