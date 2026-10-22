// TIME REBASE — makes recorded data look current.
//
// delta = (the moment the demo loaded) − (the recording's capturedAt). Then, in every recorded body:
//   1. every string that is a full ISO-8601 timestamp (a date AND a time, with `Z` or an offset,
//      e.g. `2026-10-20T09:15:00.000Z`) is shifted by delta and written back as `toISOString()`;
//   2. every NUMBER under a key ending in `At` or `Ms` (`createdAt`, `resumeAtMs`, `fromMs`) that
//      lies within ±3 years of capturedAt is read as epoch milliseconds and shifted by delta.
//
// CALENDAR VALUES MOVE BY WHOLE WEEKS (or whole months), so they stay calendar values AND keep
// their weekday — a Monday week is still a Monday week, a sprint still starts on its weekday:
//   3. a timestamp on an EXACT HOUR (zero minutes, seconds and milliseconds) is a calendar
//      boundary — a period's start, a sprint's dates, a week bucket, at UTC midnight or at a local
//      midnight such as Europe/London's T23:00Z. It moves by `days` = delta rounded to whole WEEKS,
//      so it stays on the same hour and weekday. Recorded event times are almost never on the hour;
//   4. a date with no time (`2026-10-20`) and a sprint period key (`sprint-2026-10-06`) move by the
//      same `days`;
//   5. a month period key (`month-2026-09`) moves by `months`, the whole calendar months between
//      capturedAt and now — so the month that was in progress when the data was captured is the
//      month in progress now. An object carrying a month `periodKey` gets its `periodStart` /
//      `periodEnd` / `cadenceDays` rewritten to the shifted month, so the key and its dates agree,
//      and an in-progress month's `elapsedDays` is recomputed from its shifted start and now.
// Nothing else moves. A duration (`waitMs: 5400000`) is nowhere near capturedAt as an epoch, so
// rule 2 leaves it alone.
//
// THE SPA SENDS PERIOD KEYS BACK in request paths (`/api/pro/insights/reports/sprint-…`), so
// `unshiftPath` undoes rules 4 and 5 on a request's path segments before it is matched against the
// recording. Date-like query values need nothing: matching drops them (recording.ts).

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPRINT_KEY = /^sprint-(\d{4}-\d{2}-\d{2})$/;
const MONTH_KEY = /^month-(\d{4})-(\d{2})$/;
const THREE_YEARS_MS = 3 * 366 * 86_400_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const EPOCH_KEY = /(At|Ms)$/;

export interface Rebaser {
  readonly deltaMs: number;
  /** The days calendar values move by — always a whole number of weeks. */
  readonly days: number;
  /** Whole calendar months a month key moves by. */
  readonly months: number;
  /** A deep copy of `value` with every timestamp shifted. */
  rebase<T>(value: T): T;
  /** Shift one ISO timestamp string (returned unchanged when it is not one). */
  shiftIso(value: string): string;
  /** A request URL (path + query) with every shifted period key / date in its PATH moved back. */
  unshiftPath(url: string): string;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `YYYY-MM-DD` moved by `days`. */
function shiftDate(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00.000Z`);
  return Number.isFinite(t) ? new Date(t + days * DAY_MS).toISOString().slice(0, 10) : ymd;
}

/** `YYYY`, `MM` moved by `months` → `{ y, m }` (m 1-12). */
function shiftMonth(y: number, m: number, months: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + months;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

function shiftMonthKey(key: string, months: number): string {
  const mm = MONTH_KEY.exec(key);
  if (!mm) return key;
  const { y, m } = shiftMonth(Number(mm[1]), Number(mm[2]), months);
  return `month-${pad(y, 4)}-${pad(m)}`;
}

export function makeRebaser(capturedAt: string, nowMs: number): Rebaser {
  const capturedMs = Date.parse(capturedAt);
  const deltaMs = Number.isFinite(capturedMs) ? nowMs - capturedMs : 0;
  const days = 7 * Math.round(deltaMs / (7 * DAY_MS));
  const months = (() => {
    if (!Number.isFinite(capturedMs)) return 0;
    const a = new Date(capturedMs);
    const b = new Date(nowMs);
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  })();
  const lo = capturedMs - THREE_YEARS_MS;
  const hi = capturedMs + THREE_YEARS_MS;

  /** Rule 3: an exact-hour instant is a calendar boundary and moves by whole weeks. */
  const shiftEpoch = (t: number): number => (t % HOUR_MS === 0 ? t + days * DAY_MS : t + deltaMs);

  const shiftIso = (s: string): string => {
    if (deltaMs === 0 || !ISO_TIMESTAMP.test(s)) return s;
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(shiftEpoch(t)).toISOString() : s;
  };

  const shiftString = (s: string): string => {
    if (deltaMs === 0) return s;
    if (ISO_TIMESTAMP.test(s)) return shiftIso(s);
    if (DATE_ONLY.test(s)) return shiftDate(s, days);
    const sk = SPRINT_KEY.exec(s);
    if (sk) return `sprint-${shiftDate(sk[1]!, days)}`;
    if (MONTH_KEY.test(s)) return shiftMonthKey(s, months);
    return s;
  };

  /** A month period object's start / end / length follow its (already shifted) key. */
  const fixMonthPeriod = (o: Record<string, unknown>): void => {
    const key = o.periodKey;
    if (typeof key !== 'string') return;
    const mm = MONTH_KEY.exec(key);
    if (!mm) return;
    const y = Number(mm[1]);
    const m = Number(mm[2]);
    const start = Date.UTC(y, m - 1, 1);
    const next = shiftMonth(y, m, 1);
    const end = Date.UTC(next.y, next.m - 1, 1);
    if (typeof o.periodStart === 'string') o.periodStart = new Date(start).toISOString();
    if (typeof o.periodEnd === 'string') o.periodEnd = new Date(end).toISOString();
    if (typeof o.cadenceDays === 'number') o.cadenceDays = Math.round((end - start) / DAY_MS);
    // The recorded count is days into the CAPTURE month; the shifted month started elsewhere.
    if (o.inProgress === true && typeof o.elapsedDays === 'number') {
      o.elapsedDays = Math.max(0, Math.min(Math.round((end - start) / DAY_MS), Math.floor((nowMs - start) / DAY_MS)));
    }
  };

  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') return shiftString(v);
    if (typeof v === 'number') {
      if (deltaMs !== 0 && key != null && EPOCH_KEY.test(key) && Number.isFinite(v) && v >= lo && v <= hi) {
        return shiftEpoch(v);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v != null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      if (deltaMs !== 0) fixMonthPeriod(out);
      return out;
    }
    return v;
  };

  const unshiftSegment = (seg: string): string => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return seg;
    }
    const sk = SPRINT_KEY.exec(decoded);
    if (sk) return encodeURIComponent(`sprint-${shiftDate(sk[1]!, -days)}`);
    if (MONTH_KEY.test(decoded)) return encodeURIComponent(shiftMonthKey(decoded, -months));
    if (DATE_ONLY.test(decoded)) return shiftDate(decoded, -days);
    return seg;
  };

  const unshiftPath = (url: string): string => {
    if (deltaMs === 0) return url;
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    const rest = q < 0 ? '' : url.slice(q);
    return path.split('/').map(unshiftSegment).join('/') + rest;
  };

  return {
    deltaMs,
    days,
    months,
    rebase: <T>(value: T): T => walk(value, null) as T,
    shiftIso,
    unshiftPath,
  };
}
