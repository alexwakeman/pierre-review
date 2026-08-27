import type { HumanThemesResult } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useHumanThemes, useRefreshHumanThemes } from '../../hooks/useHumanThemes.js';
import { CommentIcon, RefreshIcon } from '../Icons.js';
import { ThemesReportBody, ThemesSkeleton } from './ThemesReportView.js';
import { prRefToMeta } from './ThemeThreadsDetail.js';

// The Feed "Discussion themes" panel (Pro Haiku) — the HUMAN sibling of the Bots "Themes" panel.
// Summarises what PEOPLE are raising in review (concerns, debates, decisions, questions), including
// their replies on bot threads. STRICTLY Pro (activityDigest tier), scoped to the active WORKSPACE
// + window (reuses the shared bot window selector so all three summaries stay on one window). The
// funnel does NO deterministic categorisation — it prioritises PR-level comments, then threads with
// responses, then recency, up to a safe cap. Reuses the shared report body (ThemesReportBody).

// Deterministic per-participant volume (from the read layer, not the model).
function ParticipantRollup({ result }: { result: HumanThemesResult }): JSX.Element | null {
  if (result.participants.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Most active
      </div>
      <div className="space-y-1">
        {result.participants.map((p) => (
          <div key={p.userId} className="flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
              {p.displayName || p.login || `#${p.userId}`}
            </span>
            <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
              {p.comments} comment{p.comments === 1 ? '' : 's'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HumanCoverageLine({ result }: { result: HumanThemesResult }): JSX.Element {
  const c = result.coverage;
  return (
    <div className="mt-3 border-t border-ai-hairline pt-2 text-[10px] text-gray-400">
      Summarised the top {c.analyzed.toLocaleString()} of {c.totalComments.toLocaleString()} review
      comment{c.totalComments === 1 ? '' : 's'} (prioritised by PR-level comments, then active
      threads, then recency){c.truncated ? ' · older comments beyond the cap were excluded' : ''}.
      Generated {new Date(result.generatedAt).toLocaleString()}.
    </div>
  );
}

export function HumanThemesPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const window = useFilters((s) => s.botAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openThemeThreads = useFilters((s) => s.openThemeThreadsDetail);

  const query = useHumanThemes(window, activityDigest, workspaceId);
  const refresh = useRefreshHumanThemes(window, workspaceId);
  const usage = useAiUsage(activityDigest);
  const outOfCredits = usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  if (!activityDigest) return null;

  const result = query.data?.result ?? null;
  const busy = refresh.isPending;

  return (
    <div
      className="rounded-lg border border-ai-border bg-ai-surface p-4"
      data-testid="human-themes-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <CommentIcon size={15} className="inline-block align-[-0.1em]" /> What people are
          discussing
        </span>
        <span className="shrink-0 rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
          Pro
        </span>
        <button
          type="button"
          onClick={() => {
            // The hook refuses on an unresolved workspace (it would otherwise summarise the
            // account's Default); the disabled state below is the visible half of the same guard.
            if (workspaceId == null) return;
            refresh.mutate();
          }}
          disabled={busy || outOfCredits || workspaceId == null}
          className="ml-auto rounded bg-ai-signal px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
          title={outOfCredits ? 'Out of AI credits — resets next month' : 'Summarise what people are raising in review across this Workspace (runs the Haiku model)'}
        >
          {busy ? (
            'Summarising…'
          ) : result ? (
            <>
              <RefreshIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
              Regenerate
            </>
          ) : (
            'Generate'
          )}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        A read of what your reviewers keep raising — recurring concerns, debates, decisions, and
        questions across this Workspace’s human review comments (including replies on bot threads). Themes
        are an AI read (approximate); the volumes and “where” are exact.
      </p>

      {refresh.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(refresh.error as Error)?.message ?? 'Couldn’t generate the summary.'}
        </div>
      )}
      {!refresh.isError && refresh.notice && <div className="mt-2 text-[11px] text-gray-400">{refresh.notice}</div>}
      {outOfCredits && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — the summary resumes on the 1st. Any existing summary still shows.
        </div>
      )}

      {busy && !result ? (
        <ThemesSkeleton />
      ) : query.isLoading ? (
        <div className="mt-3 h-24 animate-pulse rounded bg-ai-surface-2" />
      ) : result ? (
        <div key={result.generatedAt} className="digest-fade-in">
          <ThemesReportBody
            narrative={result.narrative}
            themes={result.themes}
            bySeverity={result.bySeverity}
            byArea={result.byArea}
            ActorIcon={CommentIcon}
            emptyThemesLabel="No distinct discussion themes surfaced in this window."
            reviewerSection={<ParticipantRollup result={result} />}
            coverageLine={<HumanCoverageLine result={result} />}
            onOpenPr={(pr) => openPrDetailTab(prRefToMeta(pr), { fromActivity: true })}
            onOpenTheme={(theme) => openThemeThreads(theme, 'human')}
          />
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-ai-border p-3 text-[12px] text-gray-500 dark:text-gray-400">
          <span>No summary yet — generate one to see what people are discussing in review.</span>
        </div>
      )}
    </div>
  );
}
