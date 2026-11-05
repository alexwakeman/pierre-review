import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type {
  ClaudeFollowUpItemRecord,
  ClaudeReviewFollowUpRecord,
  ClaudeThreadAddressed,
  ClaudeThreadAssessment,
  ClaudeThreadFindingOutcome,
  ClaudeThreadJudgement,
  ClaudeThreadJudgementsForPr,
  ClaudeThreadValidity,
  AiProviderId,
} from '@pierre-review/shared';
import {
  aiRunProvider,
  isStillOpenFollowUp,
  isStillOpenThread,
  limnFindingPost,
  parseStillOpenMarker,
  stillOpenReasonOf,
  continuationThreadMap,
  threadAssessmentCounts,
  type ClaudeStillOpenBy,
  type ClaudeThreadStillOpen,
  type TeammateReviewRecord,
} from '@pierre-review/shared';
import type { ClaudeThreadAssessmentCounts } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// What the latest Claude review said about each review thread, for the THREAD CARDS
// (`POST /api/claude-review/thread-judgements`). DB-only, account-scoped, ONE batched read for every
// PR on screen — a thread card never fetches on its own.
//
// Threads rooted on Claude's OWN posted findings are not thread judgements (the follow-up owns
// them); each carries the newest follow-up's outcome instead (`findingJudgementsFromFollowUps`).
//
// "Latest" = the newest SUCCEEDED, non-skip run that assessed threads (`thread_assessments` not
// null), with any later Check threads run folded over it (`currentThreadAssessmentsForPrs`). A newer
// run still in flight, failed or skipped judged nothing, so the previous judgements stand until a
// run replaces them.

/* eslint-disable @typescript-eslint/no-explicit-any */

const iso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : new Date(d as string | number).toISOString();

/**
 * Trim a stored assessment to what a thread card needs. A thread Claude did not judge at all
 * (both fields `not_checked`: over the cap, or not reported) is DROPPED — the card must keep its
 * own pills rather than wear a Claude marker that says nothing.
 */
export function judgementsFromAssessments(
  assessments: readonly ClaudeThreadAssessment[],
): ClaudeThreadJudgement[] {
  const out: ClaudeThreadJudgement[] = [];
  const seen = new Set<number>();
  for (const a of assessments) {
    if (a == null || typeof a.threadId !== 'number' || seen.has(a.threadId)) continue;
    if (a.validity === 'not_checked' && a.addressed === 'not_checked') continue;
    seen.add(a.threadId);
    out.push({
      threadId: a.threadId,
      validity: a.validity,
      addressed: a.addressed,
      explanation: a.explanation ?? null,
      reason: a.reason ?? null,
      resolved: a.resolved === true,
      assessedAtHead: a.assessedAtHead,
      carried: a.carried === true,
    });
  }
  return out;
}

/**
 * Fold a later Check threads run over a review's assessments: per thread, the OVERLAY wins (it is
 * newer); threads only the base knows keep their base judgement. Order: the overlay's, then the
 * base's leftovers. Pure (exported for the test).
 */
export function overlayThreadAssessments(
  base: readonly ClaudeThreadAssessment[] | null,
  overlay: readonly ClaudeThreadAssessment[] | null,
): ClaudeThreadAssessment[] | null {
  if (!overlay) return base ? [...base] : null;
  if (!base) return [...overlay];
  const seen = new Set<number>();
  const out: ClaudeThreadAssessment[] = [];
  for (const a of overlay) {
    if (a == null || typeof a.threadId !== 'number' || seen.has(a.threadId)) continue;
    seen.add(a.threadId);
    out.push(a);
  }
  for (const a of base) {
    if (a == null || typeof a.threadId !== 'number' || seen.has(a.threadId)) continue;
    seen.add(a.threadId);
    out.push(a);
  }
  return out;
}

/** The thread judgements of one PR as they stand now (see `currentThreadAssessmentsForPrs`). */
export interface CurrentThreadAssessments {
  prId: number;
  reviewId: number | null;
  reviewHeadSha: string | null;
  reviewFinishedAt: Date | null;
  checkId: number | null;
  checkHeadSha: string | null;
  checkFinishedAt: Date | null;
  assessments: ClaudeThreadAssessment[];
  /**
   * Who made each thread's judgement as it stands (Phase 4): the Check threads run's provider for a
   * thread the overlay judged, else the review's. Mixed providers fold like any two runs — the newer
   * wins — and each judgement keeps the label of the run that made it.
   */
  providerByThread: Map<number, AiProviderId>;
  /**
   * When each thread's judgement as it stands was made: the Check threads run's completion for a
   * thread the overlay judged, else the review's finish. The team fold (team-view.ts) dates a
   * teammate finding's "found it addressed" by it — a check newer than the review settles a teammate
   * finding posted after that review.
   */
  judgedAtByThread: Map<number, Date | null>;
}

/**
 * The prior judgements a NEW run on `provider` may carry or lock (`planThreadReview`): only those
 * the SAME provider made. A run on the other provider judges every thread afresh, so its verdicts
 * are its own — never the other provider's copied under its label (the in-situ comparison).
 * Pure (exported for the test).
 */
export function priorAssessmentsForProvider(
  current: Pick<CurrentThreadAssessments, 'assessments' | 'providerByThread'> | null | undefined,
  provider: AiProviderId,
): ClaudeThreadAssessment[] | null {
  if (!current) return null;
  return current.assessments.filter(
    (a) => a != null && typeof a.threadId === 'number' && current.providerByThread.get(a.threadId) === provider,
  );
}

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : d == null ? 0 : new Date(d as string | number).getTime();

/**
 * THE ONE FOLD of "what Claude says about each thread now": the latest SUCCEEDED, non-skip Claude
 * review that judged threads, with the newest succeeded Check threads run that STARTED after it finished
 * folded over it (per thread, the newer wins). A PR with only a check reads as the check alone.
 * Readers: the thread cards (`getThreadJudgements`), the Claude Review tab, the next review's carry
 * (manager.ts), the next check's plan and AI Fix's review seed. DB-only, account-scoped, batched.
 * `beforeReviewId`: only reviews older than it (a running review reading its own prior).
 */
export async function currentThreadAssessmentsForPrs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
  opts: { beforeReviewId?: number } = {},
): Promise<Map<number, CurrentThreadAssessments>> {
  const out = new Map<number, CurrentThreadAssessments>();
  if (prIds.length === 0) return out;
  const s = ctx.schema as any;
  const cr = s.claudeReviews;
  const ct = s.claudeThreadChecks;
  const ids = [...new Set(prIds)];

  // Reviews — ids first, the JSON for the winners alone.
  const idRows = (await ctx.db
    .select({ id: cr.id, prId: cr.prId })
    .from(cr)
    .where(
      and(
        inArray(cr.prId, ids),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        isNotNull(cr.threadAssessments),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
        ...(opts.beforeReviewId != null ? [lt(cr.id, opts.beforeReviewId)] : []),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{ id: number; prId: number }>;
  const latestReview = new Map<number, number>();
  for (const r of idRows) if (!latestReview.has(r.prId)) latestReview.set(r.prId, r.id);
  const reviews = new Map<
    number,
    {
      id: number;
      headSha: string;
      finishedAt: Date | null;
      threadAssessments: ClaudeThreadAssessment[] | null;
      provider: string | null;
      model: string;
    }
  >();
  if (latestReview.size > 0) {
    const rows = (await ctx.db
      .select({
        id: cr.id,
        prId: cr.prId,
        headSha: cr.headSha,
        finishedAt: cr.finishedAt,
        threadAssessments: cr.threadAssessments,
        provider: cr.provider,
        model: cr.model,
      })
      .from(cr)
      .where(and(inArray(cr.id, [...latestReview.values()]), eq(cr.accountId, accountId)))
      .execute()) as Array<{
      id: number;
      prId: number;
      headSha: string;
      finishedAt: Date | null;
      threadAssessments: ClaudeThreadAssessment[] | null;
      provider: string | null;
      model: string;
    }>;
    for (const r of rows) reviews.set(r.prId, r);
  }

  // Checks — the newest succeeded one per PR that STARTED after that PR's review finished. A check
  // stores its WHOLE reconciled set (carried items included), planned against the fold as it stood
  // when it started; one that started before the review finished was planned against an older review
  // and would overwrite that review's fresh judgements with stale carried ones, so it never applies.
  const checkIds = (await ctx.db
    .select({ id: ct.id, prId: ct.prId, startedAt: ct.startedAt, createdAt: ct.createdAt })
    .from(ct)
    .where(
      and(
        inArray(ct.prId, ids),
        eq(ct.accountId, accountId),
        eq(ct.status, 'succeeded'),
        isNotNull(ct.threadAssessments),
      ),
    )
    .orderBy(desc(ct.id))
    .execute()) as Array<{ id: number; prId: number; startedAt: Date | null; createdAt: Date | null }>;
  const latestCheck = new Map<number, number>();
  for (const c of checkIds) {
    if (latestCheck.has(c.prId)) continue;
    const rv = reviews.get(c.prId);
    if (rv && ms(c.startedAt ?? c.createdAt) <= ms(rv.finishedAt)) {
      latestCheck.set(c.prId, -1); // planned before the review finished: none applies (older ones started earlier still)
      continue;
    }
    latestCheck.set(c.prId, c.id);
  }
  const wanted = [...latestCheck.values()].filter((id) => id > 0);
  const checks = new Map<
    number,
    {
      id: number;
      headSha: string;
      completedAt: Date | null;
      threadAssessments: ClaudeThreadAssessment[] | null;
      provider: string | null;
      model: string;
    }
  >();
  if (wanted.length > 0) {
    const rows = (await ctx.db
      .select({
        id: ct.id,
        prId: ct.prId,
        headSha: ct.headSha,
        completedAt: ct.completedAt,
        threadAssessments: ct.threadAssessments,
        provider: ct.provider,
        model: ct.model,
      })
      .from(ct)
      .where(and(inArray(ct.id, wanted), eq(ct.accountId, accountId)))
      .execute()) as Array<{
      id: number;
      prId: number;
      headSha: string;
      completedAt: Date | null;
      threadAssessments: ClaudeThreadAssessment[] | null;
      provider: string | null;
      model: string;
    }>;
    for (const r of rows) checks.set(r.prId, r);
  }

  for (const prId of ids) {
    const rv = reviews.get(prId);
    const ck = checks.get(prId);
    const base = rv && Array.isArray(rv.threadAssessments) ? rv.threadAssessments : null;
    const over = ck && Array.isArray(ck.threadAssessments) ? ck.threadAssessments : null;
    const merged = overlayThreadAssessments(base, over);
    if (!merged) continue;
    // Each thread is labelled by the run whose judgement won the fold (the overlay's, else the base's).
    const providerByThread = new Map<number, AiProviderId>();
    const judgedAtByThread = new Map<number, Date | null>();
    if (rv && base) {
      const p = aiRunProvider(rv.provider, rv.model);
      for (const a of base)
        if (a != null && typeof a.threadId === 'number') {
          providerByThread.set(a.threadId, p);
          judgedAtByThread.set(a.threadId, rv.finishedAt ?? null);
        }
    }
    if (ck && over) {
      const p = aiRunProvider(ck.provider, ck.model);
      for (const a of over)
        if (a != null && typeof a.threadId === 'number') {
          providerByThread.set(a.threadId, p);
          judgedAtByThread.set(a.threadId, ck.completedAt ?? null);
        }
    }
    out.set(prId, {
      prId,
      reviewId: rv?.id ?? null,
      reviewHeadSha: rv?.headSha ?? null,
      reviewFinishedAt: rv?.finishedAt ?? null,
      checkId: over ? ck!.id : null,
      checkHeadSha: over ? ck!.headSha : null,
      checkFinishedAt: over ? ck!.completedAt : null,
      assessments: merged,
      providerByThread,
      judgedAtByThread,
    });
  }
  return out;
}

// ---- LIMN FINDINGS ARE NOT REVIEW THREADS (docs/CLAUDE-REVIEW.md § Limn findings are not review threads) ----
// A thread whose ROOT comment is a Limn finding — the reader's own post or a teammate's Limn — is a
// FINDING: the Findings list shows it (the reader's own through the follow-up, a teammate's through
// the team fold, team-view.ts). Listing it again under "Review threads" said the same point twice.
// The reader's own are never judged (db/review-threads-for-review.ts leaves them out); a teammate's
// ARE still judged — the team fold settles the teammate finding from that judgement — but the
// DISPLAYED threads list and its counts leave them out (`shownThreadAssessments`).

/**
 * Per PR, the review threads whose ROOT comment (oldest, then lowest id — the loader's order) is a
 * Limn finding: stored under a `limn:` bot (`limn_posted_by_user_id` set at sync, db/limn-bots.ts),
 * or — a poster sync could not attribute — its body passes the shared `limnFindingPost` with
 * `threadRoot`. Account-scoped, DB-only, one read for every PR.
 */
export async function limnFindingThreadIdsForPrs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (prIds.length === 0) return out;
  const s = ctx.schema as any;
  const rc = s.reviewComments;
  const prs = s.pullRequests;
  const rows = (await ctx.db
    .select({
      id: rc.id,
      prId: rc.prId,
      threadId: rc.threadId,
      createdAt: rc.createdAt,
      body: rc.body,
      limnPostedBy: rc.limnPostedByUserId,
    })
    .from(rc)
    .innerJoin(prs, eq(prs.id, rc.prId))
    .where(and(inArray(rc.prId, [...new Set(prIds)]), eq(prs.accountId, accountId), isNotNull(rc.threadId)))
    .execute()) as Array<{
    id: number;
    prId: number;
    threadId: number | null;
    createdAt: Date | null;
    body: string | null;
    limnPostedBy: number | null;
  }>;
  const roots = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.threadId == null) continue;
    const cur = roots.get(r.threadId);
    if (!cur || ms(r.createdAt) < ms(cur.createdAt) || (ms(r.createdAt) === ms(cur.createdAt) && r.id < cur.id))
      roots.set(r.threadId, r);
  }
  for (const [threadId, root] of roots) {
    if (root.limnPostedBy == null && limnFindingPost(root.body, { threadRoot: true }) == null) continue;
    const set = out.get(root.prId) ?? new Set<number>();
    set.add(threadId);
    out.set(root.prId, set);
  }
  return out;
}

/** The DISPLAYED threads: every assessment except a Limn finding's thread. Pure. */
export function shownThreadAssessments<T extends { threadId: number }>(
  items: readonly T[],
  limnFindingThreads: ReadonlySet<number> | undefined,
): T[] {
  if (!limnFindingThreads || limnFindingThreads.size === 0) return [...items];
  return items.filter((a) => a == null || !limnFindingThreads.has(a.threadId));
}

/** `shownThreadAssessments` + its counts, for a wire field pair (null stays null). Pure. */
export function shownThreadsWire(
  items: readonly ClaudeThreadAssessment[] | null | undefined,
  limnFindingThreads: ReadonlySet<number> | undefined,
): { items: ClaudeThreadAssessment[] | null; counts: ClaudeThreadAssessmentCounts | null } {
  if (!Array.isArray(items)) return { items: null, counts: null };
  const shown = shownThreadAssessments(items, limnFindingThreads);
  return { items: shown, counts: threadAssessmentCounts(shown) };
}

/**
 * The judgements the TEAM FOLD reads (team-view.ts `threadJudgements`) — EVERY judged thread,
 * Limn finding threads included, each dated by the run that made it and naming the review it stands
 * on. Pure.
 */
export function teamThreadJudgements(
  current: Pick<CurrentThreadAssessments, 'assessments' | 'judgedAtByThread' | 'reviewId'> | null | undefined,
): Array<{ threadId: number; addressed: ClaudeThreadAddressed; at?: number; reviewId?: number }> | null {
  if (!current) return null;
  return current.assessments
    .filter((a) => a != null && typeof a.threadId === 'number')
    .map((a) => {
      const at = current.judgedAtByThread.get(a.threadId);
      return {
        threadId: a.threadId,
        addressed: a.addressed,
        ...(at != null ? { at: ms(at) } : {}),
        ...(current.reviewId != null ? { reviewId: current.reviewId } : {}),
      };
    });
}

/**
 * The AI Review tab's threads, as `GET /api/prs/:id/claude-review` serves them: the Limn finding
 * threads, the current judgements DISPLAYED (Limn finding threads left out, with their counts) and
 * the judgements the TEAM FOLD reads (all of them, dated). DB-only, account-scoped.
 */
export async function tabThreadView(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{
  limnFindingThreads: Set<number>;
  shown: { items: ClaudeThreadAssessment[] | null; counts: ClaudeThreadAssessmentCounts | null };
  team: ReturnType<typeof teamThreadJudgements>;
}> {
  const [limn, current] = await Promise.all([
    limnFindingThreadIdsForPrs(ctx, accountId, [prId]),
    currentThreadAssessmentsForPrs(ctx, accountId, [prId]),
  ]);
  const limnFindingThreads = limn.get(prId) ?? new Set<number>();
  const rec = current.get(prId) ?? null;
  return {
    limnFindingThreads,
    shown: shownThreadsWire(rec?.assessments ?? null, limnFindingThreads),
    team: teamThreadJudgements(rec),
  };
}

/** The two generic fields a finding's outcome MIRRORS (for readers that know only them). Pure. */
export function findingMirror(
  o: Pick<ClaudeThreadFindingOutcome, 'status' | 'acceptKind'>,
): { validity: ClaudeThreadValidity; addressed: ClaudeThreadAddressed } {
  switch (o.status) {
    case 'addressed':
    case 'no_longer_applies':
      return { validity: 'not_checked', addressed: 'addressed' };
    case 'partly_addressed':
      return { validity: 'not_checked', addressed: 'partly_addressed' };
    case 'not_addressed':
    case 'reply_disputed':
      return { validity: 'not_checked', addressed: 'not_addressed' };
    case 'reply_accepted':
      return o.acceptKind === 'deferred'
        ? { validity: 'valid', addressed: 'not_addressed' }
        : { validity: 'not_valid', addressed: 'not_checked' };
  }
}

/**
 * CLAUDE'S OWN FINDINGS ON THEIR THREADS. A thread rooted on one of Limn's posted findings is never
 * a thread judgement (the follow-up owns it), so without this its card showed only GitHub's state —
 * "Resolved" — and nothing of what the later reviews found. Per thread (`item.threadId`, stamped at
 * run time), the NEWEST review's follow-up item that judged it (`not_checked` skipped: it never made
 * a claim). A settled finding leaves later follow-ups, so the newest item naming it is its last word.
 * `reviews` NEWEST FIRST. Pure (exported for the test).
 */
export function findingJudgementsFromFollowUps(
  reviews: ReadonlyArray<{
    id: number;
    headSha: string;
    followUp: ClaudeReviewFollowUpRecord | null;
    provider?: string | null;
    model?: string | null;
  }>,
): Map<number, ClaudeThreadJudgement> {
  const out = new Map<number, ClaudeThreadJudgement>();
  for (const r of reviews) {
    const items: ClaudeFollowUpItemRecord[] = Array.isArray(r.followUp?.items) ? r.followUp!.items : [];
    for (const it of items) {
      const threadId = it?.threadId;
      if (typeof threadId !== 'number' || out.has(threadId)) continue;
      if (it.status === 'not_checked' || it.status == null) continue;
      const finding: ClaudeThreadFindingOutcome = {
        status: it.status,
        acceptKind: it.status === 'reply_accepted' ? (it.acceptKind ?? null) : null,
        replyAuthor:
          it.status === 'reply_accepted' || it.status === 'reply_disputed' ? (it.reply?.author ?? null) : null,
        reviewId: r.id,
      };
      out.set(threadId, {
        threadId,
        ...findingMirror(finding),
        explanation: it.explanation ?? null,
        reason: null,
        // Read the thread's CURRENT resolved state from the thread itself.
        resolved: false,
        assessedAtHead: r.headSha,
        carried: it.statusCarried === true,
        finding,
        // The review whose follow-up made this judgement — never the reader's active provider.
        provider: aiRunProvider(r.provider, r.model),
      });
    }
  }
  return out;
}

/** Every succeeded review's follow-up record per PR, newest first (account-scoped, DB-only). */
async function followUpsForPrs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<
  Map<number, Array<{ id: number; headSha: string; finishedAt: Date | null; followUp: ClaudeReviewFollowUpRecord | null; provider: string | null; model: string | null }>>
> {
  const out = new Map<
    number,
    Array<{ id: number; headSha: string; finishedAt: Date | null; followUp: ClaudeReviewFollowUpRecord | null; provider: string | null; model: string | null }>
  >();
  if (prIds.length === 0) return out;
  const cr = (ctx.schema as any).claudeReviews;
  const rows = (await ctx.db
    .select({
      id: cr.id,
      prId: cr.prId,
      headSha: cr.headSha,
      finishedAt: cr.finishedAt,
      followUp: cr.followUp,
      provider: cr.provider,
      model: cr.model,
    })
    .from(cr)
    .where(
      and(
        inArray(cr.prId, [...new Set(prIds)]),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        isNotNull(cr.followUp),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{
    id: number;
    prId: number;
    headSha: string;
    finishedAt: Date | null;
    followUp: ClaudeReviewFollowUpRecord | null;
    provider: string | null;
    model: string | null;
  }>;
  for (const r of rows) {
    const list = out.get(r.prId) ?? [];
    list.push(r);
    out.set(r.prId, list);
  }
  return out;
}

// ── STILL-OPEN POINTS ON THE THREAD CARDS (docs/CLAUDE-REVIEW.md § Still-open points) ──────────────
// Each judged thread says whether a Limn holds its point open now: the reader's own newest judgement
// (a thread judgement that holds up and is not addressed, or a follow-up item on a Limn finding still
// open), or a TEAMMATE'S Limn's posted one (`j=` `o`, imported as `TeammateReviewRecord.judged`). The
// NEWER of the two decides; a teammate's later "addressed" lifts the reader's older still-open, and the
// reverse. A thread only a teammate's Limn judged is listed on its own (`teammateOnly`). The reason of
// a teammate's still-open is its Limn's "Still open:" reply on that thread (the newest), else none.

/** One word about a thread's point: open or not, when, and by whom. */
export interface StillOpenWord {
  open: boolean;
  at: number; // ms
  by: ClaudeStillOpenBy;
  reason: string | null;
  severity: ClaudeThreadStillOpen['severity'];
  headSha: string | null;
}

/** The newer word wins (ties: the reader's own). Pure. */
export function newerStillOpenWord(own: StillOpenWord | undefined, mate: StillOpenWord | undefined): StillOpenWord | undefined {
  if (own == null) return mate;
  if (mate == null) return own;
  return mate.at > own.at ? mate : own;
}

const firstSentenceOf = (t: string | null | undefined): string | null => {
  const one = (t ?? '').replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  const m = /^(.+?[.!?])(?=\s|$)/.exec(one);
  const s = (m?.[1] ?? one).trim();
  return s.length > 200 ? `${s.slice(0, 199).trimEnd()}…` : s;
};

const sevOf = (s: string | null | undefined): ClaudeThreadStillOpen['severity'] =>
  s === 'blocker' || s === 'warning' || s === 'nit' || s === 'question' ? s : null;

/**
 * Per PR, per thread, the NEWEST teammate Limn's word on it (every imported teammate review's `j=`
 * entry, matched to the thread by its root comment's databaseId), with the reason from that Limn's
 * "Still open:" reply. Account-scoped, DB-only, batched.
 */
export async function teammateStillOpenWordsForPrs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, Map<number, StillOpenWord>>> {
  const out = new Map<number, Map<number, StillOpenWord>>();
  if (prIds.length === 0) return out;
  const s = ctx.schema as any;
  const cr = s.claudeReviews;
  const users = s.users;
  const rc = s.reviewComments;
  const mates = (await ctx.db
    .select({
      prId: cr.prId,
      id: cr.id,
      headSha: cr.headSha,
      postedAt: cr.postedAt,
      teammate: cr.teammate,
      userId: cr.sourceUserId,
      login: users.githubLogin,
      name: users.displayName,
    })
    .from(cr)
    .leftJoin(users, eq(users.id, cr.sourceUserId))
    .where(and(inArray(cr.prId, [...new Set(prIds)]), eq(cr.accountId, accountId), eq(cr.kind, 'teammate')))
    .execute()) as Array<{
    prId: number;
    id: number;
    headSha: string;
    postedAt: Date | null;
    teammate: TeammateReviewRecord | null;
    userId: number | null;
    login: string | null;
    name: string | null;
  }>;
  const withJudged = mates.filter((m) => (m.teammate?.judged ?? []).length > 0 && m.login != null);
  if (withJudged.length === 0) return out;
  const comments = (await ctx.db
    .select({
      id: rc.id,
      prId: rc.prId,
      threadId: rc.threadId,
      databaseId: rc.databaseId,
      body: rc.body,
      createdAt: rc.createdAt,
      poster: rc.limnPostedByUserId,
      authorId: rc.authorId,
    })
    .from(rc)
    .where(inArray(rc.prId, [...new Set(withJudged.map((m) => m.prId))]))
    .execute()) as Array<{
    id: number;
    prId: number;
    threadId: number | null;
    databaseId: string | null;
    body: string | null;
    createdAt: Date | null;
    poster: number | null;
    authorId: number | null;
  }>;
  const threadOfComment = new Map<string, number>(); // `${prId}:${databaseId}` → thread
  const byThread = new Map<number, typeof comments>();
  for (const c of comments.sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id - b.id)) {
    if (c.threadId == null) continue;
    if (c.databaseId != null) threadOfComment.set(`${c.prId}:${c.databaseId}`, c.threadId);
    const list = byThread.get(c.threadId) ?? [];
    list.push(c);
    byThread.set(c.threadId, list);
  }
  // Oldest first, so a newer teammate review's word replaces an older one.
  for (const m of withJudged.sort((a, b) => ms(a.postedAt) - ms(b.postedAt) || a.id - b.id)) {
    const at = ms(m.postedAt);
    const by: ClaudeStillOpenBy = { you: false, login: m.login!, name: m.name ?? null };
    for (const j of m.teammate?.judged ?? []) {
      const threadId = threadOfComment.get(`${m.prId}:${j.commentId}`);
      if (threadId == null) continue;
      const list = byThread.get(threadId) ?? [];
      // Only the thread's ROOT is what a judgement names.
      if (list[0]?.databaseId !== j.commentId) continue;
      const open = j.outcome === 'still_open';
      // That Limn's newest "Still open:" reply on the thread, at or before its post.
      const reply = open
        ? [...list]
            .reverse()
            .find(
              (c) =>
                parseStillOpenMarker(c.body) != null &&
                (c.poster ?? c.authorId) === m.userId &&
                ms(c.createdAt) <= at + 10 * 60_000,
            )
        : undefined;
      const rootPost = limnFindingPost(list[0]?.body, { threadRoot: true });
      const map = out.get(m.prId) ?? new Map<number, StillOpenWord>();
      map.set(threadId, {
        open,
        at,
        by,
        reason: reply != null ? stillOpenReasonOf(reply.body) || null : null,
        severity: rootPost != null && !rootPost.stillOpen ? sevOf(rootPost.severity) : null,
        headSha: m.headSha ?? null,
      });
      out.set(m.prId, map);
    }
  }
  return out;
}

export async function getThreadJudgements(
  ctx: AgentContext,
  prIds: readonly number[],
  accountId: number,
): Promise<ClaudeThreadJudgementsForPr[]> {
  if (prIds.length === 0) return [];
  const [current, followUps, mateWords] = await Promise.all([
    currentThreadAssessmentsForPrs(ctx, accountId, prIds),
    followUpsForPrs(ctx, accountId, prIds),
    teammateStillOpenWordsForPrs(ctx, accountId, prIds),
  ]);
  const findings = new Map<number, Map<number, ClaudeThreadJudgement>>();
  for (const [prId, list] of followUps) {
    const m = findingJudgementsFromFollowUps(list);
    if (m.size > 0) findings.set(prId, m);
  }
  const wanted = [...new Set([...current.keys(), ...findings.keys(), ...[...mateWords].filter(([, m]) => [...m.values()].some((w) => w.open)).map(([id]) => id)])];
  if (wanted.length === 0) return [];
  const s = ctx.schema as any;
  const prs = s.pullRequests;
  const heads = (await ctx.db
    .select({ id: prs.id, headSha: prs.headSha })
    .from(prs)
    .where(and(inArray(prs.id, wanted), eq(prs.accountId, accountId)))
    .execute()) as Array<{ id: number; headSha: string | null }>;
  const headOf = new Map(heads.map((h) => [h.id, h.headSha]));
  const out: ClaudeThreadJudgementsForPr[] = [];
  for (const prId of wanted) {
    if (!headOf.has(prId)) continue;
    const c = current.get(prId);
    const judgements = c
      ? judgementsFromAssessments(c.assessments).map((j) => {
          const provider = c.providerByThread.get(j.threadId);
          return provider ? { ...j, provider } : j;
        })
      : [];
    // An ordinary thread judgement wins on a thread both somehow name (the two sets are disjoint).
    const judged = new Set(judgements.map((j) => j.threadId));
    for (const j of findings.get(prId)?.values() ?? []) if (!judged.has(j.threadId)) judgements.push(j);
    // STILL OPEN: the reader's own word per thread, then the newer of it and a teammate's.
    const ownWords = new Map<number, StillOpenWord>();
    const finishedOf = new Map((followUps.get(prId) ?? []).map((r) => [r.id, ms(r.finishedAt)]));
    for (const j of judgements) {
      if (j.finding != null) {
        ownWords.set(j.threadId, {
          open: isStillOpenFollowUp(j.finding.status),
          at: finishedOf.get(j.finding.reviewId) ?? 0,
          by: { you: true },
          reason: firstSentenceOf(j.explanation),
          severity: null,
          headSha: j.assessedAtHead,
        });
      } else {
        ownWords.set(j.threadId, {
          open: isStillOpenThread(j),
          at: ms(c?.judgedAtByThread.get(j.threadId) ?? null),
          by: { you: true },
          reason: (j.reason ?? '').trim() || firstSentenceOf(j.explanation),
          severity: null,
          headSha: j.assessedAtHead,
        });
      }
    }
    const mates = mateWords.get(prId);
    const words = new Map<number, StillOpenWord>();
    for (const id of new Set([...ownWords.keys(), ...(mates?.keys() ?? [])])) {
      const w = newerStillOpenWord(ownWords.get(id), mates?.get(id));
      if (w?.open) words.set(id, w);
    }
    // GAP 8: a point held open on a thread that a newer thread CONTINUES (shared
    // `continuationThreadMap`) is shown on the continuation — where the author can act — unless the
    // continuation has a newer word of its own. The earlier thread then shows none.
    const moved = new Set<number>();
    if (words.size > 0) {
      const rcs = s.reviewComments;
      const cms = (await ctx.db
        .select({ id: rcs.id, threadId: rcs.threadId, databaseId: rcs.databaseId, body: rcs.body, createdAt: rcs.createdAt })
        .from(rcs)
        .where(eq(rcs.prId, prId))
        .execute()) as Array<{ id: number; threadId: number | null; databaseId: string | null; body: string | null; createdAt: Date | null }>;
      const cont = continuationThreadMap(cms.map((x) => ({ ...x, createdAt: ms(x.createdAt) })));
      for (const [from, w] of [...words]) {
        const to = cont.get(from);
        if (to == null) continue;
        words.delete(from);
        const there = newerStillOpenWord(ownWords.get(to), mates?.get(to));
        const best = there == null || there.at < w.at ? w : there;
        if (best.open) words.set(to, best);
        else words.delete(to);
        if (best === w && !judgements.some((j) => j.threadId === to)) {
          const base = judgements.find((j) => j.threadId === from);
          if (base != null) {
            judgements.push({ ...base, threadId: to });
            moved.add(to);
          }
        }
      }
    }
    if (words.size > 0) {
      const rt = s.reviewThreads;
      const rows = (await ctx.db
        .select({ id: rt.id, path: rt.path, line: rt.line, isResolved: rt.isResolved })
        .from(rt)
        .where(and(eq(rt.prId, prId), inArray(rt.id, [...words.keys()])))
        .execute()) as Array<{ id: number; path: string; line: number | null; isResolved: boolean }>;
      const threadRow = new Map(rows.map((r) => [r.id, r]));
      for (const [threadId, w] of words) {
        const t = threadRow.get(threadId);
        if (t == null) continue;
        const stillOpen: ClaudeThreadStillOpen = {
          by: w.by,
          reason: w.reason,
          at: w.at > 0 ? new Date(w.at).toISOString() : null,
          headSha: w.headSha ?? '',
          severity: w.severity,
          path: t.path,
          line: t.line,
          threadResolved: t.isResolved,
        };
        const i = judgements.findIndex((j) => j.threadId === threadId);
        if (i >= 0) judgements[i] = { ...judgements[i]!, ...(moved.has(threadId) ? { resolved: t.isResolved } : {}), stillOpen };
        else
          judgements.push({
            threadId,
            validity: 'valid',
            addressed: 'not_addressed',
            explanation: null,
            reason: w.reason,
            resolved: t.isResolved,
            assessedAtHead: w.headSha ?? '',
            carried: false,
            stillOpen,
            teammateOnly: true,
          });
      }
    }
    if (c) {
      const fromCheck = c.checkId != null;
      out.push({
        prId,
        reviewId: c.reviewId,
        checkId: c.checkId,
        reviewedHeadSha: (fromCheck ? c.checkHeadSha : c.reviewHeadSha) ?? '',
        finishedAt: iso(fromCheck ? c.checkFinishedAt : c.reviewFinishedAt),
        currentHeadSha: headOf.get(prId) ?? null,
        judgements,
      });
    } else {
      // Only Claude's own findings were followed up (no run judged other reviewers' threads).
      const latest = followUps.get(prId)?.[0];
      out.push({
        prId,
        reviewId: latest?.id ?? null,
        checkId: null,
        reviewedHeadSha: latest?.headSha ?? '',
        finishedAt: iso(latest?.finishedAt ?? null),
        currentHeadSha: headOf.get(prId) ?? null,
        judgements,
      });
    }
  }
  return out;
}
