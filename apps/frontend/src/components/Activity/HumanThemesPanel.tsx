import type { HumanThemesResult } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { useHumanThemes, useRefreshHumanThemes } from '../../hooks/useHumanThemes.js';
import { ThemesReportBody, ThemesSkeleton } from './ThemesReportView.js';

// The Feed "Discussion themes" panel (Pro Haiku) — the HUMAN sibling of the Bots "Themes" panel.
// Summarises what PEOPLE are raising in review (concerns, debates, decisions, questions), including
// their replies on bot threads. STRICTLY Pro (activityDigest tier), scoped to the current TEAM +
// window (reuses the shared bot window selector so all three summaries stay on one window). The
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
    <div className="mt-3 border-t border-violet-200/50 pt-2 text-[10px] text-gray-400 dark:border-violet-900/40">
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
  const scope = scopeToParam(useFilters((s) => s.teamScope));

  const query = useHumanThemes(window, activityDigest, scope);
  const refresh = useRefreshHumanThemes(window, scope);
  const usage = useAiUsage(activityDigest);
  const outOfCredits = usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;

  if (!activityDigest) return null;

  const result = query.data?.result ?? null;
  const busy = refresh.isPending;

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="human-themes-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">💬</span> What people are discussing
        </span>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <span className="shrink-0 rounded bg-sky-100 px-1 text-[9px] font-semibold uppercase text-sky-600 dark:bg-sky-900/40 dark:text-sky-300">
          beta
        </span>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={busy || outOfCredits}
          className="ml-auto rounded bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          title={outOfCredits ? 'Out of AI credits — resets next month' : 'Summarise what people are raising in review over this scope (runs the Haiku model)'}
        >
          {busy ? 'Summarising…' : result ? '↻ Regenerate' : 'Generate'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        A read of what your reviewers keep raising — recurring concerns, debates, decisions, and
        questions across the team’s human review comments (including replies on bot threads). Themes
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
        <div className="mt-3 h-24 animate-pulse rounded bg-violet-500/5" />
      ) : result ? (
        <div key={result.generatedAt} className="digest-fade-in">
          <ThemesReportBody
            narrative={result.narrative}
            themes={result.themes}
            bySeverity={result.bySeverity}
            byArea={result.byArea}
            actorEmoji="💬"
            emptyThemesLabel="No distinct discussion themes surfaced in this window."
            reviewerSection={<ParticipantRollup result={result} />}
            coverageLine={<HumanCoverageLine result={result} />}
          />
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-violet-300/60 p-3 text-[12px] text-gray-500 dark:border-violet-800/60 dark:text-gray-400">
          <span>No summary yet — generate one to see what people are discussing in review.</span>
        </div>
      )}
    </div>
  );
}
