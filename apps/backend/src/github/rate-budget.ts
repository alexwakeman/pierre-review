// In-memory per-ACCOUNT GitHub rate budget — the pre-emptive half of rate-limit handling.
//
// Every sync walk page already reports `rateLimit { remaining resetAt cost }`; this module
// is where that goes. The walks (sync-repo, the CI-history backfill, trunk-history
// pagination) call `gateBudget` at their loop tops: when the account's remaining budget is
// under a floor, or a hard limit was observed (`noteLimited` — fed by `isRateLimitError`
// classifications), the walk PAUSES — a cancellable sleep until the reset — instead of
// slamming into GitHub's hard 403 and surfacing a red error for a condition that resolves
// itself. The cheap consumers (adaptive probes, the PR-detail refresh poll) just ask
// `isLimited` and skip their tick.
//
// Deliberately IN-MEMORY, keyed by accountId, on the sync/auth-notices.ts pattern: the
// budget is a property of the account's ONE token, it self-heals (GitHub's windows are
// hourly), and after a restart the first walk page re-seeds it. Cloud's single Fastify
// process means the sync that writes this and every sibling that reads it share the map.

interface AccountRateBudget {
  // Points left in the primary GraphQL window, from the last observed `rateLimit` block.
  // null = never observed / presumed reset.
  remaining: number | null;
  // When GitHub said the primary window resets.
  resetAt: Date | null;
  // Set when a request actually came back rate-limited (primary exhausted or the
  // secondary/abuse limiter) — nothing on this account's token should run until then.
  limitedUntil: Date | null;
}

const budgets = new Map<number, AccountRateBudget>();

// Walks pause pre-emptively when fewer than this many points remain. The fat activity
// query costs ~1 point/page but the commit-files REST fan-out and sibling walks share the
// same account, so the floor leaves headroom for them (and for the user's own clicks).
export const RATE_BUDGET_FLOOR = 100;

// A limited error with no Retry-After / reset header waits this long before re-trying.
const DEFAULT_LIMITED_MS = 60_000;

// Defensive clamp on any wait target — GitHub's windows are hourly, so anything longer is
// a corrupt header, and an unbounded sleep would pin a sync slot for days.
const MAX_WAIT_MS = 65 * 60_000;

// Small random spread added to every wait target so N queued walks waking at the same
// reset instant don't stampede the API in the same millisecond.
const JITTER_MS = 2_000;

function ensure(accountId: number): AccountRateBudget {
  let b = budgets.get(accountId);
  if (!b) {
    b = { remaining: null, resetAt: null, limitedUntil: null };
    budgets.set(accountId, b);
  }
  return b;
}

/**
 * Feed the budget from a SUCCESSFUL response's `rateLimit` block (every walk page reports
 * one). Deliberately does NOT clear `limitedUntil`: the REST secondary/abuse limiter is
 * independent of the GraphQL primary window, so a GraphQL page landing proves nothing
 * about a REST-observed block (noteLimited from ensureCommitFiles). `limitedUntil` is
 * time-bounded and self-expiring anyway — gateBudget clears it once the window passes.
 */
export function noteBudget(
  accountId: number,
  info: { remaining: number | null; resetAt: Date | null },
): void {
  const b = ensure(accountId);
  if (info.remaining != null) b.remaining = info.remaining;
  if (info.resetAt != null) b.resetAt = info.resetAt;
}

/**
 * Record that a request actually came back rate-limited. `until` is the classifier's
 * resume estimate (Retry-After / x-ratelimit-reset) when one was present; null falls back
 * to a conservative minute.
 */
export function noteLimited(accountId: number, until: Date | null): void {
  const b = ensure(accountId);
  const now = Date.now();
  const target =
    until != null && until.getTime() > now ? until.getTime() : now + DEFAULT_LIMITED_MS;
  b.limitedUntil = new Date(Math.min(target, now + MAX_WAIT_MS));
}

/** True while a hard limit is known to be in effect for this account's token. */
export function isLimited(accountId: number): boolean {
  const b = budgets.get(accountId);
  return b?.limitedUntil != null && b.limitedUntil.getTime() > Date.now();
}

/**
 * Wait out the account's budget window, if any. Returns 'ok' immediately when the budget
 * is healthy (the overwhelmingly common case — no timers, no allocation). Otherwise:
 *
 *   - the wait target is the LATEST of the applicable signals (the primary window's
 *     `resetAt` when under the floor; `limitedUntil` when hard-limited), falling back to
 *     one minute when neither carries a usable time, plus a small jitter;
 *   - `onWait(resumeAt)` fires ONCE when the wait begins, so the caller can surface
 *     `progress.paused` — and clear it when this resolves 'ok';
 *   - the sleep runs in ≤1s slices, each checking `shouldCancel` — a user cancel returns
 *     'cancelled' immediately, and the caller bails exactly like any cancelled walk;
 *   - on expiry the stale state is cleared (the window is presumed reset) so the next
 *     real `rateLimit` observation re-seeds it rather than re-gating forever.
 */
export async function gateBudget(
  accountId: number,
  opts: {
    shouldCancel?: () => boolean;
    onWait?: (resumeAt: Date) => void;
    floor?: number;
  } = {},
): Promise<'ok' | 'cancelled'> {
  const floor = opts.floor ?? RATE_BUDGET_FLOOR;
  const b = budgets.get(accountId);
  if (!b) return 'ok';
  const now = Date.now();
  const limited = b.limitedUntil != null && b.limitedUntil.getTime() > now;
  const underFloor = b.remaining != null && b.remaining < floor;
  if (!limited && !underFloor) return 'ok';

  const signals: number[] = [];
  if (limited) signals.push(b.limitedUntil!.getTime());
  if (underFloor && b.resetAt != null) signals.push(b.resetAt.getTime());
  const base = signals.length > 0 ? Math.max(...signals) : now + DEFAULT_LIMITED_MS;
  const target =
    Math.min(Math.max(base, now + 1_000), now + MAX_WAIT_MS) +
    Math.floor(Math.random() * JITTER_MS);

  opts.onWait?.(new Date(target));
  while (Date.now() < target) {
    if (opts.shouldCancel?.()) return 'cancelled';
    const slice = Math.min(1_000, target - Date.now());
    await new Promise((r) => setTimeout(r, slice));
  }
  if (opts.shouldCancel?.()) return 'cancelled';

  // The wait ran out — the window is presumed reset. Clear whatever gated us so the walk
  // proceeds and the next page's real `rateLimit` block re-seeds the budget; leaving the
  // stale numbers in place would re-enter this gate on every page forever.
  const cur = budgets.get(accountId);
  if (cur) {
    const t = Date.now();
    if (cur.limitedUntil != null && cur.limitedUntil.getTime() <= t) cur.limitedUntil = null;
    if (
      cur.remaining != null &&
      cur.remaining < floor &&
      (cur.resetAt == null || cur.resetAt.getTime() <= t)
    ) {
      cur.remaining = null;
      cur.resetAt = null;
    }
  }
  return 'ok';
}

/** Test-only: clear all in-memory budget state. */
export function __resetRateBudget(): void {
  budgets.clear();
}
