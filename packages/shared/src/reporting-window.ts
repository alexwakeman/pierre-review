import type { ReportingWindowInfo } from './types.js';

// THE REPORTING WINDOW IN WORDS — the ONE spelling every Reports surface prints, server-templated
// sentences (Chronology) and SPA labels alike. The window itself is resolved server-side
// (`apps/backend/src/db/reporting-window.ts`); this file only names it.
//
// ⚠ A WINDOW IS NAMED BY WHAT WAS USED, never by the setting. A workspace set to 'sprint' with no
// cadence measures the trailing 14 days, and the label must say "Last 14 days", not "This sprint".

/** The product default when nothing else decides it: the trailing fortnight. */
export const REPORTING_DEFAULT_DAYS = 14;

/** Day N of M, counting the day you are in. */
export function reportingWindowDay(w: ReportingWindowInfo): number {
  return Math.max(1, Math.min(w.days, Math.ceil(w.elapsedDays)));
}

/** The two fields every title reads — so a caller holding only the mode and the length (the
 *  flow-metric tiles) names the window through the same spelling as one holding the full echo. */
type WindowNameFields = Pick<ReportingWindowInfo, 'mode' | 'days'>;

/** A short title: "This sprint so far" / "Last 14 days". */
export function reportingWindowTitle(w: WindowNameFields): string {
  return w.mode === 'sprint' ? 'This sprint so far' : `Last ${w.days} days`;
}

/** The shortest name, for a picker option: "This sprint" / "Last 14 days". */
export function reportingWindowShortTitle(w: WindowNameFields): string {
  return w.mode === 'sprint' ? 'This sprint' : `Last ${w.days} days`;
}

/** The title with its position: "This sprint so far (day 4 of 14)" / "Last 14 days". */
export function reportingWindowCaption(w: ReportingWindowInfo): string {
  return w.mode === 'sprint'
    ? `This sprint so far (day ${reportingWindowDay(w)} of ${w.days})`
    : `Last ${w.days} days`;
}

/** For a sentence: "so far this sprint" / "in the last 14 days". */
export function reportingWindowPhrase(w: WindowNameFields): string {
  return w.mode === 'sprint' ? 'so far this sprint' : `in the last ${w.days} days`;
}
