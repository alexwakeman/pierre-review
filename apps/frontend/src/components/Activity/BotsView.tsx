import { useMemo } from 'react';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { BotRoiPanel, ResolveBacklogBanner, TuningSuggestions } from './BotRoiPanel.js';
import { WorkspaceBotCharts } from './WorkspaceBotCharts.js';
import { BotThemesPanel } from './BotThemesPanel.js';
import { BotAdvisorPanel } from './BotAdvisorPanel.js';
import { BotSettingsPanel } from './BotSettingsPanel.js';
import { BenchmarkPanel } from './BenchmarkPanel.js';
import { benchmarkBodyFor, effectiveBotsTab } from './benchmarkModel.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';
import { BotIcon } from '../Icons.js';
import { ProBadge, ProLockPanel, useProGateState } from '../ProGate.js';

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
//                      `ProLockPanel` in its own place — and the BENCHMARK sub-tab, the peer-cohort
//                      placement, which locks the same way. The `WorkspaceBotCharts` section below
//                      the ROI table was already `botDepth` and stays silently absent (its own,
//                      older posture).
//   PAID (`activityDigest`)
//                      the THEMES sub-tab — "What they're flagging", the qualitative AI read of the
//                      bot comment stream. A DIFFERENT capability from the two above, on the
//                      AI-summary tier, and it takes the ABSENT posture rather than the locked one.
//   FREE (`botTriage`) everything else in the `roi` branch: the "only a bot reviewed N open PRs"
//                      governance caution, the resolve backlog, the hoisted tuning suggestions and
//                      the bot-only feed — plus the whole `Settings` sub-tab, which is the reason
//                      the RAIL ENTRY MUST STAY UNGATED (an `npx` user has to be able to classify a
//                      reviewer, and there is real free triage on this screen).
//
// The `ROI` and `Benchmark` sub-tabs therefore keep their place in the tab list for everyone and
// wear a Pro badge: visible-but-locked, not absent. (`Advisor` and `Themes` keep the opposite
// posture — only LISTED when entitled. For the advisor it is because it is workspace-grain with no
// free half to sit beside; for Themes it is because `ProGate.tsx` holds the visible-but-locked set
// at SIX named surfaces with a written argument that a seventh needs its own, and because the panel
// renders `null` on OSS, where an always-listed tab would be a blank pane. Two postures in one tab
// strip is deliberate, not drift.)
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
  const { botAdvisor, activityDigest } = useProCapabilities();
  const showAdvisor = repoId == null && botAdvisor;
  // Themes is Pro (`activityDigest`, the AI-summary tier — NOT `botDepth`) and takes the ADVISOR's
  // posture, not ROI's: LISTED only when entitled, absent otherwise. Two reasons, and both are
  // load-bearing. `components/ProGate.tsx` keeps the visible-but-locked set at exactly SIX named
  // surfaces with a written argument that a seventh needs its own; and `BotThemesPanel` returns
  // `null` on the OSS build, so an always-listed tab would draw a blank pane there. This is the
  // FEED's setup exactly (`Feed | Themes`, listed on `activityDigest`), which is the point — one
  // report, one gate, two rails.
  //
  // ⚠ NOT GATED ON `repoId == null`. Unlike the advisor this report is genuinely per-repo: the
  // panel takes `repoScope`, the client gives the narrowed report its own cache slot and the
  // plugin's `scope_key` carries the matching `|r:` suffix, so the per-repo console's Bots tab
  // gets that repo's own report rather than the workspace's.
  const showThemes = activityDigest;
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
  // render it. ('behaviour' left the union itself — the field is transient and URL-silent, so no
  // stored value can resurrect it; a removed key needs no runtime mapping, only this
  // derive-never-write-back rule for the capability-gated ones. ⚠ 'themes' left with it and has
  // since RETURNED as a real member — the panel below is now a tab of its own, not a card on
  // Measure.)
  //
  // ⚠ THE RULE NOW LIVES IN `benchmarkModel.ts` so it can be tested without a renderer, and it
  // degrades ONLY the two members that are not LISTED without their capability, `'advisor'` and
  // `'themes'`. `'benchmark'` and `'roi'` are visible-but-locked and are never corrected: an
  // unentitled `?botsTab=benchmark` must land on the tab it names and meet the lock.
  const effectiveTab = effectiveBotsTab(innerTab, { showAdvisor, showThemes });

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
          // ⚠ SECOND, NOT LAST. The panel sat FIRST on the Measure surface until it moved here, so
          // second in the strip is what preserves its prominence — a report demoted to the far end
          // of the strip on the day it got its own tab would read as a downgrade.
          // ⚠ LISTED ONLY WHEN ENTITLED — the Feed's Themes posture, mirrored deliberately. See
          // `showThemes` above for why it is not the visible-but-locked one ROI and Benchmark use.
          ...(showThemes ? [{ key: 'themes', label: 'Themes' } as const] : []),
          ...(showAdvisor ? [{ key: 'advisor', label: 'Advisor' } as const] : []),
          // ⚠ LISTED ON EVERY TIER, exactly like ROI. The tab is the only place an unentitled
          // reader learns the product can answer "is our bot normal?" at all, and a gated sub-tab
          // must still be SELECTABLE or a bookmarked `?botsTab=benchmark` lands elsewhere.
          { key: 'benchmark', label: 'Benchmark' },
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
              {/* The four paid sub-tabs, badged from the ONE shared badge so the paid surfaces
                  cannot drift into slightly different chips. `Settings` carries none — it is free.

                  ⚠ THE ROI BADGE IS UNCONDITIONAL, not `!botDepth`. Advisor's has always shown to
                  the entitled (it is only listed for them at all), so a chip that appeared and
                  vanished with entitlement would read as a glitch rather than a tier label — and
                  keying it on the capability would also make it FLICKER on every cold load, since
                  `useProCapabilities()` answers all-false until /api/me lands. It labels the tier,
                  not the reader.

                  The badge sits INSIDE the tab button so the accessible name composes as
                  "ROI, Pro feature"; it is a label with no click target of its own, because a link
                  inside a tab button is a nested interactive control. */}
              {(t.key === 'advisor' ||
                t.key === 'themes' ||
                t.key === 'roi' ||
                t.key === 'benchmark') && (
                <ProBadge
                  variant="tab"
                  title={
                    t.key === 'roi'
                      ? 'The ROI table is part of Pro.'
                      : t.key === 'benchmark'
                        ? 'The peer benchmark is part of Pro.'
                        : t.key === 'themes'
                          ? 'The themes summary is part of Pro.'
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
      ) : effectiveTab === 'themes' ? (
        /* "What they're flagging" — the workspace-grain qualitative report: every deterministic
           figure (per-bot volume + acted-on, area split, per-theme comment counts, coverage) is the
           build fold's, the themes and narrative are the model's read (labelled approximate).
           `repoScope` narrows the DATA (membership ∩ narrow, server-side), so the per-repo console
           Bots tab measures that repo alone — the same repoScope the analytics ride.

           ⚠ NO WINDOW PICKER HERE, AND THAT IS A CHOICE. The panel reads `botAnalyticsWindow`,
           whose one writer is the picker INSIDE the paid ROI panel (which argues on the record
           against being hoisted). A second window control on this tab would let the cached report
           and the rest of the Bots console disagree about the population — one screen, two time
           grains — and the Feed's twin already ships without one. If it ever proves painful, hoist
           the picker to the STRIP so every sub-tab shares it; do not add a second field. */
        <BotThemesPanel repoIds={repoScope} />
      ) : effectiveTab === 'benchmark' ? (
        <BenchmarkTabBody repoId={repoId} />
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
              visible-but-locked, this is silently absent. The reversal was scoped to six named
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

/**
 * The Benchmark tab's body: the real panel, the locked pane, or nothing at all for the beat
 * `/api/me` is in flight.
 *
 * ⚠ THE BLANK BEAT IS THE POINT. `useProCapabilities()` reads all-false until `/api/me` resolves,
 * so the obvious `!botDepth ? <lock/> : <panel/>` paints "See what Pro includes" for one frame on
 * every cold load AT AN ACCOUNT THAT PAYS. `useProGateState` is the three-state answer.
 *
 * ⚠ AND THE GATE IS DOUBLED ON PURPOSE. `useBotBenchmarkPlacement` ANDs `botDepth` into its own
 * `enabled` as well, because a client gate is not a monetisation gate: the route 402s, and a
 * mounted-but-unentitled pane that polled it would be finding out by error on a timer. The lock
 * decides what the reader SEES; the hook decides what the SPA asks for.
 *
 * The lock names the QUESTION this view answers, never the price (ProGate.tsx, rule 2), and it
 * carries a testid DISTINCT from the entitled body's so no screenshot run can photograph a lock.
 */
function BenchmarkTabBody({ repoId }: { repoId?: number }): JSX.Element | null {
  const { botDepth } = useProCapabilities();
  // ⚠ THROUGH `benchmarkBodyFor`, not a hand-rolled two-way branch — the three-state decision is
  // pinned by `apps/frontend/test/botsBenchmark.test.ts`, which has no renderer to mount this with.
  const body = benchmarkBodyFor(useProGateState(botDepth));
  if (body === 'blank') return null;
  if (body === 'locked') {
    return (
      <ProLockPanel heading="Peer benchmark" testId="benchmark-locked">
        Is this reviewer normal? Benchmark places each of your bots against the same product
        running in repositories of comparable activity — how much it writes, how much of it your
        team acts on, how long a person takes to reach it — and names the ones that are far enough
        from their peers, in both rank and real terms, to be worth acting on.
      </ProLockPanel>
    );
  }
  return <BenchmarkPanel repoId={repoId} />;
}
