import { useMemo } from 'react';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useFilters } from '../../store/filters.js';
import { BotRoiPanel, ResolveBacklogBanner, TuningSuggestions } from './BotRoiPanel.js';
import { WorkspaceBotCharts } from './WorkspaceBotCharts.js';
import { BotThemesPanel } from './BotThemesPanel.js';
import { BotSettingsPanel } from './BotSettingsPanel.js';
import { BenchmarkPanel } from './BenchmarkPanel.js';
import { effectiveBotsTab } from './benchmarkModel.js';
import { BotIcon } from '../Icons.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { Tabs, useRegisterCommands, type Command, type TabItem } from '../ui/index.js';
import { Callout, PageHeader } from './reportChrome.js';
import type { BotsInnerTab } from '../../store/filters.js';
import type { BotWindowKind } from '@pierre-review/shared';

// The Bots rail view — "the calm layer above your review bots". It composes:
//   • the ROI / utilisation panel (per-bot signal-to-noise + trend + keep/tune/noisy verdicts).
//     (Bot ACTIVITY is not here: it is the Feed's "Bots" side — one Feed, two sides.)
//   • Classification (BotSettingsPanel): who counts as a bot in this Workspace, its role, vendor
//     and price. It was the Feed's "Bot classification" sub-tab; the Feed is a stream only now.
// (The Bot Tuning Advisor tab is REMOVED, UI and backend; its advisor_* tables stay dormant.)
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

  // Classification is the WORKSPACE's bot list with no repo narrowing — cross-repo rail only.
  // Themes is genuinely per-repo (the panel takes `repoScope`), so it shows on both mounts.
  const showClassification = repoId == null;
  // DERIVE the visible tab; never write a correction back to the store (`benchmarkModel.ts`).
  // Themes is written by a model, so it shows only while AI is on.
  const showThemes = useAiCapabilities().enabled;
  const effectiveTab = effectiveBotsTab(innerTab, { showClassification, showThemes });

  // ⌘K while Bots Monitoring is showing: the window, and the two lists behind the callouts.
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const openBotThreadsDetail = useFilters((s) => s.openBotThreadsDetail);
  const commands = useMemo<Command[]>(() => {
    const icon = <BotIcon size={14} />;
    const win = (v: BotWindowKind, label: string): Command => ({
      id: `bots:window:${v}`,
      group: 'Actions',
      title: `Bots: measure ${label}`,
      keywords: ['window', 'roi'],
      icon,
      run: () => {
        setInnerTab('roi');
        setWindow(v);
      },
    });
    return [
      win('rolling_7', 'the last 7 days'),
      win('rolling_14', 'the last 14 days'),
      win('rolling_30', 'the last 30 days'),
      win('sprint', 'this sprint'),
      { id: 'bots:bot-only', group: 'Actions', title: 'Bots: open PRs only a bot reviewed', icon, run: () => openBotOnlyDetail(repoId ?? null) },
      { id: 'bots:resolve', group: 'Actions', title: 'Bots: review & resolve likely-addressed threads', icon, run: () => openBotThreadsDetail(repoId ?? null) },
    ];
  }, [setInnerTab, setWindow, openBotOnlyDetail, openBotThreadsDetail, repoId]);
  useRegisterCommands(repoId != null ? `bots:repo:${repoId}` : 'bots', commands);

  const tabs: readonly TabItem<BotsInnerTab>[] = [
    { id: 'roi', label: 'ROI' },
    // ⚠ SECOND, NOT LAST. The panel sat FIRST on the Measure surface until it moved here, so
    // second in the strip is what preserves its prominence.
    { id: 'themes', label: 'Themes', hidden: !showThemes },
    { id: 'benchmark', label: 'Benchmark' },
    { id: 'classification', label: 'Classification', hidden: !showClassification },
  ];

  return (
    <div className="max-w-[1400px] space-y-5" data-testid="bots-view">
      {/* One page header (the rail mount) — the per-repo console mount already has its own header
          and tab strip, so there the title drops to a section heading and the 1–9 keys stay with
          the console. Both mounts are one BotsView body. */}
      {repoId == null ? (
        <PageHeader title="Bots Monitoring">
          <Tabs label="Bots Monitoring tabs" idPrefix="bots" numberKeys value={effectiveTab} onChange={setInnerTab} tabs={tabs} />
        </PageHeader>
      ) : (
        <header className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-title text-ui-ink">Bots Monitoring</h2>
            {/* The per-repo mount says what it is scoped to; the rail needs no tagline. */}
            <span className="text-meta text-ui-mute">This Workspace’s bots, measured on this repo.</span>
          </div>
          <Tabs label="Bots Monitoring tabs" idPrefix="repo-bots" value={effectiveTab} onChange={setInnerTab} tabs={tabs} />
        </header>
      )}

      {effectiveTab === 'classification' ? (
        // Who counts as a bot in this Workspace, plus each bot's price. The Feed's and the
        // Timeline's bot hiding read it.
        <BotSettingsPanel />
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
            <Callout
              tone="warn"
              icon={<BotIcon />}
              onClick={() => openBotOnlyDetail(repoId ?? null)}
              testId="bot-only-caption"
              title="Show the open PRs only a bot reviewed"
              action="Show list →"
            >
              Only a bot reviewed{' '}
              <span className="font-semibold tabular-nums">{botOnly}</span>{' '}
              open PR{botOnly === 1 ? '' : 's'} — no human review yet. Consider a human pass before
              they merge.{' '}
              {/* The count is a live review-state snapshot of currently-OPEN PRs (any age); merged
                  PRs are excluded here (they're in the list behind "Show merged"). */}
              <span className="text-ui-mute">Open PRs only, any age.</span>
            </Callout>
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
