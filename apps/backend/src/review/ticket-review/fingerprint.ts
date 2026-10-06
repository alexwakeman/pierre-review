import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  ClaudeReviewTicket,
  TicketAssessment,
  TicketReviewPrState,
  TicketReviewStaleReason,
  TicketReviewState,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// "IS THIS TICKET REVIEW STILL TRUE?" — answered by the SERVER, never the model.
//
// A run stores the FINGERPRINT of what it judged: the story's hash and every member PR's
// (id, head, state). The live fingerprint is rebuilt the same way from the synced `pull_requests`
// rows and the plugin's current membership; a difference means the run no longer describes the
// ticket, and the auto sweeper re-runs it.
//
// ⚠ PURE AND CLOCK-FREE. Nothing derived from `Date.now()` may enter it, or a ticket nobody touched
// would re-run (and re-bill) on a timer. Bump TICKET_REVIEW_VERSION when what a run produces for the
// same inputs changes (the prompt's rules, the reconcile) — every stored run then reads stale once.

export const TICKET_REVIEW_VERSION = 1;

export interface FingerprintMember {
  prId: number;
  // '' when the PR has no synced head yet.
  headSha: string;
  state: TicketReviewPrState;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256(title | description | acceptance criteria) — the story's identity for currency. */
export function ticketHash(
  t: Pick<ClaudeReviewTicket, 'title' | 'description' | 'acceptanceCriteria'>,
): string {
  return sha256([t.title ?? '', t.description ?? '', t.acceptanceCriteria ?? ''].join('\u0000'));
}

/** sha256(version | ticketHash | sorted "prId:headSha:state"). Member order does not matter. */
export function fingerprint(hash: string, members: readonly FingerprintMember[]): string {
  const parts = members
    .map((m) => `${m.prId}:${m.headSha}:${m.state}`)
    .sort();
  return sha256([`v${TICKET_REVIEW_VERSION}`, hash, ...parts].join('\n'));
}

/** 'manual:<prId>:<sha8(title | acceptance criteria)>' — a pasted story, scoped to one PR. */
export function manualTicketIdent(
  prId: number,
  t: Pick<ClaudeReviewTicket, 'title' | 'acceptanceCriteria'>,
): string {
  return `manual:${prId}:${sha256(`${t.title ?? ''}\u0000${t.acceptanceCriteria ?? ''}`).slice(0, 8)}`;
}

/** A PR's member state: open, merged, or null (closed without merging — never a member). */
export function memberStateOf(state: string): TicketReviewPrState | null {
  return state === 'open' ? 'open' : state === 'merged' ? 'merged' : null;
}

export interface LiveMember extends FingerprintMember {
  repoId: number;
  number: number;
  title: string;
  // The synced last-activity time. Orders which card-less members a run reads as diffs
  // (cards.ts `partitionMembers`); ⚠ never part of the fingerprint.
  updatedAt: Date | null;
}

/**
 * The live member rows for a candidate PR set, read from `pull_requests` (this account only).
 * Closed-but-unmerged PRs and ids that are not this account's are dropped. Sorted by prId.
 */
export async function readLiveMembers(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<LiveMember[]> {
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return [];
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const pr = (ctx.schema as any).pullRequests;
  const rows = (await ctx.db
    .select({
      id: pr.id,
      repoId: pr.repoId,
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha,
      state: pr.state,
      updatedAt: pr.updatedAt,
    })
    .from(pr)
    .where(and(eq(pr.accountId, accountId), inArray(pr.id, ids)))
    .execute()) as Array<{
    id: number;
    repoId: number;
    number: number;
    title: string;
    headSha: string | null;
    state: string;
    updatedAt: Date | number | null;
  }>;
  const out: LiveMember[] = [];
  for (const r of rows) {
    const state = memberStateOf(r.state);
    if (state == null) continue;
    out.push({
      prId: r.id,
      repoId: r.repoId,
      number: r.number,
      title: r.title,
      headSha: r.headSha ?? '',
      state,
      updatedAt: r.updatedAt == null ? null : r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt),
    });
  }
  return out.sort((a, b) => a.prId - b.prId);
}

/** The live fingerprint of a ticket whose current story hash and member PR ids are known. */
export async function liveFingerprint(
  ctx: AgentContext,
  accountId: number,
  hash: string,
  prIds: readonly number[],
): Promise<{ fingerprint: string; members: LiveMember[] }> {
  const members = await readLiveMembers(ctx, accountId, prIds);
  return { fingerprint: fingerprint(hash, members), members };
}

/** What moved between a run's stored inputs and the live ones, in TicketReviewStaleReason order. */
export function staleReasons(
  stored: { ticketHash: string | null; members: readonly FingerprintMember[] },
  live: { ticketHash: string; members: readonly FingerprintMember[] },
): { reasons: TicketReviewStaleReason[]; changedPrIds: number[] } {
  const reasons = new Set<TicketReviewStaleReason>();
  const changed = new Set<number>();
  if (stored.ticketHash !== live.ticketHash) reasons.add('story_edited');
  const before = new Map(stored.members.map((m) => [m.prId, m]));
  const now = new Map(live.members.map((m) => [m.prId, m]));
  for (const [id, m] of now) {
    const was = before.get(id);
    if (was == null) {
      reasons.add('pr_added');
      changed.add(id);
    } else if (was.headSha !== m.headSha) {
      reasons.add('pr_pushed');
      changed.add(id);
    } else if (was.state !== m.state) {
      reasons.add('pr_merged');
      changed.add(id);
    }
  }
  for (const id of before.keys()) {
    if (!now.has(id)) {
      reasons.add('pr_left');
      changed.add(id);
    }
  }
  const order: TicketReviewStaleReason[] = ['story_edited', 'pr_added', 'pr_left', 'pr_pushed', 'pr_merged'];
  return {
    reasons: order.filter((r) => reasons.has(r)),
    changedPrIds: [...changed].sort((a, b) => a - b),
  };
}

/** Criteria counts of one stored assessment. */
export function criteriaCounts(a: TicketAssessment | null): TicketReviewState['counts'] {
  if (a == null) return null;
  const c = { met: 0, partlyMet: 0, notMet: 0, unclear: 0, notChecked: 0, total: a.criteria.length };
  for (const x of a.criteria) {
    if (x.status === 'met') c.met += 1;
    else if (x.status === 'partly_met') c.partlyMet += 1;
    else if (x.status === 'not_met') c.notMet += 1;
    else if (x.status === 'unclear') c.unclear += 1;
    else c.notChecked += 1;
  }
  return c;
}

/**
 * One ticket's currency, from its latest SUCCEEDED run (if any), its in-flight run (if any) and the
 * live inputs (null = not knowable now — no plugin answer: the latest run is then reported as
 * current, since nothing shows it moved).
 */
export function deriveTicketReviewState(args: {
  ident: string;
  latest: {
    id: number;
    fingerprint: string | null;
    ticketHash: string | null;
    alignment: TicketReviewState['alignment'];
    assessment: TicketAssessment | null;
    completedAt: Date | null;
    members: readonly FingerprintMember[];
  } | null;
  runningRunId: number | null;
  live: { ticketHash: string; members: readonly FingerprintMember[] } | null;
}): TicketReviewState {
  const { ident, latest, runningRunId, live } = args;
  const base: TicketReviewState = {
    ident,
    status: 'none',
    staleBecause: [],
    changedPrIds: [],
    latestRunId: latest?.id ?? null,
    runningRunId,
    alignment: latest?.alignment ?? null,
    counts: criteriaCounts(latest?.assessment ?? null),
    memberCount: latest?.members.length ?? 0,
    checkedAt: latest?.completedAt ? latest.completedAt.toISOString() : null,
  };
  // A run stored before it was prepared has no fingerprint and can never be current. A moved
  // fingerprint with no listed reason is a TICKET_REVIEW_VERSION bump: stale, nothing to name.
  let moved = latest != null && latest.fingerprint == null;
  if (latest != null && latest.fingerprint != null && live != null) {
    moved = fingerprint(live.ticketHash, live.members) !== latest.fingerprint;
    if (moved) {
      const { reasons, changedPrIds } = staleReasons(latest, live);
      base.staleBecause = reasons;
      base.changedPrIds = changedPrIds;
    }
  }
  if (runningRunId != null) base.status = 'running';
  else if (latest == null) base.status = 'none';
  else base.status = moved ? 'stale' : 'current';
  return base;
}
