import type { DigestPrRef } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useRetroReport, useRefreshRetroReport } from '../../hooks/useRetroReport.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { SummaryMarkdown } from './prRefTable.js';

// The Insights "Retro" rail view — a Pro Haiku retrospective NARRATIVE over the sprint window:
// what shipped, resolved-thread highlights + time-to-resolve, CI failures + root causes,
// recurring themes, a light sentiment read, and follow-ups. A peer of the "Sprint report"
// (state of play): this is the retrograde "what just happened" story. Cost-safe — generates
// only on Generate/Regenerate; `stale` flags the window's activity moved on (advances daily).

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

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RetroSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 py-0.5" aria-hidden="true">
      <div className="digest-skeleton-line h-3.5" style={{ width: '52%' }} />
      {['94%', '88%', '96%', '72%', '84%', '68%', '90%'].map((w, i) => (
        <div key={i} className="digest-skeleton-line h-3" style={{ width: w }} />
      ))}
    </div>
  );
}

export function RetroView(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);
  const { data, isLoading } = useRetroReport(activityDigest, scope);
  const refresh = useRefreshRetroReport(scope);
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;

  // The AI digest capability is the gate (the retro shares the digest's Haiku seam + cost
  // throttle). Absent → render nothing.
  if (!activityDigest) return null;

  const report = data?.report ?? null;
  const busy = refresh.isPending;
  const windowLabel =
    report != null ? `${fmtDate(report.window.from)} – ${fmtDate(report.window.to)}` : null;

  return (
    <div className="p-4">
      <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
            <span aria-hidden="true">✨</span> Retro
          </span>
          <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            Pro
          </span>
          {windowLabel != null && (
            <span className="text-xs text-gray-400">· {windowLabel}</span>
          )}
          <span className="ml-auto flex items-center gap-2 text-[10px] text-gray-400">
            {report != null && (
              <span title={report.model}>
                Haiku
                {report.stale ? ' · stale' : ''}
              </span>
            )}
            {report == null ? (
              <button
                type="button"
                onClick={() => refresh.mutate()}
                disabled={busy || outOfCredits}
                className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
                title={
                  outOfCredits
                    ? 'Out of AI credits — resets next month'
                    : 'Generate a retrospective of the sprint window (runs the Haiku model)'
                }
              >
                {outOfCredits ? 'Out of credits' : busy ? 'Generating…' : 'Generate'}
              </button>
            ) : (
              report.stale && (
                <button
                  type="button"
                  onClick={() => refresh.mutate()}
                  disabled={busy || outOfCredits}
                  className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
                  title={
                    outOfCredits
                      ? 'Out of AI credits — resets next month'
                      : 'Regenerate — the window has more activity since this was written (runs the Haiku model)'
                  }
                >
                  <span aria-hidden="true">↻</span>
                  {outOfCredits ? 'Out of credits' : busy ? 'Regenerating…' : 'Regenerate'}
                </button>
              )
            )}
          </span>
        </div>

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          A retrospective of the period: what shipped and what it did, review-thread resolutions,
          CI failures &amp; root causes, recurring themes, tone, and follow-ups. The window follows
          your <span className="font-medium">Sprint</span> setting (sprint-to-date / 7 / 14 days).
        </p>

        {refresh.isError && (
          <div className="mt-2 text-[11px] text-red-500">
            {(refresh.error as Error)?.message ?? 'Couldn’t generate the retro.'}
          </div>
        )}
        {!refresh.isError && refresh.notice && (
          <div className="mt-2 text-[11px] text-gray-400">{refresh.notice}</div>
        )}
        {outOfCredits && (
          <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            Out of AI credits this month — summaries resume on the 1st. Existing retros still show.
          </div>
        )}

        <div className="mt-3">
          {busy ? (
            <RetroSkeleton />
          ) : isLoading ? (
            <div className="h-24 animate-pulse rounded bg-violet-500/5" />
          ) : report ? (
            <div key={report.generatedAt} className="digest-fade-in">
              <SummaryMarkdown
                markdown={report.summary}
                prRefs={report.prRefs}
                onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
              />
              <div className="mt-2 text-[10px] text-gray-400">
                Generated {new Date(report.generatedAt).toLocaleString()}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              Tells the story of the past period — what merged, which review threads got resolved
              and how quickly, why CI failed, the themes that kept coming up, and what followed.
              Click <span className="font-medium">Generate</span> above.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
