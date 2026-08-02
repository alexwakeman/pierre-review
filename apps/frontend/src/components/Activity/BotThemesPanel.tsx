import type { BotThemesResult } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useBotThemes, useRefreshBotThemes } from '../../hooks/useBotThemes.js';
import { ThemesReportBody, ThemesSkeleton } from './ThemesReportView.js';
import { prRefToMeta } from './ThemeThreadsDetail.js';

// The Bots "Themes" panel (Pro Haiku) — the QUALITATIVE layer of the Bots console: what the
// automated reviewers are actually flagging (nature + criticality + where), read from the deduped
// comment stream. Every deterministic figure (per-bot volume, area split, coverage) comes straight
// from the read layer; the themes + narrative are the model's read (labelled approximate). STRICTLY
// Pro — gated on the activityDigest AI-summary capability — and scoped to the current WORKSPACE +
// window. There is no repo narrowing: the cached report is keyed `ws:<id>` on both sides (the
// client's query key and the plugin's `scope_key`), so the panel only renders in the cross-repo
// Bots rail. The report BODY is shared with the Feed "Discussion themes" panel (ThemesReportBody).

// The deterministic per-bot volume + acted-on rollup (from the read layer, not the model).
function BotRollup({ result }: { result: BotThemesResult }): JSX.Element | null {
  if (result.bots.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        By reviewer
      </div>
      <div className="space-y-1">
        {result.bots.map((b) => (
          <div key={b.key} className="flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{b.label}</span>
            <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
              {b.comments} comment{b.comments === 1 ? '' : 's'}
            </span>
            <span
              className="w-16 shrink-0 text-right tabular-nums text-gray-400"
              title="Share of this reviewer's threads later resolved or likely-addressed (approximate)"
            >
              {b.actedOnPct != null ? `${b.actedOnPct}% acted` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BotCoverageLine({ result }: { result: BotThemesResult }): JSX.Element {
  const c = result.coverage;
  return (
    <div className="mt-3 border-t border-violet-200/50 pt-2 text-[10px] text-gray-400 dark:border-violet-900/40">
      Summarised {c.deduped.toLocaleString()} distinct {c.deduped === 1 ? 'point' : 'points'} from{' '}
      {c.totalComments.toLocaleString()} bot comment{c.totalComments === 1 ? '' : 's'}
      {c.analyzed < c.deduped ? ` (top ${c.analyzed.toLocaleString()} analysed)` : ''}
      {c.truncated ? ' · older comments beyond the cap were excluded' : ''}. Generated{' '}
      {new Date(result.generatedAt).toLocaleString()}.
    </div>
  );
}

export function BotThemesPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const window = useFilters((s) => s.botAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openThemeThreads = useFilters((s) => s.openThemeThreadsDetail);

  const query = useBotThemes(window, activityDigest, workspaceId);
  // Generation is the one BILLED path here, so it refuses outright while the workspace is
  // unresolved rather than spending on the account's Default (see useRefreshBotThemes).
  const refresh = useRefreshBotThemes(window, workspaceId);
  const usage = useAiUsage(activityDigest);
  const outOfCredits = usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  if (!activityDigest) return null;

  const result = query.data?.result ?? null;
  const busy = refresh.isPending;

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="bot-themes-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">🔍</span> What bots flag
        </span>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={busy || outOfCredits || workspaceId == null}
          className="ml-auto rounded bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          title={
            outOfCredits
              ? 'Out of AI credits — resets next month'
              : 'Summarise what the review bots are flagging in this Workspace (runs the Haiku model)'
          }
        >
          {busy ? 'Summarising…' : result ? '↻ Regenerate' : 'Generate'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        A qualitative read of what your automated reviewers keep flagging — the recurring themes, how
        critical they are, and where they cluster. Themes are an AI read (approximate); the volumes and
        “where” are exact.
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
            actorEmoji="🤖"
            emptyThemesLabel="No distinct themes surfaced from the bot comments in this window."
            reviewerSection={<BotRollup result={result} />}
            coverageLine={<BotCoverageLine result={result} />}
            onOpenPr={(pr) => openPrDetailTab(prRefToMeta(pr), { fromActivity: true })}
            onOpenTheme={(theme) => openThemeThreads(theme, 'bot')}
          />
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-violet-300/60 p-3 text-[12px] text-gray-500 dark:border-violet-800/60 dark:text-gray-400">
          <span>No summary yet — generate one to see what your review bots are flagging.</span>
        </div>
      )}
    </div>
  );
}
