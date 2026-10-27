// AUTO REVIEW RETRIES — the pure halves the ONE start rule (`autoReviewDue`, auto.ts) reads when the
// latest AUTO run at a PR's current head FAILED. Nothing here decides on its own: auto.ts folds these
// into "due now / wait / never by itself".
//
//   • `classifyAutoReviewFailure` — is the stored error TRANSIENT (a usage or rate limit, an overload,
//     a network or timeout failure, a sign-in or runtime problem, a restart) or FINAL (a per-review
//     budget or turn cap, a validation failure, a refusal, a diff GitHub will not serve)? An error it
//     does not recognise is FINAL: an automatic retry must never re-bill a failure that would repeat.
//   • `parseRetryAtMs` — the reset time the error itself names ("try again at 5:04 PM", Claude's
//     "limit reached|<epoch>", "try again in 2 hours").
//   • `usageResetFromReading` — the reset time the provider's usage reading names, when the error
//     did not.
//
// ⚠ Every regex here runs over provider text: each is linear (no nested quantifiers).
import type { AiUsageReading, AiUsageWindowReading } from '@pierre-review/shared';

export type AutoReviewFailureKind = 'usage_limit' | 'transient' | 'final';

/** At most this many AUTOMATIC attempts per (PR, head); a reader's press waives it. */
export const AUTO_RETRY_MAX_ATTEMPTS = 3;
/** The wait after the 1st failure, and after every later one (when no reset time is known). */
export const AUTO_RETRY_BACKOFF_FIRST_MS = 60 * 60 * 1000;
export const AUTO_RETRY_BACKOFF_LATER_MS = 4 * 60 * 60 * 1000;

const USAGE_LIMIT =
  /usage limit|rate[ _-]?limit|limit reached|hit your (?:usage )?limit|too many requests|\b429\b|quota exceeded|out of credits/i;
const TRANSIENT = new RegExp(
  [
    'overloaded',
    '(?:api error|http|status)[: ]{1,3}5\\d\\d\\b',
    'timed out',
    'timeout',
    'etimedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'socket hang up',
    'fetch failed',
    'network error',
    'connection (?:reset|refused|error|closed)',
    'service unavailable',
    'temporarily unavailable',
    'interrupted by restart',
    'not signed in',
    'signed out',
    'failed to authenticate',
    'authentication',
    'oauth',
    'no credential',
    'not installed',
    'runtime (?:is )?(?:missing|not ready)',
    'spend budget',
  ].join('|'),
  'i',
);

/** Transient (retry later) or final (never retried automatically). Null/empty reads as final. */
export function classifyAutoReviewFailure(error: string | null | undefined): AutoReviewFailureKind {
  const e = (error ?? '').slice(0, 2000);
  if (e.trim() === '') return 'final';
  if (USAGE_LIMIT.test(e)) return 'usage_limit';
  if (TRANSIENT.test(e)) return 'transient';
  return 'final';
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/**
 * The time the error says the limit lifts, in ms, or null when it names none. Times of day are read
 * in this machine's local time (the provider prints the reader's), as the NEXT such moment after
 * the failure.
 */
export function parseRetryAtMs(error: string | null | undefined, failedAtMs: number): number | null {
  const e = (error ?? '').slice(0, 2000);
  if (e === '') return null;
  // Claude Code: "Claude AI usage limit reached|1793040000" (epoch seconds or ms).
  const epoch = /\|(\d{10,13})\b/.exec(e);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n < 1e12 ? n * 1000 : n;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  // "try again in 2 hours 5 minutes" / "resets in 45m".
  const inAt = /(?:try again|retry|resets?|available again) in\b/i.exec(e);
  if (inAt) {
    const tail = e.slice(inAt.index + inAt[0].length, inAt.index + inAt[0].length + 60);
    let total = 0;
    for (const m of tail.matchAll(/(\d{1,4})\s?(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])\b/gi)) {
      const unit = (m[2] ?? '').toLowerCase()[0] ?? '';
      total += Number(m[1]) * (UNIT_MS[unit] ?? 0);
    }
    if (total > 0) return failedAtMs + total;
  }
  // "try again at 5:04 PM", "try again at Oct 29th, 2026 5:04 PM", "resets 3pm", "resets at 17:04".
  const at =
    /(?:try again at|resets? at|resets|available again at)\s{1,3}(?:([a-z]{3})[a-z]{0,6}\.?\s{1,3}(\d{1,2})(?:st|nd|rd|th)?,?\s{0,3}(\d{4})?,?\s{0,3}(?:at\s{1,3})?)?(\d{1,2})(?::(\d{2}))?\s{0,2}([ap])?\.?m?\b/i.exec(
      e,
    );
  if (at) {
    const [, mon, day, year, hh, mm, ampm] = at;
    if (mm == null && ampm == null) return null; // "resets 3" — not a time
    let hour = Number(hh);
    const minute = mm != null ? Number(mm) : 0;
    if (ampm != null) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return null;
    const d = new Date(failedAtMs);
    const monthIdx = mon != null ? MONTHS[mon.toLowerCase()] : undefined;
    if (mon != null && monthIdx === undefined) return null;
    if (monthIdx !== undefined && day != null) {
      d.setFullYear(year != null ? Number(year) : d.getFullYear(), monthIdx, Number(day));
    }
    d.setHours(hour, minute, 0, 0);
    let ms = d.getTime();
    if (ms <= failedAtMs) {
      if (monthIdx !== undefined && year == null) {
        d.setFullYear(d.getFullYear() + 1);
        ms = d.getTime();
      } else if (monthIdx === undefined) {
        ms += 86_400_000;
      }
    }
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * The reset the provider's usage reading names for a limit hit at `failedAtMs`: the LATEST reset of
 * the windows it reports exhausted (all of them must lift); else, when a reading observed AFTER the
 * failure shows no window exhausted, that observation (the limit had lifted by then); else null.
 */
export function usageResetFromReading(reading: AiUsageReading | null | undefined, failedAtMs: number): number | null {
  if (reading == null) return null;
  const windows: AiUsageWindowReading[] = [
    reading.week,
    reading.fiveHour,
    ...Object.values(reading.models ?? {}),
  ].filter((w): w is AiUsageWindowReading => w != null);
  const exhausted = windows.filter((w) => w.utilization != null && w.utilization >= 100 && w.resetsAtMs != null);
  if (exhausted.length > 0) return Math.max(...exhausted.map((w) => w.resetsAtMs as number));
  const after = windows.filter((w) => w.utilization != null && w.observedAtMs > failedAtMs);
  if (after.length > 0) return Math.min(...after.map((w) => w.observedAtMs));
  return null;
}
