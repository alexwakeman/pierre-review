import type { RepoDigest } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useOpenPrTab } from '../../hooks/useOpenPrTab.js';
import { useInsightsDigestExpand } from '../../store/digestCollapse.js';
import { RepoDigestCard } from './RepoDigestCard.js';

// The per-repo AI "branch summaries" moved into the Insights panel (they used to live atop
// the Feed). Presentational: the refresh is driven by the Insights header's single unified
// Refresh, so there's no per-card / per-section regenerate here. COLLAPSED BY DEFAULT (they
// sit under the sprint report as reference) via the Insights-scoped expand store.
export function InsightsDigests({
  digests,
  isLoading,
  anyWatched,
  refreshingRepoIds,
  embedded = false,
}: {
  digests: RepoDigest[];
  isLoading: boolean;
  anyWatched: boolean;
  refreshingRepoIds: Set<number>;
  // When nested inside the sprint report card, the card's collapsible section header is the
  // label, so suppress this component's own "Repo summaries" header to avoid a double title.
  embedded?: boolean;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const expanded = useInsightsDigestExpand((s) => s.expanded);
  const toggle = useInsightsDigestExpand((s) => s.toggle);
  const openPr = useOpenPrTab();

  // Gated on the AI-digest capability (independent of teamInsights — a user could have one
  // without the other), exactly like the old Feed mount.
  if (!activityDigest) return null;

  return (
    <div className="space-y-2">
      {!embedded && (
        <div className="flex items-center gap-2 px-0.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            <span aria-hidden="true">✨</span> Repo summaries · watched repos
          </span>
        </div>
      )}
      {!anyWatched ? (
        <p className="px-0.5 text-xs text-gray-400">
          No watched repos in view — Watch a repo (the eye toggle) to get a summary here.
        </p>
      ) : isLoading ? (
        <div className="h-12 animate-pulse rounded-md border border-violet-200 bg-violet-50/40 dark:border-violet-900/40 dark:bg-violet-950/10" />
      ) : digests.length === 0 ? (
        <p className="px-0.5 text-xs text-gray-400">
          No summaries yet — click Refresh above to summarise your watched repos.
        </p>
      ) : (
        <div className="space-y-2">
          {digests.map((d) => (
            <RepoDigestCard
              key={d.repoId}
              digest={d}
              isLoading={false}
              title={d.repoFullName}
              collapsed={!expanded.has(d.repoId)}
              onToggle={() => toggle(d.repoId)}
              regenerating={refreshingRepoIds.has(d.repoId)}
              onOpenPr={openPr}
              showProBadge={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
