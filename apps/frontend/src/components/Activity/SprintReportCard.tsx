import type { DigestPrRef } from '@pierre-review/shared';
import { relativeTime } from '../../lib/ui.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useSprintReport, useRefreshSprintReport } from '../../hooks/useSprintReport.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { useSprintReportUi } from '../../store/digestCollapse.js';
import { SummaryMarkdown } from './prRefTable.js';

// A Pro Haiku summary OF the Insights, shown on the Insights "Sprint" sub-tab: headline metrics +
// prioritised, PR-linked issues, repos ranked by activity + code volume. Cost-safe: it
// only generates on an explicit Generate/Regenerate. `stale` flags that the Insights
// changed since it was written, so the lead knows to regenerate. Referenced PRs are
// clickable → the PR detail (Overview), mirroring the digest's #N refs. Scoped per team via
// the FilterBar's team selection (teamScope) — each team's report caches independently.

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
// the button appears only when a report exists AND `report.stale` (real delta).
export function SprintReportCard(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);
  const { data, isLoading } = useSprintReport(activityDigest, scope);
  const refresh = useRefreshSprintReport(scope);
  // Metered-plan credit status (paid cloud): drives disabling Generate/Regenerate. Fetched
  // eagerly (the card doesn't wait for the Track-usage panel to open); shares the ['ai-usage']
  // cache. Unmetered (local) → allowanceCredits null → never out of credits.
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;
  // Collapse state persists across Insights-tab switches / reloads (was ephemeral useState,
  // which reset the container closed every visit).
  const collapsed = useSprintReportUi((s) => s.collapsed);
  const setCollapsed = useSprintReportUi((s) => s.setCollapsed);

  // The AI digest capability is the gate (the report shares the digest's Haiku seam +
  // cost throttle). Absent → render nothing, exactly like the digest banner.
  if (!activityDigest) return null;

  const report = data?.report ?? null;
  const busy = refresh.isPending;

  const regenerate = (): void => {
    refresh.mutate();
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
                  : 'Generate the first sprint report from the current Insights (runs the Haiku model)'
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
                    : 'Regenerate the sprint report — the Insights changed since it was written (runs the Haiku model)'
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
              generated from the Insights. Click{' '}
              <span className="font-medium">Generate</span> above.
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
