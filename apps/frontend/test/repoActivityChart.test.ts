// "Where the work is happening" — the two per-repository cards under Flow metrics on Reports →
// Overview: `WorkspaceRepoActivityCharts` (what was opened in the last 14 days) and
// `WorkspaceReachCard` (how far the pull requests open right now could reach).
//
// These are SOURCE guards. Everything pinned here is load-bearing and invisible in the rendered
// JSX, and each failure mode is a plausible-LOOKING card rather than a broken one:
//
//   1. TWO MEASURES, TWO SCALES, NEVER A BLENDED SCORE. The blend is what CLAUDE.md rejects in
//      five places ("a number no PR resembles"). The merge into one row list is a LAYOUT change:
//      `RepoRows` still scales each column against its OWN maximum, and a bar length is a ratio
//      inside one column. A single shared maximum is the regression to catch.
//
//   2. THE REPOSITORY NAME IS WRITTEN OUT IN FULL. The rotated 8px axis label it replaced was
//      truncated to 13 characters and then CLIPPED by the svg viewport, eating the "…" that said
//      so — six of seven real repositories. A `title=` tooltip is not the fix (unavailable on
//      touch and to a keyboard), so neither the truncation nor a tooltip may come back.
//
//   3. UNKNOWN IS NOT ZERO, ON BOTH CARDS. An ALL-unsized repository prints "size unknown" in its
//      own row and a PARTIALLY-sized one prints how much of it the bar covers; an open pull request
//      with no reach reading is not drawn at all and is counted in words. A missing bar is not a
//      disclosure, and neither is a full-looking bar over 43 of 45 pull requests.
//
//   4. NO CLICK HANDLER. A decorative table adds no unlabelled keyboard stops.
//
//   5. ONE ROW NEVER MIXES THE HEADLINE AND SUBSET POPULATIONS. Every total the reach card prints
//      is folded over the SHOWN repositories; what the cap cut travels separately, is named on the
//      DRAWN measure as well as the ranking one, and is never subtracted against them.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

const ACTIVITY = read('components/Activity/WorkspaceRepoActivityCharts.tsx');
const REACH = read('components/Activity/WorkspaceReachCard.tsx');
const ROWS = read('components/charts/RepoRows.tsx');
const FOLD = read('hooks/useBlastRadius.ts');

describe('the row list, by source guard', () => {
  it('scales each column against its OWN maximum, and nothing against a shared one', () => {
    // The one line that keeps the two measures apart: a per-column reduce, not a max over
    // everything. A shared maximum would draw a PR count (≈5) beside a line count (≈5000)
    // sub-pixel — the mechanical half of the "two charts, never one" argument.
    expect(ROWS).toMatch(/const columnMax = columns\.map\(/);
    // Ratios stay inside a column: the only division is by that column's own max.
    expect(ROWS).toMatch(/\(v \/ max\) \* 100/);
    // No composite index anywhere in either card.
    expect(ACTIVITY).not.toMatch(/\bindex\b\s*[:=][^=]/);
    expect(REACH).not.toMatch(/\bindex\b\s*[:=][^=]/);
  });

  it('names every colour on the card in a key', () => {
    // A two-colour stack with no key is an unlabelled claim, and the automation orange is only
    // allowed at all because a key relieves its sub-3:1 surface contrast. `BarChart` used to draw
    // this legend for free; the row list has to draw it deliberately.
    expect(ROWS).toMatch(/<Legend series=\{legendSeries\}/);
    expect(ACTIVITY).toMatch(/key: 'human'/);
    expect(ACTIVITY).toMatch(/key: 'automation'/);
    expect(ACTIVITY).toMatch(/label: 'People'/);
    expect(ACTIVITY).toMatch(/label: 'Automation'/);
  });

  it('writes the repository name out in full, with no truncation and no tooltip', () => {
    // The full `owner/name` straight off the wire row — no shortener, no character budget.
    expect(ACTIVITY).toMatch(/labels = rows\.map\(\(r\) => r\.repoFullName\)/);
    // The DECLARATIONS, not the words: the header above the component names both while
    // explaining why they went, and a guard that fired on that explanation would be deleted.
    expect(ACTIVITY).not.toMatch(/^\s*const MAX_LABEL_CHARS/m);
    expect(ACTIVITY).not.toMatch(/^export function axisLabels/m);
    // ⚠ A tooltip is NOT the alternative to truncation: unavailable on touch, unavailable to a
    // keyboard. If either card ever needs one, the name is already wrong.
    expect(ROWS).not.toMatch(/title=["'{]/);
    expect(ROWS).not.toMatch(/\btruncate\b/);
    expect(ROWS).toMatch(/break-words/);
  });

  it('adds no click handler and therefore no keyboard stops', () => {
    // The PROPS, not the words — the components' headers name them while explaining why they are
    // absent, and a guard that fired on the explanation would be deleted rather than believed.
    for (const src of [ACTIVITY, REACH, ROWS]) {
      expect(src).not.toMatch(/onSelectBar\s*=/);
      expect(src).not.toMatch(/barAriaLabel\s*=/);
      expect(src).not.toMatch(/onClick\s*=/);
    }
  });

  it('states each card its own window, and says the comparison is absent', () => {
    // Four framings live on this one panel — the tiles' rolling 14-vs-prior-14, the 12-week trend
    // band, the activity card's 14 days with no comparison, and the reach card's snapshot. "14
    // days" alone still lets a reader assume the comparison the tiles have.
    expect(ACTIVITY).toMatch(/no prior-period comparison/);
    expect(REACH).toMatch(/a snapshot, not a window/);
  });

  it('discloses the cap, the unsized PRs and the partial-window repos', () => {
    // Each of the three would otherwise be a list quietly asserting something false: a silent
    // truncation, an unsized PR drawn as a zero, and a mid-window repo drawn as "quiet".
    expect(ACTIVITY).toMatch(/are not shown/);
    expect(ACTIVITY).toMatch(/no\s*\n?\s*recorded size/);
    expect(ACTIVITY).toMatch(/added to this workspace during the window/);
    // ⚠ NEVER PRO-RATED — that would fabricate pull requests nobody opened.
    expect(ACTIVITY).not.toMatch(/windowDays\s*\/|\/\s*elapsed/);
    // ⚠ UNKNOWN SIZE IS NOT ZERO SIZE, and now it is marked in the repository's OWN row as well as
    // counted in words below.
    expect(ACTIVITY).toMatch(/unknownLabel: 'size unknown'/);
    expect(ACTIVITY).toMatch(/r\.linesChanged == null \? null :/);
  });

  it('marks a PARTIALLY-sized repository in its own row, not only an all-unsized one', () => {
    // ⚠ `linesChanged` is null only when `sizedPrs === 0`, so `unknownLabel` fires for an ALL-
    // unsized repository and nothing else. MEASURED on workspace 1: one repository opened 45 pull
    // requests of which 2 were never sized, beside six neighbours with none — its bar and its
    // printed figure cover 43 of its 45 and are drawn identically to rows that cover all of theirs.
    // The aggregate sentence counts those 2 pull requests and never says which repository holds
    // them, so the ROW has to.
    expect(ACTIVITY).toMatch(/noteFor=\{\(i\) =>/);
    expect(ACTIVITY).toMatch(/r\.unsizedPrs === 0 \|\| r\.linesChanged == null/);
    expect(ACTIVITY).toMatch(/lines cover \$\{fmtNum\(r\.sizedPrs\)\} of/);
  });
});

describe('the reach card, by source guard', () => {
  it('goes through the ONE resolver and never re-implements a threshold', () => {
    // The same function the chip calls, on the same rows, with the same config — so a bar and a
    // chip can never disagree about a pull request, and the Settings dial repaints both live.
    expect(FOLD).toMatch(/blastRadius\(pr, config\)/);
    expect(FOLD).not.toMatch(/BLAST_THRESHOLDS|highCodeLoc|lowCodeFiles/);
    expect(REACH).not.toMatch(/blastRadius\([a-zA-Z]/);
  });

  it('reads the WORKSPACE open-PR list, never the Timeline board one', () => {
    // ⚠ `useSearchOpenPrs` carries `filters.repoIds`, whose picker is not mounted on Reports — a
    // card scoped by it would be silently short with no visible control to widen it.
    expect(FOLD).toMatch(/useWorkspaceOpenPrs\(\)/);
    expect(FOLD).not.toMatch(/useSearchOpenPrs\(|useSearchTimeline\(|[^e]useOpenPrs\(/);
  });

  it('never draws an unknown reading, and counts it in words instead', () => {
    // ⚠ A fourth stacked band would make "we don't know" look like a level and would inflate the
    // bar so it no longer means "pull requests with a reading". Three segments, and the rest is
    // prose — including the per-row mark, because the bars do NOT total the open-PR count the list
    // is ranked by.
    expect(REACH.match(/key: '(?:low|medium|high)'/g)).toHaveLength(3);
    expect(REACH).not.toMatch(/key: 'unknown'|label: 'Unknown'/);
    expect(REACH).toMatch(/no reading and/);
    expect(REACH).toMatch(/with no reading/);
  });

  it('is free on every tier', () => {
    // No ProGate, no capability read, no 402: blast radius is CORE and so is its home. The Reports
    // rail entry is ungated precisely because these free metrics live there.
    for (const src of [REACH, FOLD, ACTIVITY]) {
      expect(src).not.toMatch(/^import .*ProGate/m);
      expect(src).not.toMatch(/<ProGate|<ProLockPanel|useProCapabilities\(|useProGateState\(/);
    }
  });

  it('caps the list and says what it cut, on the ranking measure AND the drawn one', () => {
    expect(FOLD).toMatch(/const REACH_MAX_REPOS = 12/);
    expect(REACH).toMatch(/not shown\./);
    // ⚠ The list is ranked by TOTAL open pull requests while the bars draw the Low/Medium/High
    // split, so the repository holding the most HIGH-reach pull requests can sit below the fold.
    // A sentence naming only the PR count gives a reader no way to know that happened — the same
    // argument `omitted.linesChanged` on the card beside it is built on.
    expect(FOLD).toMatch(/high: total\(cut,/);
    expect(REACH).toMatch(/of them high reach/);
  });

  it('folds every printed total over the SHOWN repositories, and carries the cut apart', () => {
    // ⚠ ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS. `repos` is sliced to 12; a
    // total taken over `all` would print an unread count and a draft count covering repositories
    // whose bars are not on screen, beside bars that are. Latent on the dev DB (4 repositories with
    // anything open in the busiest workspace) and live on the 19-repository estate the fold's own
    // comments cite.
    expect(FOLD).toMatch(/const shown = all\.slice\(0, REACH_MAX_REPOS\)/);
    for (const key of ['openPrs', 'read', 'unread', 'drafts']) {
      expect(FOLD).toMatch(new RegExp(`${key}: total\\(shown,`));
    }
    expect(FOLD).not.toMatch(/openPrs: all\.reduce|unread: all\.reduce/);
    // The drafts count used to be a fold over the RAW list, which no slice could ever narrow.
    expect(FOLD).not.toMatch(/prs\.reduce/);
    // The two counts that are deliberately NOT the drawn subset, and say so on screen: how many
    // repositories hold anything open at all, and how many the workspace holds.
    expect(FOLD).toMatch(/repoCount: all\.length/);
    expect(FOLD).toMatch(/workspaceRepos: repos\.reduce/);
  });

  it('accounts for the repositories that hold nothing open', () => {
    // MEASURED on workspace 1: 8 member repositories, 7 with a PR opened in the fortnight, 4 with
    // anything open right now — so this card reads "4 repositories" beside a neighbour reading
    // "7 repositories", and without this sentence nothing accounts for the difference. The
    // neighbour states its own version of exactly this.
    expect(REACH).toMatch(/nothing open right now/);
    expect(REACH).toMatch(/reach\.workspaceRepos > reach\.repoCount/);
  });

  it('gives every prose fraction its own denominator, in full', () => {
    // ⚠ THE DRAFTS SENTENCE CARRIES ITS OWN POPULATION. "N of them are drafts" printed the total
    // nowhere at all whenever the unread sentence was absent — which it is on a fully-read corpus —
    // and when that sentence WAS present, "them" read as the unread subset, which drafts is not
    // counted over.
    expect(REACH).toMatch(/\{count\(reach\.drafts\)\} of the \{count\(reach\.openPrs\)\}/);
    expect(REACH).not.toMatch(/of them\{' '\}\s*\n?\s*\{plural\(reach\.drafts/);
    // ⚠ AND IN FULL. `fmtNum` collapses anything over 999 to one decimal of thousands, so "156 of
    // the 1.6k open pull requests" is not a subtraction a reader can perform. It stays inside the
    // table, where a cell shares its formatter with the column maximum printed under it.
    expect(REACH).not.toMatch(/fmtNum\(reach\./);
    expect(REACH).toMatch(/function count\(n: number\): string \{\s*\n\s*return n\.toLocaleString\(\)/);
  });

  it('names the neighbouring card rather than pointing at it', () => {
    // The grid is two columns only at `lg` and above; below it the cards STACK, and "the card
    // beside it" is then the card ABOVE. A name survives the reflow.
    expect(REACH).toMatch(/Activity by repository covers the last \{neighbourWindowDays\} days/);
    expect(REACH).not.toMatch(/beside it covers/);
  });
});
