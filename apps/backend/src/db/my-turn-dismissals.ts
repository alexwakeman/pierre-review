// MY TURN DISMISSALS + ONE CARD PER PR (CORE, free, both modes, no AI).
//
// Two rules the My Turn fold (`getMyTurn`) applies, kept here so they can be read — and tested —
// apart from the 700-line fold that calls them.
//
// ── 1. A DISMISSAL SETS ONE ITEM DOWN UNTIL SOMETHING NEW HAPPENS ────────────────────────────
//
// The reader can take a subject — a pull request, or a repository for a red default branch — off
// their plate. ⚠ This is NOT the "Done" button migration 0060 deleted, and the difference is the
// whole design. That one stored "I dealt with this" and never expired, so a PR whose ball came back
// stayed hidden behind it for weeks. This one stores a TIMESTAMP and lets the fold decide:
//
//   • an item on a dismissed subject is hidden only while its OWN clock (the moment the thing that
//     needs you happened — `MyTurnPr.since`, a thread's `lastReplyAt`, …) is at or before the
//     dismissal. Anything LATER shows again, and only that item: a new reply comes back as a reply,
//     not as the review request you set down;
//   • a subject with NO My Turn item at all — you acted, it closed, the request was withdrawn —
//     DISCHARGES its row (`dischargeable`), so the next summons starts fresh rather than arriving
//     already dismissed. That is what stops a dismissal outliving the thing it dismissed.
//
// It is applied INSIDE `getMyTurn`, so the board, the brief's counts, the badges, the browser
// notification and the CLI all stop showing a dismissed item together — the Settings-gate rule.
//
// ── 2. ONE CARD PER PR ON THE BOARD (`onePerPr`) ─────────────────────────────────────────────
//
// A PR can hold several My Turn jobs at once (a review requested of you AND a reply in your thread
// AND your own unanswered thread). The My turn tab shows ONE: the job highest in the READER'S type
// order (Settings → My Turn — the tab's own grouping), and within one type the one that has waited
// longest (the scorer's pick too: same PR, same type ⇒ same proximity and relevance, so the older
// clock scores higher and wins `compareScored`'s age tie-break). Ties beyond that break on the
// item's own id, so two reads of unchanged data keep the same card.
//
// ⚠ IT IS A BOARD RULE, NOT A NOTIFICATION RULE. `getWorkspaceInsights` asks for it; the
// account-wide `GET /api/my-turn` does not, because the browser-notification watcher diffs item
// ids — a deduplicated list would flip the winner whenever the top job cleared and announce the
// runner-up as "new". Red default branches are repo-grained and never collide with a PR.
import { and, eq, inArray } from 'drizzle-orm';
import type {
  MyTurnCardReason,
  MyTurnDismissedItem,
  MyTurnDismissTarget,
  MyTurnResponse,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { myTurnDismissals, pullRequests, repos } = schema;

/** One stored dismissal, with what the fold needs to decide whether it still applies. */
export interface StoredDismissal {
  target: MyTurnDismissTarget;
  dismissedAtMs: number;
  /** The subject's repository: the PR's repo for 'pr', the repo itself for 'repo'. */
  repoId: number;
  /** A PR subject that is no longer open — discharged unless something is still on it. */
  closed: boolean;
}

export const subjectKey = (t: MyTurnDismissTarget): string => `${t.kind}:${t.id}`;

/** Every dismissal the account holds. One indexed select plus a join for the PR's repo/state. */
export async function readMyTurnDismissals(accountId: number): Promise<StoredDismissal[]> {
  const rows = await db
    .select({
      prId: myTurnDismissals.prId,
      repoId: myTurnDismissals.repoId,
      dismissedAt: myTurnDismissals.dismissedAt,
      prRepoId: pullRequests.repoId,
      prState: pullRequests.state,
    })
    .from(myTurnDismissals)
    .leftJoin(pullRequests, eq(pullRequests.id, myTurnDismissals.prId))
    .where(eq(myTurnDismissals.accountId, accountId))
    .execute();
  const out: StoredDismissal[] = [];
  for (const r of rows) {
    if (r.prId != null && r.prRepoId != null) {
      out.push({
        target: { kind: 'pr', id: r.prId },
        dismissedAtMs: r.dismissedAt.getTime(),
        repoId: r.prRepoId,
        closed: r.prState !== 'open',
      });
    } else if (r.repoId != null) {
      out.push({
        target: { kind: 'repo', id: r.repoId },
        dismissedAtMs: r.dismissedAt.getTime(),
        repoId: r.repoId,
        closed: false,
      });
    }
  }
  return out;
}

/**
 * The dismissal's timestamp, ROUNDED UP to the whole second. SQLite stores `mode: 'timestamp'` in
 * whole seconds, so an unrounded write would land up to 999ms EARLY and an item that happened just
 * before the press would compare as "after" it and stay on screen. Rounded the same way in both
 * dialects, so the rule is one rule.
 */
export function dismissalInstant(nowMs: number): Date {
  return new Date(Math.ceil(nowMs / 1000) * 1000);
}

/**
 * Dismiss one subject. Null when the subject is not this account's — the route answers 404, so
 * the family is not an existence oracle. ⚠ The composite FK would refuse a cross-account pair
 * anyway; this read exists to answer with a 404 rather than a constraint error.
 *
 * Re-dismissing moves the timestamp forward: "and whatever arrived since, too".
 */
export async function dismissMyTurn(
  accountId: number,
  target: MyTurnDismissTarget,
  nowMs: number = Date.now(),
): Promise<Date | null> {
  const at = dismissalInstant(nowMs);
  if (target.kind === 'pr') {
    const owned = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, target.id), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute();
    if (owned[0] == null) return null;
    await db
      .insert(myTurnDismissals)
      .values({ accountId, prId: target.id, repoId: null, dismissedAt: at })
      .onConflictDoUpdate({
        target: [myTurnDismissals.accountId, myTurnDismissals.prId],
        set: { dismissedAt: at },
      })
      .execute();
    return at;
  }
  const owned = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.id, target.id), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  if (owned[0] == null) return null;
  await db
    .insert(myTurnDismissals)
    .values({ accountId, prId: null, repoId: target.id, dismissedAt: at })
    .onConflictDoUpdate({
      target: [myTurnDismissals.accountId, myTurnDismissals.repoId],
      set: { dismissedAt: at },
    })
    .execute();
  return at;
}

/** Bring a subject back. True when a dismissal existed. Scoped by account on the row itself. */
export async function restoreMyTurn(
  accountId: number,
  target: MyTurnDismissTarget,
): Promise<boolean> {
  const col = target.kind === 'pr' ? myTurnDismissals.prId : myTurnDismissals.repoId;
  const deleted = await db
    .delete(myTurnDismissals)
    .where(and(eq(myTurnDismissals.accountId, accountId), eq(col, target.id)))
    .returning({ id: myTurnDismissals.id })
    .execute();
  return deleted.length > 0;
}

/** Drop the rows the fold found nothing left for — see `MyTurnDismissalFilter.dischargeable`. */
export async function dischargeMyTurnDismissals(
  accountId: number,
  targets: readonly MyTurnDismissTarget[],
): Promise<void> {
  const prIds = targets.filter((t) => t.kind === 'pr').map((t) => t.id);
  const repoIds = targets.filter((t) => t.kind === 'repo').map((t) => t.id);
  if (prIds.length > 0) {
    await db
      .delete(myTurnDismissals)
      .where(and(eq(myTurnDismissals.accountId, accountId), inArray(myTurnDismissals.prId, prIds)))
      .execute();
  }
  if (repoIds.length > 0) {
    await db
      .delete(myTurnDismissals)
      .where(
        and(eq(myTurnDismissals.accountId, accountId), inArray(myTurnDismissals.repoId, repoIds)),
      )
      .execute();
  }
}

/** What the dismissed list needs to describe a hidden subject. */
export type DismissedDescription = Pick<
  MyTurnDismissedItem,
  'repoFullName' | 'prNumber' | 'title' | 'githubUrl'
>;

/**
 * The per-fold filter. `keep` is called once per candidate item, in any order; it records which
 * subjects the fold saw at all, which it showed and which it hid, so the three questions after the
 * fold — what is dismissed, what may be discharged — are answered off what actually happened.
 */
export class MyTurnDismissalFilter {
  private readonly byKey: Map<string, StoredDismissal>;
  private readonly orderIdx: ReadonlyMap<MyTurnCardReason, number>;
  private readonly present = new Set<string>();
  private readonly shown = new Set<string>();
  private readonly hidden = new Map<
    string,
    { reason: MyTurnCardReason; describe: () => DismissedDescription }
  >();

  constructor(rows: readonly StoredDismissal[], order: readonly MyTurnCardReason[]) {
    this.byKey = new Map(rows.map((r) => [subjectKey(r.target), r]));
    this.orderIdx = new Map(order.map((r, i) => [r, i] as const));
  }

  /** True ⇒ the item stays. `clock` is the item's own ISO clock; null ⇒ it has none, and an
   *  item with no clock cannot prove it is newer than the dismissal, so it stays hidden. */
  keep(
    target: MyTurnDismissTarget,
    clock: string | null | undefined,
    reason: MyTurnCardReason,
    describe: () => DismissedDescription,
  ): boolean {
    const key = subjectKey(target);
    this.present.add(key);
    const d = this.byKey.get(key);
    if (d == null) return true;
    const ms = clock == null ? Number.NaN : Date.parse(clock);
    if (Number.isFinite(ms) && ms > d.dismissedAtMs) {
      this.shown.add(key);
      return true;
    }
    const prev = this.hidden.get(key);
    if (prev == null || this.rank(reason) < this.rank(prev.reason)) {
      this.hidden.set(key, { reason, describe });
    }
    return false;
  }

  private rank(r: MyTurnCardReason): number {
    return this.orderIdx.get(r) ?? Number.MAX_SAFE_INTEGER;
  }

  /** Subjects wholly hidden by a live dismissal — the tab's "Dismissed" list, newest first. A
   *  subject with a newer item showing is back on the plate and is not listed. */
  dismissed(): MyTurnDismissedItem[] {
    const out: MyTurnDismissedItem[] = [];
    for (const [key, h] of this.hidden) {
      if (this.shown.has(key)) continue;
      const d = this.byKey.get(key)!;
      out.push({
        target: d.target,
        ...h.describe(),
        reason: h.reason,
        dismissedAt: new Date(d.dismissedAtMs).toISOString(),
      });
    }
    return out.sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt));
  }

  /**
   * Rows with nothing left to dismiss: the fold saw NO item on the subject. ⚠ ONLY WHERE THE FOLD
   * COULD HAVE SEEN ONE — a workspace-scoped fold has not looked at another workspace's repos, so
   * `inScope` says which subjects this read covered. A closed PR is dead wherever it lives.
   */
  dischargeable(inScope: (repoId: number) => boolean): MyTurnDismissTarget[] {
    const out: MyTurnDismissTarget[] = [];
    for (const [key, d] of this.byKey) {
      if (this.present.has(key)) continue;
      if (d.closed || inScope(d.repoId)) out.push(d.target);
    }
    return out;
  }
}

// ── ONE CARD PER PR ──────────────────────────────────────────────────────────────────────────

/** The fifteen sections of a `MyTurnResponse` — everything `onePerPr` reads and rewrites. */
export type MyTurnSections = Omit<MyTurnResponse, 'users' | 'order' | 'off' | 'configKey' | 'dismissed'>;

interface Candidate {
  prId: number;
  reason: MyTurnCardReason;
  clockMs: number;
  /** Stable tie-break — the item's own id within its section. */
  ref: string;
}

const clockMsOf = (iso: string | null | undefined): number => {
  const ms = iso == null ? Number.NaN : Date.parse(iso);
  // No clock ⇒ the oldest possible: the board's scorer dates such a card off the PR's open time,
  // which is the longest wait it has.
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

/**
 * Keep ONE item per pull request across every PR-grained section — see the header's rule 2.
 * Pure. Sections keep their own order; only losers are removed.
 */
export function onePerPr(
  mt: MyTurnSections,
  order: readonly MyTurnCardReason[],
): MyTurnSections {
  const orderIdx = new Map(order.map((r, i) => [r, i] as const));
  const rank = (r: MyTurnCardReason): number => orderIdx.get(r) ?? Number.MAX_SAFE_INTEGER;
  const better = (a: Candidate, b: Candidate): boolean =>
    rank(a.reason) - rank(b.reason) < 0 ||
    (rank(a.reason) === rank(b.reason) &&
      (a.clockMs < b.clockMs || (a.clockMs === b.clockMs && `${a.reason}:${a.ref}` < `${b.reason}:${b.ref}`)));

  const best = new Map<number, Candidate>();
  const offer = (c: Candidate): void => {
    const cur = best.get(c.prId);
    if (cur == null || better(c, cur)) best.set(c.prId, c);
  };
  const winnerIs = (c: Candidate): boolean => {
    const w = best.get(c.prId)!;
    return w.reason === c.reason && w.ref === c.ref;
  };

  // Each section, described once: its reason, and how to read an item's PR, clock and id.
  const pr = <T extends { prId: number; since?: string }>(reason: MyTurnCardReason) => ({
    of: (i: T): Candidate => ({ prId: i.prId, reason, clockMs: clockMsOf(i.since), ref: `${i.prId}` }),
  });
  const S = {
    awaitingReview: pr<MyTurnSections['awaitingReview'][number]>('review_request'),
    mentions: pr<MyTurnSections['mentions'][number]>('mention'),
    commentReplies: pr<MyTurnSections['commentReplies'][number]>('comment_reply'),
    pushedSince: pr<MyTurnSections['pushedSince'][number]>('pushed_since'),
    ownCiRed: pr<MyTurnSections['ownCiRed'][number]>('own_ci_red'),
    ownConflicts: pr<MyTurnSections['ownConflicts'][number]>('own_conflicts'),
    approvedPrs: pr<MyTurnSections['approvedPrs'][number]>('pr_approved'),
    ownReady: pr<MyTurnSections['ownReady'][number]>('own_ready'),
    yourPrs: pr<MyTurnSections['yourPrs'][number]>('your_pr'),
    watchedRepoPrs: pr<MyTurnSections['watchedRepoPrs'][number]>('watched_repo_pr'),
  };
  const thread = (reason: MyTurnCardReason) => ({
    of: (i: MyTurnSections['threadsAwaiting'][number]): Candidate => ({
      prId: i.prId,
      reason,
      clockMs: clockMsOf(i.lastReplyAt),
      ref: `${i.threadId}`,
    }),
  });
  const threadsAwaiting = thread('thread');
  const threadReplies = thread('thread_reply');
  const ownThreads = {
    of: (i: MyTurnSections['ownThreads'][number]): Candidate => ({
      prId: i.prId,
      reason: 'own_thread',
      clockMs: clockMsOf(i.since),
      ref: `${i.threadId}`,
    }),
  };
  const claude = {
    of: (i: MyTurnSections['claudeReviewsToAction'][number]): Candidate => ({
      prId: i.prId,
      reason: 'claude_review',
      clockMs: clockMsOf(i.finishedAt),
      ref: `${i.reviewId}`,
    }),
  };

  for (const i of mt.awaitingReview) offer(S.awaitingReview.of(i));
  for (const i of mt.mentions) offer(S.mentions.of(i));
  for (const i of mt.commentReplies) offer(S.commentReplies.of(i));
  for (const i of mt.pushedSince) offer(S.pushedSince.of(i));
  for (const i of mt.ownCiRed) offer(S.ownCiRed.of(i));
  for (const i of mt.ownConflicts) offer(S.ownConflicts.of(i));
  for (const i of mt.approvedPrs) offer(S.approvedPrs.of(i));
  for (const i of mt.ownReady) offer(S.ownReady.of(i));
  for (const i of mt.yourPrs) offer(S.yourPrs.of(i));
  for (const i of mt.watchedRepoPrs) offer(S.watchedRepoPrs.of(i));
  for (const i of mt.threadsAwaiting) offer(threadsAwaiting.of(i));
  for (const i of mt.threadReplies) offer(threadReplies.of(i));
  for (const i of mt.ownThreads) offer(ownThreads.of(i));
  for (const i of mt.claudeReviewsToAction) offer(claude.of(i));

  return {
    awaitingReview: mt.awaitingReview.filter((i) => winnerIs(S.awaitingReview.of(i))),
    mentions: mt.mentions.filter((i) => winnerIs(S.mentions.of(i))),
    commentReplies: mt.commentReplies.filter((i) => winnerIs(S.commentReplies.of(i))),
    pushedSince: mt.pushedSince.filter((i) => winnerIs(S.pushedSince.of(i))),
    ownCiRed: mt.ownCiRed.filter((i) => winnerIs(S.ownCiRed.of(i))),
    ownConflicts: mt.ownConflicts.filter((i) => winnerIs(S.ownConflicts.of(i))),
    approvedPrs: mt.approvedPrs.filter((i) => winnerIs(S.approvedPrs.of(i))),
    ownReady: mt.ownReady.filter((i) => winnerIs(S.ownReady.of(i))),
    yourPrs: mt.yourPrs.filter((i) => winnerIs(S.yourPrs.of(i))),
    watchedRepoPrs: mt.watchedRepoPrs.filter((i) => winnerIs(S.watchedRepoPrs.of(i))),
    threadsAwaiting: mt.threadsAwaiting.filter((i) => winnerIs(threadsAwaiting.of(i))),
    threadReplies: mt.threadReplies.filter((i) => winnerIs(threadReplies.of(i))),
    ownThreads: mt.ownThreads.filter((i) => winnerIs(ownThreads.of(i))),
    claudeReviewsToAction: mt.claudeReviewsToAction.filter((i) => winnerIs(claude.of(i))),
    // Repo-grained: a branch is not a pull request, and never shares a key with one.
    redTrunks: mt.redTrunks,
  };
}
