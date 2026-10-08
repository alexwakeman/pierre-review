import {
  REPORTING_DEFAULT_DAYS,
  reportingWindowCaption,
  reportingWindowPhrase,
  reportingWindowTitle,
  type ReportingWindowInfo,
} from '@pierre-review/shared';

// The reporting window in the SPA's words — thin wrappers over the shared spelling
// (packages/shared/src/reporting-window.ts), plus the dates, which only a screen needs.

/** A response that predates `window` is the trailing fortnight it always was. */
export function windowOrDefault(
  w: ReportingWindowInfo | null | undefined,
  from: string,
  to: string,
): ReportingWindowInfo {
  return (
    w ?? {
      mode: 'rolling_14',
      from,
      to,
      end: to,
      days: REPORTING_DEFAULT_DAYS,
      elapsedDays: REPORTING_DEFAULT_DAYS,
    }
  );
}

const DAY_FMT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

/** "1 Oct – 8 Oct": the measured span, last day inclusive (the wire `to` is exclusive). */
export function windowDates(w: ReportingWindowInfo): string {
  const from = new Date(w.from);
  const lastMs = Math.max(from.getTime(), new Date(w.to).getTime() - 1);
  const a = from.toLocaleDateString(undefined, DAY_FMT);
  const b = new Date(lastMs).toLocaleDateString(undefined, DAY_FMT);
  return a === b ? a : `${a} – ${b}`;
}

export { reportingWindowCaption, reportingWindowPhrase, reportingWindowTitle };
