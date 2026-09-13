import type { WorkspaceRepoActivity } from '@pierre-review/shared';
import { RepoRows, type RepoRowColumn } from '../charts/RepoRows.js';
import { ChartCard, PALETTE, fmtNum } from '../charts/common.js';
import { useWorkspaceReach } from '../../hooks/useBlastRadius.js';
import { WorkspaceReachCard } from './WorkspaceReachCard.js';

// WHERE IS THE WORK HAPPENING — the per-repository half of Flow metrics.
//
// The tiles and 12-week trends above answer "how much" and "how fast" for the whole workspace.
// They cannot answer "which repository", and on a real workspace the members differ by two orders
// of magnitude: one fortnight held 147 PRs / 1.4k lines in a config repo and 71 PRs / 141.7k lines
// in an application repo. Both are activity; they are not the same activity.
//
// The section holds TWO CARDS side by side: this one (what was opened in the last 14 days) and
// `WorkspaceReachCard` (how far the pull requests open RIGHT NOW could reach). Two questions, two
// populations, two windows — so each card states its own beneath itself.
//
// ── TWO MEASURES, TWO SCALES, NOT ONE SCORE ──────────────────────────────────────────────────
//
// The tempting shape is a single "activity index" per repository — some normalised blend of PR
// count and line count. It is the exact shape this codebase rejects in five separate places ("a
// blended figure is a number no PR resembles"; "a workspace-wide rate is a number no member of any
// cell resembles"; the rollup carries no percentile of its own; two populations must be labelled
// apart and never subtracted), and there is no precedent anywhere in this repo for a normalised
// composite. Nobody could reconcile such an index with the tiles directly above it, and no
// repository would resemble its own number.
//
// The two measures are now COLUMNS OF ONE ROW LIST rather than two bar charts, which is a layout
// change and not a licence to fuse them: `RepoRows` scales each column against ITS OWN maximum and
// prints its own origin, so a bar length is a ratio within one column and never a cross-measure
// number. (A grouped BarChart was never available: `niceMax` gives every series ONE y-axis, and a
// PR count ≈5 beside a line count ≈5000 draws the count sub-pixel — MEASURED at 50 vs 50k on real
// data.) One repository is one row, so the two measures are in one order by construction rather
// than by a claim printed under a pair of charts.
//
// ── THE REPOSITORY NAME IS WRITTEN OUT IN FULL ───────────────────────────────────────────────
//
// This replaced a rotated 8px axis label truncated to 13 characters, which MEASURED as six of
// seven real repositories rendering as "…tric-backend" — and the clipped glyph was the very "…"
// that said so. The row label wraps instead. `axisLabels()`, `MAX_LABEL_CHARS` and the "In order:"
// recovery line under the pair are all deleted with it: there is nothing left to recover.
//
// ── THE WINDOW IS A ROLLING 14 DAYS, AND THAT IS THE THIRD WINDOW ON THIS PANEL ───────────────
//
// The tiles above compare a rolling 14 days against the prior 14; the trend band above is a fixed
// 12 weeks; this is 14 days with NO comparison at all, and the reach card beside it is a snapshot
// with no window. Four framings on one screen is more than a reader will infer, so each card says
// its own. This one CANNOT follow the team's sprint cadence: that setting lives in the private
// plugin and this surface is free — using `INSIGHT_SPRINT_DAYS` is what makes it agree with the
// tiles beside it by construction rather than by luck.
//
// ── NOT CLICKABLE, ON PURPOSE ────────────────────────────────────────────────────────────────
//
// No row is a button and no cell carries a handler, so a decorative table adds no unlabelled
// keyboard stops. If drill-down is ever wanted, the rail already owns per-repo navigation
// (`setActivityRepo`).

// Human vs automation. The same two hues the panel above uses for its human/bot review-load split,
// so one colour means one thing across the whole screen. Validated as a categorical pair (CVD ΔE
// 30.3 protan, 31.9 tritan, 36.9 normal); the key `RepoRows` draws under the list is the relief the
// orange's sub-3:1 surface contrast obliges (MEASURED 2.80:1 against the light page ground), and
// every figure is printed beside its own bar besides.
const HUMAN_COLOR = PALETTE.blue;
const AUTOMATION_COLOR = PALETTE.orange;
// Lines changed is one segment, so it needs no separation budget — teal is simply the one palette
// hue this panel does not already spend on a trend line. It is also below the 3:1 fill floor on the
// light ground (2.49:1), which is survivable for the same two reasons the orange is: the key names
// it, and the number is printed on every row.
const LINES_COLOR = PALETTE.teal;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function WorkspaceRepoActivityCharts({
  activity,
}: {
  activity: WorkspaceRepoActivity;
}): JSX.Element | null {
  // The reach card folds its own data (every open PR in the workspace, through the ONE
  // `blastRadius()` resolver) and answers a different question on a different population, so it is
  // NOT gated on this card's two conditions — three of the dev DB's eight workspaces hold a single
  // repository, where "which repository" is unanswerable but "what mix of reach" is not.
  const reach = useWorkspaceReach();

  const rows = activity.repos;
  // ⚠ A COMPARISON NEEDS SOMETHING TO COMPARE. On a single-repository workspace this card can only
  // ever draw one row, and one row answers "where is the work happening?" with the name the reader
  // already picked in the rail — the tiles above it say the same thing in numbers. So the gate is
  // MEMBERSHIP (`workspaceRepos`), not activity: a workspace that HOLDS several repositories and
  // happened to have one busy fortnight still gets the card, because "only this one moved" is a
  // real answer, and the disclosure below names how many stayed quiet.
  //
  // Nothing opened anywhere in the window is the second gate: the card says nothing at all rather
  // than drawing an empty list — the flow tiles above already state that this workspace had a quiet
  // fortnight, and an empty box repeating it is noise.
  const showActivity = activity.workspaceRepos > 1 && rows.length > 0;
  if (!showActivity && reach == null) return null;

  const labels = rows.map((r) => r.repoFullName);
  const columns: RepoRowColumn[] = [
    {
      key: 'prs',
      header: 'PRs opened',
      segments: [
        { key: 'human', label: 'People', color: HUMAN_COLOR },
        { key: 'automation', label: 'Automation', color: AUTOMATION_COLOR },
      ],
      values: rows.map((r) => [r.prsOpenedHuman, r.prsOpenedAutomation]),
      // Never reached: a count of pull requests opened is always known.
      unknownLabel: 'not counted',
      format: fmtNum,
      valueMode: 'total',
      barWidthPct: 20,
      valueWidthPct: 10,
    },
    {
      key: 'lines',
      header: 'Lines changed',
      segments: [{ key: 'lines', label: 'Lines changed', color: LINES_COLOR }],
      // ⚠ UNKNOWN SIZE IS NOT ZERO SIZE. `linesChanged: null` reaches the row as `null` and prints
      // "size unknown" against that repository's name — a zero-length bar and an absent one are the
      // same pixels, and neither is a disclosure.
      //
      // ⚠ THAT LABEL FIRES ONLY FOR AN ALL-UNSIZED REPOSITORY. The fold nulls `linesChanged` when
      // `sizedPrs === 0` and no sooner, so a repository with SOME unsized pull requests draws a
      // full-looking bar covering only its sized subset — MEASURED on workspace 1: one repository
      // opened 45 PRs of which 2 were never sized, beside six neighbours with none, drawn
      // identically. The PARTIAL case is marked by `noteFor` under the repository's own name; the
      // aggregate sentence below counts the pull requests and says nothing about where they are.
      values: rows.map((r) => (r.linesChanged == null ? null : [r.linesChanged])),
      unknownLabel: 'size unknown',
      format: fmtNum,
      valueMode: 'total',
      barWidthPct: 20,
      valueWidthPct: 12,
    },
  ];

  const shownCount = rows.length;
  const capNote =
    activity.omitted.repos > 0
      ? `top ${shownCount} of ${activity.activeRepos} repositories`
      : `${shownCount} ${plural(shownCount, 'repository', 'repositories')}`;

  const unsized = rows.reduce((n, r) => n + r.unsizedPrs, 0);
  const partial = rows.filter((r) => r.addedDuringWindow);

  return (
    <div className="space-y-2" data-testid="repo-activity-charts">
      <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Where the work is happening
      </h4>
      {/* Two columns on a wide screen, stacked below `lg`. It stays two columns even when only ONE
          card renders: a lone card stretched to 1,350px puts its numbers a screen-width away from
          the name they belong to, which is the reading problem this whole section exists to fix.
          ⚠ THE CELLS STRETCH, AND EACH CARD IS `h-full` INSIDE ITS CELL — so the two boxes end on
          one line whatever their contents weigh. Their disclosures live INSIDE the cards for the
          same reason: while they hung below, each card was its own height and the two sentence
          blocks started at different y, which made a two-card row read as two unrelated things.
          The slack goes to the shorter card's BOTTOM as blank space; nothing is spread to fill. */}
      <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2">
        {showActivity && (
          <ChartCard
            title="Activity by repository"
            note={`${activity.windowDays} days · ${capNote}`}
            className="h-full"
          >
              <RepoRows
                labels={labels}
                columns={columns}
                nameWidthPct={38}
                // ⚠ A PARTIALLY-SIZED REPOSITORY MARKS ITSELF. `unknownLabel` covers only the
                // all-unsized case; this covers the one the aggregate sentence cannot, because that
                // sentence counts pull requests and never says which repository they are in.
                noteFor={(i) => {
                  const r = rows[i];
                  if (r == null || r.unsizedPrs === 0 || r.linesChanged == null) return null;
                  return `lines cover ${fmtNum(r.sizedPrs)} of ${fmtNum(
                    r.sizedPrs + r.unsizedPrs,
                  )} PRs`;
                }}
              />
              <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
                Each column has its own scale, so a bar compares repositories within its column and
                never across the two.
              </p>

            {/* The disclosures. Each one exists because the alternative is a list that quietly
                asserts something false; none of them is decoration. */}
            <div className="mt-2 space-y-1 text-[12px] text-gray-500 dark:text-gray-400">
              {/* The window, stated once. It differs from BOTH windows above it — the tiles compare
                  against a prior fortnight and the trend band spans 12 weeks — so saying "rolling
                  14 days" alone would still leave a reader assuming a comparison that is not
                  there. */}
              <p>
                Pull requests opened in the last {activity.windowDays} days, by repository — the
                same window as the tiles above, with no prior-period comparison.
              </p>
              {activity.omitted.repos > 0 && (
                // NO SILENT CAPS. The list is ranked by PRs opened, so the repository that leads on
                // lines changed can sit below the fold — naming what the cut was worth on both
                // measures is the only way a reader can see that.
                <p>
                  {activity.omitted.repos} more{' '}
                  {plural(activity.omitted.repos, 'repository', 'repositories')} saw{' '}
                  {fmtNum(activity.omitted.prsOpened)}{' '}
                  {plural(activity.omitted.prsOpened, 'pull request', 'pull requests')}
                  {activity.omitted.linesChanged != null && (
                    <> and {fmtNum(activity.omitted.linesChanged)} lines changed</>
                  )}{' '}
                  in this window and are not shown.
                </p>
              )}
              {activity.workspaceRepos > activity.activeRepos && (
                // A repository with NOTHING opened gets no row at all, which on its own reads as
                // "this workspace has N repos". On real data 3 of one workspace's 5 repositories
                // were silent for the fortnight — a fact about the workspace, not an omission.
                <p>
                  {activity.workspaceRepos - activity.activeRepos} of the {activity.workspaceRepos}{' '}
                  {plural(activity.workspaceRepos, 'repository', 'repositories')} in this workspace
                  saw no pull request opened in this window.
                </p>
              )}
              {unsized > 0 && (
                // ⚠ UNKNOWN SIZE IS NOT ZERO SIZE. The three size columns are NOT NULL DEFAULT 0,
                // so a PR whose detail never hydrated is byte-identical to one that changed
                // nothing. Those PRs are counted in "PRs opened" and excluded from "Lines changed",
                // which means the two columns cover different populations — and a reader is
                // entitled to know by how much. ⚠ THIS SENTENCE COUNTS PULL REQUESTS AND NEVER SAYS
                // WHERE THEY ARE: the rows are what name repositories, either as "size unknown"
                // (nothing in it was ever sized) or as "lines cover 43 of 45 PRs" (some of it was).
                <p>
                  {fmtNum(unsized)} {plural(unsized, 'pull request has', 'pull requests have')} no
                  recorded size and {plural(unsized, 'is', 'are')} counted in PRs opened but not in
                  lines changed.
                </p>
              )}
              {partial.length > 0 && (
                // COVERAGE BIAS. A repository added part-way through the window draws a short bar
                // that reads as "this team is quiet". It is not pro-rated up — that would fabricate
                // pull requests nobody opened — it is named.
                <p>
                  {partial.map((r) => r.repoFullName).join(', ')}{' '}
                  {plural(partial.length, 'was', 'were')} added to this workspace during the window,
                  so {plural(partial.length, 'its bars cover', 'their bars cover')} less than{' '}
                  {activity.windowDays} days.
                </p>
              )}
            </div>
          </ChartCard>
        )}
        {reach != null && (
          <WorkspaceReachCard
            reach={reach}
            neighbourWindowDays={showActivity ? activity.windowDays : null}
          />
        )}
      </div>
    </div>
  );
}
