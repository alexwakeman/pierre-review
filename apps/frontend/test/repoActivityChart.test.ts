// "Where the work is happening" — the per-repo pair under Flow metrics on Reports → Overview.
//
// Three things here are load-bearing and invisible in the JSX, so they are pinned rather than
// commented:
//
//   1. THE AXIS LABEL. BarChart uses ONE string for both the axis tick and the hover tooltip, so a
//      repository whose trailing segment is not unique in this chart would appear twice under one
//      name with no way to tell which bar is which. Two owners routinely ship a `frontend`.
//
//   2. TWO CHARTS, NEVER A BLENDED SCORE, AND NEVER ONE GROUPED CHART. The blend is what CLAUDE.md
//      rejects in five places ("a number no PR resembles"); the grouped variant is broken by
//      BarChart's shared `niceMax` y-axis, which draws a PR count (≈5) beside a line count (≈5000)
//      sub-pixel. A source guard, because the failure of either is a plausible-looking chart.
//
//   3. NO CLICK HANDLER. `onSelectBar` is opt-in precisely so a decorative chart adds no unlabelled
//      keyboard stops, and `seriesKey` is meaningless on a two-series band.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { axisLabels } from '../src/components/Activity/WorkspaceRepoActivityCharts.js';

const SRC = readFileSync(
  new URL('../src/components/Activity/WorkspaceRepoActivityCharts.tsx', import.meta.url),
  'utf8',
);

describe('axisLabels', () => {
  it('uses the trailing segment when it is unique in this chart', () => {
    expect(
      axisLabels([
        { repoFullName: 'DEFRA/nrf-frontend' },
        { repoFullName: 'mrdoob/three.js' },
      ]),
    ).toEqual(['nrf-frontend', 'three.js']);
  });

  it('qualifies a short name that collides, and only that one', () => {
    // Two owners, one repo name. Falling back to the short name for both would print "frontend"
    // twice on the axis AND in both tooltips. The owner survives the length budget here; where it
    // does not, the "In order:" key line under the pair carries the full names.
    expect(
      axisLabels([
        { repoFullName: 'ab/frontend' },
        { repoFullName: 'cd/frontend' },
        { repoFullName: 'cd/backend' },
      ]),
    ).toEqual(['ab/frontend', 'cd/frontend', 'backend']);
  });

  it('shortens from the HEAD, keeping the tail that distinguishes a repo family', () => {
    // `bng-metric-backend` / `bng-metric-frontend` differ only at the end, so a head-preserving
    // truncation collapses exactly the repositories a reader is trying to tell apart. Every result
    // must also fit BarChart's fixed 40px rotated-label band, which clips silently.
    const out = axisLabels([
      { repoFullName: 'DEFRA/bng-metric-backend' },
      { repoFullName: 'DEFRA/bng-metric-frontend' },
      { repoFullName: 'DEFRA/bng-library' },
    ]);
    expect(out).toEqual(['…tric-backend', '…ric-frontend', 'bng-library']);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(13);
  });

  it('degrades to the whole string when there is no owner segment', () => {
    expect(axisLabels([{ repoFullName: 'solo' }])).toEqual(['solo']);
  });
});

describe('the chart pair, by source guard', () => {
  it('draws TWO separate charts and no blended score', () => {
    // Exactly two <BarChart uses: PRs opened and lines changed.
    expect(SRC.match(/<BarChart/g)).toHaveLength(2);
    // A composite index would need arithmetic across the two measures. There is none.
    expect(SRC).not.toMatch(/\bindex\b\s*[:=][^=]/);
  });

  it('splits PRs opened into people vs automation as a STACKED pair', () => {
    // Stacked, not grouped: the bar TOTAL is the metric both charts are ordered by, and the split
    // lives inside it. A repository topping the chart on dependency bumps is the failure this
    // series exists to make visible rather than to hide.
    expect(SRC).toMatch(/mode="stacked"/);
    expect(SRC).toMatch(/key: 'human'/);
    expect(SRC).toMatch(/key: 'automation'/);
  });

  it('adds no click handler and therefore no keyboard stops', () => {
    // The PROP, not the word — the component's own header names `onSelectBar` while explaining
    // why it is absent, and a guard that fired on the explanation would be deleted by the next
    // reader rather than believed.
    expect(SRC).not.toMatch(/onSelectBar\s*=/);
    expect(SRC).not.toMatch(/barAriaLabel\s*=/);
  });

  it('states the window on the pair, and says the comparison is absent', () => {
    // Three windows live on this one panel — the tiles' rolling 14-vs-prior-14, the 12-week trend
    // band, and this. "14 days" alone still lets a reader assume the comparison the tiles have.
    expect(SRC).toMatch(/no prior-period comparison/);
  });

  it('discloses the cap, the unsized PRs and the partial-window repos', () => {
    // Each of the three would otherwise be a chart quietly asserting something false: a silent
    // truncation, an unsized PR drawn as a zero (BarChart drops every `v <= 0`, so unknown and
    // zero are the same absent bar), and a mid-window repo drawn as "quiet".
    expect(SRC).toMatch(/are not shown/);
    expect(SRC).toMatch(/no recorded\s*\n?\s*size/);
    expect(SRC).toMatch(/added to this workspace during the window/);
    // ⚠ NEVER PRO-RATED — that would fabricate pull requests nobody opened.
    expect(SRC).not.toMatch(/windowDays\s*\/|\/\s*elapsed/);
  });
});
