// ── The daily brief (plan P3.1 / N1): ONE deterministic "what needs me" fold per workspace ──
//
// Computed on read, stored nowhere (D5 — zero core migrations). Every line REUSES the exact fold
// of the surface its strip line deep-links to, so a number and the view it opens cannot disagree
// (the plan's ⚠: "never a re-derivation that can disagree with the surface it links to"):
//
//   myTurn           → getConsolidatedFeed(...).counts.myTurn — the feed's OWN my-turn facet,
//                      under the default feed view (excludeBots: true — the SPA's 'hide' lens),
//                      so the strip's number IS the My Turn pill's number on a fresh Feed open.
//                      The actor-less CI-row exclusion is inherited from that fold (CI rows are
//                      withheld from enrichMyTurn inside getConsolidatedFeed), not re-implemented.
//   stalled /
//   untouchedThreads /
//   needsReviewer    → getWorkspaceInsights card counts — the same cards GET /api/attention
//                      serves (one stalled_review card = one PR; one untouched_thread card = one
//                      thread; one reviewer_routing card = one PR needing a reviewer).
//   resolveBacklog   → getResolvableBotThreadPrs(...).totalThreads — the review-&-resolve tab's
//                      own number (same predicate the resolve route re-derives).
//   trunkRed         → the repos DEFAULT-BRANCH head snapshot columns (branch-status's source of
//                      truth) — red = 'failure' | 'error'; pending/unknown are not red.
//   botAnomalies     → a NARROW volume-only self-baseline (below) — deliberately NOT the full
//                      getBotBehaviourAnalytics compute (trends+heatmaps+overlap+ML fold over
//                      every bot), which is priced for an explicit Pro tab open, not an
//                      every-morning free strip.
//
// ── The anomaly slice (the cost decision, spelled out) ──
// Weekly bot-activity counts (review_comment | pr_comment | review_submitted events) per
// role-'review' automated reviewer over the last 84 days — one indexed scan of `events`, no
// thread/ML/heatmap work — folded through the SAME exported `weeklyAnomalies` (median ± MAD,
// z ≥ 3) the behaviour tab uses, with the SAME volume discipline: zero weeks are null (a
// "typical volume" means "how much when it's working"; going dark is the silence detector's
// question and this slice deliberately does not ask it), direction 'both', minScale 2. A bot is
// flagged when its CURRENT trailing-7-day bucket is the anomalous one — the brief is about this
// week, not history.
//
// ── The TTL cache ──
// A module-level 5-minute per-(accountId, workspaceId) cache, coalescing concurrent computes by
// storing the promise. Rationale: the brief renders at the top of the Feed on every console open
// and the roll-up loops it across workspaces, while its inputs (a sync tick, a review landing)
// change on minutes-not-seconds cadence — so a ≤5-min-stale count is honest and a per-open
// recompute of the feed+insights folds is not. The staleness is DISCLOSED (`computedAt` travels
// to the route's `generatedAt`). A rejected compute is evicted so an error never sticks for 5
// minutes. This also keeps the Pro narration's free staleness probe cheap: the synthesis GET
// recomputes the brief's payload hash through this same fold.
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { DailyBriefBotAnomaly, DailyBriefCounts, DailyBriefTrunkRepo } from '@pierre-review/shared';
import { db, schema } from './client.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  classificationLabelMap,
  getConsolidatedFeed,
  getResolvableBotThreadPrs,
  getWorkspaceInsights,
  resolveWorkspaceScope,
  weeklyAnomalies,
  type BotScope,
} from './queries.js';

const WEEK_MS = 7 * 86_400_000;
const SPAN_WEEKS = 12; // 84 days — the behaviour tab's own baseline span
/** Defensive caps: the strip is a one-line-per-item surface, not a listing. */
const ANOMALY_CAP = 5;
const TRUNK_CAP = 8;

const TTL_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  promise: Promise<DailyBriefCounts>;
}
const cache = new Map<string, CacheEntry>();

/** Test seam: drop every cached brief (the module-level-cache convention). */
export function clearDailyBriefCache(): void {
  cache.clear();
}

// The narrow volume-only anomaly slice (see the module header for why it is NOT the behaviour
// compute). Returns at most ANOMALY_CAP bots, most-anomalous first.
async function briefBotAnomalies(
  accountId: number,
  scope: BotScope,
): Promise<DailyBriefBotAnomaly[]> {
  if (scope.repoIds.length === 0) return [];
  const botIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'review');
  if (botIds.length === 0) return [];

  const { events } = schema;
  const nowMs = Date.now();
  const since = new Date(nowMs - SPAN_WEEKS * WEEK_MS);
  const rows = await db
    .select({ actorId: events.actorId, occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.accountId, accountId),
        inArray(events.repoId, scope.repoIds),
        inArray(events.actorId, botIds),
        inArray(events.type, ['review_comment', 'pr_comment', 'review_submitted']),
        gte(events.occurredAt, since),
      ),
    )
    .execute();
  if (rows.length === 0) return [];

  // Rolling 7-day buckets ENDING NOW, oldest first — index 11 is the trailing week the brief
  // reports on. (Calendar weeks would make Monday mornings compare a 1-day bucket to full ones.)
  const byBot = new Map<number, number[]>();
  for (const r of rows) {
    if (r.actorId == null) continue;
    const age = nowMs - r.occurredAt.getTime();
    const bucket = SPAN_WEEKS - 1 - Math.min(SPAN_WEEKS - 1, Math.floor(age / WEEK_MS));
    let counts = byBot.get(r.actorId);
    if (!counts) {
      counts = Array.from({ length: SPAN_WEEKS }, () => 0);
      byBot.set(r.actorId, counts);
    }
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }

  const flagged: { userId: number; z: number }[] = [];
  for (const [userId, counts] of byBot) {
    // Active-weeks-only baseline (zero weeks → null), the behaviour tab's volume discipline.
    const series: (number | null)[] = counts.map((v) => (v > 0 ? v : null));
    const anoms = weeklyAnomalies(series, { direction: 'both', minScale: 2 });
    const current = anoms[SPAN_WEEKS - 1];
    if (current != null) flagged.push({ userId, z: current.z });
  }
  if (flagged.length === 0) return [];
  flagged.sort((a, b) => b.z - a.z);
  const top = flagged.slice(0, ANOMALY_CAP);

  const [labels, kinds] = await Promise.all([
    classificationLabelMap(accountId, scope.workspaceId),
    classificationKindForUser(accountId, scope.workspaceId),
  ]);
  const { users } = schema;
  const userRows = await db
    .select({ id: users.id, login: users.githubLogin })
    .from(users)
    .where(inArray(users.id, top.map((f) => f.userId)))
    .execute();
  const loginById = new Map(userRows.map((u) => [u.id, u.login]));
  return top.map((f) => {
    const login = loginById.get(f.userId) ?? null;
    return {
      userId: f.userId,
      label: labels.get(f.userId) ?? login ?? `#${f.userId}`,
      login,
      kind: kinds.get(f.userId) ?? null,
    };
  });
}

async function trunkRedRepos(
  accountId: number,
  scope: BotScope,
): Promise<DailyBriefTrunkRepo[]> {
  if (scope.repoIds.length === 0) return [];
  const { repos } = schema;
  const rows = await db
    .select({ id: repos.id, name: repos.name, ci: repos.defaultBranchCiStatus })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
    .execute();
  return rows
    .filter((r) => r.ci === 'failure' || r.ci === 'error')
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, TRUNK_CAP)
    .map((r) => ({ repoId: r.id, name: r.name }));
}

async function computeBriefCounts(
  accountId: number,
  workspaceId: number,
): Promise<DailyBriefCounts> {
  // Number in → the resolver still owns membership (a foreign/dead id degrades to Default,
  // exactly the scoped-route posture; the caller already resolved real requests).
  const scope = await resolveWorkspaceScope(accountId, workspaceId);

  const [feed, insights, backlog, botAnomalies, trunkRed] = await Promise.all([
    // limit: 1 — the facet counts cover the WHOLE post-cap stream regardless of the page, and
    // only the page pays enrichment cost. excludeBots: true = the SPA's default 'hide' lens, so
    // this IS the My Turn pill's number on a fresh Feed open.
    getConsolidatedFeed(accountId, {
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      excludeBots: true,
      limit: 1,
    }),
    // The /api/attention fold verbatim (getWorkspaceInsights with the default window); the two
    // bot cards it filters out are not counted here either.
    getWorkspaceInsights(accountId, undefined, scope),
    getResolvableBotThreadPrs(accountId, scope),
    briefBotAnomalies(accountId, scope),
    trunkRedRepos(accountId, scope),
  ]);

  let stalled = 0;
  let untouchedThreads = 0;
  let needsReviewer = 0;
  for (const c of insights.cards) {
    if (c.kind === 'stalled_review') stalled += 1;
    else if (c.kind === 'untouched_thread') untouchedThreads += 1;
    else if (c.kind === 'reviewer_routing') needsReviewer += 1;
  }

  return {
    myTurn: feed.counts?.myTurn ?? 0,
    stalled,
    untouchedThreads,
    needsReviewer,
    resolveBacklog: backlog.totalThreads,
    botAnomalies,
    trunkRed,
  };
}

/** The brief fold + its computed-at timestamp (the route's `generatedAt` disclosure). */
export async function getDailyBriefEntry(
  accountId: number,
  workspaceId: number,
): Promise<{ counts: DailyBriefCounts; computedAt: Date }> {
  const key = `${accountId}:${workspaceId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return { counts: await hit.promise, computedAt: new Date(hit.at) };
  }
  const promise = computeBriefCounts(accountId, workspaceId);
  cache.set(key, { at: now, promise });
  // An errored compute must not stick for 5 minutes.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return { counts: await promise, computedAt: new Date(now) };
}

/**
 * The ONE daily-brief fold (ProHostQueries.getDailyBriefCounts's real body — bind.ts swaps its
 * declared-inert throw for this). Counts only, no cost fields, computed on read behind the
 * module-level 5-min TTL cache above.
 */
export async function getDailyBriefCounts(
  accountId: number,
  workspaceId: number,
): Promise<DailyBriefCounts> {
  return (await getDailyBriefEntry(accountId, workspaceId)).counts;
}
