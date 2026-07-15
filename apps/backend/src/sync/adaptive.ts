// Adaptive polling cadence + conditional change-probe — real-time sync Phase 2
// (see docs/REALTIME-SYNC.md). Gated by config.syncAdaptive; the scheduler calls into
// this ONLY when that flag is on, so default behaviour is untouched.
//
// Two levers, both aimed at "fresher where activity is, cheaper when quiet":
//  1. Per-repo cadence buckets — a repo is synced at most once per its bucket's interval,
//     bucketed by how recently a PR changed (hot <1h, warm <6h, else cold).
//  2. A conditional REST probe before the fat GraphQL walk on incremental syncs — a 304
//     (nothing changed by updatedAt) costs no rate limit and lets us skip the walk, UNLESS
//     the re-walk floor is due (the floor catches CI-finish / thread-resolve, which never
//     bump updatedAt so the probe can't see them).
//
// State is in-memory and per-process — lost on restart, which is harmless: a repo simply
// gets one immediate attempt after boot (lastFullWalkAt seeds to 0, so the floor forces
// the first walk) and its cadence re-learns from there.
import { config } from '../config.js';
import { ghRestGetConditional } from '../github/client.js';

// Activity windows that define the buckets (constants, not env — the tunable knobs are the
// per-bucket intervals in config). "Changed" = the probe saw a PR's updatedAt advance.
const HOT_WINDOW_MS = 60 * 60 * 1000; // < 1h since last change → hot
const WARM_WINDOW_MS = 6 * 60 * 60 * 1000; // < 6h → warm; else cold

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
}

const cadence = new Map<number, RepoCadence>();

function ensure(repoId: number, now: number): RepoCadence {
  let c = cadence.get(repoId);
  if (!c) {
    c = { lastAttemptAt: 0, lastChangeAt: now, lastFullWalkAt: 0, etag: null };
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
 * Whether a repo is due for a sync attempt at `now` — true when it's never been attempted
 * or its bucket interval has elapsed since the last attempt. Cheap (no I/O); the scheduler
 * calls this to skip not-yet-due repos before doing any work.
 */
export function isDue(repoId: number, now: number): boolean {
  const c = cadence.get(repoId);
  if (!c) return true;
  return now - c.lastAttemptAt >= intervalMs(bucketFor(repoId, now));
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
): Promise<{ walk: boolean; reason: 'changed' | 'floor' | 'probe_error' | 'unchanged' }> {
  const c = ensure(repoId, now);
  c.lastAttemptAt = now;

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
