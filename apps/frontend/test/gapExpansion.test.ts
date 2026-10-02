// The Changes tab's hunk expander — GitHub's design, as pure functions (lib/diff.ts).
//
// A gap between two hunks offers TWO arrows (down = the lines just after the code above, up = the
// lines just before the code below), 20 lines a click, and collapses to ONE expand-all control
// once a click would empty it. Before the first hunk there is only code below (one up arrow);
// after the last only code above (one down arrow), offered before the file is loaded only when the
// patch does not provably reach the end of the file. Expansion is render-side: `parsePatch`'s rows
// never change, so these functions only ever compute a reveal over them.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  GAP_EXPAND_STEP,
  NO_REVEAL,
  clampReveal,
  expandGapReveal,
  gapControlLabel,
  gapControls,
  gapPlace,
  gapRemaining,
  gapSlice,
  gapSummary,
  parsePatch,
  patchReachesEnd,
  type GapReveal,
} from '../src/lib/diff.js';

const TWO_HUNKS = [
  '@@ -18,3 +18,3 @@ import {',
  ' a',
  '-b',
  '+B',
  '@@ -60,3 +60,3 @@ function foo() {',
  ' c',
  '-d',
  '+D',
  ' e',
  ' f',
  ' g',
].join('\n');

describe('gapPlace', () => {
  it('names the first hunk `first` and every later one `between`', () => {
    const rows = parsePatch(TWO_HUNKS);
    expect(gapPlace(rows, 0)).toBe('first');
    expect(gapPlace(rows, 4)).toBe('between');
  });
});

describe('gapControls — which arrows a gap offers', () => {
  it('between two hunks: down then up while more than one step is hidden', () => {
    expect(gapControls('between', 45)).toEqual(['down', 'up']);
    expect(gapControls('between', GAP_EXPAND_STEP + 1)).toEqual(['down', 'up']);
  });
  it('between two hunks: one expand-all once a click would empty it', () => {
    expect(gapControls('between', GAP_EXPAND_STEP)).toEqual(['all']);
    expect(gapControls('between', 1)).toEqual(['all']);
  });
  it('top of file: a single up arrow, whatever the size', () => {
    expect(gapControls('first', 300)).toEqual(['up']);
    expect(gapControls('first', 5)).toEqual(['up']);
  });
  it('end of file: a single down arrow, including while the size is unknown', () => {
    expect(gapControls('trailing', 300)).toEqual(['down']);
    expect(gapControls('trailing', null)).toEqual(['down']);
  });
  it('nothing once the gap is fully revealed', () => {
    for (const p of ['first', 'between', 'trailing'] as const) expect(gapControls(p, 0)).toEqual([]);
  });
});

describe('expandGapReveal — one click', () => {
  it('down grows the top, up grows the bottom, by one step each', () => {
    let r: GapReveal = NO_REVEAL;
    r = expandGapReveal(r, 'down', 45);
    expect(r).toEqual({ top: 20, bottom: 0 });
    r = expandGapReveal(r, 'up', 45);
    expect(r).toEqual({ top: 20, bottom: 20 });
    expect(gapRemaining(45, r)).toBe(5);
    expect(gapControls('between', gapRemaining(45, r))).toEqual(['all']);
    r = expandGapReveal(r, 'all', 45);
    expect(gapRemaining(45, r)).toBe(0);
    expect(r.top + r.bottom).toBe(45);
  });
  it('never reveals past the gap', () => {
    const r = expandGapReveal(NO_REVEAL, 'up', 7);
    expect(r).toEqual({ top: 0, bottom: 7 });
    expect(gapRemaining(7, r)).toBe(0);
  });
  it('an unknown size (trailing, file not loaded) asks for one step, clamped once it is known', () => {
    const r = expandGapReveal(NO_REVEAL, 'down', null);
    expect(r).toEqual({ top: 20, bottom: 0 });
    expect(clampReveal(null, r)).toEqual(NO_REVEAL);
    expect(clampReveal(12, r)).toEqual({ top: 12, bottom: 0 });
    expect(gapRemaining(12, r)).toBe(0);
    expect(gapRemaining(130, r)).toBe(110);
  });
  it('clamps an over-sized reveal so top and bottom never overlap', () => {
    expect(clampReveal(30, { top: 20, bottom: 20 })).toEqual({ top: 20, bottom: 10 });
  });
});

describe('gapSlice — the lines one side of a reveal draws', () => {
  const gap = { count: 45, oldFrom: 53, newFrom: 55, context: 'function foo() {' };
  it('the top slice starts at the gap, the bottom slice ends at it', () => {
    expect(gapSlice(gap, 0, 20)).toMatchObject({ count: 20, oldFrom: 53, newFrom: 55 });
    expect(gapSlice(gap, 45 - 20, 20)).toMatchObject({ count: 20, oldFrom: 78, newFrom: 80 });
  });
});

describe('labels — accessible names and the muted summary', () => {
  it('names each control by what it reveals', () => {
    expect(gapControlLabel('down', 45)).toBe('Expand 20 lines down');
    expect(gapControlLabel('up', 45)).toBe('Expand 20 lines up');
    expect(gapControlLabel('up', 7)).toBe('Expand 7 lines up');
    expect(gapControlLabel('all', 19)).toBe('Expand all 19 lines');
    expect(gapControlLabel('down', null)).toBe('Expand 20 lines down');
    expect(gapControlLabel('all', 1)).toBe('Expand all 1 line');
  });
  it('summary: count first, then the function context; no "Show" prose', () => {
    expect(gapSummary(20, 'function isReady(feature, condition) {')).toBe(
      '20 hidden lines · function isReady(feature, condition) {',
    );
    expect(gapSummary(1, '')).toBe('1 hidden line');
    expect(gapSummary(null, '')).toBe('');
    expect(gapSummary(null, 'import {')).toBe('import {');
    expect(gapSummary(1200, '')).toBe(`${(1200).toLocaleString()} hidden lines`);
  });
});

describe('patchReachesEnd — is a trailing gap worth offering before the load?', () => {
  it('a last change followed by three context lines may have more file after it', () => {
    expect(patchReachesEnd(parsePatch(TWO_HUNKS))).toBe(false);
  });
  it('fewer than three trailing context lines means git ran out of file', () => {
    expect(patchReachesEnd(parsePatch('@@ -10,3 +10,3 @@\n a\n-b\n+B\n c'))).toBe(true);
    expect(patchReachesEnd(parsePatch('@@ -10,2 +10,2 @@\n a\n-b\n+B'))).toBe(true);
  });
  it('the no-newline marker is the end of the file', () => {
    expect(
      patchReachesEnd(parsePatch('@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n e\n\\ No newline at end of file')),
    ).toBe(true);
  });
  it('an added file reaches its own end', () => {
    expect(patchReachesEnd(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b'))).toBe(true);
  });
});
