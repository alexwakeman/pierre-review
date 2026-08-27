import type { BotThemesResult } from '@pierre-review/shared';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useBotThemes, useRefreshBotThemes } from '../../hooks/useBotThemes.js';
import { BotIcon, MagnifierIcon, RefreshIcon } from '../Icons.js';
import { ThemesReportBody, ThemesSkeleton } from './ThemesReportView.js';
import { prRefToMeta } from './ThemeThreadsDetail.js';

// The Bots "What they're flagging" panel (Pro Haiku) — the QUALITATIVE layer of the Bots console,
// REVIVED merged with the deterministic layer it briefly ceded to a SynthesisCard mount: what the
// automated reviewers are actually flagging (nature + criticality + where), read from the deduped
// comment stream. Every deterministic figure (per-bot volume, area split, coverage, the per-theme
// comment counts) comes straight from the build fold; the themes, narrative AND the severity-strip
// aggregates over them are the model's read (labelled approximate — the description sentence must
// never claim those exact). STRICTLY Pro — gated on the activityDigest AI-summary capability, with
// SynthesisCard's exact free-tier posture (OSS → nothing, free cloud → the one-line Pro nudge).
// Scoped to the current WORKSPACE + window + `repoIds` narrowing: the per-repo Bots console tab
// passes `[repoId]` so it measures that repo alone (the cached report is keyed with the same
// narrowing on both sides — the client's repoKeySlot and the plugin's scope_key `|r:` suffix).
// The report BODY is shared with the Feed "Discussion themes" panel (ThemesReportBody) and
// scrolls inside a fixed-height region so the deterministic Measure surface below (caution
// banners, ROI table, charts, bot feed) is never pushed off-screen.

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
    <div className="mt-3 border-t border-ai-hairline pt-2 text-[10px] text-gray-400">
      Summarised {c.deduped.toLocaleString()} distinct {c.deduped === 1 ? 'point' : 'points'} from{' '}
      {c.totalComments.toLocaleString()} bot comment{c.totalComments === 1 ? '' : 's'}
      {c.analyzed < c.deduped ? ` (top ${c.analyzed.toLocaleString()} analysed)` : ''}
      {c.truncated ? ' · older comments beyond the cap were excluded' : ''}. Generated{' '}
      {new Date(result.generatedAt).toLocaleString()}.
    </div>
  );
}

export function BotThemesPanel({ repoIds }: { repoIds: number[] | null }): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const isCloud = useMe().data?.deploymentMode === 'cloud';
  const window = useFilters((s) => s.botAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openThemeThreads = useFilters((s) => s.openThemeThreadsDetail);

  const query = useBotThemes(window, activityDigest, workspaceId, repoIds);
  // Generation is the one BILLED path here, so it refuses outright while the workspace is
  // unresolved rather than spending on the account's Default (see useRefreshBotThemes).
  const refresh = useRefreshBotThemes(window, workspaceId, repoIds);
  const usage = useAiUsage(activityDigest);
  const outOfCredits = usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  // Capability off: OSS renders nothing (absence, never an error — nothing is fetched either
  // way); cloud renders the one-line Pro nudge. SynthesisCard's posture, which this panel
  // replaced on the Bots view.
  if (!activityDigest) {
    if (!isCloud) return null;
    return (
      <p className="text-[10px] text-gray-400">
        <span className="mr-1 rounded bg-ai-signal/15 px-1 text-[10px] font-semibold text-ai-signal">
          Pro
        </span>
        A themed summary of what your review bots keep flagging is part of Pro — upgrade to get
        the report above the measurements.
      </p>
    );
  }

  // The plugin tier is off server-side (enabled:false), or the read failed: nothing — the
  // deterministic Measure surface below stays primary.
  const resp = query.data;
  if (query.isError || (resp != null && !resp.enabled)) return null;

  const result = resp?.result ?? null;
  // Shared-mutation-key read, never per-mount `isPending`: a board switch mid-run unmounts this
  // panel, and on return the button must still show the in-flight Haiku run (the CiAnalysisCard /
  // useSynthesisGenerating lesson).
  const busy = refresh.busy;

  return (
    <div
      className="rounded-lg border border-ai-border bg-ai-surface p-4"
      data-testid="bot-themes-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <MagnifierIcon size={15} className="inline-block align-[-0.1em]" /> What they’re flagging
        </span>
        <span className="shrink-0 rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
          Pro
        </span>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={busy || outOfCredits || workspaceId == null}
          className="ml-auto rounded bg-ai-signal px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
          title={
            outOfCredits
              ? 'Out of AI credits — resets next month'
              : 'Summarise what the review bots are flagging in this scope (runs the Haiku model; unchanged comments cost nothing)'
          }
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
        A qualitative read of what your automated reviewers keep flagging — the recurring themes, how
        critical they are, and where they cluster. Themes are an AI read (approximate); the volumes,
        per-theme comment counts and “where” are exact.
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
        /* The scroll region holds the BODY only — header, button and notices above stay put, so
           Regenerate is always reachable and the Measure surface below keeps its place. Fixed rem
           cap (not vh): BotsView stacks the caution banners, ROI table, charts and bot feed
           underneath, and the panel must not push them off-screen. */
        <div className="mt-1 max-h-[32rem] overflow-y-auto overscroll-contain pr-1">
          <div key={result.generatedAt} className="digest-fade-in">
            <ThemesReportBody
              narrative={result.narrative}
              themes={result.themes}
              bySeverity={result.bySeverity}
              byArea={result.byArea}
              ActorIcon={BotIcon}
              emptyThemesLabel="No distinct themes surfaced from the bot comments in this window."
              reviewerSection={<BotRollup result={result} />}
              coverageLine={<BotCoverageLine result={result} />}
              onOpenPr={(pr) => openPrDetailTab(prRefToMeta(pr), { fromActivity: true })}
              onOpenTheme={(theme) => openThemeThreads(theme, 'bot')}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-ai-border p-3 text-[12px] text-gray-500 dark:text-gray-400">
          <span>No summary yet — generate one to see what your review bots are flagging.</span>
        </div>
      )}
    </div>
  );
}
