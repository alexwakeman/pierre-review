import { useState } from 'react';
import type { DigestPrRef, RepoDigest } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useSprintReport, useRefreshSprintReport } from '../../hooks/useSprintReport.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { SummaryMarkdown } from './prRefTable.js';
import { InsightsDigests } from './InsightsDigests.js';

// A Pro Haiku summary OF the Insights, pinned atop the Insights rail: headline metrics +
// prioritised, PR-linked issues, repos ranked by activity + code volume. Cost-safe: it
// only generates on an explicit Generate/Regenerate. `stale` flags that the Insights
// changed since it was written, so the lead knows to regenerate. Referenced PRs are
// clickable → the PR detail (Overview), mirroring the digest's #N refs.

function refMeta(ref: DigestPrRef): PinnedPr {
  return {
    id: ref.prId as number,
    number: ref.prNumber,
    title: ref.title ?? `#${ref.prNumber}`,
    repoFullName: ref.repoFullName,
    authorLogin: ref.authorLogin,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// `showRefresh` is false when the card is embedded in the unified Insights panel, whose
// single header "Refresh" regenerates all summaries (sprint report + digests) at once.
// The per-repo digest cards are nested INSIDE this card (collapsed by default) to keep the
// Insights tab compact — the parent passes the digest data down.
export function SprintReportCard({
  showRefresh = true,
  digests,
  digestsLoading = false,
  anyWatched = false,
  refreshingRepoIds,
}: {
  showRefresh?: boolean;
  digests?: RepoDigest[];
  digestsLoading?: boolean;
  anyWatched?: boolean;
  refreshingRepoIds?: Set<number>;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const { data, isLoading } = useSprintReport(activityDigest);
  const refresh = useRefreshSprintReport();
  const [collapsed, setCollapsed] = useState(false);
  // The nested per-repo "Repo summaries" section is collapsed by default (the length win).
  const [reposOpen, setReposOpen] = useState(false);
  const showRepos = digests !== undefined && anyWatched;
  const repoCount = digests?.length ?? 0;

  // The AI digest capability is the gate (the report shares the digest's Haiku seam +
  // cost throttle). Absent → render nothing, exactly like the digest banner.
  if (!activityDigest) return null;

  const report = data?.report ?? null;
  const busy = refresh.isPending;

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/60 dark:bg-violet-950/20">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200"
        >
          <span className="w-3 select-none text-gray-400">{collapsed ? '▸' : '▾'}</span>
          Sprint report
        </button>
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro · AI
        </span>
        {report?.stale && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            Insights changed — regenerate
          </span>
        )}
        {report && (
          <span className="hidden text-[11px] text-gray-400 sm:inline">
            {report.model}
          </span>
        )}
        {showRefresh && (
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={busy}
            className="ml-auto rounded border border-violet-300 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/30"
            title="Generate a fresh sprint report from the current Insights (uses the Haiku model)"
          >
            {busy ? 'Generating…' : report ? '↻ Regenerate' : 'Generate'}
          </button>
        )}
      </div>

      {showRefresh && refresh.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(refresh.error as Error)?.message ?? 'Couldn’t generate the report.'}
        </div>
      )}

      {!collapsed && (
        <div className="mt-2">
          {isLoading ? (
            <div className="h-16 animate-pulse rounded bg-violet-500/5" />
          ) : report ? (
            <>
              <SummaryMarkdown
                markdown={report.summary}
                prRefs={report.prRefs}
                onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
              />
              <div className="mt-1.5 text-[10px] text-gray-400">
                Generated {new Date(report.generatedAt).toLocaleString()}
              </div>
            </>
          ) : (
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              A prioritised, PR-linked summary of what needs attention this sprint —
              generated from the Insights below.{' '}
              {showRefresh ? (
                <>
                  Click <span className="font-medium">Generate</span>.
                </>
              ) : (
                <>
                  Use <span className="font-medium">Refresh</span> above to generate it.
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Per-repo digest cards, nested + collapsed by default so the Insights tab stays
          compact. Each repo card inside is itself collapsible (collapsed by default). */}
      {!collapsed && showRepos && (
        <div className="mt-3 border-t border-violet-200/60 pt-2 dark:border-violet-900/40">
          <button
            type="button"
            onClick={() => setReposOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300"
          >
            <span className="w-3 select-none text-gray-400">{reposOpen ? '▾' : '▸'}</span>
            <span aria-hidden="true">✨</span> Repo summaries
            <span className="font-normal text-gray-400">· {repoCount}</span>
          </button>
          {reposOpen && (
            <div className="mt-2">
              <InsightsDigests
                embedded
                digests={digests ?? []}
                isLoading={digestsLoading}
                anyWatched={anyWatched}
                refreshingRepoIds={refreshingRepoIds ?? new Set()}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
