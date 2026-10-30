import { useFilters } from '../../store/filters.js';
import { useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { FilterIcon } from '../Icons.js';

// The single-PR feed-isolation banner ("Showing only #N …"). Rendered in the per-repo Activity
// console directly UNDER the repo summary header (RepoFeedHeader) — the only place the feed can
// be isolated (setActivityRepo clears the isolation on any rail switch). Set from the PR-detail
// "Show in Activity feed" button or a drill-down row (store.feedIsolatedPrId). NOT sticky — it
// scrolls with the content. Dismissible with Clear. Returns null when nothing is isolated.
export function FeedIsolationBanner(): JSX.Element | null {
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  // WORKSPACE-WIDE open-PRs cache (shared with the Open PRs rail line and its count, and
  // OpenPrsDetail) resolves the isolated PR's number
  // + title for the label. Deliberately NOT the timeline-scoped `useSearchOpenPrs`: Members AND
  // the repo picker are both Timeline-only filters, and a board narrowed to other repos would hide
  // the very PR this banner is naming — leaving it stuck on the generic "the selected PR".
  const { data: openPrsData } = useWorkspaceOpenPrs();
  if (feedIsolatedPrId == null) return null;
  const isolatedPr = openPrsData?.prs.find((p) => p.id === feedIsolatedPrId) ?? null;
  return (
    <div className="flex items-center gap-2 rounded-ui border border-ui-line bg-ui-sel px-3 py-1.5 text-meta text-ui-accent shadow-sm">
      <FilterIcon className="shrink-0" />
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
        className="hit shrink-0 rounded-ui border border-ui-line px-2 py-0.5 font-medium hover:bg-ui-hover"
      >
        Clear
      </button>
    </div>
  );
}
