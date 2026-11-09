import { and, desc, eq, inArray } from 'drizzle-orm';
import { TICKET_REVIEW_MAX_PRS, type ClaudeReviewTicket, type TicketReviewStaleReason } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getTicketSource } from '../../tracker/ticket-source.js';
import { utcDayStartMs } from '../claude-review/auto.js';
import { fingerprint, readLiveMembers, staleReasons, ticketHash, type LiveMember } from './fingerprint.js';
import { countAutoTicketReviewsSince, getTicketStateInputs } from './persist.js';
import { jiraStoryFor, ticketCommentsFor } from './prepare.js';
import { newCommentsMakeStale } from '../../tracker/comments.js';
import { ticketAutoCheckPlan, type TicketAutoChange, type TicketAutoPlan } from './auto-plan.js';

// THE AUTOMATIC STORY CHECK'S INPUTS, read from stored rows — ONE reader for the sweeper (sweep.ts,
// which acts on the plan) and the states route (routes.ts, which shows it). The rule itself is the
// pure `ticketAutoCheckPlan` (auto-plan.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Why the sweeper queued a run (ticket_reviews.cause, migration 0182). NULL = a manual run.
export type TicketReviewCause = 'first' | 'pushed' | 'joined' | 'left' | 'merged' | 'story_edited' | 'commented';

export interface TicketAutoContext {
  accountId: number;
  // workspaceId → when auto review was switched on there (the auto-enabled workspaces only).
  enabled: ReadonlyMap<number, number>;
  // The PR that brought the ticket up (the sweeper's changed PR), when known.
  viaPrId: number | null;
  // An auto PR review of a member just launched (skips the first check's onboarding floor).
  kicked: boolean;
  aiReady: boolean;
  overBudget: boolean;
  laneRoom: number | null;
  // A run is claimed in the lane (manager.ts `ticketReviewHeld`).
  held: boolean;
  dailyCap: number;
  // The reader's users.id (null = not known: nothing is exempt).
  readerUserId: number | null;
  // Shared across one sweep tick: workspaceId → automatic runs counted today.
  capUsed?: Map<number, number>;
}

export interface TicketAutoState {
  plan: TicketAutoPlan;
  // The workspace an automatic run counts against (null = no auto-enabled member workspace).
  workspaceId: number | null;
  ticket: ClaudeReviewTicket | null;
  live: LiveMember[];
  first: boolean;
  cause: TicketReviewCause | null;
}

/** The reader's users.id — the account's GitHub login in `users`. null when not known. */
export async function readerUserIdOf(ctx: AgentContext, accountId: number): Promise<number | null> {
  const { accounts, users } = s(ctx);
  const rows = (await ctx.db
    .select({ id: users.id })
    .from(accounts)
    .innerJoin(users, eq(users.githubLogin, accounts.githubLogin))
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

interface MemberClock {
  id: number;
  openedAt: Date | null;
  headSeenAt: Date | null;
  headBurstAt: Date | null;
  mergedAt: Date | null;
  authorId: number | null;
  limnOpenedForUserId: number | null;
}

async function readMemberClocks(ctx: AgentContext, accountId: number, prIds: readonly number[]): Promise<MemberClock[]> {
  if (prIds.length === 0) return [];
  const { pullRequests: pr } = s(ctx);
  return (await ctx.db
    .select({
      id: pr.id,
      openedAt: pr.openedAt,
      headSeenAt: pr.headSeenAt,
      headBurstAt: pr.headBurstAt,
      mergedAt: pr.mergedAt,
      authorId: pr.authorId,
      limnOpenedForUserId: pr.limnOpenedForUserId,
    })
    .from(pr)
    .where(and(eq(pr.accountId, accountId), inArray(pr.id, [...prIds])))
    .execute()) as MemberClock[];
}

/** When the latest run of the ticket (any status) was queued or started — it saw every change before. */
async function lastRunAtMs(ctx: AgentContext, accountId: number, ident: string): Promise<number | null> {
  const { ticketReviews: tr } = s(ctx);
  const rows = (await ctx.db
    .select({ createdAt: tr.createdAt, startedAt: tr.startedAt })
    .from(tr)
    .where(and(eq(tr.accountId, accountId), eq(tr.ticketIdent, ident)))
    .orderBy(desc(tr.id))
    .limit(1)
    .execute()) as Array<{ createdAt: Date | null; startedAt: Date | null }>;
  const r = rows[0];
  if (!r) return null;
  const t = (d: Date | null): number => (d ? new Date(d).getTime() : 0);
  return Math.max(t(r.createdAt), t(r.startedAt)) || null;
}

const ms = (d: Date | number | null | undefined): number | null => (d == null ? null : new Date(d).getTime());

/** The cause a run is stored with: 'pushed' only when nothing but heads moved. */
export function causeOf(
  first: boolean,
  reasons: readonly TicketReviewStaleReason[],
): TicketReviewCause | null {
  if (first) return 'first';
  if (reasons.includes('pr_added')) return 'joined';
  if (reasons.includes('pr_left')) return 'left';
  if (reasons.includes('pr_merged')) return 'merged';
  if (reasons.includes('story_edited')) return 'story_edited';
  if (reasons.includes('pr_pushed')) return 'pushed';
  if (reasons.includes('new_comments')) return 'commented';
  return null;
}

/**
 * One tracker ticket's automatic-check state. null = nothing to say: no member PRs, no stored story,
 * or a pasted ('manual:') ticket (those never run automatically).
 */
export async function loadTicketAutoState(
  ctx: AgentContext,
  ident: string,
  a: TicketAutoContext,
  nowMs: number,
): Promise<TicketAutoState | null> {
  const { accountId } = a;
  const membersWs = await getTicketSource()
    .ticketMembers(accountId, ident)
    .catch(() => []);
  const memberIds = [...new Set(membersWs.map((m) => m.prId))];
  if (memberIds.length === 0) return null;
  const ticket = await jiraStoryFor(accountId, ident, memberIds);
  if (!ticket) return null;
  const live = await readLiveMembers(ctx, accountId, memberIds);
  if (live.length === 0) return null;

  const wsOfPr = new Map(membersWs.map((m) => [m.prId, m.workspaceId]));
  const viaWs = a.viaPrId != null ? wsOfPr.get(a.viaPrId) : undefined;
  const enabledWs = [...new Set(membersWs.map((m) => m.workspaceId))].filter((w) => a.enabled.has(w)).sort((x, y) => x - y);
  const workspaceId = viaWs != null && a.enabled.has(viaWs) ? viaWs : (enabledWs[0] ?? null);

  const liveHash = ticketHash(ticket);
  const fp = fingerprint(liveHash, live);
  const st = (await getTicketStateInputs(ctx, accountId, [ident])).get(ident);
  const first = st?.latest == null;
  // A person's comment the latest check did not see re-checks it ONLY while it still has a criterion
  // not done (tracker/comments.ts `newCommentsMakeStale`; docs/TRACKERS.md § Ticket comments).
  const comments = st?.latest?.commentsSeen != null ? await ticketCommentsFor(accountId, ident) : [];
  const commentsStale = !first && newCommentsMakeStale(st?.latest, comments);
  const needsRun = first || st!.latest!.fingerprint !== fp || commentsStale;
  const attempt = st?.latestAttempt;
  const alreadyTried = attempt != null && attempt.id > (st?.latest?.id ?? 0) && attempt.fingerprint === fp;
  const reasons: TicketReviewStaleReason[] =
    st?.latest != null ? staleReasons(st.latest, { ticketHash: liveHash, members: live }).reasons : [];
  if (commentsStale) reasons.push('new_comments');

  // ---- the changes the grace window counts from ----
  const liveIds = live.map((m) => m.prId);
  const clocks = await readMemberClocks(ctx, accountId, liveIds);
  const changes: TicketAutoChange[] = [];
  for (const c of clocks) {
    const seen = ms(c.headSeenAt);
    if (seen != null) changes.push({ atMs: seen, sinceMs: ms(c.headBurstAt), prId: c.id, kind: 'pushed' });
    const merged = ms(c.mergedAt);
    if (merged != null) changes.push({ atMs: merged, prId: c.id, kind: 'merged' });
  }
  const liveSet = new Set(liveIds);
  for (const m of membersWs) {
    if (!liveSet.has(m.prId)) continue;
    const linked = m.linkedAtMs ?? null;
    if (linked != null) changes.push({ atMs: linked, prId: m.prId, kind: 'joined' });
    // A row's `changed_at` is also stamped when it is first written (= its join): not a second change.
    const changed = m.changedAtMs ?? null;
    if (changed != null && changed !== linked) changes.push({ atMs: changed, prId: null, kind: 'ticket_changed' });
  }

  // Each comment that check did not see restarts the grace window from when it was written.
  if (commentsStale) {
    const seen = new Set(st?.latest?.commentsSeen?.ids ?? []);
    for (const c of comments) {
      const at = Date.parse(c.createdAt);
      if (!seen.has(c.id) && Number.isFinite(at)) changes.push({ atMs: at, prId: null, kind: 'commented' });
    }
  }

  // ---- the onboarding floor (a first check only) ----
  let floorOk = true;
  if (first && !a.kicked && workspaceId != null) {
    const floor = a.enabled.get(workspaceId)!;
    const opened = new Map(clocks.map((c) => [c.id, ms(c.openedAt) ?? 0]));
    floorOk = live.some((m) => m.state === 'open' && (opened.get(m.prId) ?? 0) >= floor);
  }

  // ---- the daily cap: a ticket with a PR the reader owns is never held by it ----
  let used = 0;
  if (workspaceId != null) {
    const cached = a.capUsed?.get(workspaceId);
    used = cached ?? (await countAutoTicketReviewsSince(ctx, accountId, workspaceId, utcDayStartMs(nowMs)));
    a.capUsed?.set(workspaceId, used);
  }
  const exempt =
    a.readerUserId != null &&
    clocks.some((c) => c.authorId === a.readerUserId || c.limnOpenedForUserId === a.readerUserId);

  const plan = ticketAutoCheckPlan(
    {
      running: a.held || st?.runningRunId != null,
      needsRun,
      autoOn: workspaceId != null,
      tooManyPrs: live.length > TICKET_REVIEW_MAX_PRS,
      alreadyTried,
      first,
      floorOk,
      aiReady: a.aiReady,
      overBudget: a.overBudget,
      changes,
      lastRunAtMs: await lastRunAtMs(ctx, accountId, ident),
      cap: { used, limit: a.dailyCap, exempt },
      laneRoom: a.laneRoom,
    },
    nowMs,
  );
  return { plan, workspaceId, ticket, live, first, cause: causeOf(first, reasons) };
}

