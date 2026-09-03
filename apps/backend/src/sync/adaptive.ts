// Adaptive polling cadence + conditional change-probe — real-time sync Phase 2
// (see docs/REALTIME-SYNC.md). Gated by config.syncAdaptive; the scheduler calls into
// this ONLY when that flag is on, so default behaviour is untouched.
//
// Three levers, the first two aimed at "fresher where activity is, cheaper when quiet" and
// the third at "a repo we cannot read must not be retried at the cadence of a healthy one":
//  1. Per-repo cadence buckets — a repo is synced at most once per its bucket's interval,
//     bucketed by how recently a PR changed (hot <1h, warm <6h, else cold).
//  2. A conditional REST probe before the fat GraphQL walk on incremental syncs — a 304
//     (nothing changed by updatedAt) costs no rate limit and lets us skip the walk, UNLESS
//     the re-walk floor is due (the floor catches CI-finish / thread-resolve, which never
//     bump updatedAt so the probe can't see them).
//  3. A HEALTH backoff on consecutive failures (noteWalkFailure) that WIDENS whatever the
//     activity bucket asks for. ⚠ Health is deliberately a SEPARATE axis: the buckets
//     describe how busy a repo is, and overloading them with "how broken is it" would make
//     a failing repo look quiet — and a quiet repo get punished for being quiet.
//
// State is in-memory and per-process — lost on restart, which is harmless: a repo simply
// gets one immediate attempt after boot (lastFullWalkAt seeds to 0, so the floor forces
// the first walk) and its cadence re-learns from there.
import { config } from '../config.js';
import { ghRestGetConditional } from '../github/client.js';
import { isLimited } from '../github/rate-budget.js';

// Activity windows that define the buckets (constants, not env — the tunable knobs are the
// per-bucket intervals in config). "Changed" = the probe saw a PR's updatedAt advance.
const HOT_WINDOW_MS = 60 * 60 * 1000; // < 1h since last change → hot
const WARM_WINDOW_MS = 6 * 60 * 60 * 1000; // < 6h → warm; else cold

// The health backoff's ceiling. Six hours is long enough that a permanently unreadable repo
// costs ~4 walks a day instead of 1,440, and short enough that a repo whose token/permission
// was fixed comes back the same working day without anyone restarting the process.
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
// 2**n × the cold interval already exceeds the cap long before this, so the clamp only exists
// to keep the shift out of Infinity/NaN territory on an absurd failure count.
const MAX_BACKOFF_SHIFT = 16;

export type Bucket = 'hot' | 'warm' | 'cold';

interface RepoCadence {
  // Last time the scheduler attempted this repo (probe or walk). Gates the interval.
  lastAttemptAt: number;
  // Last time the probe observed a change (a 200) — drives the bucket. Seeded to "now" on
  // first sight so a freshly-booted repo starts hot and decays if it turns out quiet.
  lastChangeAt: number;
  // Last completed full walk — drives the floor (force a walk at least this often).
  lastFullWalkAt: number;
  // ETag of the conditional pulls-list probe, for the next If-None-Match.
  etag: string | null;
  // Consecutive FAILED scheduled walks (reset by any success) — drives the health backoff.
  consecutiveFailures: number;
}

const cadence = new Map<number, RepoCadence>();

function ensure(repoId: number, now: number): RepoCadence {
  let c = cadence.get(repoId);
  if (!c) {
    c = {
      lastAttemptAt: 0,
      lastChangeAt: now,
      lastFullWalkAt: 0,
      etag: null,
      consecutiveFailures: 0,
    };
    cadence.set(repoId, c);
  }
  return c;
}

/** The activity bucket for a repo at `now` (cold when unseen). */
export function bucketFor(repoId: number, now: number): Bucket {
  const c = cadence.get(repoId);
  if (!c) return 'cold';
  const sinceChange = now - c.lastChangeAt;
  if (sinceChange < HOT_WINDOW_MS) return 'hot';
  if (sinceChange < WARM_WINDOW_MS) return 'warm';
  return 'cold';
}

function intervalMs(bucket: Bucket): number {
  switch (bucket) {
    case 'hot':
      return config.syncHotIntervalSec * 1000;
    case 'warm':
      return config.syncWarmIntervalSec * 1000;
    case 'cold':
      return config.syncColdIntervalSec * 1000;
  }
}

/**
 * How long a repo with `failures` consecutive failed walks must wait on top of nothing —
 * exponential from the COLD interval (15 min → 30m, 1h, 2h, 4h, then the 6h cap). Zero while
 * the repo is healthy, so a working repo's cadence is exactly what it always was.
 */
function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const shift = Math.min(failures, MAX_BACKOFF_SHIFT);
  return Math.min(config.syncColdIntervalSec * 1000 * 2 ** shift, MAX_BACKOFF_MS);
}

/** The current health backoff for a repo, in ms (0 when it has no recorded failures). */
export function backoffMsFor(repoId: number): number {
  return backoffMs(cadence.get(repoId)?.consecutiveFailures ?? 0);
}

/**
 * Whether a repo is due for a sync attempt at `now` — true when it's never been attempted,
 * or the WIDER of its bucket interval and its health backoff has elapsed since the last
 * attempt. Cheap (no I/O); the scheduler calls this to skip not-yet-due repos before doing
 * any work.
 *
 * ⚠ The gate is only as good as the attempt stamp. Every scheduled sync must call
 * `noteAttempt` — for a while only `decideIncrementalWalk` did, so a repo pinned in FULL
 * mode (which is what a repo whose first walk always fails is) never got a stamp and passed
 * this check on EVERY tick: four unreadable repos, re-walked once a minute at 15 points
 * each, burned 72% of a 5,000-point/hour GraphQL budget for five weeks.
 */
export function isDue(repoId: number, now: number): boolean {
  const c = cadence.get(repoId);
  if (!c) return true;
  const wait = Math.max(
    intervalMs(bucketFor(repoId, now)),
    backoffMs(c.consecutiveFailures),
  );
  return now - c.lastAttemptAt >= wait;
}

/**
 * Stamp that the scheduler is ATTEMPTING this repo now, whatever the mode and whatever
 * happens next. The floor under `isDue`: `decideIncrementalWalk` stamps the incremental
 * path, and this covers everything else (a first backfill, a repo stuck in full mode, any
 * future branch), so no path can ever re-walk a repo once per tick again.
 *
 * ⚠ Not sufficient on its own. `ensure()` seeds `lastChangeAt: now`, so a first-sighted repo
 * reads HOT (120s) — an unreadable repo stamped-but-healthy would still be retried 30×/hour.
 * The health backoff (noteWalkFailure) is what actually widens it.
 */
export function noteAttempt(repoId: number, now: number): void {
  ensure(repoId, now).lastAttemptAt = now;
}

/**
 * Record that a scheduled walk FAILED. Returns the new consecutive-failure count, so the
 * caller can log how far the repo has backed off.
 */
export function noteWalkFailure(repoId: number, now: number): number {
  const c = ensure(repoId, now);
  c.consecutiveFailures += 1;
  return c.consecutiveFailures;
}

/** Record that a walk SUCCEEDED — clears the health backoff (never touches the buckets). */
export function noteWalkSuccess(repoId: number, now: number): void {
  ensure(repoId, now).consecutiveFailures = 0;
}

/**
 * Stamp an attempt, run the conditional probe, and decide whether to run the full walk.
 * Returns true to walk (something changed by updatedAt, OR the re-walk floor is due, OR the
 * probe failed — never skip on uncertainty), false to skip the fat query this tick. Called
 * only for INCREMENTAL syncs when adaptive is on. A 200 also refreshes the bucket
 * (lastChangeAt), so an active repo climbs to a faster cadence and a quiet one decays.
 */
export async function decideIncrementalWalk(
  repoId: number,
  owner: string,
  name: string,
  token: string,
  now: number,
  // Optional (trailing, so existing call shapes stand): lets the probe stand down while
  // the owning account is rate-limited — see below.
  accountId?: number,
): Promise<{
  walk: boolean;
  reason: 'changed' | 'floor' | 'probe_error' | 'unchanged' | 'rate_limited';
}> {
  const c = ensure(repoId, now);
  c.lastAttemptAt = now;

  // While the account's token is known rate-limited (github/rate-budget.ts), don't even
  // probe: a limited probe fails non-304, which the "never skip on uncertainty" rule
  // below would turn into MORE walks — the exact opposite of what a limited token needs.
  // The limited state self-clears; the floor's blind spots simply wait out the window.
  if (accountId != null && isLimited(accountId)) {
    return { walk: false, reason: 'rate_limited' };
  }

  const floorDue = now - c.lastFullWalkAt >= config.syncFloorIntervalSec * 1000;

  let changed = true;
  let probeErrored = false;
  try {
    const res = await ghRestGetConditional(
      token,
      // Most-recently-updated PR only: its representation (hence the ETag) changes iff some
      // PR's updatedAt advanced. state=all so a close/merge/reopen counts too.
      `/repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc&per_page=1`,
      c.etag,
    );
    if (res.etag) c.etag = res.etag;
    changed = !res.notModified;
    if (changed) c.lastChangeAt = now;
  } catch {
    // Network/permission failure → don't lose data; fall back to walking.
    probeErrored = true;
    changed = true;
  }

  if (changed) return { walk: true, reason: probeErrored ? 'probe_error' : 'changed' };
  if (floorDue) return { walk: true, reason: 'floor' };
  return { walk: false, reason: 'unchanged' };
}

/** Record that a full walk just completed (resets the floor). */
export function recordFullWalk(repoId: number, now: number): void {
  ensure(repoId, now).lastFullWalkAt = now;
}

/** Test-only: clear all in-memory cadence state. */
export function __resetAdaptiveState(): void {
  cadence.clear();
}
