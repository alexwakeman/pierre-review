// THE DESIGN GRID'S PURE FOLD: which rows and columns render, where each card sits, which arrows can
// be drawn (and how they read aloud), the PR ref → member lookup, and the arrow geometry.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/designGrid.test.ts
import { describe, expect, it } from 'vitest';
import type { DesignDiagram, SequenceDiagramMember } from '@pierre-review/shared';
import { ARROW_TRACK_PX, CHANGE_KEY_LABEL, CHANGE_WORD, changesPresent, crossings, layoutDesign, memberForRef, placeArrowLabels, prBadgeTexts, routeArrow, separateArrowRuns } from '../src/lib/designGrid.js';

const design = (over: Partial<DesignDiagram> = {}): DesignDiagram => ({
  acts: [
    { id: 'imp', title: 'Import' },
    { id: 'chk', title: 'Check' },
    { id: 'save', title: 'Save' },
  ],
  // Deliberately out of canonical order, with an unused layer.
  layers: ['data', 'ui', 'domain'],
  cells: [
    { id: 'c1', act: 'imp', layer: 'domain', label: 'Parse rows', pattern: 'Pipeline', change: 'new', pr: null, files: ['a.ts'] },
    { id: 'c2', act: 'chk', layer: 'domain', label: 'Reject bad rows', pattern: 'Guard clause', change: 'changed', pr: null, files: [] },
    { id: 'c3', act: 'save', layer: 'data', label: 'Store each rate once', pattern: null, change: 'unchanged', pr: null, files: [] },
  ],
  arrows: [
    { from: 'c1', to: 'c2', label: 'rows' },
    { from: 'c2', to: 'c3', label: null },
  ],
  ...over,
});

describe('changesPresent (the border key under the grid)', () => {
  it('lists only the change kinds the grid draws, in New, Changed, Unchanged order', () => {
    expect(changesPresent(layoutDesign(design()))).toEqual(['new', 'changed', 'unchanged']);
    const onlyChanged = design({
      cells: [{ id: 'c2', act: 'chk', layer: 'domain', label: 'Reject bad rows', pattern: null, change: 'changed', pr: null, files: [] }],
      arrows: [],
    });
    expect(changesPresent(layoutDesign(onlyChanged))).toEqual(['changed']);
    expect(changesPresent({ cells: [] })).toEqual([]);
  });

  it('names every kind in words', () => {
    expect(Object.values(CHANGE_KEY_LABEL).every((l) => l.trim() !== '')).toBe(true);
  });
});

describe('layoutDesign', () => {
  it('renders every act as a column and ONLY the used layers as rows, in canonical order', () => {
    const l = layoutDesign(design());
    expect(l.acts.map((a) => a.id)).toEqual(['imp', 'chk', 'save']);
    expect(l.rows).toEqual([
      { layer: 'domain', label: 'Domain / service' },
      { layer: 'data', label: 'Data / store' },
    ]);
    expect(l.cells.map((g) => [g.cell.id, g.row, g.col])).toEqual([
      ['c1', 0, 0],
      ['c2', 0, 1],
      ['c3', 1, 2],
    ]);
  });

  it('drops a second card in a taken slot and a card naming a missing act', () => {
    const d = design();
    d.cells.push({ ...d.cells[0]!, id: 'twin' });
    d.cells.push({ ...d.cells[0]!, id: 'lost', act: 'nope', layer: 'tests' });
    const l = layoutDesign(d);
    expect(l.cells.map((g) => g.cell.id)).toEqual(['c1', 'c2', 'c3']);
    // The lost card's layer gets no row.
    expect(l.rows.map((r) => r.layer)).toEqual(['domain', 'data']);
  });

  it('keeps only arrows between drawn cards, never a self-loop, and words each one', () => {
    const d = design({
      arrows: [
        { from: 'c1', to: 'c2', label: 'rows' },
        { from: 'c1', to: 'gone', label: null },
        { from: 'c3', to: 'c3', label: null },
      ],
    });
    const l = layoutDesign(d);
    expect(l.arrows).toHaveLength(1);
    expect(l.arrows[0]!.text).toBe('Parse rows (Import, Domain / service) to Reject bad rows (Check, Domain / service): rows');
  });

  it('marks change in words, unchanged carries none', () => {
    expect(CHANGE_WORD).toEqual({ new: 'New', changed: 'Changed', unchanged: null });
  });
});

describe('memberForRef', () => {
  const members: SequenceDiagramMember[] = [
    { prId: 10, repo: 'acme/api', number: 1, title: 'a', state: 'open', headSha: 'x' },
    { prId: 20, repo: 'acme/web', number: 2, title: 'b', state: 'merged', headSha: 'y' },
  ];
  it('maps PRn to members[n-1], case-insensitively; anything else is null', () => {
    expect(memberForRef('PR2', members)?.prId).toBe(20);
    expect(memberForRef('pr1', members)?.prId).toBe(10);
    expect(memberForRef('PR3', members)).toBeNull();
    expect(memberForRef(null, members)).toBeNull();
    expect(memberForRef('X1', members)).toBeNull();
  });
});

describe('routeArrow', () => {
  // Two columns of 100px cards in 120px slots, a 40px column gap and a 20px row gap.
  const at = (row: number, col: number) => {
    const sx = col * 160;
    const sy = row * 80;
    return { slot: { x: sx, y: sy, w: 120, h: 60 }, card: { x: sx + 10, y: sy + 10, w: 100, h: 40 }, row, col };
  };
  const none = () => false;
  it('neighbours in a row: one straight run between the cards', () => {
    const g = routeArrow(at(0, 0), at(0, 1), none, 40, 20);
    expect(g.d).toBe('M 110 30 L 167 30');
    expect([g.lx, g.ly]).toEqual([138.5, 30]);
  });
  it('another row and column: along the row, down the gap beside the target, into its side', () => {
    const g = routeArrow(at(0, 0), at(2, 1), none, 40, 20);
    expect(g.d).toBe('M 110 30 L 140 30 L 140 190 L 167 190');
  });
  it('a card in the way in the row: drops to the row gap first', () => {
    const g = routeArrow(at(0, 0), at(1, 2), (r, c) => r === 0 && c === 1, 40, 20);
    expect(g.d).toBe('M 85 50 L 85 70 L 300 70 L 300 110 L 327 110');
  });
  it('stacked and clear: straight down', () => {
    expect(routeArrow(at(0, 0), at(1, 0), none, 40, 20).d).toBe('M 60 50 L 60 87');
  });
  it('stacked with a card between: round the column gap on the right', () => {
    const g = routeArrow(at(0, 0), at(2, 0), (r, c) => r === 1 && c === 0, 40, 20);
    expect(g.d).toBe('M 110 30 L 140 30 L 140 190 L 113 190');
  });
});

describe('prBadgeTexts', () => {
  const m = (prId: number, repo: string, number: number) =>
    ({ prId, repo, number, title: '', state: 'open', headSha: 'x' }) as SequenceDiagramMember;
  it('drops the shared word prefix between repos', () => {
    const b = prBadgeTexts([m(1, 'DEFRA/bng-metric-backend', 498), m(2, 'DEFRA/bng-metric-harness', 170)]);
    expect([b.get(1), b.get(2)]).toEqual(['backend #498', 'harness #170']);
  });
  it('is just the number in one repo', () => {
    const b = prBadgeTexts([m(1, 'o/api', 3), m(2, 'o/api', 4)]);
    expect([b.get(1), b.get(2)]).toEqual(['#3', '#4']);
  });
  it('never cuts mid-word, and keeps a name the prefix would empty', () => {
    const b = prBadgeTexts([m(1, 'o/app', 1), m(2, 'o/apple', 2), m(3, 'o/app-web', 3)]);
    expect([b.get(1), b.get(2), b.get(3)]).toEqual(['app #1', 'apple #2', 'app-web #3']);
  });
});


describe('separateArrowRuns — no two lines share a run', () => {
  // Two arrows from the right column into two left-column cards, both down the SAME gap at x = 100.
  const a: Array<[number, number]> = [[300, 50], [100, 50], [100, 200], [80, 200]];
  const b: Array<[number, number]> = [[300, 120], [100, 120], [100, 300], [80, 300]];

  it('gives each arrow in a shared up/down run its own track, keeping every line right-angled', () => {
    const [sa, sb] = separateArrowRuns([a, b], 40, 20);
    const xa = sa![1]![0];
    const xb = sb![1]![0];
    expect(xa).not.toBe(xb);
    expect(Math.abs(xa - xb)).toBeCloseTo(Math.min(ARROW_TRACK_PX, 40 / 3), 5);
    // The run's two corners moved together, so it is still vertical…
    expect(sa![1]![0]).toBe(sa![2]![0]);
    expect(sb![1]![0]).toBe(sb![2]![0]);
    // …and the ends on the cards did not move.
    expect(sa![0]).toEqual([300, 50]);
    expect(sb![3]).toEqual([80, 300]);
  });

  it('separates two arrows entering on the same sideways line', () => {
    const c: Array<[number, number]> = [[300, 200], [80, 200]];
    const [sa, sc] = separateArrowRuns([a, c], 40, 20);
    expect(sa![3]![1]).not.toBe(sc![1]![1]);
  });

  it('leaves runs alone that only share a line without overlapping, and never moves a lone arrow', () => {
    const far: Array<[number, number]> = [[300, 400], [100, 400], [100, 500], [80, 500]];
    expect(separateArrowRuns([a, far], 40, 20)).toEqual([a, far]);
    expect(separateArrowRuns([a], 40, 20)).toEqual([a]);
  });

  it('narrows the tracks to fit a narrow channel', () => {
    const c: Array<[number, number]> = [[300, 80], [100, 80], [100, 250], [80, 250]];
    const xs = separateArrowRuns([a, b, c], 12, 20).map((r) => r[1]![0]);
    expect(new Set(xs).size).toBe(3);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(12);
  });
});

describe('separateArrowRuns — the track order avoids crossings', () => {
  it('lines turning out of a shared run in opposite order do not cross after separation', () => {
    // Both come up the gap at x = 100 from below and turn left into one card's side; the one that
    // starts lower must take the INNER track or it crosses the other's turn.
    const short: Array<[number, number]> = [[300, 200], [100, 200], [100, 50], [80, 50]];
    const long: Array<[number, number]> = [[300, 400], [100, 400], [100, 50], [80, 50]];
    expect(crossings(separateArrowRuns([short, long], 40, 40))).toBe(0);
    expect(crossings(separateArrowRuns([long, short], 40, 40))).toBe(0);
  });
});

describe('placeArrowLabels', () => {
  it('keeps a marker off another line', () => {
    const v: Array<[number, number]> = [[100, 0], [100, 200]];
    const h: Array<[number, number]> = [[0, 100], [200, 100]];
    const [lv, lh] = placeArrowLabels([v, h]);
    expect(Math.abs(lv![1] - 100)).toBeGreaterThanOrEqual(13); // not on the crossing
    expect(Math.hypot(lv![0] - lh![0], lv![1] - lh![1])).toBeGreaterThanOrEqual(26);
  });
});
