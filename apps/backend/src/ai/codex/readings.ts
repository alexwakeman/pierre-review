// PURE folds over what `codex app-server` answers (docs/CODEX-SPIKE.md § 6; the shapes are 0.164.0's
// generated protocol schemas, `GetAccountResponse`, `GetAccountRateLimitsResponse`,
// `GetAccountTokenUsageResponse`). Every parser answers null on a shape it does not recognise —
// "no reading", which never blocks anything — and never throws.
import type { AiAccountTokenSpan, AiUsageReading, AiUsageWindowReading } from '@pierre-review/shared';

export interface CodexAccountInfo {
  /** A live sign-in (`account/read` with `refreshToken: true` answered an account). */
  signedIn: boolean;
  /** 'chatgpt' (a ChatGPT plan), 'apiKey' (a key stored by `codex login --with-api-key`), or another
   *  kind Limn does not use. Null when signed out. */
  type: string | null;
  /** The ChatGPT plan ('plus', 'pro', 'team', …), or null. */
  plan: string | null;
}

const SIGNED_OUT: CodexAccountInfo = { signedIn: false, type: null, plan: null };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `account/read` → signed in or not. ⚠ `account: null` is the ONLY "signed out" — `codex login status`
 * exits 0 for a dead sign-in (the spike's January login), so it is never asked.
 */
export function parseCodexAccount(raw: unknown): CodexAccountInfo | null {
  if (!isObj(raw) || (!('account' in raw) && !('requiresOpenaiAuth' in raw))) return null;
  const account = raw.account;
  if (account == null) return SIGNED_OUT;
  if (!isObj(account) || typeof account.type !== 'string') return null;
  const plan = typeof account.planType === 'string' && account.planType !== 'unknown' ? account.planType : null;
  return { signedIn: true, type: account.type, plan };
}

/** Codex's two windows, by their LENGTH (not by the primary/secondary naming). */
export const CODEX_FIVE_HOUR_WINDOW_MINS = 300;
export const CODEX_WEEK_WINDOW_MINS = 10080;

function windowOf(w: unknown, observedAtMs: number): { mins: number; reading: AiUsageWindowReading } | null {
  if (!isObj(w)) return null;
  const used = w.usedPercent;
  const mins = w.windowDurationMins;
  const resets = w.resetsAt;
  if (typeof mins !== 'number') return null;
  return {
    mins,
    reading: {
      // Codex's own figure, ALREADY 0–100, and a WHOLE number (docs/CODEX-SPIKE.md § 6).
      utilization: typeof used === 'number' && Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : null,
      // Unix SECONDS on this path.
      resetsAtMs: typeof resets === 'number' && Number.isFinite(resets) ? resets * 1000 : null,
      observedAtMs,
    },
  };
}

/**
 * `account/rateLimits/read` → ONE normalised AiUsageReading: the 300-minute window is `fiveHour`, the
 * 10080-minute window is `week`, `planType` is the subscription. Null when neither window is there.
 */
export function readingFromCodexRateLimits(raw: unknown, nowMs: number): AiUsageReading | null {
  if (!isObj(raw)) return null;
  const limits = isObj(raw.rateLimits) ? raw.rateLimits : null;
  if (!limits) return null;
  const out: AiUsageReading = {};
  for (const key of ['primary', 'secondary'] as const) {
    const w = windowOf(limits[key], nowMs);
    if (!w) continue;
    if (w.mins === CODEX_FIVE_HOUR_WINDOW_MINS) out.fiveHour = w.reading;
    else if (w.mins === CODEX_WEEK_WINDOW_MINS) out.week = w.reading;
  }
  if (!out.fiveHour && !out.week) return null;
  out.subscriptionType = typeof limits.planType === 'string' ? limits.planType : null;
  return out;
}

export interface CodexDailyTokens {
  /** Start of the day, epoch ms (the bucket's `startDate`, read as UTC when it carries no zone). */
  startMs: number;
  tokens: number;
}

export interface CodexTokenUsage {
  /** The account's lifetime token count, or null when not reported. */
  lifetimeTokens: number | null;
  /** Daily buckets, or null when not reported. */
  daily: CodexDailyTokens[] | null;
}

/** A bucket's `startDate` → epoch ms. A bare date (`2026-10-25`) is that day in UTC. */
export function parseBucketStart(s: string): number | null {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const t = Date.parse(bare ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
}

/** `account/usage/read` → the lifetime count and the daily buckets. Null on an unknown shape. */
export function parseCodexTokenUsage(raw: unknown): CodexTokenUsage | null {
  if (!isObj(raw) || !isObj(raw.summary)) return null;
  const life = raw.summary.lifetimeTokens;
  let daily: CodexDailyTokens[] | null = null;
  if (Array.isArray(raw.dailyUsageBuckets)) {
    daily = [];
    for (const b of raw.dailyUsageBuckets) {
      if (!isObj(b) || typeof b.startDate !== 'string' || typeof b.tokens !== 'number') continue;
      const startMs = parseBucketStart(b.startDate);
      if (startMs != null && Number.isFinite(b.tokens) && b.tokens >= 0) daily.push({ startMs, tokens: b.tokens });
    }
  }
  return {
    lifetimeTokens: typeof life === 'number' && Number.isFinite(life) && life >= 0 ? life : null,
    daily,
  };
}

/** One observation of the account's lifetime token count. */
export interface LifetimeSample {
  atMs: number;
  lifetimeTokens: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old a sample taken BEFORE a window may be and still count as that window's start: the probe's
 * interval (5 minutes, ai/codex/app-server.ts) plus slack. An older one would put tokens the account
 * spent BEFORE the window into the count, which makes Limn's share look SMALLER — the unsafe side.
 */
export const START_SAMPLE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * THE ACCOUNT'S TOKENS OVER A SPAN THAT STARTS AS CLOSE TO `fromMs` AS IS KNOWN, and that span's
 * start — the denominator of the token-weighted share (docs/CODEX-PLAN.md § 6). ⚠ The caller counts
 * LIMN'S tokens from the SAME `fromMs` (and `inclusive`) it returns, never from the window's own
 * start: numerator and denominator over two different spans was the over-attribution this replaced
 * (samples live in memory, so after a restart or a sign-in the account was counted over an hour while
 * Limn's ledger was counted over the whole week). Pure.
 *
 *   1. EXACT: a sample at or before `fromMs`, taken no more than `maxStartAgeMs` before it → the newest
 *      sample's count minus that one's, from the sample's time (Limn's rows AFTER it).
 *   2. A SHORTER SPAN, when no such sample exists but two or more fall inside the window: newest minus
 *      oldest, from the OLDEST INSIDE sample's time.
 *   3. DAILY BUCKETS, for a window of a day or more only: every bucket overlapping the window, from
 *      the first such bucket's start (Limn's rows from then on, that start included). Never for the
 *      5-hour window. (Measured 2026-10-25 on a Plus account: `dailyUsageBuckets` came back EMPTY.)
 *   4. null — unknown. The share is then UNKNOWN too (null, which never blocks).
 */
export function accountTokensInWindow(
  samples: readonly LifetimeSample[],
  daily: readonly CodexDailyTokens[] | null,
  fromMs: number,
  toMs: number,
  maxStartAgeMs: number = START_SAMPLE_MAX_AGE_MS,
): AiAccountTokenSpan | null {
  if (!(toMs > fromMs)) return null;
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
  const newest = sorted.filter((s) => s.atMs <= toMs).at(-1);
  const before = sorted.filter((s) => s.atMs <= fromMs).at(-1);
  if (before && newest && fromMs - before.atMs <= maxStartAgeMs) {
    return { tokens: Math.max(0, newest.lifetimeTokens - before.lifetimeTokens), fromMs: before.atMs, inclusive: false };
  }
  const inside = sorted.filter((s) => s.atMs > fromMs && s.atMs <= toMs);
  if (inside.length >= 2) {
    return { tokens: Math.max(0, inside.at(-1)!.lifetimeTokens - inside[0]!.lifetimeTokens), fromMs: inside[0]!.atMs, inclusive: false };
  }
  if (daily && daily.length > 0 && toMs - fromMs >= DAY_MS) {
    const hit = daily.filter((b) => b.startMs + DAY_MS > fromMs && b.startMs <= toMs);
    if (hit.length > 0) {
      return {
        tokens: hit.reduce((s, b) => s + b.tokens, 0),
        fromMs: Math.min(...hit.map((b) => b.startMs)),
        inclusive: true,
      };
    }
  }
  return null;
}

