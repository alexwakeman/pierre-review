// ── PENDING → "AI REVIEWS": THE NEWEST AI REVIEW ON EACH PR (docs/BACKEND.md § The AI reviews list) ──
//
// The tab's one list: a stable REFERENCE, never an inbox. One `ai_review` card per PR of the
// workspace, open or not — the NEWEST of:
//   • the reader's OWN Limn — a finished full review (`kind IS NULL`, `succeeded`, not a router
//     skip). A Claude + Codex pair is ONE review: listed once, on its first half, with the pair's
//     one verdict and both halves' findings (a merged-away repeat never counts);
//   • a TEAMMATE's Limn — a review it posted to GitHub, imported as `kind = 'teammate'`.
// Newest first, at most `AI_REVIEWS_LIST_CAP` rows.
//
// ⚠ LOOKING NEVER REMOVES A ROW. The workspace's `ai_reviews_seen_at` stamp only says which rows are
// newer than the reader's last look: the SPA tags them "New" (against the stamp its visit started
// with) and the tab's badge counts them (`PendingTab.newTotal`). It is moved ONLY by the reader
// looking (`markAiReviewsSeen`, the SPA's POST while the tab is on screen), never by a read.
//
// ⚠ LIVE BOARD ONLY and COUNTED ONLY IN ITS TAB: `buildPendingBoard` appends these after the fold,
// so the daily brief, Slack, the My Turn counts and the notifications never see one.
//
// DB only — no GitHub call.
import { AI_REVIEWS_LIST_CAP, type AiReviewCard } from '@pierre-review/shared';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from './client.js';
import { TEAMMATE_KIND } from './teammate-reviews.js';
import { prInBoardScope } from './queries.js';

const { claudeReviews: cr, claudeReviewFindings: crf, pullRequests, repos, workspaces } = schema;

/** The stamp, or null when the reader never looked in this workspace. Account-scoped. */
export async function getAiReviewsSeenAt(accountId: number, workspaceId: number): Promise<Date | null> {
  const rows = await db
    .select({ at: workspaces.aiReviewsSeenAt })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .limit(1)
    .execute();
  return rows[0]?.at ?? null;
}

/** How many listed rows are newer than the stamp (null = never looked: all of them). Pure. */
export function countNewAiReviews(cards: readonly AiReviewCard[], seenAt: Date | null): number {
  if (seenAt == null) return cards.length;
  const ms = seenAt.getTime();
  return cards.filter((c) => Date.parse(c.at) > ms).length;
}

/**
 * THE ONE WRITER. The reader looked: stamp `through` (the newest review time their list showed),
 * else `now`. Clamped to `now`, and NEVER BACK — an older `through` (a second tab, a stale list)
 * leaves the stamp where it is. Scoped to the account's own workspace; returns the stamp after the
 * call, or null when the workspace is not the account's.
 */
export async function markAiReviewsSeen(
  accountId: number,
  workspaceId: number,
  through: Date | null,
  now: number = Date.now(),
): Promise<Date | null> {
  const wanted = Math.floor(Math.min(through?.getTime() ?? now, now) / 1000);
  const rows = await db
    .update(workspaces)
    .set({
      aiReviewsSeenAt: sql`max(coalesce(${workspaces.aiReviewsSeenAt}, 0), ${wanted})`,
    })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ at: workspaces.aiReviewsSeenAt })
    .execute();
  return rows[0]?.at ?? null;
}

type Verdict = AiReviewCard['verdict'];

/**
 * The `ai_review` cards for one workspace scope: the newest AI review on each PR, newest first, at
 * most `AI_REVIEWS_LIST_CAP` — plus the teammates they name (for `users[]`). DB only.
 */
export async function buildAiReviewCards(
  accountId: number,
  repoIds: readonly number[],
  // The scope's PROJECT PRs in external repos (db/external-repos.ts) — listed beside the watched
  // repos' PRs, so a review of the reader's own PR in an external repo shows here too.
  projectPrIds: readonly number[] = [],
): Promise<{ cards: AiReviewCard[]; userIds: number[] }> {
  if (repoIds.length === 0 && projectPrIds.length === 0) return { cards: [], userIds: [] };
  // Own runs by FINISH time, teammates' reviews by POST time (else import time) — the two clocks
  // `listTeammateReviews` and the run panel already show.
  const clock = sql<number>`case when ${cr.kind} = ${TEAMMATE_KIND} then coalesce(${cr.postedAt}, ${cr.createdAt}) else coalesce(${cr.finishedAt}, ${cr.createdAt}) end`;
  const all = await db
    .select({
      id: cr.id,
      prId: cr.prId,
      kind: cr.kind,
      verdict: cr.verdict,
      trigger: cr.trigger,
      pairId: cr.pairId,
      pairRole: cr.pairRole,
      pairConsolidation: cr.pairConsolidation,
      finishedAt: cr.finishedAt,
      postedAt: cr.postedAt,
      createdAt: cr.createdAt,
      sourceUserId: cr.sourceUserId,
      repoId: pullRequests.repoId,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      owner: repos.owner,
      name: repos.name,
    })
    .from(cr)
    .innerJoin(pullRequests, eq(pullRequests.id, cr.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(cr.accountId, accountId),
        eq(repos.accountId, accountId),
        prInBoardScope(repoIds, projectPrIds),
        or(
          and(
            isNull(cr.kind),
            eq(cr.status, 'succeeded'),
            // A router SKIP is not a review: nothing was read.
            sql`coalesce(${cr.reviewMode}, '') <> 'skip'`,
            // A pair is ONE review, listed on its first half.
            sql`coalesce(${cr.pairRole}, 'first') = 'first'`,
          ),
          and(
            eq(cr.kind, TEAMMATE_KIND),
            // Never unnamed: a teammate's review with no poster would read as the reader's own.
            isNotNull(cr.sourceUserId),
          ),
        ),
      ),
    )
    .orderBy(sql`${clock} desc`, sql`${cr.id} desc`)
    .execute();
  // ONE ROW PER PR — its newest review — and at most the cap.
  const onPr = new Set<number>();
  const rows: typeof all = [];
  for (const r of all) {
    if (onPr.has(r.prId)) continue;
    onPr.add(r.prId);
    rows.push(r);
    if (rows.length >= AI_REVIEWS_LIST_CAP) break;
  }
  if (rows.length === 0) return { cards: [], userIds: [] };

  // A pair's second half: its findings count, and its finish time when it ended later.
  const pairIds = [...new Set(rows.map((r) => r.pairId).filter((id): id is number => id != null))];
  const secondOf = new Map<number, { id: number; finishedAt: Date | null }>();
  if (pairIds.length > 0) {
    for (const h of await db
      .select({ id: cr.id, pairId: cr.pairId, finishedAt: cr.finishedAt })
      .from(cr)
      .where(and(eq(cr.accountId, accountId), inArray(cr.pairId, pairIds), eq(cr.pairRole, 'second'), eq(cr.status, 'succeeded')))
      .execute()) {
      if (h.pairId != null) secondOf.set(h.pairId, { id: h.id, finishedAt: h.finishedAt });
    }
  }
  const runIdsOf = (r: (typeof rows)[number]): number[] => {
    const second = r.pairId != null ? secondOf.get(r.pairId) : undefined;
    return second != null ? [r.id, second.id] : [r.id];
  };

  // ONE grouped count over every listed run: findings that ask for something.
  const findingCount = new Map<number, number>();
  for (const f of await db
    .select({ reviewId: crf.reviewId, n: sql<number>`count(*)` })
    .from(crf)
    .where(
      and(
        inArray(crf.reviewId, rows.flatMap(runIdsOf)),
        isNull(crf.mergedInto),
        sql`${crf.severity} <> 'praise'`,
      ),
    )
    .groupBy(crf.reviewId)
    .execute()) {
    findingCount.set(f.reviewId, Number(f.n));
  }

  const userIds = new Set<number>();
  const cards: AiReviewCard[] = rows.map((r) => {
    const teammate = r.kind === TEAMMATE_KIND;
    const second = r.pairId != null ? secondOf.get(r.pairId) : undefined;
    const ownAt = Math.max(
      (r.finishedAt ?? r.createdAt).getTime(),
      second?.finishedAt?.getTime() ?? 0,
    );
    const at = teammate ? (r.postedAt ?? r.createdAt).getTime() : ownAt;
    const verdict: Verdict =
      !teammate && r.pairId != null ? (r.pairConsolidation?.verdict ?? r.verdict) : r.verdict;
    if (teammate && r.sourceUserId != null) userIds.add(r.sourceUserId);
    return {
      id: `ai_review:${r.id}`,
      kind: 'ai_review',
      severity: 'info',
      reviewId: r.id,
      prId: r.prId,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      githubUrl: `https://github.com/${r.owner}/${r.name}/pull/${r.prNumber}`,
      ranByUserId: teammate ? r.sourceUserId : null,
      auto: !teammate && r.trigger === 'auto',
      verdict,
      findingCount: runIdsOf(r).reduce((n, id) => n + (findingCount.get(id) ?? 0), 0),
      at: new Date(at).toISOString(),
    };
  });
  cards.sort(compareAiReviews);
  return { cards, userIds: [...userIds] };
}

/** Newest first; ties to the higher review id — a total order, so two polls list alike. */
export function compareAiReviews(a: AiReviewCard, b: AiReviewCard): number {
  return Date.parse(b.at) - Date.parse(a.at) || b.reviewId - a.reviewId;
}
