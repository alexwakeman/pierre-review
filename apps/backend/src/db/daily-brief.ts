// ── The daily brief (plan P3.1 / N1): ONE deterministic "what needs me" fold per workspace ──
//
// Computed on read, stored nowhere (D5 — zero core migrations). Every line REUSES the exact fold
// of the surface its strip line deep-links to, so a number and the view it opens cannot disagree
// (the plan's ⚠: "never a re-derivation that can disagree with the surface it links to"):
//
//   myTurn /
//   stalled /
//   untouchedThreads /
//   needsReviewer    → getWorkspaceInsights card counts — the same cards GET /api/attention
//                      serves (one my_turn card = one thing on your plate; one stalled_review
//                      card = one PR; one untouched_thread card = one thread; one
//                      reviewer_routing card = one PR needing a reviewer).
//                      ⚠ `myTurn` USED TO be getConsolidatedFeed(...).counts.myTurn — a count of
//                      feed EVENTS in a rolling 14 days, which corresponded to no clickable list
//                      ("54 items" the user could not open). It is now literally the number of
//                      my_turn cards the board emitted, which are in turn one-per-row of the
//                      `getMyTurn(accountId, scope)` fold GET /api/my-turn serves — so the strip's
//                      number, the board's list and the My Turn view are one population.
//                      ⚠ Those cards are CAPPED (MY_TURN_CARD_CAP = 50) and the cap is DISCLOSED,
//                      not hidden: `myTurnTotal` carries the uncapped population so the line can
//                      read "50 of 148". The displayed figure stays `myTurn` — the card count —
//                      because that is the list the click opens. See the shared type's doc.
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
// ── TWO caches, and the line between them (⚠ do not merge them back into one) ──
// The brief USED to sit behind a single 5-minute per-(accountId, workspaceId) TTL covering every
// slice. That made the strip's headline a snapshot of a fold whose LIST is live: `myTurn` is the
// my_turn card count, the click opens GET /api/attention, and that route recomputes the very same
// getWorkspaceInsights fold on every request with no cache at all. Dismiss two cards (or open two
// of your PRs — `pr_views` moves the fold too) and the strip kept saying 5 over a board of 3 for
// up to five more minutes. A count that a single click disproves is not "≤5 min stale", it is
// wrong; disclosing the staleness would not have made it right.
//
// So the split is by WHETHER THE NUMBER SITS ABOVE A LIVE LIST:
//
//   COUNTS (the four card counts + resolveBacklog + trunkRed) — computed FRESH on every read of
//     `getDailyBriefEntry`, the ACTIVE workspace's line. Each one is the same fold the surface it
//     deep-links to serves on demand, so it must be evaluated at the same moment the user looks
//     at it. This is affordable precisely BECAUSE the anomaly slice below is not in it.
//   botAnomalies — keeps its OWN 5-min TTL (`anomalyCache`). It is an 84-day `events` scan, and
//     it backs NO clickable list: its line reads "unusual volume this week" and opens a bot tab,
//     so nothing a click renders can contradict a five-minute-old flag.
//   The ROLL-UP + the Pro narration inputs — keep a whole-counts TTL (`countsCache`, reached
//     through `getDailyBriefCounts`). The "Elsewhere" lines describe OTHER workspaces: clicking
//     one switches workspace, which then fetches that workspace's own FRESH brief, so the number
//     is re-derived before any list can disagree with it. Freshening the loop instead would
//     multiply getWorkspaceInsights by workspace count on every Feed mount — the cost this route
//     is on the `search` tier for.
//
// ⚠ THEREFORE `generatedAt` DESCRIBES TWO COMPUTATION TIMES, and the honest one is the tighter:
// it stamps the COUNTS (now == the request), while `botAnomalies` inside the same object may be
// up to ANOMALY_TTL_MS older. That asymmetry is the feature, not an oversight — collapsing it
// back into one cache to make one timestamp true again reintroduces the bug above.
//
// Both caches coalesce concurrent computes by storing the promise, and evict a REJECTED one so an
// error never sticks for the whole window.
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { DailyBriefBotAnomaly, DailyBriefCounts, DailyBriefTrunkRepo } from '@pierre-review/shared';
import { db, schema } from './client.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  classificationLabelMap,
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

/** The 84-day anomaly scan's own window (see the header — it backs no clickable list). */
const ANOMALY_TTL_MS = 5 * 60_000;
/** The roll-up / narration window — OTHER workspaces' lines, never the active one's. */
const COUNTS_TTL_MS = 5 * 60_000;

interface CacheEntry<T> {
  at: number;
  promise: Promise<T>;
}
const anomalyCache = new Map<string, CacheEntry<DailyBriefBotAnomaly[]>>();
const countsCache = new Map<string, CacheEntry<DailyBriefCounts>>();

/** The one TTL read both caches share, so their eviction rules cannot drift apart. */
function cached<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.at < ttlMs) return hit.promise;
  const promise = compute();
  map.set(key, { at: now, promise });
  // An errored compute must not stick for the whole window.
  promise.catch(() => {
    if (map.get(key)?.promise === promise) map.delete(key);
  });
  return promise;
}

/** Test seam: drop every cached brief slice (the module-level-cache convention). */
export function clearDailyBriefCache(): void {
  anomalyCache.clear();
  countsCache.clear();
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

  const [insights, backlog, botAnomalies, trunkRed] = await Promise.all([
    // The /api/attention fold verbatim (getWorkspaceInsights with the default window); the two
    // bot cards it filters out are not counted here either. ⚠ UNCACHED, and that is the point:
    // /api/attention re-runs this exact call on every request, so a cached copy here is a number
    // the very next click disproves.
    getWorkspaceInsights(accountId, undefined, scope),
    getResolvableBotThreadPrs(accountId, scope),
    // The ONE cached slice — the 84-day scan, keyed on the RESOLVED workspace (the raw argument
    // may have degraded to Default). Membership changes reach it within ANOMALY_TTL_MS, which is
    // fine here and only here: no list contradicts a bot-volume flag.
    cached(anomalyCache, `${accountId}:${scope.workspaceId}`, ANOMALY_TTL_MS, () =>
      briefBotAnomalies(accountId, scope),
    ),
    trunkRedRepos(accountId, scope),
  ]);

  let myTurn = 0;
  // The `MyTurnCard.personal` subset of the same cards — the figure the NOTIFICATION surfaces
  // display, where the board keeps displaying `myTurn`. Counted off the cards for exactly the
  // reason `myTurn` is: it is the number of PERSONAL cards the board actually paints, so its
  // total (`myTurnPersonalTotal`, the pre-cap fold) is the only thing that may qualify it.
  let myTurnPersonal = 0;
  let stalled = 0;
  let untouchedThreads = 0;
  let needsReviewer = 0;
  for (const c of insights.cards) {
    if (c.kind === 'my_turn') {
      myTurn += 1;
      if (c.personal) myTurnPersonal += 1;
    } else if (c.kind === 'stalled_review') stalled += 1;
    else if (c.kind === 'untouched_thread') untouchedThreads += 1;
    else if (c.kind === 'reviewer_routing') needsReviewer += 1;
  }

  return {
    myTurn,
    // The cap DISCLOSURE, passed straight through from the same getWorkspaceInsights call above
    // (same fold, same scope, same default window) — so the strip's "of N" and the board's "of N"
    // are one number, not two derivations that can drift. ⚠ `myTurn` above stays the figure the
    // strip DISPLAYS: it is the number of cards the board will paint, and a strip that announced
    // 148 over a board of 50 is exactly the "number you can't open" this brief replaced.
    myTurnTotal: insights.myTurnTotal,
    myTurnPersonal,
    // ⚠ THE MATCHED DENOMINATOR, and it is not optional in practice. `myTurnPersonal` paired with
    // `myTurnTotal` would put two populations in one row, AND the cap disclosure only fires when
    // the displayed figure equals the count it qualifies — so a narrow line borrowing the broad
    // total would silently lose its "of N" on every capped workspace.
    myTurnPersonalTotal: insights.myTurnPersonalTotal,
    stalled,
    untouchedThreads,
    needsReviewer,
    resolveBacklog: backlog.totalThreads,
    botAnomalies,
    trunkRed,
  };
}

/**
 * THE ACTIVE WORKSPACE'S BRIEF — the one whose numbers sit above lists the strip can open, so its
 * counts are computed FRESH on every call and never served from a cache (only the anomaly slice
 * inside them is TTL'd; see the header). `computedAt` therefore stamps THE COUNTS, not the object.
 *
 * ⚠ Do not "optimise" this into `getDailyBriefCounts` below. They differ in exactly one way and it
 * is the whole fix: this one cannot lag GET /api/attention, that one may.
 */
export async function getDailyBriefEntry(
  accountId: number,
  workspaceId: number,
): Promise<{ counts: DailyBriefCounts; computedAt: Date }> {
  // Stamped before the fold, so `generatedAt` can never claim to be newer than the read it describes.
  const computedAt = new Date();
  return { counts: await computeBriefCounts(accountId, workspaceId), computedAt };
}

/**
 * The CACHED daily-brief fold (ProHostQueries.getDailyBriefCounts's real body — bind.ts swaps its
 * declared-inert throw for this). Counts only, no cost fields, behind the module-level 5-min TTL.
 *
 * ⚠ Callers are the ones for whom a ≤5-min-old count cannot be contradicted by a click: the
 * roll-up's OTHER-workspace lines (switching workspace re-derives them fresh) and the Pro
 * narration's input assembly (whose phrasing is digit-free — the figures the strip paints always
 * come from the counts response). The workspace the user is LOOKING at goes through
 * `getDailyBriefEntry` above instead.
 *
 * ⚠ And the fresh path must NOT seed this cache with what it just computed, obvious as that looks:
 * the narration's payload hash is read from here, so a counts vector that tracked every read would
 * bill a regeneration for a count that ticked down and back up inside one window. The TTL is a
 * cost gate on this path, not a performance one.
 */
export async function getDailyBriefCounts(
  accountId: number,
  workspaceId: number,
): Promise<DailyBriefCounts> {
  return cached(countsCache, `${accountId}:${workspaceId}`, COUNTS_TTL_MS, () =>
    computeBriefCounts(accountId, workspaceId),
  );
}
