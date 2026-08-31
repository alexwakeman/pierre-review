import { useState } from 'react';
import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { ChevronIcon } from '../Icons.js';
import { ProBadge, ProLockPanel, useProGateState } from '../ProGate.js';
import { BottlenecksPanel } from './BottlenecksPanel.js';
import { effectiveInsightsTab } from './bottlenecksModel.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { TrackUsage } from './TrackUsage.js';
import { WorkspaceFlowMetrics } from './WorkspaceFlowMetrics.js';

// The "Reports" pane — the Activity rail entry formerly labelled "Insights" (the store value
// behind it is still `activityRepoId === 'insights'`; see Activity/index.tsx).
//
// ⚠ THE RAIL ENTRY THAT OPENS THIS PANE IS UNGATED ON EVERY TIER AND MUST STAY THAT WAY. That is
// not an oversight surviving from when the pane was free: the free flow metrics live here, and
// they are the reason a free account has any cause to open Reports at all. What is gated is the
// named PANES inside, never the entry — gating the entry would take a free feature behind the wall.
//
// The pane MIXES TIERS, and its job is to keep them visibly apart:
//
//   • Flow metrics — CORE/FREE. The DORA-ish tiles + trend charts, moved here off the Feed, where
//     a workspace-wide survey sat on top of a chronological stream.
//   • Period reports — PRO (`periodReports`). The stored period-over-period artifact, its
//     comparison, the forecast and the grounded chat, all inside PeriodReportsPanel, which carries
//     its own posture and issues ZERO requests without the capability.
//   • Chronology — PRO, on the SAME `periodReports` flag (see the second tab, below).
//
// ⚠ THE `Pro` CHIP SITS ON THE PERIOD-REPORT HEADING, NOT THE PANE HEADER — and on the Chronology
// TAB, not on the tab strip. It used to badge the whole pane, which for a free account reads as
// "Pro" stamped over free metrics: the wrong first impression on the one screen this pane exists
// to make worth opening. Badge the thing that is paid, at the grain it is paid at.
//
// ⚠ "Track usage" IS PRO-GATED, and not merely for tidiness: it fires `/api/pro/ai-usage`, which
// 402s for a free cloud account and 404s in OSS — but `useAiUsage` seeds `placeholderData` off
// `/api/me`, so the meters would still PAINT over the failed request. A plausible AI-spend panel
// built from a stale seed is worse than no panel.
//
// The ad-hoc chat that WAS the Overview tab lives INSIDE PeriodReportsPanel as the collapsed
// "Ask about this period" section under the report, grounded in the viewed period's own
// [fromMs, toMs) rather than a trailing window.
//
// ── THE PANE IS TWO TABS ─────────────────────────────────────────────────────────────────────
//   • Overview   — exactly the body described above, unchanged.
//   • Chronology — the COURT LEDGER (BottlenecksPanel). PRO on `periodReports`; still
//     deterministic (no model anywhere behind it) and still the twin of the Bots rail — that
//     surface measures automation, this one measures where people's time went.
//
// ⚠ CHRONOLOGY IS VISIBLE-BUT-LOCKED, WHICH REVERSES THIS APP'S USUAL POSTURE. Everywhere else a
// capability the account does not have is ABSENCE — `WorkspaceBotCharts` returns null, the
// "Depth →" pill is simply omitted, `AskAboutPeriod` below renders nothing without
// `activityDigest` — and that stays true everywhere else. (⚠ Not `PersonPeriodSection`: it used to
// be the stock example and is now one of the six locked surfaces.) Here the tab is listed for
// everyone, wears a `Pro` chip, and opens onto
// `ProLockPanel`: what the view answers, plus one link. The reversal is scoped to six named
// surfaces (components/ProGate.tsx enumerates them); do not "make it consistent" by converting
// the absent ones.
//
// ⚠ IT RIDES `periodReports` RATHER THAN A FLAG OF ITS OWN — one capability, no `apiVersion` bump,
// no plugin edit. The reasoning is written out on the route (api/routes/flow.ts), which is also
// where the enforcement lives: this file decides what the reader SEES, and a client gate is not a
// monetisation gate.
//
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK (`effectiveInsightsTab`) — the rule
// `botsInnerTab` / `feedInnerTab` are commented against. A corrective `setInsightsInnerTab()`
// would permanently forget the reader's choice. That temptation is no longer hypothetical now that
// a member is gated: an unentitled `?insightsTab=bottlenecks` — a bookmark, or a history entry
// Back replays — must render the LOCK under the tab the URL named, never be normalised into
// Overview. Normalising would also break the round-trip urlHistory.test.ts pins.

/**
 * The Chronology tab's body: the real panel, the locked pane, or nothing at all for the beat
 * `/api/me` is in flight.
 *
 * ⚠ THE BLANK BEAT IS THE POINT, not an oversight. `useProCapabilities()` reads all-false until
 * `/api/me` resolves, so the obvious `!periodReports ? <lock/> : <panel/>` paints "See what Pro
 * includes" for one frame on every cold load AT AN ACCOUNT THAT PAYS. `useProGateState` is the
 * three-state answer to that; rendering the panel through the wait would be the mirror-image lie,
 * flashing "Measuring…" at a reader we are about to tell we measure nothing for.
 *
 * The lock's copy names the QUESTION this view answers, never the price — someone who will never
 * pay still learns the product has an answer to something they wonder about (ProGate.tsx, rule 2).
 */
function ChronologyTabBody(): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  const gate = useProGateState(periodReports);
  if (gate === 'pending') return null;
  if (gate === 'locked') {
    return (
      // ⚠ A testid DISTINCT from `bottlenecks-panel`. Two states answering to one id is how a
      // misconfigured screenshot run photographs a lock screen and ships it as a marketing shot.
      <ProLockPanel heading="Chronology" testId="chronology-locked">
        Every hour a pull request is open, someone is holding it — a reviewer who hasn’t looked, an
        author who owes a reply, or nobody, approved and waiting to land. Chronology splits that
        time into the three courts and names the one that is both lopsided and slow.
      </ProLockPanel>
    );
  }
  return <BottlenecksPanel />;
}

export function InsightsView(): JSX.Element {
  const [showUsage, setShowUsage] = useState(false);
  const { activityDigest, periodReports } = useProCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  const innerTab = useFilters((s) => s.insightsInnerTab);
  const setInnerTab = useFilters((s) => s.setInsightsInnerTab);
  const effectiveTab = effectiveInsightsTab(innerTab);
  // `workspaceId === null` means "not resolved yet" — the hook holds itself idle until then, so
  // this reads `undefined` rather than another workspace's numbers.
  const metrics = useWorkspaceMetrics(workspaceId);
  // The FREE half has nothing to say: `WorkspaceFlowMetrics` self-hides when the workspace has no
  // measurable history, which would leave a bare "Flow metrics" heading over empty space.
  //
  // ⚠ IT REPLACES THAT SECTION ONLY — NEVER THE WHOLE BODY. It used to replace both sections,
  // which was right while the Pro half was SILENT without the capability (it rendered null in OSS
  // and one 10px line in cloud): two bare headings were worse than one empty box. Under the
  // visible-but-locked posture the Pro half is no longer silent — it has a locked pane to show —
  // and swallowing it here would leave a newly-onboarded free account looking at "Nothing to
  // measure" with NO Pro indicator anywhere on the pane. That account is precisely the reader the
  // lock exists for.
  //
  // The `!periodReports` conjunct STAYS: an entitled account on an empty workspace keeps today's
  // render (the self-hiding flow section, then the report panel's own setup prompt), because for
  // them "no metrics yet" is not the end of the pane.
  const nothingToShow =
    !periodReports && metrics.data != null && metrics.data.metrics == null;

  return (
    <div className="space-y-4" data-testid="insights-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Reports</h2>
        <div className="ml-auto flex items-center gap-1.5">
          {activityDigest && (
            <button
              type="button"
              onClick={() => setShowUsage((s) => !s)}
              aria-expanded={showUsage}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                showUsage
                  ? 'border-ai-signal/50 bg-ai-signal/10 text-ai-signal'
                  : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
              }`}
              title="Show your month-to-date AI usage (in credits)"
            >
              <ChevronIcon dir={showUsage ? 'down' : 'right'} size={10} />
              Track usage
            </button>
          )}
        </div>
      </div>

      {showUsage && activityDigest && <TrackUsage />}

      {/* The pane's sub-tab strip.
          ⚠ THE LIST IS STILL A CONSTANT even though Chronology is now paid: BOTH members are
          listed on every tier, `effectiveTab` (derived, never written back) picks the body, and
          the entitlement gate lives on the BODY. Dropping the tab for unentitled accounts would
          land a bookmarked `?insightsTab=bottlenecks` on Overview with nothing on screen saying
          why — the opposite of the posture this change exists to establish.
          ⚠ THE BADGE IS UNCONDITIONAL, for two reasons: it tells a paying admin which of these
          their teammates on free cannot open, and a badge conditioned on `!periodReports` would
          flicker ON then OFF for an entitled account while /api/me is in flight (capabilities read
          all-false until it resolves). It also matches the "Period reports" heading chip below,
          which has always rendered for everyone. */}
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {(
          [
            { key: 'overview', label: 'Overview', proTitle: null },
            // ⚠ LABEL-ONLY: the store/URL literal stays 'bottlenecks' (see InsightsInnerTab).
            {
              key: 'bottlenecks',
              label: 'Chronology',
              proTitle: 'Chronology is part of Pro.',
            },
          ] as const
        ).map((t) => {
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
              {/* Inside the button, so the accessible name composes as "Chronology, Pro feature"
                  rather than the chip becoming a control of its own inside a control. */}
              {t.proTitle != null && (
                <ProBadge variant="tab" className="shrink-0" title={t.proTitle} />
              )}
            </button>
          );
        })}
      </div>

      {effectiveTab === 'bottlenecks' ? (
        <ChronologyTabBody />
      ) : (
        <>
          {/* FREE. `WorkspaceFlowMetrics` self-hides when there is nothing to measure, so the empty
              state stands in for the SECTION — heading included — rather than being stacked under
              a heading with nothing beneath it. */}
          {nothingToShow ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              Nothing to measure in this Workspace yet.
              <div className="mt-1 text-[11px]">
                Flow metrics appear once this workspace has merged pull requests to measure.
              </div>
            </div>
          ) : (
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Flow metrics
              </h3>
              <WorkspaceFlowMetrics />
            </section>
          )}

          {/* PRO. The panel carries its own posture; this heading only says whose tier it is.
              The chip comes from ProGate so the five Pro surfaces cannot drift into five slightly
              different vermilion spellings — it renders the same classes this heading always had. */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Period reports
              <ProBadge variant="heading" title="Period reports are part of Pro." />
            </h3>
            <PeriodReportsPanel />
          </section>
        </>
      )}
    </div>
  );
}
