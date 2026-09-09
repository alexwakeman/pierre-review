import type { WorkspaceReach } from '../../hooks/useBlastRadius.js';
import { RepoRows, type RepoRowColumn } from '../charts/RepoRows.js';
import { ChartCard, fmtNum } from '../charts/common.js';

// REACH BY REPOSITORY — the second card in Reports → Flow metrics → "Where the work is happening".
//
// Which repositories are carrying pull requests that could reach a long way, right now. The level
// is `blastRadius()`'s, folded per repository by `useWorkspaceReach` — the SAME resolver the chip
// on every board card calls, so this card and those chips can never disagree, and the Settings
// sensitivity dial repaints it live with no cache invalidation.
//
// ── FREE ON EVERY TIER ───────────────────────────────────────────────────────────────────────
//
// No `ProGate`, no capability read, no 402 — blast radius is CORE and so is its home. It mounts
// inside `WorkspaceRepoActivityCharts`, i.e. in `WorkspaceFlowMetrics`, never inside
// `WorkspaceMetricsPanel` (which is ALSO mounted per-repo behind a Pro gate, where a per-repo
// breakdown is one row for paying accounts only).
//
// ── THE POPULATION IS "OPEN RIGHT NOW", AND THAT IS A FOURTH FRAMING ON THIS PANEL ────────────
//
// The tiles above compare a rolling 14 days against the prior 14; the trend band is a fixed 12
// weeks; the card beside this one is a rolling 14 days with no comparison; this is a SNAPSHOT with
// no window at all. So it says so in its own words rather than inheriting its neighbour's.
//
// (The "no as-of-now snapshot" ban does not reach here: that one is specific to the STORED period
// vector, whose rows are persisted, payload-hashed, billed and subtracted period-over-period.
// Nothing here is stored, hashed or compared against a prior period.)
//
// ── UNKNOWN IS NOT A FOURTH SEGMENT AND NOT A ZERO ───────────────────────────────────────────
//
// ⚠ `blastRadius()` returns null for BOTH "never measured" and "GitHub truncated the file list and
// no high arm fired" — 10.0% of open pull requests on the dev corpus before the file backfill.
// Those pull requests are NOT DRAWN: a fourth band would make "we don't know" look like a level
// and would inflate the bar so it no longer means "pull requests with a reading". The consequence
// is that a repository's bar does NOT total its open-PR count, which the list is ranked by — so
// the count is stated in words under the card, and beside the name of any repository it applies
// to. A missing segment is not a disclosure.
//
// ── EVERY PRINTED TOTAL COVERS THE DRAWN ROWS ────────────────────────────────────────────────
//
// ⚠ ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS. `useWorkspaceReach` folds
// `openPrs`, `unread` and `drafts` over the SHOWN repositories, so every figure in the prose below
// describes the drawing above it. What the cap cut rides `omitted`, is said in its own sentence,
// and is never subtracted against them.

/** Low → high, and the STACK ORDER IS FIXED, so position encodes the level as well as hue does.
 *
 *  ⚠ MEASURED AS FILLS AGAINST BOTH PAGE GROUNDS (#ffffff light, #030712 dark), not eyeballed —
 *  every one clears the 3:1 non-text floor on BOTH, which is a narrow band: it admits only
 *  luminance 0.107–0.300, so a light-to-dark ramp of one hue is arithmetically impossible here.
 *
 *    #0072B2  low     5.19:1 light · 3.88:1 dark
 *    #CC79A7  medium  3.06:1 light · 6.58:1 dark
 *    #D55E00  high    3.87:1 light · 5.21:1 dark
 *
 *  They are three of the Okabe–Ito colour-vision-deficiency-safe eight, chosen as a cool→warm ramp
 *  so the direction reads without relying on hue discrimination.
 *
 *  ⚠ TWO CANDIDATES WERE REJECTED BY MEASUREMENT. `PALETTE.green` (#22c55e) is the success green
 *  the CI dot uses, which `BlastRadiusChip` rejects BY NAME — a low blast radius is a claim about
 *  scope, never that anything passed — and it measures 2.28:1 on the light ground anyway.
 *  `PALETTE.gray` (#9ca3af) measures 2.54:1 there, under the floor. The chip's own amber
 *  (#f59e0b, 2.15:1) fails as a fill for the same reason, which is why this card cannot simply
 *  reuse the chip's text colours: those are theme-forked pairs, and a fill is one hex. */
const LOW_COLOR = '#0072B2';
const MEDIUM_COLOR = '#CC79A7';
const HIGH_COLOR = '#D55E00';

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** ⚠ PROSE COUNTS ARE PRINTED IN FULL, NEVER THROUGH `fmtNum`. Every sentence under this card is a
 *  fraction whose whole purpose is that a reader can check it, and `fmtNum` collapses anything over
 *  999 to one decimal of thousands — "156 of the 1.6k open pull requests" is not an arithmetic
 *  anybody can perform. `fmtNum` stays INSIDE the table, where a cell shares its formatter with the
 *  column maximum printed under it. (Not reachable on the dev corpus, whose largest workspace holds
 *  706 open pull requests; the account holds 1,564 across eight, so one consolidation reaches it.) */
function count(n: number): string {
  return n.toLocaleString();
}

/** ⚠ EVERY PROSE FRACTION ON THIS CARD IS OVER THE ROWS DRAWN, NOT THE WORKSPACE. `reach.openPrs`
 *  and its siblings fold over the top-`REACH_MAX_REPOS` slice, so that the sentences describe the
 *  bars — the alternative was a denominator counting repositories the reader cannot see. Once the
 *  cap bites, saying "the 210 open pull requests" full stop is then a claim about the workspace
 *  that is false, so the phrase says which population it means. Below the cap nothing is cut and
 *  the qualifier would be noise, so it is omitted — the same rule the cap disclosure follows. */
function shownHere(omittedRepos: number): string {
  return omittedRepos > 0 ? ' shown here' : '';
}

export function WorkspaceReachCard({
  reach,
  /** The window the card BESIDE this one covers, or null when that card is not rendered (a
   *  single-repository workspace, or a fortnight in which nothing was opened). The sentence below
   *  names it, so it must not be a constant this file keeps its own copy of — and it must not be
   *  said at all when there is no neighbour to say it about. */
  neighbourWindowDays,
}: {
  reach: WorkspaceReach;
  neighbourWindowDays: number | null;
}): JSX.Element {
  const shownCount = reach.repos.length;
  const capNote =
    reach.omitted.repos > 0
      ? `top ${shownCount} of ${reach.repoCount} repositories`
      : `${shownCount} ${plural(shownCount, 'repository', 'repositories')}`;

  const columns: RepoRowColumn[] = [
    {
      key: 'reach',
      header: 'Open pull requests',
      segments: [
        { key: 'low', label: 'Low', color: LOW_COLOR },
        { key: 'medium', label: 'Medium', color: MEDIUM_COLOR },
        { key: 'high', label: 'High', color: HIGH_COLOR },
      ],
      // ⚠ A repository whose every open pull request is unread prints the words rather than an
      // empty bar, which is the same pixels as "nothing open here".
      values: reach.repos.map((r) => (r.read === 0 ? null : [r.low, r.medium, r.high])),
      unknownLabel: 'no reading',
      format: fmtNum,
      // Each level gets its own printed figure under its own heading: the split IS the question,
      // and a reader should not have to decode a colour to answer it.
      valueMode: 'segments',
      barWidthPct: 24,
      valueWidthPct: 14,
    },
  ];

  return (
    <div className="space-y-2">
      <ChartCard title="Reach by repository" note={`open now · ${capNote}`}>
        <RepoRows
          labels={reach.repos.map((r) => r.repoFullName)}
          columns={columns}
          nameWidthPct={34}
          noteFor={(i) => {
            const r = reach.repos[i];
            return r != null && r.unread > 0 ? `${fmtNum(r.unread)} with no reading` : null;
          }}
        />
      </ChartCard>
      <div className="space-y-1 text-[12px] text-gray-500 dark:text-gray-400">
        <p>
          Every pull request open right now, by how far it could reach — a snapshot, not a window.
          {/* ⚠ THE NEIGHBOUR IS NAMED, NEVER POSITIONED. The grid is two columns only at `lg` and
              above; below it the cards STACK, and "the card beside it" is then the card above. */}
          {neighbourWindowDays != null && (
            <> Activity by repository covers the last {neighbourWindowDays} days.</>
          )}
        </p>
        {reach.unread > 0 && (
          // ⚠ THE BARS DO NOT TOTAL THE OPEN-PR COUNT, and this sentence is the only place that
          // difference is visible. Both halves are printed so the subtraction is checkable.
          <p>
            {count(reach.unread)} of the {count(reach.openPrs)} open{' '}
            {plural(reach.openPrs, 'pull request', 'pull requests')}
            {shownHere(reach.omitted.repos)}{' '}
            {plural(reach.unread, 'has', 'have')} no reading and{' '}
            {plural(reach.unread, 'is', 'are')} not drawn.
          </p>
        )}
        {reach.drafts > 0 && (
          // ⚠ THE ONE PLACE THIS CARD AND THE "OPEN PRS" TILE ABOVE CAN BE RECONCILED — while
          // nothing is cut. The tile excludes drafts and this does not, so on a real workspace they
          // read 204 and 210. A draft that touches a migration is reach sitting in the repository;
          // dropping it would make the number agree by making it wrong. Past the cap the two stop
          // being comparable (the tile is workspace-wide, this is the drawn rows), which is what
          // `shownHere` says out loud rather than leaving the reader to a subtraction that no
          // longer works.
          //
          // ⚠ IT CARRIES ITS OWN DENOMINATOR AND ITS OWN NOUN. "N of them are drafts" printed the
          // total nowhere at all whenever the unread sentence above was absent (it is, on a fully
          // read corpus) — a reconciliation missing one of its two numbers — and when that sentence
          // WAS present, "them" read as the unread subset, which drafts is not counted over.
          <p>
            {count(reach.drafts)} of the {count(reach.openPrs)} open{' '}
            {plural(reach.openPrs, 'pull request', 'pull requests')}
            {shownHere(reach.omitted.repos)}{' '}
            {plural(reach.drafts, 'is a draft', 'are drafts')}.
          </p>
        )}
        {reach.omitted.repos > 0 && (
          // NO SILENT CAPS — AND THE CUT IS NAMED ON THE DRAWN MEASURE TOO. The list is ranked by
          // TOTAL open pull requests while the bars draw the Low/Medium/High split, so the
          // repository holding the most high-reach pull requests can sit below the fold and a
          // sentence naming only the PR count would give a reader no way to know. (`omitted
          // .linesChanged` on the card beside this one exists for the identical reason.)
          <p>
            {count(reach.omitted.repos)} more{' '}
            {plural(reach.omitted.repos, 'repository', 'repositories')}{' '}
            {plural(reach.omitted.repos, 'holds', 'hold')} {count(reach.omitted.openPrs)} open{' '}
            {plural(reach.omitted.openPrs, 'pull request', 'pull requests')},{' '}
            {reach.omitted.high === 0 ? 'none' : count(reach.omitted.high)} of them high reach, and{' '}
            {plural(reach.omitted.repos, 'is', 'are')} not shown.
          </p>
        )}
        {reach.workspaceRepos > reach.repoCount && (
          // A repository with NOTHING open gets no row at all, which on its own reads as "this
          // workspace has N repositories" — and the card beside this one counts a different N (7
          // repositories saw a PR opened in the fortnight; 4 hold anything open right now), so
          // without this sentence the two cards' repository counts disagree with nothing accounting
          // for the difference. The neighbour states its own version of exactly this.
          <p>
            {count(reach.workspaceRepos - reach.repoCount)} of the {count(reach.workspaceRepos)}{' '}
            {plural(reach.workspaceRepos, 'repository', 'repositories')} in this workspace{' '}
            {plural(reach.workspaceRepos - reach.repoCount, 'has', 'have')} nothing open right now.
          </p>
        )}
      </div>
    </div>
  );
}
