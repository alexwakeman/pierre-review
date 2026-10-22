import { SPRINT_REFRESH_TICKET_CHECKS, TICKET_REVIEW_MAX_PRS, type SprintGraphPr, type SprintRefreshTicketChecks } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { setSprintTicketChecks } from '../../tracker/sprint/hooks.js';
import { fingerprint, readLiveMembers, ticketHash, type LiveMember } from './fingerprint.js';
import { startTicketReview, ticketReviewHeld, type StartTicketArgs, type StartTicketResult } from './manager.js';
import { getTicketStateInputs, type TicketStateInputs } from './persist.js';
import { jiraMemberIds, jiraStoryFor } from './prepare.js';

// THIS SPRINT → "REFRESH" ALSO RUNS TICKET CHECKS (docs/CLAUDE-REVIEW.md § Ticket review → Started by
// a sprint refresh). A MANUAL press of This Sprint's Refresh (POST /api/sprint-stories/refresh) starts
// the ticket review — the Story check, agentic, on the user's own Claude — for AT MOST
// SPRINT_REFRESH_TICKET_CHECKS sprint tickets, so the cards' "n of m met" fills in over time. Never on
// a view, never from the sprint read's own schedule.
//
//   • WHO: sprint tickets (never ghosts) with ≥ 1 open or merged PR in this workspace, whose check is
//     not CURRENT (the server fingerprint, the sweeper's own: story hash + members' heads/state).
//     Skipped: a run queued or running (DB or this process), ≤ 0 or > TICKET_REVIEW_MAX_PRS members,
//     no stored story, and a ticket whose newest attempt since the last success FAILED or was REFUSED
//     on these very inputs (the sweeper's rule — pressing Refresh again must not re-bill a failure).
//   • ORDER: never checked first, then stale; within each, the newest member PR activity first.
//   • HOW: `startTicketReview(…, trigger: 'manual')` — the ticket review's ONE door, its lane, its
//     shared REVIEW_CONCURRENCY slots. 'manual' because a person pressed the button: it goes ahead of
//     automatic items and does NOT count against TICKET_REVIEW_DAILY_CAP (auto / cascade only).
//   • Pre-check is the start route's: no Claude credential → 'no_credential'; nothing starts.
//
// The selection is DB + local reads only, done inline so the 202 can say how many started.

/** Tickets examined at most per refresh (each costs a few local DB reads). */
export const SPRINT_CHECK_EXAMINE_MAX = 40;

export interface SprintCheckCandidate {
  ident: string;
  key: string;
  title: string;
  prs: SprintGraphPr[];
}

export interface SprintCheckLive {
  fingerprint: string;
  members: LiveMember[];
  ticketKey: string | null;
  ticketTitle: string | null;
}

export interface SprintCheckDeps {
  /** Sprint tickets (not ghosts) with their PRs in this workspace, graph order. */
  candidates(accountId: number, workspaceId: number): Promise<SprintCheckCandidate[]>;
  states(accountId: number, idents: readonly string[]): Promise<Map<string, TicketStateInputs>>;
  /** The ticket's live fingerprint; null = no stored story or no members. */
  live(accountId: number, ident: string): Promise<SprintCheckLive | null>;
  held(accountId: number, ident: string): boolean;
  start(a: StartTicketArgs): Promise<StartTicketResult>;
}

export interface SprintCheckPick {
  ident: string;
  never: boolean;
  newestMs: number;
  live: SprintCheckLive;
  originPrId: number;
}

const hasLivePr = (c: SprintCheckCandidate): boolean => c.prs.some((p) => p.state === 'open' || p.state === 'merged');

/** The ticket's position in the order and the PR the run starts from; null = not due. Pure. */
export function sprintCheckPickOf(
  c: SprintCheckCandidate,
  st: TicketStateInputs | undefined,
  live: SprintCheckLive | null,
): SprintCheckPick | null {
  if (live == null || live.members.length === 0 || live.members.length > TICKET_REVIEW_MAX_PRS) return null;
  if (st?.runningRunId != null) return null;
  if (st?.latest?.fingerprint === live.fingerprint) return null;
  const attempt = st?.latestAttempt;
  if (attempt != null && attempt.id > (st?.latest?.id ?? 0) && attempt.fingerprint === live.fingerprint) return null;
  const newestMs = Math.max(0, ...live.members.map((m) => (m.updatedAt == null ? 0 : m.updatedAt.getTime())));
  const inWs = new Set(c.prs.map((p) => p.prId));
  const origin =
    c.prs.find((p) => p.state === 'open')?.prId ??
    c.prs.find((p) => p.state === 'merged')?.prId ??
    live.members.find((m) => inWs.has(m.prId))?.prId ??
    live.members[0]!.prId;
  return { ident: c.ident, never: st?.latest == null, newestMs, live, originPrId: origin };
}

/** Never checked first, then stale; newest activity first within each; then ident. Pure. */
export function orderSprintChecks(picks: SprintCheckPick[]): SprintCheckPick[] {
  return [...picks].sort(
    (a, b) => Number(b.never) - Number(a.never) || b.newestMs - a.newestMs || (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0),
  );
}

const DEFAULT_DEPS = (ctx: AgentContext): SprintCheckDeps => ({
  candidates: async (accountId, workspaceId) => {
    const [{ workspaceSite }, { graphPrsFor, loadGraphTickets }] = await Promise.all([
      import('../../db/stories.js'),
      import('../../db/sprint-graph.js'),
    ]);
    const site = await workspaceSite(accountId, workspaceId);
    if (site == null) return [];
    // `aiEnabled: false` — the briefs are not needed to pick, and it skips their read.
    const t = await loadGraphTickets(accountId, workspaceId, site, false);
    const prs = await graphPrsFor(accountId, workspaceId, site, t.sprintRows.map((r) => r.issueKey));
    return t.sprint.map((x) => ({ ident: x.ident, key: x.key, title: x.title, prs: prs.get(x.ident) ?? [] }));
  },
  states: (accountId, idents) => getTicketStateInputs(ctx, accountId, idents),
  live: async (accountId, ident) => {
    const memberIds = await jiraMemberIds(accountId, ident);
    if (memberIds.length === 0) return null;
    const ticket = await jiraStoryFor(accountId, ident, memberIds);
    if (ticket == null) return null;
    const members = await readLiveMembers(ctx, accountId, memberIds);
    return { fingerprint: fingerprint(ticketHash(ticket), members), members, ticketKey: ticket.key ?? null, ticketTitle: ticket.title ?? null };
  },
  held: ticketReviewHeld,
  start: (a) => startTicketReview(ctx, a),
});

/** Start up to `max` ticket checks for this workspace's sprint. Never throws. */
export async function runSprintTicketChecks(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  opts: { max?: number; deps?: SprintCheckDeps } = {},
): Promise<SprintRefreshTicketChecks> {
  const max = opts.max ?? SPRINT_REFRESH_TICKET_CHECKS;
  const deps = opts.deps ?? DEFAULT_DEPS(ctx);
  try {
    if (ctx.llm.detectAuth().status === 'none') return { started: 0, skipped: 'no_credential' };
    const all = (await deps.candidates(accountId, workspaceId)).filter(hasLivePr).filter((c) => !deps.held(accountId, c.ident));
    if (all.length === 0) return { started: 0, skipped: null };
    const states = await deps.states(
      accountId,
      all.map((c) => c.ident),
    );
    // Never-checked tickets are examined first so the cap cannot be spent on stale ones alone.
    const examine = [...all].sort((a, b) => Number(states.get(a.ident)?.latest != null) - Number(states.get(b.ident)?.latest != null));
    const picks: SprintCheckPick[] = [];
    for (const c of examine.slice(0, SPRINT_CHECK_EXAMINE_MAX)) {
      const st = states.get(c.ident);
      if (st?.runningRunId != null) continue;
      const pick = sprintCheckPickOf(c, st, await deps.live(accountId, c.ident));
      if (pick != null) picks.push(pick);
    }
    let started = 0;
    for (const p of orderSprintChecks(picks)) {
      if (started >= max) break;
      const r = await deps.start({
        accountId,
        workspaceId,
        ident: p.ident,
        ticketKey: p.live.ticketKey,
        ticketTitle: p.live.ticketTitle,
        manualTicket: null,
        originPrId: p.originPrId,
        trigger: 'manual',
      });
      if (r.outcome === 'queued') started += 1;
      else if (r.outcome === 'busy' || r.outcome === 'disabled') break;
    }
    return { started, skipped: null };
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, err: String(err).slice(0, 200) }, 'sprint ticket checks failed');
    return { started: 0, skipped: null };
  }
}

/** Registered from the agentic registration (local, AI on): the refresh route's seam. */
export function registerSprintTicketChecks(ctx: AgentContext): void {
  setSprintTicketChecks((accountId, workspaceId) => runSprintTicketChecks(ctx, accountId, workspaceId));
}
