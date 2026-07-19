import { useFilters } from '../../store/filters.js';
import { useSearchOpenPrs } from '../../hooks/useTriage.js';

// The single-PR feed-isolation banner ("Showing only #N …"). Rendered ONCE at the very top of
// the Activity detail panel (above the Open-PRs pane, the repo digest header, the Bots view —
// whatever context is active) so the "we're filtering to one PR" cue is the first thing seen,
// in every place the feed can be isolated. It's set from the PR-detail "Show in Activity feed"
// button or a drill-down row (store.feedIsolatedPrId). Deliberately NOT sticky — it scrolls
// away with the content (the previous sticky/float wasn't wanted). Dismissible with Clear.
// Returns null when nothing is isolated.
export function FeedIsolationBanner(): JSX.Element | null {
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  // Member-AGNOSTIC open-PRs cache (shared with FeedView / FeedOpenPrsPanel — Members is a
  // Timeline-only filter) resolves the isolated PR's number + title for the label.
  const { data: openPrsData } = useSearchOpenPrs();
  if (feedIsolatedPrId == null) return null;
  const isolatedPr = openPrsData?.prs.find((p) => p.id === feedIsolatedPrId) ?? null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 shadow-sm dark:border-sky-500/50 dark:bg-sky-950/60 dark:text-sky-200">
      <span aria-hidden="true">☰</span>
      <span className="min-w-0 flex-1 truncate">
        Showing only{' '}
        {isolatedPr != null ? (
          <>
            <span className="font-mono">#{isolatedPr.number}</span> {isolatedPr.title}
          </>
        ) : (
          'the selected PR'
        )}
      </span>
      <button
        type="button"
        onClick={() => setFeedIsolatedPrId(null)}
        className="shrink-0 rounded border border-sky-400 px-2 py-0.5 font-medium hover:bg-sky-100 dark:border-sky-500/60 dark:hover:bg-sky-900/40"
      >
        Clear
      </button>
    </div>
  );
}
