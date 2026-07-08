import type { DigestPrRef, RepoDigest } from '@pierre-review/shared';
import { relativeTime } from '../../lib/ui.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useSprintReport, useRefreshSprintReport } from '../../hooks/useSprintReport.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useSprintReportUi } from '../../store/digestCollapse.js';
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

// The card ALWAYS owns its own delta-gated Regenerate (Haiku seam via useRefreshSprintReport):
// the button appears only when a report exists AND `report.stale` (real delta), matching the
// per-repo digest cards. The per-repo digest cards are nested INSIDE this card (collapsed by
// default) to keep the Insights tab compact — the parent passes the digest data down, plus a
// per-repo regenerate callback threaded through to InsightsDigests.
export function SprintReportCard({
  digests,
  digestsLoading = false,
  anyWatched = false,
  refreshingRepoIds,
  onRegenerateRepo,
  onRegenerateAllDigests,
  cascadeBusy = false,
}: {
  digests?: RepoDigest[];
  digestsLoading?: boolean;
  anyWatched?: boolean;
  refreshingRepoIds?: Set<number>;
  // Per-repo regenerate for the nested digest cards; each card offers it only when that
  // repo's own digest is stale (delta-gated inside InsightsDigests).
  onRegenerateRepo?: (repoId: number) => void;
  // Cascade: (re)generating the sprint report ALSO refreshes every watched repo's digest —
  // itself delta-gated server-side (only repos whose content actually changed regenerate), so
  // "State of play" and the per-repo summaries move together. Fired alongside the sprint refresh.
  onRegenerateAllDigests?: () => void;
  // True while the cascaded digest sweep is streaming. Folded into the button's disabled state
  // so a second click can't abort the in-flight sweep (the sprint refresh itself may resolve in
  // ~200ms when throttled, which would otherwise re-enable the button mid-cascade).
  cascadeBusy?: boolean;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const { data, isLoading } = useSprintReport(activityDigest);
  const refresh = useRefreshSprintReport();
  // Metered-plan credit status (paid cloud): drives disabling Generate/Regenerate here AND on
  // the nested per-repo digest cards. Fetched eagerly (the card doesn't wait for the Track-usage
  // panel to open); shares the ['ai-usage'] cache. Unmetered (local) → allowanceCredits null →
  // never out of credits.
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;
  // Collapse state persists across Insights-tab switches / reloads (was ephemeral useState,
  // which reset the container closed every visit). Per-repo cards inside persist separately
  // via useInsightsDigestExpand.
  const collapsed = useSprintReportUi((s) => s.collapsed);
  const setCollapsed = useSprintReportUi((s) => s.setCollapsed);
  const reposOpen = useSprintReportUi((s) => s.reposOpen);
  const setReposOpen = useSprintReportUi((s) => s.setReposOpen);
  const showRepos = digests !== undefined && anyWatched;
  const repoCount = digests?.length ?? 0;

  // The AI digest capability is the gate (the report shares the digest's Haiku seam +
  // cost throttle). Absent → render nothing, exactly like the digest banner.
  if (!activityDigest) return null;

  const report = data?.report ?? null;
  // Disabled through BOTH the sprint refresh AND the cascaded digest sweep — clicking again
  // mid-cascade would abort the SSE sweep and drop its cache reconciliation (see cascadeBusy).
  const busy = refresh.isPending || cascadeBusy;

  // (Re)generate the sprint report AND cascade a delta-gated refresh across every watched
  // repo's digest. The two run on independent throttles/guards, so neither starves the other;
  // the digest side only re-bills repos whose content actually changed (payload-hash gate).
  const regenerate = (): void => {
    refresh.mutate();
    onRegenerateAllDigests?.();
  };

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="sprint-report"
    >
      {/* Header mirrors RepoDigestCard's grammar: the whole row toggles collapse; the inner
          controls stop propagation. Left = caret + ✨ + title (button) + Pro badge; right
          (ml-auto) = a gray "Haiku · <time> · stale" line then the delta-gated Regenerate. */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        className="-mx-1 flex cursor-pointer select-none items-center gap-2 rounded px-1 hover:bg-violet-500/5"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(!collapsed);
          }}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-white"
        >
          <span className="w-3 select-none text-gray-400">{collapsed ? '▸' : '▾'}</span>
          <span aria-hidden="true">✨</span> Sprint report
        </button>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-gray-400">
          {report != null && (
            <span title={report.model}>
              Haiku {' · '}
              {relativeTime(report.generatedAt)}
              {report.stale ? ' · stale' : ''}
            </span>
          )}
          {/* Regenerate ONLY when a report exists AND it's stale (a real delta). No report yet
              → a "Generate" button to create the first one. */}
          {report == null ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                regenerate();
              }}
              disabled={busy || outOfCredits}
              className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
              title={
                outOfCredits
                  ? 'Out of AI credits — resets next month'
                  : 'Generate the first sprint report from the current Insights, and every watched repo’s summary (runs the Haiku model)'
              }
            >
              {outOfCredits ? 'Out of credits' : busy ? 'Generating…' : 'Generate'}
            </button>
          ) : (
            report.stale && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  regenerate();
                }}
                disabled={busy || outOfCredits}
                className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
                title={
                  outOfCredits
                    ? 'Out of AI credits — resets next month'
                    : 'Regenerate the sprint report and every changed repo summary — the Insights changed since it was written (runs the Haiku model)'
                }
              >
                <span aria-hidden="true">↻</span>
                {outOfCredits ? 'Out of credits' : busy ? 'Regenerating…' : 'Regenerate'}
              </button>
            )
          )}
        </span>
      </div>

      {refresh.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(refresh.error as Error)?.message ?? 'Couldn’t generate the report.'}
        </div>
      )}
      {!refresh.isError && refresh.notice && (
        <div className="mt-2 text-[11px] text-gray-400">{refresh.notice}</div>
      )}
      {outOfCredits && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — summaries resume on the 1st. Existing reports still show.
        </div>
      )}

      {!collapsed && (
        <div className="mt-2">
          {busy ? (
            // Regenerating: drop the old text and show the same "shine swipe" skeleton the
            // per-repo digest cards use, so every AI summary shimmers consistently.
            <SprintReportSkeleton />
          ) : isLoading ? (
            <div className="h-16 animate-pulse rounded bg-violet-500/5" />
          ) : report ? (
            // Keyed by generatedAt so `digest-fade-in` replays each time a fresh report arrives.
            <div key={report.generatedAt} className="digest-fade-in">
              <SummaryMarkdown
                markdown={report.summary}
                prRefs={report.prRefs}
                onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
              />
              <div className="mt-1.5 text-[10px] text-gray-400">
                Generated {new Date(report.generatedAt).toLocaleString()}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              A prioritised, PR-linked summary of what needs attention this sprint —
              generated from the Insights below. Click{' '}
              <span className="font-medium">Generate</span> above.
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
            onClick={() => setReposOpen(!reposOpen)}
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
                onRegenerateRepo={onRegenerateRepo}
                outOfCredits={outOfCredits}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Placeholder lines with a sweeping shine, shown in place of the sprint summary while it
// regenerates — the same treatment as the per-repo digest cards (DigestSkeleton), sized for
// the longer report (a headline + a few bulleted lines). Purely decorative.
function SprintReportSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 py-0.5" aria-hidden="true">
      <div className="digest-skeleton-line h-3.5" style={{ width: '58%' }} />
      {['94%', '88%', '72%', '80%', '64%'].map((w, i) => (
        <div key={i} className="digest-skeleton-line h-3" style={{ width: w }} />
      ))}
    </div>
  );
}
