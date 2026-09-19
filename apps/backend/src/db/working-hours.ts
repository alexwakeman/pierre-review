// ── WORKING HOURS: a time-zone-aware clock that only runs while people are at work ──────────
//
// Chronology charges every hour a pull request waits to whoever it is waiting on. Measured on a
// real workspace, 73% of those hours fell outside the team's working day, so a PR opened on
// Friday afternoon was charged a weekend. This calendar answers "how many WORKING hours lie
// between these two instants" for one workspace's zone, days and hours
// (packages/shared/src/flow-settings.ts).
//
// ⚠ BUILT ONCE PER REQUEST, THEN O(log n) PER QUESTION. The working windows over the whole span
// are precomputed with a prefix sum, so `between(a, b)` is two binary searches — never a walk in
// fixed steps (the exploration script stepped in 15-minute slices and took seconds).
//
// ⚠ DAYLIGHT SAVING IS HANDLED BY CONSTRUCTION, NOT BY OFFSET ARITHMETIC. Each working day's start
// and end are converted from local wall-clock time to an instant separately, through Intl, so the
// day the clocks change is simply a working day one hour shorter or longer in UTC terms — which is
// what it was for the people working it.
//
// ⚠ NO HOLIDAYS. A bank holiday counts as a working day. The calendar is a weekly pattern, stated
// on screen as one; a holiday list per workspace is a separate feature.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A PR open longer than this still gets a calendar, but only this far back from the newest instant. */
const MAX_SPAN_DAYS = 3_660;

export interface WorkingCalendarSettings {
  timeZone: string;
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  /** Minutes after local midnight. */
  startMinute: number;
  endMinute: number;
}

export interface WorkingCalendar {
  /** Working hours in `[aMs, bMs)`. Zero when b ≤ a. */
  between(aMs: number, bMs: number): number;
  /** The ISO weekday (1 = Monday) of an instant in the calendar's zone. */
  weekday(ms: number): number;
  /** Working hours in one working day — the unit "a working day" means on screen. */
  readonly dayHours: number;
  readonly settings: WorkingCalendarSettings;
}

// Intl formatters are expensive to construct and cheap to reuse.
const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

function weekdayFormatter(tz: string): Intl.DateTimeFormat {
  let f = weekdayFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    weekdayFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function localParts(ms: number, tz: string): LocalParts {
  const out: LocalParts = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    const v = Number(p.value);
    if (p.type === 'year') out.y = v;
    else if (p.type === 'month') out.mo = v;
    else if (p.type === 'day') out.d = v;
    else if (p.type === 'hour') out.h = v % 24;
    else if (p.type === 'minute') out.mi = v;
    else if (p.type === 'second') out.s = v;
  }
  return out;
}

/** The zone's offset from UTC at an instant, in ms (local − UTC). */
function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = localParts(whole, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - whole;
}

/**
 * The instant at which a local wall-clock time occurs. Two passes, because the offset to use is
 * the one in force at the ANSWER, not at the guess — they differ only across a clock change. A
 * wall-clock time that does not exist (inside a spring-forward gap) moves forward by the gap.
 */
export function zonedToUtc(y: number, mo: number, d: number, minute: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, 0, minute);
  const off1 = offsetAt(guess, tz);
  let t = guess - off1;
  const off2 = offsetAt(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function buildWorkingCalendar(
  settings: WorkingCalendarSettings,
  fromMs: number,
  toMs: number,
): WorkingCalendar {
  const tz = settings.timeZone;
  const workDays = new Set(settings.days);
  const lo = Math.max(Math.min(fromMs, toMs), toMs - MAX_SPAN_DAYS * DAY_MS);
  const hi = Math.max(fromMs, toMs);

  // Walk LOCAL calendar dates from the day before `lo` to the day after `hi`, using a UTC Date
  // purely as a calendar (it has no DST), and convert each working day's two edges separately.
  const startLocal = localParts(lo, tz);
  const base = Date.UTC(startLocal.y, startLocal.mo - 1, startLocal.d) - DAY_MS;
  const days = Math.ceil((hi - lo) / DAY_MS) + 3;

  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < days; i += 1) {
    const cal = new Date(base + i * DAY_MS);
    const iso = cal.getUTCDay() === 0 ? 7 : cal.getUTCDay();
    if (!workDays.has(iso)) continue;
    const y = cal.getUTCFullYear();
    const mo = cal.getUTCMonth() + 1;
    const d = cal.getUTCDate();
    const s = zonedToUtc(y, mo, d, settings.startMinute, tz);
    const e = zonedToUtc(y, mo, d, settings.endMinute, tz);
    if (e > s && (starts.length === 0 || s >= (ends[ends.length - 1] as number))) {
      starts.push(s);
      ends.push(e);
    }
  }
  // prefix[i] = working ms in every window before window i.
  const prefix: number[] = new Array(starts.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < starts.length; i += 1) {
    prefix[i + 1] = (prefix[i] as number) + ((ends[i] as number) - (starts[i] as number));
  }

  /** Working ms from the calendar's beginning up to `t`. */
  const cum = (t: number): number => {
    // The last window starting at or before t.
    let lo2 = 0;
    let hi2 = starts.length - 1;
    let idx = -1;
    while (lo2 <= hi2) {
      const mid = (lo2 + hi2) >> 1;
      if ((starts[mid] as number) <= t) {
        idx = mid;
        lo2 = mid + 1;
      } else {
        hi2 = mid - 1;
      }
    }
    if (idx === -1) return 0;
    const s = starts[idx] as number;
    const e = ends[idx] as number;
    return (prefix[idx] as number) + Math.min(t, e) - s;
  };

  return {
    between(aMs: number, bMs: number): number {
      if (!(bMs > aMs)) return 0;
      return Math.max(0, cum(bMs) - cum(aMs)) / HOUR_MS;
    },
    weekday(ms: number): number {
      const w = weekdayFormatter(tz).format(new Date(ms));
      return WEEKDAY_INDEX[w] ?? 1;
    },
    dayHours: (settings.endMinute - settings.startMinute) / 60,
    settings,
  };
}
