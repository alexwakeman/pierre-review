import { useMemo } from 'react';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { BotRoiPanel, ResolveBacklogBanner } from './BotRoiPanel.js';
import { BotBehaviourPanel } from './BotBehaviourPanel.js';
import { BotThemesPanel } from './BotThemesPanel.js';
import { BotSettingsPanel } from './BotSettingsPanel.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';

// The Bots rail view — "the calm layer above your review bots" as a CORE, FREE feature (works
// via the npx / OSS path, no @pierre/pro plugin). It composes:
//   • the ROI / utilisation panel (per-bot signal-to-noise + trend + keep/tune/noisy verdicts),
//   • a bot-ONLY activity feed (the consolidated Feed hard-filtered to automated-reviewer
//     activity) with review-thread derived-state pills (Untouched / Replied / Likely-addressed /
//     Resolved) so you can triage the bot firehose by state.
// Everything reads the CORE, deterministic bot routes + the core consolidated-feed route — no AI,
// no Pro gate. The detection heuristics and Limn's own attribution markers (account-wide policy,
// not a judgement about any one Workspace) stay in the Settings modal's "Review bots" section.
//
// ── SCOPE: ONE WORKSPACE, ALWAYS ─────────────────────────────────────────────────────────────
// Every panel here is scoped by `filters.workspaceId` — the single scope this app has. A BOT IS A
// PER-WORKSPACE OBJECT: one `workspace_reviewers` row per (account, workspace, actor), carrying
// the judgement, the vendor identity AND the price. So a vendor running in six of the workspace's
// repos is ONE row here, merged by GitHub handle — not six.
//
// `repoId` narrows the DATA to one repo (the per-repo Bots tab in the repo console): the
// analytics, the bot-only feed, the bot-only-review caution and the vendor drill-down all measure
// that repo alone. It does NOT narrow the judgement — there is nothing per-repo left to narrow —
// which is why the Settings sub-tab renders the whole workspace's reviewers and filters them
// client-side by footprint, and says out loud that an edit there lands workspace-wide.
export function BotsView({ repoId }: { repoId?: number } = {}): JSX.Element {
  // Reuse the same analytics query BotRoiPanel drives (same key → deduped) just for the
  // bot-only-review count in the header caution. Same workspace + repo narrowing as the panel, so
  // both hit the same cache entry.
  const workspaceId = useFilters((s) => s.workspaceId);
  const window = useFilters((s) => s.botAnalyticsWindow);
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const { data } = useBotAnalytics(workspaceId, window, true, repoScope);
  const botOnly = data?.totals.botOnlyPrs ?? 0;

  // The EXACT PR list behind the count lives in the bot-only-PRs drill-down TAB (same
  // window/workspace/repoIds route → caption ≡ list); the caption just opens it.
  const openBotOnlyDetail = useFilters((s) => s.openBotOnlyDetail);

  // Inner sub-tab: the shipped ROI surface vs the EXPERIMENTAL behaviour analytics. A single
  // shared store field (both the cross-repo rail Bots view and the per-repo console Bots tab
  // funnel through this one BotsView), so switching sticks across rail/tab round-trips.
  const innerTab = useFilters((s) => s.botsInnerTab);
  const setInnerTab = useFilters((s) => s.setBotsInnerTab);

  // The "Themes" AI summary is STRICTLY Pro (activityDigest tier) and WORKSPACE-scoped with no
  // repo narrowing, so it only appears in the cross-repo Bots rail (repoId == null) — not the
  // per-repo console Bots tab. When it's unavailable but the shared scalar still points at it,
  // fall back to ROI.
  const { activityDigest } = useProCapabilities();
  const showThemes = repoId == null && activityDigest;
  // "Settings" ("who counts as a review bot in this Workspace") shows in BOTH views. It used to be
  // cross-repo ONLY because the judgement was keyed per TEAM and a repo tab could not express a
  // team key (team_repos was many-to-many, so one repo sat in several teams). A repo now belongs
  // to exactly ONE workspace and the judgement is the workspace's, so a repo tab is simply the
  // same list filtered to the bots with a footprint in that repo. It is CORE/free — unlike Themes
  // it has no capability gate, which also fixes an OSS gap: reviewer classification used to live
  // behind SettingsModal's caps.botTriage, so an `npx` user could not classify a reviewer at all.
  //
  // DERIVE the visible tab; never write a correction back to the store. `themes` is still
  // optional and shares one scalar with the per-repo console, so it can legitimately hold a key
  // that isn't rendered here — writing a "fix" would permanently forget the user's choice for the
  // view that DOES render it.
  const effectiveTab = innerTab === 'themes' && !showThemes ? 'roi' : innerTab;

  return (
    <div className="space-y-3" data-testid="bots-view">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Review bots</h2>
        <span className="text-[11px] text-gray-400">
          {repoId != null
            ? 'The calm layer above your review bots — this Workspace’s bots, measured on this repo.'
            : 'The calm layer above your review bots — detect, measure, and triage the automated reviewers in this Workspace.'}
        </span>
      </div>

      {/* Inner sub-tab bar — ROI (shipped) vs Behaviour (experimental). Shows in BOTH the
          cross-repo rail Bots view and the per-repo console Bots tab (one BotsView body). */}
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {([
          { key: 'roi', label: 'ROI' },
          { key: 'behaviour', label: 'Behaviour' },
          ...(showThemes ? [{ key: 'themes', label: 'Themes' } as const] : []),
          { key: 'settings', label: 'Settings' },
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

      {/* "Showing only #N" when the bot feed is isolated to one PR (e.g. from the Bot-only-PRs
          "Show in feed", which lands here). Kept OUTSIDE the sub-tab switch so its Clear — the
          only in-view way to un-isolate the bot feed — is always reachable. Self-hides otherwise. */}
      <FeedIsolationBanner />

      {effectiveTab === 'behaviour' ? (
        <BotBehaviourPanel repoId={repoId} />
      ) : effectiveTab === 'themes' ? (
        <BotThemesPanel />
      ) : effectiveTab === 'settings' ? (
        /* A per-repo Bots tab shows the SAME workspace listing, filtered client-side to the bots
           with a footprint in that repo — every edit there is still workspace-wide, and the panel
           says so. */
        <BotSettingsPanel repoId={repoId} />
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
                🤖 Only a bot reviewed <span className="font-semibold tabular-nums">{botOnly}</span>{' '}
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

          {/* The ML severity surface lives INSIDE the ROI panel now — one merged table (the
              ML columns) plus the totals strip, all computed from the one windowed
              /api/bot-analytics response, so the screen carries one time grain. The standalone
              BotSeverityPanel (corpus-wide, its own /api/bot-severity fetch) is retired. */}
          <BotRoiPanel repoId={repoId} />

          {/* The bot-only activity feed — the consolidated Feed filtered to automated-reviewer
              activity, with review-thread derived-state pills for triage. Same cards / inline
              threads / pagination as every other feed, just bot-scoped (and repo-scoped in the
              per-repo Bots tab). */}
          <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
            <FeedView repoId={repoId} botsMode />
          </div>
        </>
      )}
    </div>
  );
}
