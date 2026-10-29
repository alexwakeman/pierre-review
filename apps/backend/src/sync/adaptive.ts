// Adaptive polling cadence + conditional change-probe — real-time sync Phase 2
// (see docs/REALTIME-SYNC.md). Gated by config.syncAdaptive; the scheduler calls into
// this ONLY when that flag is on, so default behaviour is untouched.
//
// "Probe often for free, walk at most once a minute per repo, check settled state for ~1 point
// instead of walking blind." Four levers:
//  1. Per-repo cadence buckets — a repo is PROBED at most once per its bucket's interval
//     (hot 20s / warm 60s / cold 300s by default), bucketed by how recently a PR changed
//     (hot <1h, warm <6h, else cold).
//  2. A conditional REST probe before the fat GraphQL walk on incremental syncs — a 304
//     (nothing changed by updatedAt) costs no rate limit and lets us skip the walk, UNLESS
//     the slow INSURANCE walk is due (`syncFloorIntervalSec`, default 3h).
//  3. THE WALK CAP — a probe's 2xx (never a probe error: that proves nothing) marks the repo
//     DIRTY, and the scheduler walks a dirty repo at most once per `syncMinWalkIntervalSec` (60s). A dirty repo inside
//     the cap is NOT forgotten: `isDue` grants it the moment the cap allows, without waiting
//     out its bucket, and a walk clears the flag only when it STARTED after the change was seen.
//     The settle sweep's cadence (`isSettleDue`, sync/settle-sweep.ts) lives here too, on the
//     same buckets: updatedAt-SILENT changes (CI finishing, a thread resolve) are found by that
//     sweep, never by a walk.
//  4. A HEALTH backoff on consecutive failures (noteWalkFailure) that WIDENS whatever the
//     activity bucket asks for. ⚠ Health is deliberately a SEPARATE axis: the buckets
//     describe how busy a repo is, and overloading them with "how broken is it" would make
//     a failing repo look quiet — and a quiet repo get punished for being quiet.
//
// State is in-memory and per-process — lost on restart, which is harmless: a repo simply
// gets one immediate attempt after boot (lastFullWalkAt seeds to 0, so the insurance walk
// forces the first walk, and lastSettleAt seeds to 0, so the first sweep reads it) and its
// cadence re-learns from there.
import { config } from '../config.js';
import { ghRestGetConditional } from '../github/client.js';
import { isLimited, noteLimited } from '../github/rate-budget.js';

// Activity windows that define the buckets (constants, not env — the tunable knobs are the
// per-bucket intervals in config). "Changed" = the probe saw a PR's updatedAt advance.
const HOT_WINDOW_MS = 60 * 60 * 1000; // < 1h since last change → hot
const WARM_WINDOW_MS = 6 * 60 * 60 * 1000; // < 6h → warm; else cold

// The health backoff's base: 15 min, doubling. A CONSTANT, deliberately not the cold interval —
// the cold probe interval fell from 900s to 300s when probes became the cheap path, and a repo
// we cannot read must not be retried more often because of that.
const BACKOFF_BASE_MS = 15 * 60 * 1000;

// The health backoff's ceiling. Six hours is long enough that a permanently unreadable repo
// costs ~4 walks a day instead of 1,440, and short enough that a repo whose token/permission
// was fixed comes back the same working day without anyone restarting the process.
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
// 2**n × the base already exceeds the cap long before this, so the clamp only exists to keep
// the shift out of Infinity/NaN territory on an absurd failure count.
const MAX_BACKOFF_SHIFT = 16;

export type Bucket = 'hot' | 'warm' | 'cold';

interface RepoCadence {
  // Last time the scheduler attempted this repo (probe or walk). Gates the interval.
  lastAttemptAt: number;
  // Last time a change was observed (a probe 200, or the settle sweep) — drives the bucket.
  // Seeded to "now" on first sight so a freshly-booted repo starts hot and decays if it turns
  // out quiet.
  lastChangeAt: number;
  // Last completed full walk — drives the insurance walk (force a walk at least this often).
  lastFullWalkAt: number;
  // When the scheduler last STARTED a walk of this repo — drives the walk cap.
  lastWalkStartAt: number;
  // When a change was first seen that no walk has covered yet (a probe 2xx, or
  // the settle sweep finding a PR the DB lacks or one newer than stored). Null = clean.
  dirtyAt: number | null;
  // When the settle sweep last read this repo — drives isSettleDue.
  lastSettleAt: number;
  // When GitHub last ANSWERED for this repo (a probe 304/200, a completed scheduled walk, a
  // settle read) — "last checked" in the header, because with walks only on change a quiet
  // repo's "last synced" can be hours old while it was checked seconds ago. 0 = never.
  lastCheckedAt: number;
  // ETag of the conditional pulls-list probe, for the next If-None-Match.
  etag: string | null;
  // Consecutive FAILED scheduled walks (reset by any success) — drives the health backoff.
  consecutiveFailures: number;
  // Walks justified by a probe GitHub did not ANSWER (a non-2xx/304 status, or a thrown network
  // error) since its last real answer — spaces the next such walk (probeErrorGapMs). Reset by any
  // 304/2xx.
  probeErrorWalks: number;
}

const cadence = new Map<number, RepoCadence>();

function ensure(repoId: number, now: number): RepoCadence {
  let c = cadence.get(repoId);
  if (!c) {
    c = {
      lastAttemptAt: 0,
      lastChangeAt: now,
      lastFullWalkAt: 0,
      lastWalkStartAt: 0,
      dirtyAt: null,
      lastSettleAt: 0,
      lastCheckedAt: 0,
      etag: null,
      consecutiveFailures: 0,
      probeErrorWalks: 0,
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

function walkCapMs(): number {
  return config.syncMinWalkIntervalSec * 1000;
}

/**
 * How long a repo with `failures` consecutive failed walks must wait on top of nothing —
 * exponential from a 15-minute base (30m, 1h, 2h, 4h, then the 6h cap). Zero while the repo
 * is healthy, so a working repo's cadence is exactly what it always was.
 */
function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const shift = Math.min(failures, MAX_BACKOFF_SHIFT);
  return Math.min(BACKOFF_BASE_MS * 2 ** shift, MAX_BACKOFF_MS);
}

/**
 * How long after the last completed walk a FAILING probe may justify a walk, given how many walks
 * failing probes have already justified since GitHub last answered: 15 min for the first, doubling
 * per walk (30 min, 1h, 2h), never longer than the insurance walk.
 * ⚠ A probe GitHub did not answer PROVED NOTHING — it is not a change. Treating it as one (as this
 * module once did) walked a repo whose REST probe kept getting a 403/5xx about once a minute,
 * ~15 GraphQL points each, forever. The settle sweep (a separate GraphQL read) still marks the
 * repo dirty on any newer PR, so uncertainty is covered without paying a walk per probe.
 */
function probeErrorGapMs(priorWalks: number): number {
  const shift = Math.min(Math.max(priorWalks, 0), MAX_BACKOFF_SHIFT);
  return Math.min(BACKOFF_BASE_MS * 2 ** shift, config.syncFloorIntervalSec * 1000);
}

/** The current health backoff for a repo, in ms (0 when it has no recorded failures). */
export function backoffMsFor(repoId: number): number {
  return backoffMs(cadence.get(repoId)?.consecutiveFailures ?? 0);
}

/**
 * Whether a repo is due for a sync attempt at `now` — true when it's never been attempted,
 * or the WIDER of its bucket interval and its health backoff has elapsed since the last
 * attempt, or it is DIRTY and the walk cap now allows a walk. Cheap (no I/O); the scheduler
 * calls this to skip not-yet-due repos before doing any work.
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
  const backoff = backoffMs(c.consecutiveFailures);
  // A DIRTY repo is due the moment the walk cap allows, whatever its bucket says — a change the
  // cap held back must be walked as soon as it may be, never parked behind a cold interval. The
  // health backoff still applies (a dirty repo whose walks fail is still a repo we cannot read).
  if (
    c.dirtyAt != null &&
    now - c.lastWalkStartAt >= walkCapMs() &&
    now - c.lastAttemptAt >= backoff
  ) {
    return true;
  }
  const wait = Math.max(intervalMs(bucketFor(repoId, now)), backoff);
  return now - c.lastAttemptAt >= wait;
}

/**
 * Stamp that the scheduler is ATTEMPTING this repo now, whatever the mode and whatever
 * happens next. The floor under `isDue`: `decideIncrementalWalk` stamps the incremental
 * path, and this covers everything else (a first backfill, a repo stuck in full mode, any
 * future branch), so no path can ever re-walk a repo once per tick again.
 *
 * ⚠ Not sufficient on its own. `ensure()` seeds `lastChangeAt: now`, so a first-sighted repo
 * reads HOT (20s) — an unreadable repo stamped-but-healthy would still be retried 180×/hour.
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

export type WalkDecisionReason =
  | 'changed'
  | 'dirty'
  | 'floor'
  | 'probe_error'
  | 'unchanged'
  | 'capped'
  | 'rate_limited';

/**
 * Stamp an attempt, run the conditional probe, and decide whether to run the full walk.
 * Called only for INCREMENTAL syncs when adaptive is on.
 *
 *   • A repo already DIRTY whose walk cap has elapsed walks at once, without a probe (the probe
 *     that dirtied it already spent its answer, and its ETag is stored).
 *   • Otherwise probe. A 2xx refreshes the bucket (lastChangeAt) and marks the repo dirty. A
 *     rate-limited probe notes the shared budget and walks nothing (`rate_limited`). Any other
 *     failure (a non-2xx status or a network error) is NOT a change: it marks nothing and walks
 *     only once `probeErrorGapMs` has passed since the last walk (`probe_error`).
 *   • Dirty → walk when the cap allows, else `capped` (the flag stays set, and `isDue`
 *     re-grants the repo the moment the cap allows).
 *   • Clean → walk only when the insurance walk is due (`floor`), else `unchanged`.
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
): Promise<{ walk: boolean; reason: WalkDecisionReason }> {
  const c = ensure(repoId, now);
  c.lastAttemptAt = now;

  // While the account's token is known rate-limited (github/rate-budget.ts), don't even
  // probe: a limited probe fails non-304, which the "never skip on uncertainty" rule
  // below would turn into MORE walks — the exact opposite of what a limited token needs.
  // The limited state self-clears; a dirty flag simply waits it out.
  if (accountId != null && isLimited(accountId)) {
    return { walk: false, reason: 'rate_limited' };
  }

  const capOk = now - c.lastWalkStartAt >= walkCapMs();
  if (c.dirtyAt != null && capOk) return { walk: true, reason: 'dirty' };

  // What the probe proved: 'unchanged' (a real 304), 'changed' (a real 2xx), or 'error' — a
  // non-2xx status (ghRestGetConditional reports those, it never throws on them) or a network
  // failure. ⚠ Only a 2xx is a change: a 401/403/404/5xx is GitHub NOT answering.
  let outcome: 'unchanged' | 'changed' | 'error' = 'error';
  try {
    const res = await ghRestGetConditional(
      token,
      // Most-recently-updated PR only: its representation (hence the ETag) changes iff some
      // PR's updatedAt advanced. state=all so a close/merge/reopen counts too.
      // ⚠ GitHub serves this with `Cache-Control: private, max-age=60` — see
      // docs/REALTIME-SYNC.md § The max-age caveat for what that can mean for a 304.
      `/repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc&per_page=1`,
      c.etag,
    );
    if (res.rateLimited) {
      // GitHub's limiter answered the probe — PRE-EMPTED, never an error: note the shared budget
      // (every walk and probe on this token then stands down until it lifts) and walk nothing. A
      // dirty flag simply waits it out.
      if (accountId != null) noteLimited(accountId, res.rateLimited.resumeAt);
      return { walk: false, reason: 'rate_limited' };
    }
    if (res.notModified) outcome = 'unchanged';
    else if (res.status >= 200 && res.status < 300) outcome = 'changed';
    // An error response's ETag is not the list's — keep the last real one.
    if (outcome !== 'error' && res.etag) c.etag = res.etag;
  } catch {
    // Network failure — 'error'.
  }

  if (outcome === 'error') {
    // Not a change: no dirty flag, no bucket refresh, not "checked". Walk only when it has been
    // long enough since the last walk (probeErrorGapMs), so a probe that keeps failing costs a
    // spaced-out walk rather than one per probe.
    // (The gap never exceeds the insurance interval, so the insurance walk is covered here too.)
    if (c.dirtyAt != null && !capOk) return { walk: false, reason: 'capped' };
    if (capOk && now - c.lastFullWalkAt >= probeErrorGapMs(c.probeErrorWalks)) {
      c.probeErrorWalks += 1;
      return { walk: true, reason: 'probe_error' };
    }
    return { walk: false, reason: 'probe_error' };
  }

  c.probeErrorWalks = 0;
  c.lastCheckedAt = now;
  if (outcome === 'changed') {
    c.lastChangeAt = now;
    c.dirtyAt ??= now;
  }
  if (c.dirtyAt != null) {
    if (!capOk) return { walk: false, reason: 'capped' };
    return { walk: true, reason: 'changed' };
  }
  if (now - c.lastFullWalkAt >= config.syncFloorIntervalSec * 1000) {
    return { walk: true, reason: 'floor' };
  }
  return { walk: false, reason: 'unchanged' };
}

/**
 * Stamp that the scheduler is STARTING a walk of this repo now — the walk cap's clock. Every
 * scheduled walk calls it, whatever the mode; manual walks do not (they are not capped).
 */
export function noteWalkStart(repoId: number, now: number): void {
  ensure(repoId, now).lastWalkStartAt = now;
}

/**
 * Mark a repo DIRTY: a change was seen that no walk has covered yet. The probe does this on a
 * 200; the settle sweep does it when GitHub lists an open PR the DB lacks, or one newer than
 * stored. Also refreshes the bucket — it is a change.
 */
export function markDirty(repoId: number, now: number): void {
  const c = ensure(repoId, now);
  c.dirtyAt ??= now;
  c.lastChangeAt = Math.max(c.lastChangeAt, now);
}

/** Is the repo dirty (a change seen that no walk has covered yet)? */
export function isDirty(repoId: number): boolean {
  return cadence.get(repoId)?.dirtyAt != null;
}

/**
 * Record that a full walk just completed (resets the insurance clock). `startedAt` is when the
 * walk began: the dirty flag is cleared only when the walk started AT OR AFTER the change was
 * seen — a change noticed mid-walk (the settle sweep runs alongside) may sit past the pages the
 * walk already read, so it keeps the flag and gets its own walk once the cap allows. Omitted =
 * "this walk covers everything seen so far".
 */
export function recordFullWalk(repoId: number, now: number, startedAt: number = now): void {
  const c = ensure(repoId, now);
  c.lastFullWalkAt = now;
  c.lastCheckedAt = now;
  if (c.dirtyAt != null && c.dirtyAt <= startedAt) c.dirtyAt = null;
}

// ── The settle sweep's cadence (sync/settle-sweep.ts) ────────────────────────────────────────

function settleIntervalMs(bucket: Bucket): number {
  return (
    (bucket === 'cold' ? config.syncSettleColdIntervalSec : config.syncSettleIntervalSec) * 1000
  );
}

/**
 * Is the repo due a settle read at `now`? Hot and warm repos every `syncSettleIntervalSec`
 * (5 min), cold ones every `syncSettleColdIntervalSec` (15 min). A repo never read is due at
 * once, so the first sweep after a boot reads everything (changes made while the app was shut).
 */
export function isSettleDue(repoId: number, now: number): boolean {
  const c = cadence.get(repoId);
  if (!c || c.lastSettleAt === 0) return true;
  return now - c.lastSettleAt >= settleIntervalMs(bucketFor(repoId, now));
}

/**
 * Stamp that the settle sweep read this repo (`answered`), or tried and failed for a non-limit
 * reason (still stamped, so a GitHub fault is not re-asked on every tick — but not "checked").
 */
export function noteSettle(repoId: number, now: number, answered = true): void {
  const c = ensure(repoId, now);
  c.lastSettleAt = now;
  if (answered) c.lastCheckedAt = now;
}

/** When GitHub last answered for this repo (probe, scheduled walk or settle read), or null. */
export function lastCheckedAtFor(repoId: number): Date | null {
  const at = cadence.get(repoId)?.lastCheckedAt ?? 0;
  return at > 0 ? new Date(at) : null;
}

/**
 * Decorate a repo listing with `lastCheckedAt` (ISO). In memory, lost on restart; a repo never
 * checked by this process gets NO key (the field is optional on the wire), never null. The ids
 * come from the caller's own account-scoped listing, so no other tenant's repo can be read.
 */
export function withLastChecked<T extends { id: number }>(
  rows: T[],
): Array<T & { lastCheckedAt?: string }> {
  return rows.map((r) => {
    const at = lastCheckedAtFor(r.id);
    return at ? { ...r, lastCheckedAt: at.toISOString() } : r;
  });
}

/** Test-only: clear all in-memory cadence state. */
export function __resetAdaptiveState(): void {
  cadence.clear();
}
