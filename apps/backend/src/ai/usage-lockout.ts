// A PROVIDER'S USAGE LIMIT IS A LOCKOUT, NOT A TRANSIENT FAILURE (docs/CLAUDE-REVIEW.md § Claude +
// Codex → Usage limits). When Codex answers "You've hit your usage limit … try again at 8:54 PM",
// every Codex run until then fails the same way. Real (2026-11-02, PR 199965): a teammate's Limn held
// the Claude half, so the auto review ran Codex alone, which failed three times a minute apart.
//
// While a provider is locked out:
//   • an AUTOMATIC run never starts on it — a pair runs its other half alone; a single run whose
//     default provider is locked moves to the other provider when that one is ready, else it is
//     SKIPPED (no row, not a failure; the sweeper re-derives it later);
//   • the auto-review retry rule does not retry a usage-limit failure of that provider;
//   • a READER'S press is never blocked: the Run area shows one line ("Codex is over its usage
//     limit until 8:54 PM.") and the press runs.
//
// IN MEMORY, per process. A boot re-derives it from the newest failed review row
// (`restoreUsageLockouts`). The lock ends at the reset the error names (`parseRetryAtMs`: "try again
// at 8:54 PM", "try again in 45 minutes", an epoch), else LOCKOUT_DEFAULT_MS after the failure.
import type { AiProviderId } from '@pierre-review/shared';
import { parseRetryAtMs } from '../review/claude-review/auto-retry.js';

/** How long a usage limit locks a provider out when its error names no reset time. */
export const LOCKOUT_DEFAULT_MS = 60 * 60 * 1000;
/** A lock never runs longer than this (a misread date must not lock a provider out for a month). */
export const LOCKOUT_MAX_MS = 8 * 24 * 60 * 60 * 1000;

// ⚠ NARROWER than auto-retry's USAGE_LIMIT: a plain rate limit, a 429 or "too many requests" is a
// short throttle, not a lockout. Only the account's own usage allowance being used up locks it out.
// Linear (no nested quantifiers): it runs over provider text.
const LOCKOUT = /usage limit|hit your (?!rate)[\w'’ ]{0,30}limit|out of (?:usage )?credits|quota exceeded/i;

/** Does this error say the provider's usage allowance is used up? */
export function isUsageLockoutError(error: string | null | undefined): boolean {
  const e = (error ?? '').slice(0, 2000);
  return e.trim() !== '' && LOCKOUT.test(e);
}

/**
 * When the lockout this error describes ends (ms), or null when the error is not a usage limit.
 * The reset the error names when it names one (never before the failure), else the default.
 */
export function lockoutUntilFromError(error: string | null | undefined, failedAtMs: number): number | null {
  if (!isUsageLockoutError(error)) return null;
  const named = parseRetryAtMs(error, failedAtMs);
  const until = named != null && named > failedAtMs ? named : failedAtMs + LOCKOUT_DEFAULT_MS;
  return Math.min(until, failedAtMs + LOCKOUT_MAX_MS);
}

export interface UsageLockout {
  untilMs: number;
}

const locks = new Map<AiProviderId, UsageLockout>();

/**
 * Record a failure of `provider` when it is a usage limit (any other error is ignored). A later
 * reset replaces an earlier one; an earlier one never shortens a lock already held.
 */
export function noteProviderFailure(provider: AiProviderId, error: string | null | undefined, atMs: number = Date.now()): void {
  const until = lockoutUntilFromError(error, atMs);
  if (until == null) return;
  const held = locks.get(provider);
  if (!held || held.untilMs < until) locks.set(provider, { untilMs: until });
}

/** The provider's lockout now, or null (an ended lock is forgotten). */
export function usageLockout(provider: AiProviderId, nowMs: number = Date.now()): UsageLockout | null {
  const held = locks.get(provider);
  if (!held) return null;
  if (held.untilMs <= nowMs) {
    locks.delete(provider);
    return null;
  }
  return held;
}

/** Is any provider locked out now? (cheap: lets a caller skip resolving the default provider). */
export function anyUsageLockout(nowMs: number = Date.now()): boolean {
  for (const p of [...locks.keys()]) if (usageLockout(p, nowMs)) return true;
  return false;
}

export function isLockedOut(provider: AiProviderId, nowMs: number = Date.now()): boolean {
  return usageLockout(provider, nowMs) != null;
}

/** Forget a lock (a new sign-in) — and the test hook (no provider ⇒ all). */
export function clearUsageLockout(provider?: AiProviderId): void {
  if (provider) locks.delete(provider);
  else locks.clear();
}

/**
 * WHICH PROVIDERS AN AUTOMATIC RUN USES (pure). `pair`: the workspace asks for Claude + Codex.
 *   • a pair ⇒ every provider in `order` that is ready and not locked out (two ⇒ a pair, one ⇒ alone);
 *   • a single run ⇒ the default, unless it is LOCKED OUT: then the other provider when it is ready
 *     and not locked, else none (skipped). A default that is merely not ready is the caller's
 *     existing wait (it is not moved).
 * Empty ⇒ do not run now.
 */
export function automaticRunProviders(opts: {
  defaultProvider: AiProviderId;
  pair: boolean;
  order: readonly AiProviderId[];
  ready: (p: AiProviderId) => boolean;
  locked: (p: AiProviderId) => boolean;
}): AiProviderId[] {
  const { defaultProvider, pair, order, ready, locked } = opts;
  if (pair) return order.filter((p) => ready(p) && !locked(p));
  if (!locked(defaultProvider)) return [defaultProvider];
  const other = order.find((p) => p !== defaultProvider && ready(p) && !locked(p));
  return other ? [other] : [];
}

/** The SPA's one line (`MeResponse.ai.providers.<p>.usageLockedUntil`), as ISO-8601, or null. */
export function usageLockedUntilIso(provider: AiProviderId, nowMs: number = Date.now()): string | null {
  const l = usageLockout(provider, nowMs);
  return l ? new Date(l.untilMs).toISOString() : null;
}

/**
 * THE BOOT'S RE-DERIVATION: the newest failed review row per provider, from the last
 * LOCKOUT_MAX_MS. Each is noted at its finish time (a lock already over is not kept). Never throws.
 */
export async function restoreUsageLockouts(
  read: () => Promise<Array<{ provider: string | null; error: string | null; finishedAtMs: number | null }>>,
): Promise<void> {
  try {
    for (const r of await read()) {
      if (r.provider !== 'claude' && r.provider !== 'codex') continue;
      if (r.finishedAtMs == null) continue;
      noteProviderFailure(r.provider, r.error, r.finishedAtMs);
      usageLockout(r.provider); // drops it at once when it has already ended
    }
  } catch {
    /* a lock is an optimisation: never fails a boot */
  }
}
