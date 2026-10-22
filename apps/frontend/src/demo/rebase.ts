// TIME REBASE — makes recorded data look current.
//
// delta = (the moment the demo loaded) − (the recording's capturedAt). Then, in every recorded
// body:
//   1. every string that is a full ISO-8601 timestamp (a date AND a time, with `Z` or an offset,
//      e.g. `2026-10-20T09:15:00.000Z`) is shifted by delta and written back as `toISOString()`;
//   2. every NUMBER under a key ending in `At` or `Ms` (`createdAt`, `resumeAtMs`, `fromMs`) that
//      lies within ±3 years of capturedAt is read as epoch milliseconds and shifted by delta.
// Nothing else moves. A duration (`waitMs: 5400000`) is nowhere near capturedAt as an epoch, so
// rule 2 leaves it alone; a date with no time (`2026-10-20`, a period key such as
// `sprint-2026-10-06`) is not a timestamp and is left as recorded, because the SPA sends those
// back in request paths and they must still match the recording.

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const THREE_YEARS_MS = 3 * 366 * 86_400_000;
const EPOCH_KEY = /(At|Ms)$/;

export interface Rebaser {
  readonly deltaMs: number;
  /** A deep copy of `value` with every timestamp shifted. */
  rebase<T>(value: T): T;
  /** Shift one ISO timestamp string (returned unchanged when it is not one). */
  shiftIso(value: string): string;
}

export function makeRebaser(capturedAt: string, nowMs: number): Rebaser {
  const capturedMs = Date.parse(capturedAt);
  const deltaMs = Number.isFinite(capturedMs) ? nowMs - capturedMs : 0;
  const lo = capturedMs - THREE_YEARS_MS;
  const hi = capturedMs + THREE_YEARS_MS;

  const shiftIso = (s: string): string => {
    if (deltaMs === 0 || !ISO_TIMESTAMP.test(s)) return s;
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t + deltaMs).toISOString() : s;
  };

  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') return shiftIso(v);
    if (typeof v === 'number') {
      if (deltaMs !== 0 && key != null && EPOCH_KEY.test(key) && Number.isFinite(v) && v >= lo && v <= hi) {
        return v + deltaMs;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v != null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };

  return {
    deltaMs,
    rebase: <T>(value: T): T => walk(value, null) as T,
    shiftIso,
  };
}
