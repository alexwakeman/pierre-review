import type { ReportingWindowInfo } from '@pierre-review/shared';
import type { WorkspaceReach } from './reachModel.js';
import { reportingWindowPhrase, reportingWindowTitle, windowDates } from './reportingWindowText.js';
import { RepoRows, type RepoRowColumn } from '../charts/RepoRows.js';
import { ChartCard, fmtNum } from '../charts/common.js';
import { InfoButton } from '../InfoModal.js';

// REACH BY REPOSITORY — the second card in Reports → Flow metrics → "Where the work is happening".
//
// Which repositories merged pull requests that could reach a long way, IN THE REPORTING WINDOW. The
// level is `blastRadius()`'s, folded per repository by `foldWorkspaceReach` (reachModel.ts) — the
// SAME resolver the chip on every board card calls, so this card and those chips can never
// disagree, and the Settings sensitivity dial repaints it live with no cache invalidation.
//
// ── FREE ON EVERY TIER ───────────────────────────────────────────────────────────────────────
//
// No `ProGate`, no capability read, no 402 — blast radius is CORE and so is its home. It mounts
// inside `WorkspaceRepoActivityCharts`, i.e. in `WorkspaceFlowMetrics`, never inside
// `WorkspaceMetricsPanel` (which is ALSO mounted per-repo behind a Pro gate, where a per-repo
// breakdown is one row for paying accounts only).
//
// ── THE POPULATION IS "MERGED IN THE REPORTING WINDOW" ───────────────────────────────────────
//
// Reports' rule: every figure is tied to the workspace's reporting window (this sprint so far, or
// the last 7/14 days). This card used to be a snapshot of the pull requests open at that moment, which read
// as a sprint figure beside the tiles and then emptied whenever nothing happened to be open. It is now
// the pull requests MERGED in the window — the same window, from the same server resolution, as the
// tiles above it and the card beside it — and it names that window in its note and its "i".
// Drafts do not apply to merged pull requests, so there is no draft disclosure any more.
//
// ── UNKNOWN IS NOT A FOURTH SEGMENT AND NOT A ZERO ───────────────────────────────────────────
//
// ⚠ `blastRadius()` returns null for BOTH "never measured" and "GitHub truncated the file list and
// no high arm fired". Those pull requests are NOT DRAWN: a fourth band would make "we don't know"
// look like a level. So a repository's bar does NOT total its merged count, which the list is
// ranked by — the count is stated in words under the card, and beside the name of any repository
// it applies to.
//
// ── EVERY PRINTED TOTAL COVERS THE DRAWN ROWS ────────────────────────────────────────────────
//
// ⚠ ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS. The fold totals `merged` and
// `unread` over the SHOWN repositories, so every figure in the prose describes the drawing above
// it. What the cap cut rides `omitted`, is said in its own sentence, and is never subtracted.

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
 *  999 to one decimal of thousands — "156 of the 1.6k merged pull requests" is not an arithmetic
 *  anybody can perform. `fmtNum` stays INSIDE the table, where a cell shares its formatter with the
 *  column maximum printed under it. */
function count(n: number): string {
  return n.toLocaleString();
}

/** ⚠ EVERY PROSE FRACTION ON THIS CARD IS OVER THE ROWS DRAWN, NOT THE WORKSPACE. `reach.merged`
 *  and its siblings fold over the top-`REACH_MAX_REPOS` slice, so that the sentences describe the
 *  bars — the alternative was a denominator counting repositories the reader cannot see. Once the
 *  cap bites, saying "the 210 merged pull requests" full stop is then a claim about the workspace
 *  that is false, so the phrase says which population it means. Below the cap nothing is cut and
 *  the qualifier would be noise, so it is omitted — the same rule the cap disclosure follows. */
function shownHere(omittedRepos: number): string {
  return omittedRepos > 0 ? ' shown here' : '';
}

export function WorkspaceReachCard({
  reach,
  window,
}: {
  reach: WorkspaceReach;
  /** The reporting window the pull requests were merged in — the same one the tiles name. */
  window: ReportingWindowInfo;
}): JSX.Element {
  const shownCount = reach.repos.length;
  const capNote =
    reach.omitted.repos > 0
      ? `top ${shownCount} of ${reach.repoCount} repositories`
      : `${shownCount} ${plural(shownCount, 'repository', 'repositories')}`;
  const nothingMerged = reach.repoCount === 0;
  const noneRead = !nothingMerged && reach.read === 0 && reach.omitted.read === 0;

  const columns: RepoRowColumn[] = [
    {
      key: 'reach',
      header: 'Merged pull requests',
      segments: [
        { key: 'low', label: 'Low', color: LOW_COLOR },
        { key: 'medium', label: 'Medium', color: MEDIUM_COLOR },
        { key: 'high', label: 'High', color: HIGH_COLOR },
      ],
      // ⚠ A repository whose every merged pull request is unread prints the words rather than an
      // empty bar, which is the same pixels as "nothing merged here".
      values: reach.repos.map((r) => (r.read === 0 ? null : [r.low, r.medium, r.high])),
      unknownLabel: 'reach unknown',
      format: fmtNum,
      // Each level gets its own printed figure under its own heading: the split IS the question,
      // and a reader should not have to decode a colour to answer it.
      valueMode: 'segments',
      barWidthPct: 24,
      valueWidthPct: 14,
    },
  ];

  return (
    /* ⚠ `h-full`, AND THE DISCLOSURES ARE INSIDE THE CARD — see the grid comment in
       `WorkspaceRepoActivityCharts`. The two cards on that row end on one line, and the slack goes
       to the shorter one's bottom as blank space rather than being spread through its rows. */
    <ChartCard
      title="Reach by repository"
      note={nothingMerged ? reportingWindowTitle(window) : `${reportingWindowTitle(window)} · ${capNote}`}
      className="h-full"
      testId="workspace-reach"
      info={
        <InfoButton title="Reach by repository">
          <p>
            Every pull request merged {reportingWindowPhrase(window)} ({windowDates(window)}), by
            how far its change could reach: Low, Medium or High. It is the same window as the flow
            metrics and Activity by repository.
          </p>
          <p>
            A pull request with no reach level yet is not drawn, so a bar can be shorter than the
            repository&rsquo;s merged count.
          </p>
          <p>The levels follow the sensitivity set in Settings → Blast radius.</p>
        </InfoButton>
      }
    >
      {nothingMerged ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          No pull requests merged in this window.
        </p>
      ) : noneRead ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {count(reach.merged)} {plural(reach.merged, 'pull request', 'pull requests')} merged in
          this window, none with a reach level yet.
        </p>
      ) : (
        <RepoRows
          labels={reach.repos.map((r) => r.repoFullName)}
          columns={columns}
          nameWidthPct={34}
          noteFor={(i) => {
            const r = reach.repos[i];
            return r != null && r.unread > 0 ? `${fmtNum(r.unread)} with reach unknown` : null;
          }}
        />
      )}
      <div className="mt-2 space-y-1 text-[12px] text-gray-500 dark:text-gray-400">
        {!noneRead && reach.unread > 0 && (
          // ⚠ THE BARS DO NOT TOTAL THE MERGED COUNT, and this sentence is the only place that
          // difference is visible. Both halves are printed so the subtraction is checkable.
          <p>
            {count(reach.unread)} of the {count(reach.merged)} merged{' '}
            {plural(reach.merged, 'pull request', 'pull requests')}
            {shownHere(reach.omitted.repos)}{' '}
            {plural(reach.unread, 'has', 'have')} no reach level yet and{' '}
            {plural(reach.unread, 'is', 'are')} not drawn.
          </p>
        )}
        {reach.omitted.repos > 0 && (
          // NO SILENT CAPS — AND THE CUT IS NAMED ON THE DRAWN MEASURE TOO. The list is ranked by
          // merges while the bars draw the Low/Medium/High split, so the repository holding the
          // most high-reach pull requests can sit below the fold.
          <p>
            {count(reach.omitted.repos)} more{' '}
            {plural(reach.omitted.repos, 'repository', 'repositories')} merged{' '}
            {count(reach.omitted.merged)}{' '}
            {plural(reach.omitted.merged, 'pull request', 'pull requests')},{' '}
            {reach.omitted.high === 0 ? 'none' : count(reach.omitted.high)} of them high reach, and{' '}
            {plural(reach.omitted.repos, 'is', 'are')} not shown.
          </p>
        )}
        {!nothingMerged && reach.workspaceRepos > reach.repoCount && (
          // A repository that merged NOTHING gets no row at all, which on its own reads as "this
          // workspace has N repositories".
          <p>
            {count(reach.workspaceRepos - reach.repoCount)} of the {count(reach.workspaceRepos)}{' '}
            {plural(reach.workspaceRepos, 'repository', 'repositories')} in this workspace merged
            nothing in this window.
          </p>
        )}
        {reach.truncated && (
          <p>Only the earliest pull requests merged in this window are counted; the list is partial.</p>
        )}
      </div>
    </ChartCard>
  );
}
