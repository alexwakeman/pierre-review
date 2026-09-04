import type { WorkspaceRepoActivity, WorkspaceRepoActivityRow } from '@pierre-review/shared';
import { BarChart } from '../charts/BarChart.js';
import { ChartCard, ChartEmpty, PALETTE, fmtNum, type Series } from '../charts/common.js';

// WHERE IS THE WORK HAPPENING — the per-repository half of Flow metrics.
//
// The tiles and 12-week trends above answer "how much" and "how fast" for the whole workspace.
// They cannot answer "which repository", and on a real workspace the members differ by two orders
// of magnitude: one fortnight held 147 PRs / 1.4k lines in a config repo and 71 PRs / 141.7k lines
// in an application repo. Both are activity; they are not the same activity.
//
// ── TWO CHARTS, NOT ONE SCORE ────────────────────────────────────────────────────────────────
//
// The tempting shape is a single "activity index" per repository — some normalised blend of PR
// count and line count. It is the exact shape this codebase rejects in five separate places ("a
// blended figure is a number no PR resembles"; "a workspace-wide rate is a number no member of any
// cell resembles"; the rollup carries no percentile of its own; two populations must be labelled
// apart and never subtracted), and there is no precedent anywhere in this repo for a normalised
// composite. Nobody could reconcile such an index with the tiles directly above it, and no
// repository would resemble its own number.
//
// A grouped two-series chart fails for a second, mechanical reason: BarChart's `niceMax` gives
// every series ONE y-axis, so a PR count (≈5) beside a line count (≈5000) draws the count
// sub-pixel. Two measures of different scale are two charts. The pair is ordered identically so a
// reader tracks one repository across both.
//
// ── THE WINDOW IS A ROLLING 14 DAYS, AND THAT IS THE THIRD WINDOW ON THIS PANEL ───────────────
//
// The tiles above compare a rolling 14 days against the prior 14; the trend band above is a fixed
// 12 weeks; this is 14 days with NO comparison at all. Three windows on one screen is one more
// than a reader will infer, so each card says its own and the section note says what is missing.
// It CANNOT follow the team's sprint cadence: that setting lives in the private plugin and this
// surface is free — using `INSIGHT_SPRINT_DAYS` is what makes it agree with the tiles beside it by
// construction rather than by luck.
//
// ── NOT CLICKABLE, ON PURPOSE ────────────────────────────────────────────────────────────────
//
// `onSelectBar` is opt-in precisely so a decorative chart adds no unlabelled keyboard stops, and
// `seriesKey` is meaningless on a two-series band anyway. If drill-down is ever wanted, the rail
// already owns per-repo navigation (`setActivityRepo`).

// Human vs automation. The same two hues the panel above uses for its human/bot review-load split,
// so one colour means one thing across the whole screen. Validated as a categorical pair (CVD ΔE
// 30.3 protan, 31.9 tritan, 36.9 normal); the legend BarChart draws for a multi-series chart is the
// relief the orange's sub-3:1 surface contrast obliges.
const HUMAN_COLOR = PALETTE.blue;
const AUTOMATION_COLOR = PALETTE.orange;
// Lines changed is a single series, so it needs no legend and no separation budget — teal is simply
// the one palette hue this panel does not already spend on a trend line.
const LINES_COLOR = PALETTE.teal;

/** How many characters of an axis label survive. MEASURED, not guessed: `rotateLabels` reserves a
 *  FIXED 40px bottom band in BarChart, an 8px label rotated −35° eats `width × sin 35°` of it, and
 *  anything past that is clipped by the svg viewport with no warning — "DEFRA/bng-metric-backend"
 *  rendered as "…etric-backend" on the first draft. BarChart is shared by fifteen call sites, so
 *  the band is not ours to widen; the label is. */
const MAX_LABEL_CHARS = 13;

/** Widest a single repository's bar is drawn, in px. The category count here is the READER'S data,
 *  not ours: a workspace holding one repository would otherwise render it as a ~390px slab that
 *  reads as a filled rectangle rather than a bar, and a two-repository workspace as a pair of
 *  ~250px slabs. Capped and centred, a one-repo chart still says "one repository, this tall".
 *  The BAND is uncapped, so the hover highlight still spans the full column. */
const REPO_BAR_MAX_PX = 72;

/** Axis labels: the trailing segment of `owner/name`, which is what a reader calls the repository.
 *
 *  ⚠ DISAMBIGUATE COLLISIONS. Two owners routinely ship a `frontend`, and BarChart uses ONE string
 *  for both the axis tick and the hover tooltip — so a repository whose short name is not unique in
 *  THIS chart keeps its full name rather than becoming an unresolvable duplicate label.
 *
 *  ⚠ SHORTENING KEEPS THE TAIL, NOT THE HEAD. Repositories in one workspace routinely share a
 *  family PREFIX and differ only at the end — `bng-metric-backend` beside `bng-metric-frontend`,
 *  `nrf-backend` beside `nrf-frontend` — so a head-preserving truncation collapses precisely the
 *  repositories a reader is trying to tell apart. Whenever anything is shortened the component
 *  prints the full names in chart order below, because the tooltip carries this same string and a
 *  reader who cannot recover the name from either place is looking at an unlabelled bar. */
export function axisLabels(rows: Pick<WorkspaceRepoActivityRow, 'repoFullName'>[]): string[] {
  const shortOf = (full: string): string => full.split('/').pop() ?? full;
  const seen = new Map<string, number>();
  for (const r of rows) {
    const s = shortOf(r.repoFullName);
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return rows.map((r) => {
    const s = shortOf(r.repoFullName);
    const label = (seen.get(s) ?? 0) > 1 ? r.repoFullName : s;
    return label.length <= MAX_LABEL_CHARS
      ? label
      : `…${label.slice(label.length - (MAX_LABEL_CHARS - 1))}`;
  });
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function WorkspaceRepoActivityCharts({
  activity,
}: {
  activity: WorkspaceRepoActivity;
}): JSX.Element | null {
  const rows = activity.repos;
  // ⚠ A COMPARISON NEEDS SOMETHING TO COMPARE. On a single-repository workspace this section can
  // only ever draw one bar per chart, and one bar answers "where is the work happening?" with the
  // name the reader already picked in the rail — the tiles above it say the same thing in numbers.
  // So the gate is MEMBERSHIP (`workspaceRepos`), not activity: a workspace that HOLDS several
  // repositories and happened to have one busy fortnight still gets the pair, because "only this
  // one moved" is a real answer, and the disclosure below names how many stayed quiet.
  if (activity.workspaceRepos <= 1) return null;
  // Nothing opened anywhere in the window. The section says nothing at all rather than drawing an
  // empty pair — the flow tiles above already state that this workspace had a quiet fortnight, and
  // two empty boxes repeating it is noise.
  if (rows.length === 0) return null;

  const labels = axisLabels(rows);
  const prSeries: Series[] = [
    {
      key: 'human',
      label: 'People',
      color: HUMAN_COLOR,
      values: rows.map((r) => r.prsOpenedHuman),
    },
    {
      key: 'automation',
      label: 'Automation',
      color: AUTOMATION_COLOR,
      values: rows.map((r) => r.prsOpenedAutomation),
    },
  ];
  // ⚠ `null` AND `0` DRAW IDENTICALLY (BarChart drops every `v <= 0`), so an unsized repository is
  // indistinguishable from one that changed nothing. That is why `linesChanged: null` is passed
  // straight through and the unsized COUNT is disclosed in words below — a missing bar is not a
  // disclosure.
  const lineSeries: Series[] = [
    {
      key: 'lines',
      label: 'Lines changed',
      color: LINES_COLOR,
      values: rows.map((r) => r.linesChanged),
    },
  ];
  const anyLines = rows.some((r) => r.linesChanged != null);

  const shownCount = rows.length;
  const capNote =
    activity.omitted.repos > 0
      ? `top ${shownCount} of ${activity.activeRepos} repositories`
      : `${shownCount} ${plural(shownCount, 'repository', 'repositories')}`;

  const unsized = rows.reduce((n, r) => n + r.unsizedPrs, 0);
  const partial = rows.filter((r) => r.addedDuringWindow);
  // A label was shortened somewhere, so the axis AND the tooltip are both abbreviated — the full
  // names have to be recoverable from the page or the bar is unlabelled.
  const shortened = labels.some((l) => l.startsWith('…'));

  return (
    <div className="space-y-2">
      <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Where the work is happening
      </h4>
      {/* The window, stated once for the pair. It differs from BOTH windows above it — the tiles
          compare against a prior fortnight and the trend band spans 12 weeks — so saying "rolling
          14 days" alone would still leave a reader assuming a comparison that is not there. */}
      <p className="text-[10px] text-gray-400">
        Pull requests opened in the last {activity.windowDays} days, by repository — the same window
        as the tiles above, with no prior-period comparison. Both charts are in the same order.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard
          title="PRs opened"
          note={`people vs automation · ${activity.windowDays} days · ${capNote}`}
        >
          <BarChart
            labels={labels}
            series={prSeries}
            mode="stacked"
            formatY={fmtNum}
            rotateLabels
            height={168}
            maxBarWidth={REPO_BAR_MAX_PX}
          />
        </ChartCard>
        <ChartCard
          title="Lines changed"
          note={`additions + deletions · ${activity.windowDays} days · ranked by PRs opened`}
        >
          {anyLines ? (
            <BarChart
              labels={labels}
              series={lineSeries}
              formatY={fmtNum}
              rotateLabels
              height={168}
              maxBarWidth={REPO_BAR_MAX_PX}
            />
          ) : (
            <ChartEmpty label="No pull request in this window has a recorded size" />
          )}
        </ChartCard>
      </div>

      {/* The disclosures. Each one exists because the alternative is a chart that quietly asserts
          something false; none of them is decoration. */}
      <div className="space-y-0.5 text-[10px] text-gray-400">
        {shortened && (
          // The names in chart order — the key for the abbreviated axis, and incidentally the
          // proof that the two charts really are in one order.
          <p>
            <span className="text-gray-500 dark:text-gray-400">In order:</span>{' '}
            {rows.map((r) => r.repoFullName).join(' · ')}
          </p>
        )}
        {activity.omitted.repos > 0 && (
          // NO SILENT CAPS. And the second chart is ranked by the FIRST chart's metric, so the
          // repository that leads on lines changed can sit below the fold — naming what the cut
          // was worth on both axes is the only way a reader can see that.
          <p>
            {activity.omitted.repos} more {plural(activity.omitted.repos, 'repository', 'repositories')}{' '}
            saw {fmtNum(activity.omitted.prsOpened)}{' '}
            {plural(activity.omitted.prsOpened, 'pull request', 'pull requests')}
            {activity.omitted.linesChanged != null && (
              <> and {fmtNum(activity.omitted.linesChanged)} lines changed</>
            )}{' '}
            in this window and are not shown.
          </p>
        )}
        {activity.workspaceRepos > activity.activeRepos && (
          // A repository with NOTHING opened gets no band at all, which on its own reads as
          // "this workspace has N repos". On real data 3 of one workspace's 5 repositories were
          // silent for the fortnight — a fact about the workspace, not an omission from the chart.
          <p>
            {activity.workspaceRepos - activity.activeRepos} of the{' '}
            {activity.workspaceRepos} {plural(activity.workspaceRepos, 'repository', 'repositories')}{' '}
            in this workspace saw no pull request opened in this window.
          </p>
        )}
        {unsized > 0 && (
          // ⚠ UNKNOWN SIZE IS NOT ZERO SIZE. The three size columns are NOT NULL DEFAULT 0, so a PR
          // whose detail never hydrated is byte-identical to one that changed nothing. Those PRs
          // are counted in "PRs opened" and excluded from "Lines changed", which means the two
          // charts cover different populations — and a reader is entitled to know by how much.
          <p>
            {fmtNum(unsized)} {plural(unsized, 'pull request has', 'pull requests have')} no recorded
            size and {plural(unsized, 'is', 'are')} counted in PRs opened but not in lines changed.
          </p>
        )}
        {partial.length > 0 && (
          // COVERAGE BIAS. A repository added part-way through the window draws a short bar that
          // reads as "this team is quiet". It is not pro-rated up — that would fabricate pull
          // requests nobody opened — it is named.
          <p>
            {partial.map((r) => r.repoFullName).join(', ')}{' '}
            {plural(partial.length, 'was', 'were')} added to this workspace during the window, so{' '}
            {plural(partial.length, 'its bars cover', 'their bars cover')} less than{' '}
            {activity.windowDays} days.
          </p>
        )}
      </div>
    </div>
  );
}
