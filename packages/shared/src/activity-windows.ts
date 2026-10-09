// The two windows a PERSON's activity is read over, named once so the server folds and the copy
// that captions them cannot drift apart.

/** The consolidated Feed's rolling read window — and the person "View activity" tab, which is that
 *  feed narrowed to one author. Retention upstream (`sync/branch-status.ts`) must keep at least this. */
export const FEED_WINDOW_DAYS = 14;

/** The contributor popover's counts (`GET /api/users/:id/stats`, `getUserStats`): the trailing
 *  90 days, so a hover answers "what have they done lately", captioned "Last 90 days". */
export const USER_STATS_WINDOW_DAYS = 90;
