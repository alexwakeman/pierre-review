// CLAUDE'S USAGE READING, normalised (docs/CODEX-PLAN.md § 8.1) — moved here from ai/budget.ts
// unchanged when the provider seam landed, and re-exported from there under the same names. The
// spend budget folds ONE `AiUsageReading` per provider; these are Claude's two sources:
//   • every agent run's `rate_limit_event` (ai/runtime.ts taps every Query): utilisation is a 0–1
//     FRACTION on this path (the CLI's header parsing), converted to 0–100 here, explicitly;
//   • the Agent SDK's EXPERIMENTAL usage method (the probe in ./claude.ts): utilisation ALREADY
//     0–100 (measured on a real login) and kept as-is.
// There is no shared "≤ 1 means a fraction" guess: each path knows its own scale. Pure throughout.
import type { AiUsageReading, AiUsageWindowReading } from '@pierre-review/shared';

/** At most this many per-model windows are kept from one reading. */
export const MAX_MODEL_WINDOWS = 8;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Epoch seconds or ms → ms. */
function epochMs(v: unknown): number | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** A `rate_limit_event` utilisation is a 0–1 FRACTION (the CLI parses it from the rate-limit header):
 *  → 0–100, explicitly. Out of range or not a number → null. */
function eventFractionToPct(v: unknown): number | null {
  const n = num(v);
  if (n == null || n < 0 || n > 1.5) return null;
  return n * 100;
}

/** Claude's window keys this module keeps: the 5-hour, the week, and per-model weeks. */
const MODEL_WINDOW_KEY = /^seven_day_[a-z0-9_]{1,40}$/;

/** Put one window into a reading under Claude's key. Unknown keys are ignored. Pure. */
function withWindow(reading: AiUsageReading, key: string, w: AiUsageWindowReading): AiUsageReading {
  if (key === 'five_hour') return { ...reading, fiveHour: w };
  if (key === 'seven_day') return { ...reading, week: w };
  if (MODEL_WINDOW_KEY.test(key)) {
    const models = { ...(reading.models ?? {}) };
    if (!(key in models) && Object.keys(models).length >= MAX_MODEL_WINDOWS) return reading;
    models[key] = w;
    return { ...reading, models };
  }
  return reading;
}

const isWindowKey = (k: string): boolean => k === 'five_hour' || k === 'seven_day' || MODEL_WINDOW_KEY.test(k);

/**
 * Fold one Agent SDK message into the reading. Returns the NEW reading (the windows this message names
 * merged over the rest), or null when the message names none. Pure.
 *
 * Reads `rate_limit_event.rate_limit_info`: every window in `unifiedWindows` (when the CLI sends
 * them) and otherwise the one named by `rateLimitType` ('five_hour', 'seven_day', 'seven_day_opus',
 * …). Reset times arrive in epoch seconds. Utilisation is a fraction on this path.
 */
export function foldRateLimitEvent(
  reading: AiUsageReading | null,
  message: unknown,
  nowMs: number,
): AiUsageReading | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { type?: unknown; rate_limit_info?: unknown };
  if (m.type !== 'rate_limit_event' || !m.rate_limit_info || typeof m.rate_limit_info !== 'object') return null;
  const info = m.rate_limit_info as {
    status?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    resetsAt?: unknown;
    unifiedWindows?: unknown;
  };
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object'
    ? (info.unifiedWindows as Record<string, unknown>)
    : null;
  const sources: Array<[string, { utilization?: unknown; resetsAt?: unknown; status?: unknown }]> = [];
  if (unified) {
    for (const [k, v] of Object.entries(unified)) {
      if (isWindowKey(k) && v && typeof v === 'object') sources.push([k, v as { utilization?: unknown }]);
    }
  } else if (typeof info.rateLimitType === 'string' && isWindowKey(info.rateLimitType)) {
    sources.push([info.rateLimitType, info]);
  }
  let out: AiUsageReading = {};
  let any = false;
  for (const [key, src] of sources) {
    let utilization = eventFractionToPct(src.utilization);
    if (utilization == null && src.status === 'rejected') utilization = 100;
    const resetsAtMs = epochMs(src.resetsAt);
    if (utilization == null && resetsAtMs == null) continue;
    out = withWindow(out, key, { utilization, resetsAtMs, observedAtMs: nowMs });
    any = true;
  }
  return any ? mergeReadings(reading, out) : null;
}

/** Parse the experimental usage method's answer. Its utilisation is ALREADY 0–100 (measured on a
 *  real login: `seven_day.utilization: 31`) and is kept as-is. Null on any shape mismatch. Pure. */
export function parseUsageProbe(resp: unknown, nowMs: number): AiUsageReading | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as { rate_limits_available?: unknown; rate_limits?: unknown; subscription_type?: unknown };
  const subscriptionType = typeof r.subscription_type === 'string' && r.subscription_type !== '' ? r.subscription_type : null;
  let out: AiUsageReading = {};
  let any = false;
  if (r.rate_limits_available === true && r.rate_limits && typeof r.rate_limits === 'object') {
    for (const [key, v] of Object.entries(r.rate_limits as Record<string, unknown>)) {
      if (!isWindowKey(key) || !v || typeof v !== 'object') continue;
      const o = v as { utilization?: unknown; resets_at?: unknown };
      const u = num(o.utilization);
      const t = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : NaN;
      const utilization = u != null && u >= 0 && u <= 150 ? u : null;
      const resetsAtMs = Number.isFinite(t) ? t : null;
      if (utilization == null && resetsAtMs == null) continue;
      out = withWindow(out, key, { utilization, resetsAtMs, observedAtMs: nowMs });
      any = true;
    }
  }
  if (!any && subscriptionType == null) return null;
  return { ...out, subscriptionType };
}

function storedWindow(v: unknown): AiUsageWindowReading | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as { utilization?: unknown; resetsAtMs?: unknown; observedAtMs?: unknown };
  const observedAtMs = num(w.observedAtMs);
  return observedAtMs == null ? null : { utilization: num(w.utilization), resetsAtMs: num(w.resetsAtMs), observedAtMs };
}

/** A stored reading of any age → today's shape. Never throws. */
export function normaliseStoredReading(raw: unknown): AiUsageReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { week?: unknown; fiveHour?: unknown; models?: unknown; subscriptionType?: unknown };
  const week = storedWindow(r.week);
  const fiveHour = storedWindow(r.fiveHour);
  let models: Record<string, AiUsageWindowReading> | null = null;
  if (r.models && typeof r.models === 'object') {
    for (const [k, v] of Object.entries(r.models as Record<string, unknown>).slice(0, MAX_MODEL_WINDOWS)) {
      const w = MODEL_WINDOW_KEY.test(k) ? storedWindow(v) : null;
      if (w) (models ??= {})[k] = w;
    }
  }
  const subscriptionType = typeof r.subscriptionType === 'string' ? r.subscriptionType : null;
  if (week == null && fiveHour == null && models == null && subscriptionType == null) return null;
  return { week, fiveHour, models, subscriptionType };
}

/** One window merged: the new one wins, but keeps the known reset when it read none. */
function mergeWindow(
  prev: AiUsageWindowReading | null | undefined,
  next: AiUsageWindowReading | null | undefined,
): AiUsageWindowReading | null {
  if (next == null) return prev ?? null;
  if (next.resetsAtMs == null && prev?.resetsAtMs != null) return { ...next, resetsAtMs: prev.resetsAtMs };
  return next;
}

/** Merge two readings (pure): each window independently; what `next` does not mention is kept (an
 *  event never names the subscription, and names one or two windows). */
export function mergeReadings(prev: AiUsageReading | null, next: AiUsageReading): AiUsageReading {
  const models: Record<string, AiUsageWindowReading> = { ...(prev?.models ?? {}) };
  for (const [k, w] of Object.entries(next.models ?? {})) {
    const merged = mergeWindow(models[k], w);
    if (merged && (k in models || Object.keys(models).length < MAX_MODEL_WINDOWS)) models[k] = merged;
  }
  return {
    week: mergeWindow(prev?.week, next.week),
    fiveHour: mergeWindow(prev?.fiveHour, next.fiveHour),
    models: Object.keys(models).length === 0 ? null : models,
    subscriptionType: next.subscriptionType ?? prev?.subscriptionType ?? null,
  };
}
