import { useMemo } from 'react';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { BotRoiPanel, ResolveBacklogBanner, TuningSuggestions } from './BotRoiPanel.js';
import { WorkspaceBotCharts } from './WorkspaceBotCharts.js';
import { BotThemesPanel } from './BotThemesPanel.js';
import { BotAdvisorPanel } from './BotAdvisorPanel.js';
import { BotSettingsPanel } from './BotSettingsPanel.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';
import { BotIcon } from '../Icons.js';
import { ProBadge } from '../ProGate.js';

// The Bots rail view — "the calm layer above your review bots". It composes:
//   • the ROI / utilisation panel (per-bot signal-to-noise + trend + keep/tune/noisy verdicts),
//   • a bot-ONLY activity feed (the consolidated Feed hard-filtered to automated-reviewer
//     activity) with review-thread derived-state pills (Untouched / Replied / Likely-addressed /
//     Resolved) so you can triage the bot firehose by state.
// Everything here is deterministic — no AI anywhere in this view, on either tier. The detection
// heuristics and Limn's own attribution markers (account-wide policy, not a judgement about any one
// Workspace) stay in the Settings modal's "Review bots" section.
//
// ── TWO TIERS IN ONE VIEW, AND THE RAIL ENTRY STAYS UNGATED ────────────────────────────────────
// This used to be described here as a wholly CORE/FREE feature; it no longer is, and the split
// matters because a reader reaching for "just gate the view" would take four free surfaces with it.
//
//   PAID (`botDepth`)  the ROI / utilisation PANEL — `BotRoiPanel` locks itself and renders
//                      `ProLockPanel` in its own place. The `WorkspaceBotCharts` section below it
//                      was already `botDepth` and stays silently absent (its own, older posture).
//   FREE (`botTriage`) everything else in the `roi` branch: the "only a bot reviewed N open PRs"
//                      governance caution, the resolve backlog, the hoisted tuning suggestions and
//                      the bot-only feed — plus the whole `Settings` sub-tab, which is the reason
//                      the RAIL ENTRY MUST STAY UNGATED (an `npx` user has to be able to classify a
//                      reviewer, and there is real free triage on this screen).
//
// The `ROI` sub-tab therefore keeps its place in the tab list for everyone and wears a Pro badge:
// visible-but-locked, not absent. (`Advisor` keeps the opposite posture — it is only LISTED when
// entitled — because it is workspace-grain and has no free half to sit beside. Two postures in one
// tab strip is deliberate, not drift.)
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
  // The same analytics query BotRoiPanel drives (same key → deduped), read here for the TWO FREE
  // surfaces below: the bot-only-review count in the governance caution, and the tuning
  // suggestions. Same workspace + repo narrowing as the panel, so both hit the same cache entry.
  //
  // ⚠ THIS ONE STAYS UNGATED, AND THAT IS WHY THE ROUTE IS NARROWED RATHER THAN 402'd. Free
  // accounts still need `totals.botOnlyPrs` and `suggestions`; the server withholds the ROI
  // population (`vendors`, `qualityChecks`, `ml`) instead of the whole response, so this fetch is
  // legitimate on every tier. Gating it on `botDepth` would silently delete the caution — the
  // client reads `?? 0`, so nothing would error, the amber box would just stop appearing.
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

  // The Advisor is Pro (`botAdvisor`) and WORKSPACE-scoped with no repo narrowing —
  // cross-repo rail only. Same derived-effective-tab rule.
  const { botAdvisor } = useProCapabilities();
  const showAdvisor = repoId == null && botAdvisor;
  // "Settings" ("who counts as a review bot in this Workspace") shows in BOTH views. It used to be
  // cross-repo ONLY because the judgement was keyed per TEAM and a repo tab could not express a
  // team key (team_repos was many-to-many, so one repo sat in several teams). A repo now belongs
  // to exactly ONE workspace and the judgement is the workspace's, so a repo tab is simply the
  // same list filtered to the bots with a footprint in that repo. It is CORE/free — unlike Themes
  // it has no capability gate, which also fixes an OSS gap: reviewer classification used to live
  // behind SettingsModal's caps.botTriage, so an `npx` user could not classify a reviewer at all.
  //
  // DERIVE the visible tab; never write a correction back to the store. `advisor` shares one
  // scalar with the per-repo console, so it can legitimately hold a key that isn't rendered
  // here — writing a "fix" would permanently forget the user's choice for the view that DOES
  // render it. ('behaviour' and 'themes' left the union itself — the field is transient and
  // URL-silent, so no stored value can resurrect them; a removed key needs no runtime mapping,
  // only this derive-never-write-back rule for the capability-gated ones.)
  const effectiveTab = innerTab === 'advisor' && !showAdvisor ? 'roi' : innerTab;

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

      {/* Inner sub-tab bar. Shows in BOTH the cross-repo rail Bots view and the per-repo
          console Bots tab (one BotsView body). */}
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {([
          { key: 'roi', label: 'ROI' },
          ...(showAdvisor ? [{ key: 'advisor', label: 'Advisor' } as const] : []),
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
              {/* The two paid sub-tabs, badged from the ONE shared badge so five surfaces cannot
                  drift into five slightly different chips. `Settings` carries none — it is free.

                  ⚠ THE ROI BADGE IS UNCONDITIONAL, not `!botDepth`. Advisor's has always shown to
                  the entitled (it is only listed for them at all), so a chip that appeared and
                  vanished with entitlement would read as a glitch rather than a tier label — and
                  keying it on the capability would also make it FLICKER on every cold load, since
                  `useProCapabilities()` answers all-false until /api/me lands. It labels the tier,
                  not the reader.

                  The badge sits INSIDE the tab button so the accessible name composes as
                  "ROI, Pro feature"; it is a label with no click target of its own, because a link
                  inside a tab button is a nested interactive control. */}
              {(t.key === 'advisor' || t.key === 'roi') && (
                <ProBadge
                  variant="tab"
                  title={
                    t.key === 'roi'
                      ? 'The ROI table is part of Pro.'
                      : 'The Bot Tuning Advisor is part of Pro.'
                  }
                />
              )}
            </button>
          );
        })}
      </div>

      {/* "Showing only #N" when the bot feed is isolated to one PR (e.g. from the Bot-only-PRs
          "Show in feed", which lands here). Kept OUTSIDE the sub-tab switch so its Clear — the
          only in-view way to un-isolate the bot feed — is always reachable. Self-hides otherwise. */}
      <FeedIsolationBanner />

      {effectiveTab === 'advisor' ? (
        <BotAdvisorPanel />
      ) : effectiveTab === 'settings' ? (
        /* A per-repo Bots tab shows the SAME workspace listing, filtered client-side to the bots
           with a footprint in that repo — every edit there is still workspace-wide, and the panel
           says so. */
        <BotSettingsPanel repoId={repoId} />
      ) : (
        <>
          {/* "What they're flagging" — the workspace-grain synthesis verdict RE-EXPANDED into the
              merged Themes panel: the same `getBotReviewComments` population, every deterministic
              figure (per-bot volume + acted-on, area split, per-theme comment counts, coverage)
              computed by the build fold, the themes + narrative the model's read (labelled
              approximate). `repoScope` narrows the DATA (membership ∩ narrow server-side), so the
              per-repo console Bots tab measures that repo alone — same repoScope the analytics
              ride. Free/OSS renders nothing, free cloud the Pro nudge (SynthesisCard's posture,
              carried over); the deterministic Measure surface below never waits on it. The three
              drill-down SynthesisCards (BotVolume/BotFlagging/BotThreads) and the synthesis seam
              are unaffected — this swap is this mount only. */}
          <BotThemesPanel repoIds={repoScope} />

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

          {/* Deterministic, ADVISORY tuning hints (which bot × path is mostly noise) — FREE, and
              MOUNTED HERE rather than inside the ROI panel, which is where it used to live. When
              the panel went paid this box had to leave it or go paid with it, and it is one of the
              free `botTriage` surfaces. It reads `suggestions` off the SAME analytics response the
              caution above does, which the server keeps populated for unentitled accounts for
              exactly this reason — the hoist and that narrowing are one decision.
              Self-hides when there is nothing to suggest. */}
          <TuningSuggestions suggestions={data?.suggestions ?? []} />

          {/* The ML severity surface lives INSIDE the ROI panel — one merged table (the ML columns)
              plus the totals strip, all computed from the one windowed /api/bot-analytics response,
              so the screen carries one time grain. The standalone BotSeverityPanel (corpus-wide,
              its own /api/bot-severity fetch) is retired. Both go paid with the panel; the per-
              COMMENT ML severity badges are a different route (/api/prs/:id/ml-labels) and stay
              free on every tier. */}
          <BotRoiPanel repoId={repoId} />

          {/* The surviving workspace-grain behaviour charts (findings density, PR-size-vs-volume,
              the ML block, cross-bot overlap, where-bots-work) — a collapsed-by-default section,
              `botDepth`-gated (it renders NOTHING without the capability, and fetches nothing
              until opened). The bottom of the Measure surface, above the bot feed.

              ⚠ SAME CAPABILITY AS THE PANEL ABOVE, DELIBERATELY DIFFERENT POSTURE: the panel is
              visible-but-locked, this is silently absent. The reversal was scoped to five named
              surfaces and this is not one of them — a second upsell stacked directly under the
              first would read as a paywall page rather than a screen with a paid section on it. If
              that is ever revisited, revisit it here, not by "making it consistent" in passing. */}
          <WorkspaceBotCharts repoId={repoId} />

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
