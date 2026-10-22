import { useMemo } from 'react';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useFilters } from '../../store/filters.js';
import { BotRoiPanel, ResolveBacklogBanner, TuningSuggestions } from './BotRoiPanel.js';
import { WorkspaceBotCharts } from './WorkspaceBotCharts.js';
import { BotThemesPanel } from './BotThemesPanel.js';
import { BotAdvisorPanel } from './BotAdvisorPanel.js';
import { BenchmarkPanel } from './BenchmarkPanel.js';
import { effectiveBotsTab } from './benchmarkModel.js';
import { BotIcon } from '../Icons.js';

// The Bots rail view — "the calm layer above your review bots". It composes:
//   • the ROI / utilisation panel (per-bot signal-to-noise + trend + keep/tune/noisy verdicts).
//     (Bot ACTIVITY is not here: it is the Feed's "Bots" side — one Feed, two sides.)
// Bot CLASSIFICATION (who counts as a bot, its role and vendor) is NOT here: it lives on the Feed
// rail's "Bot classification" sub-tab (BotSettingsPanel).
//
// ── SCOPE: ONE WORKSPACE, ALWAYS ─────────────────────────────────────────────────────────────
// Every panel here is scoped by `filters.workspaceId` — the single scope this app has. A BOT IS A
// PER-WORKSPACE OBJECT: one `workspace_reviewers` row per (account, workspace, actor), carrying
// the judgement, the vendor identity AND the price. So a vendor running in six of the workspace's
// repos is ONE row here, merged by GitHub handle — not six.
//
// `repoId` narrows the DATA to one repo (the per-repo Bots tab in the repo console): the
// analytics, the bot-only-review caution and the vendor drill-down all measure
// that repo alone. It does NOT narrow the judgement — there is nothing per-repo left to narrow.
export function BotsView({ repoId }: { repoId?: number } = {}): JSX.Element {
  // The same analytics query BotRoiPanel drives (same key → deduped), read here for the
  // governance caution and the tuning suggestions. Same workspace + repo narrowing as the panel, so
  // both hit the same cache entry.
  const workspaceId = useFilters((s) => s.workspaceId);
  const window = useFilters((s) => s.botAnalyticsWindow);
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const { data } = useBotAnalytics(workspaceId, window, true, repoScope);
  const botOnly = data?.totals.botOnlyPrs ?? 0;

  // The EXACT PR list behind the count lives in the bot-only-PRs drill-down TAB (same
  // window/workspace/repoIds route → caption ≡ list); the caption just opens it.
  const openBotOnlyDetail = useFilters((s) => s.openBotOnlyDetail);

  // Inner sub-tab. A single shared store field (both the cross-repo rail Bots view and the
  // per-repo console Bots tab funnel through this one BotsView), so switching sticks across
  // rail/tab round-trips. The old 'behaviour' tab is GONE (plan P1.1/C1): per-bot depth is the
  // "Depth →" drill-down tab off the ROI table, and the surviving workspace-grain charts are the
  // collapsed "Workspace charts" section at the bottom of the ROI branch.
  const innerTab = useFilters((s) => s.botsInnerTab);
  const setInnerTab = useFilters((s) => s.setBotsInnerTab);

  // The Advisor is WORKSPACE-scoped with no repo narrowing — cross-repo rail only. Themes is
  // genuinely per-repo (the panel takes `repoScope`), so it shows on both mounts.
  const showAdvisor = repoId == null;
  // DERIVE the visible tab; never write a correction back to the store (`benchmarkModel.ts`).
  const effectiveTab = effectiveBotsTab(innerTab, { showAdvisor });

  return (
    <div className="space-y-3" data-testid="bots-view">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Bots Monitoring</h2>
        {/* The per-repo mount says what it is scoped to; the rail needs no tagline. */}
        {repoId != null && (
          <span className="text-[12px] text-gray-500 dark:text-gray-400">
            This Workspace’s bots, measured on this repo.
          </span>
        )}
      </div>

      {/* Inner sub-tab bar. Shows in BOTH the cross-repo rail Bots view and the per-repo
          console Bots tab (one BotsView body). */}
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {([
          { key: 'roi', label: 'ROI' },
          // ⚠ SECOND, NOT LAST. The panel sat FIRST on the Measure surface until it moved here, so
          // second in the strip is what preserves its prominence — a report demoted to the far end
          // of the strip on the day it got its own tab would read as a downgrade.
          { key: 'themes', label: 'Themes' },
          ...(showAdvisor ? [{ key: 'advisor', label: 'Advisor' } as const] : []),
          { key: 'benchmark', label: 'Benchmark' },
          // (No Settings tab: bot classification is Feed → Bot classification.)
        ] as const).map((t) => {
          const on = effectiveTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setInnerTab(t.key)}
              className={`-mb-px flex items-center gap-1 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                on
                  ? 'border-gray-300 bg-white text-sky-600 dark:border-gray-700 dark:bg-gray-950 dark:text-sky-300'
                  : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {effectiveTab === 'advisor' ? (
        <BotAdvisorPanel />
      ) : effectiveTab === 'themes' ? (
        /* "What they're flagging" — the workspace-grain qualitative report: every deterministic
           figure (per-bot volume + acted-on, area split, per-theme comment counts, coverage) is the
           build fold's, the themes and narrative are the model's read (labelled approximate).
           `repoScope` narrows the DATA (membership ∩ narrow, server-side), so the per-repo console
           Bots tab measures that repo alone — the same repoScope the analytics ride.

           ⚠ NO WINDOW PICKER HERE, AND THAT IS A CHOICE. The panel reads `botAnalyticsWindow`,
           whose one writer is the picker INSIDE the ROI panel. A second window control on this tab would let the cached report
           and the rest of the Bots console disagree about the population — one screen, two time
           grains — and the Feed's twin already ships without one. If it ever proves painful, hoist
           the picker to the STRIP so every sub-tab shares it; do not add a second field. */
        <BotThemesPanel repoIds={repoScope} />
      ) : effectiveTab === 'benchmark' ? (
        <BenchmarkPanel repoId={repoId} />
      ) : (
        <>
          {/* Governance caution: PRs whose only review came from an automated reviewer — no human
              ever looked. Sourced from the CORE analytics totals; "Show list" opens the
              bot-only-PRs drill-down tab (same route/scope → count ≡ list). */}
          {botOnly > 0 && (
            // The WHOLE caution is clickable — it opens the bot-only-PRs drill-down tab (the exact
            // PR list behind the count; same route/scope → count ≡ list).
            <button
              type="button"
              onClick={() => openBotOnlyDetail(repoId ?? null)}
              data-testid="bot-only-caption"
              title="Show the open PRs only a bot reviewed"
              className="flex w-full items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-[11px] text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-900/40"
            >
              <span className="flex-1">
                <BotIcon className="mr-1 inline-block align-[-0.1em]" />
                Only a bot reviewed{' '}
                <span className="font-semibold tabular-nums">{botOnly}</span>{' '}
                open PR{botOnly === 1 ? '' : 's'} — no human review yet. Consider a human pass before
                they merge.{' '}
                {/* The count is a live review-state snapshot of currently-OPEN PRs (any age); merged
                    PRs are excluded here (they're in the list behind "Show merged"). */}
                <span className="text-amber-600/80 dark:text-amber-400/70">
                  Open PRs only, any age.
                </span>
              </span>
              <span className="shrink-0 self-center rounded border border-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-600/70 dark:text-amber-300">
                Show list →
              </span>
            </button>
          )}

          {/* Directly beneath the "only a bot reviewed" caution: the likely-addressed backlog, in
              the SAME full-width-clickable + "Show list" layout (sky, its own colour). Self-hides
              when the backlog is empty; opens the resolvable-bot-threads review-and-resolve tab. */}
          <ResolveBacklogBanner workspaceId={workspaceId} repoIds={repoScope} />

          {/* Deterministic, ADVISORY tuning hints (which bot × path is mostly noise), read off the
              SAME analytics response the caution above does. Self-hides when there is nothing to
              suggest. */}
          <TuningSuggestions suggestions={data?.suggestions ?? []} />

          {/* The ML severity surface lives INSIDE the ROI panel — one merged table (the ML columns)
              plus the totals strip, all computed from the one windowed /api/bot-analytics response,
              so the screen carries one time grain. The standalone BotSeverityPanel (corpus-wide,
              its own /api/bot-severity fetch) is retired. The per-COMMENT ML severity badges are
              a different route (/api/prs/:id/ml-labels). */}
          <BotRoiPanel repoId={repoId} />

          {/* The surviving workspace-grain behaviour charts (findings density, PR-size-vs-volume,
              the ML block, cross-bot overlap, where-bots-work) — a collapsed-by-default section
              that fetches nothing until opened. The bottom of the Measure surface. */}
          <WorkspaceBotCharts repoId={repoId} />
          {/* No bot feed here: bot activity is the Feed's "Bots" side (one Feed, two sides). */}
        </>
      )}
    </div>
  );
}
