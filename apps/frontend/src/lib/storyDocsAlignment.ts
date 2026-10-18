// CHECK A STORY AGAINST THE DOCS — the pure half of the Story section's docs block
// (components/Activity/StoryDocsAlignment.tsx; docs/FRONTEND.md § The story view).
//
//   shownRun             the run whose result is drawn: the newest when it SUCCEEDED, else the last good
//                        one, so a re-run in flight (or a failed one) never hides a result
//   docsButtonLabel      "Check against docs" / "Checking…" / "Check docs again"
//   docsProgressText     the words while a run is in flight (status-derived, no counts)
//   clickMessageStale    is this mount's refusal / error older than the newest run? (then hide it)
//   criteriaMatch        may the run's per-criterion notes sit UNDER the criteria the section shows now?
//
// ⚠ A note attaches by NUMBER, so it may only attach to the SAME list it was written against: the
// run's criteria source must be the section's current one (review ⇒ `ticket_review`, brief ⇒ `brief`)
// AND each of the run's criteria must read like the row at its number. Otherwise the block draws the
// run's own numbered list instead (always so for a `derived` run, whose list is Claude's).
import {
  STORY_DOCS_CRITERION_TEXT_MAX,
  isStoryDocsInFlight,
  type StoryDocsAlignmentResponse,
  type StoryDocsAlignmentRun,
  type StoryDocsAlignmentStatus,
  type StoryDocsCriterion,
  type StoryDocsCriteriaSource,
} from '@pierre-review/shared';

/** The run whose result is drawn, or null when none has succeeded. */
export function shownRun(resp: Pick<StoryDocsAlignmentResponse, 'run' | 'lastSucceeded'> | null | undefined): StoryDocsAlignmentRun | null {
  if (resp == null) return null;
  if (resp.run?.status === 'succeeded' && resp.run.result != null) return resp.run;
  if (resp.lastSucceeded?.status === 'succeeded' && resp.lastSucceeded.result != null) return resp.lastSucceeded;
  return null;
}

/** A run is in flight (the newest one), or the reader's click has not been answered yet. */
export function docsChecking(resp: Pick<StoryDocsAlignmentResponse, 'run'> | null | undefined, pending: boolean): boolean {
  return pending || (resp?.run != null && isStoryDocsInFlight(resp.run.status));
}

export function docsButtonLabel(resp: Pick<StoryDocsAlignmentResponse, 'run' | 'lastSucceeded'> | null | undefined, pending: boolean): string {
  if (docsChecking(resp, pending)) return 'Checking…';
  return shownRun(resp) != null ? 'Check docs again' : 'Check against docs';
}

const PROGRESS: Partial<Record<StoryDocsAlignmentStatus, string>> = {
  queued: 'Waiting to start…',
  shortlisting: 'Choosing sections…',
  reading: 'Reading the docs…',
};

export function docsProgressText(status: StoryDocsAlignmentStatus | null | undefined, pending: boolean): string | null {
  if (status != null && PROGRESS[status] != null) return PROGRESS[status] ?? null;
  return pending ? 'Starting…' : null;
}

/**
 * A click's refusal or error sentence is stale once a run exists that was created AFTER that click
 * (another mount, or a later click, started one) — it must not sit under a check that is going.
 */
export function clickMessageStale(run: Pick<StoryDocsAlignmentRun, 'createdAt'> | null | undefined, submittedAt: number): boolean {
  if (run == null || submittedAt <= 0) return false;
  const created = Date.parse(run.createdAt);
  return Number.isFinite(created) && created > submittedAt;
}

/** Which summary the Story section leads with now (lib/ticketStory.ts `storySummaryOf`'s kind). */
export type StorySummaryKind = 'review' | 'brief' | 'reading' | 'none';

const SOURCE_OF: Record<StorySummaryKind, StoryDocsCriteriaSource | null> = {
  review: 'ticket_review',
  brief: 'brief',
  reading: null,
  none: null,
};

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The run's criterion reads like the shown one. The server clips a long text to
 *  STORY_DOCS_CRITERION_TEXT_MAX (maybe ending "…"), so a clipped text matches the start of the row. */
function sameText(run: string, shown: string): boolean {
  const a = norm(run);
  const b = norm(shown);
  if (a === b) return true;
  const stem = a.replace(/(\u2026|\.\.\.)$/, '').trim();
  if (stem === '') return false;
  if (stem !== a) return b.startsWith(stem);
  return a.length >= STORY_DOCS_CRITERION_TEXT_MAX - 1 && b.startsWith(a);
}

/**
 * True when the run's per-criterion notes may sit under the section's own criteria rows: same source,
 * and every criterion the run checked reads like the shown criterion at its number. A `derived` run
 * never attaches (its list is Claude's, drawn inside the docs block).
 */
export function criteriaMatch(
  run: Pick<StoryDocsAlignmentRun, 'criteriaSource' | 'criteria'> | null | undefined,
  kind: StorySummaryKind,
  shownCriteria: readonly StoryDocsCriterion[] | null | undefined,
): boolean {
  if (run == null || shownCriteria == null) return false;
  const source = SOURCE_OF[kind];
  if (source == null || run.criteriaSource !== source) return false;
  // The server checks at most STORY_DOCS_CRITERIA_MAX; it may have checked fewer, never more.
  if (run.criteria.length > shownCriteria.length) return false;
  const byN = new Map(shownCriteria.map((c) => [c.n, c.text]));
  return run.criteria.every((c) => {
    const shown = byN.get(c.n);
    return shown != null && sameText(c.text, shown);
  });
}
