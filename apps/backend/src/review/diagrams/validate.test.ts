// THE DESIGN VALIDATOR: every cap refuses with what to do about it, ids and slots are checked, text
// is plain, and `files` is FILTERED (never refused) to the change.
import { describe, expect, it } from 'vitest';
import {
  DESIGN_ACT_TITLE_MAX,
  DESIGN_ARROW_LABEL_MAX,
  DESIGN_CAPTION_MAX,
  DESIGN_CELL_FILES_MAX,
  DESIGN_CELL_LABEL_MAX,
  DESIGN_MAX_ACTS,
  DESIGN_MAX_ARROWS,
  DESIGN_MAX_CELLS,
  DESIGN_MAX_LAYERS,
  DESIGN_PATTERN_MAX,
  DESIGN_TITLE_MAX,
} from '@pierre-review/shared';
import { validateDesign, type DesignContext } from './validate.js';

const PR: DesignContext = { kind: 'pr', prs: [{ ref: 'PR1', changedFiles: ['src/import.ts', 'src/rates.ts', 'test/rates.test.ts'] }] };
const STORY: DesignContext = {
  kind: 'story',
  prs: [
    { ref: 'PR1', changedFiles: ['api/routes/rates.ts', 'api/db/rates.ts'] },
    { ref: 'PR2', changedFiles: ['web/src/RatesPage.tsx'] },
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = (): any => ({
  title: 'Rate import',
  caption: 'Rows are checked, then each rate is stored once.',
  acts: [
    { id: 'imp', title: 'Import' },
    { id: 'chk', title: 'Check' },
  ],
  layers: ['domain', 'data'],
  cells: [
    { id: 'c1', act: 'imp', layer: 'domain', label: 'Parse rows', pattern: 'Pipeline', change: 'new', files: ['src/import.ts'] },
    { id: 'c2', act: 'chk', layer: 'domain', label: 'Reject rows with no account', pattern: 'Guard clause', change: 'changed', files: [] },
    { id: 'c3', act: 'chk', layer: 'data', label: 'Store each rate once', pattern: null, change: 'unchanged', files: [] },
  ],
  arrows: [{ from: 'c1', to: 'c2', label: 'rows' }],
});
const refused = (raw: unknown, ctx: DesignContext = PR): string => {
  const v = validateDesign(raw, ctx);
  expect(v.ok).toBe(false);
  return v.ok ? '' : v.message;
};

describe('validateDesign — accepts and cleans', () => {
  it('accepts a small design and keeps its shape', () => {
    const v = validateDesign(base(), PR);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.title).toBe('Rate import');
    expect(v.value.design.cells).toHaveLength(3);
    expect(v.value.design.cells[0]).toMatchObject({ pr: null, files: ['src/import.ts'], change: 'new' });
    expect(v.value.design.arrows).toEqual([{ from: 'c1', to: 'c2', label: 'rows' }]);
  });

  it('puts layers in canonical order, strips control characters and nulls empty strings', () => {
    const d = base();
    d.layers = ['data', 'domain'];
    d.cells[0].label = 'Parse\u0007 rows\n';
    d.cells[1].pattern = '  ';
    d.arrows[0].label = '';
    const v = validateDesign(d, PR);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.design.layers).toEqual(['domain', 'data']);
    expect(v.value.design.cells[0]!.label).toBe('Parse rows');
    expect(v.value.design.cells[1]!.pattern).toBeNull();
    expect(v.value.design.arrows[0]!.label).toBeNull();
  });

  it('is idempotent: the cleaned answer validates to itself (the second, storage-time pass)', () => {
    const v = validateDesign(base(), PR);
    if (!v.ok) throw new Error('expected ok');
    const again = validateDesign({ ...v.value.design, title: v.value.title, caption: v.value.caption }, PR);
    expect(again.ok && again.value).toEqual(v.value);
  });
});

describe('validateDesign — every cap refuses with its fix', () => {
  it('acts', () => {
    const d = base();
    d.acts = Array.from({ length: DESIGN_MAX_ACTS + 1 }, (_, i) => ({ id: `a${i}`, title: `Act ${i}` }));
    d.cells = d.acts.map((a: any, i: number) => ({ id: `x${i}`, act: a.id, layer: 'domain', label: 'L', pattern: 'P', change: 'new' }));
    d.layers = ['domain'];
    d.arrows = [];
    expect(refused(d)).toContain(`${DESIGN_MAX_ACTS + 1} acts; merge stages so there are at most ${DESIGN_MAX_ACTS}`);
    expect(refused({ ...base(), acts: [] })).toMatch(/acts is empty/);
  });

  it('layers: too many, unknown, duplicate, listed with no cell, used but not listed', () => {
    const d = base();
    d.layers = ['ui', 'api', 'domain', 'data', 'external', 'tests'];
    const m = refused(d);
    expect(m).toContain(`6 layers; use at most ${DESIGN_MAX_LAYERS}`);
    expect(m).toContain('layer "ui" has no cell; drop it from layers');
    expect(refused({ ...base(), layers: ['domain', 'data', 'infra'] })).toMatch(/unknown layer "infra"; use only: ui, api, domain, data, external, tests/);
    expect(refused({ ...base(), layers: ['domain', 'data', 'data'] })).toMatch(/layer "data" is listed twice/);
    const unlisted = base();
    unlisted.layers = ['domain'];
    expect(refused(unlisted)).toMatch(/cell "c3" uses layer "data"; add it to layers/);
    const unknownCell = base();
    unknownCell.cells[2].layer = 'cache';
    expect(refused(unknownCell)).toMatch(/cell "c3" has unknown layer "cache"/);
  });

  it('cells: count, one per slot, unknown act, act with no cell, no pattern anywhere', () => {
    const d = base();
    d.cells = Array.from({ length: DESIGN_MAX_CELLS + 1 }, (_, i) => ({ id: `c${i}`, act: 'imp', layer: 'domain', label: 'L', pattern: 'P', change: 'new' }));
    expect(refused(d)).toContain(`${DESIGN_MAX_CELLS + 1} cells; merge or drop cells so there are at most ${DESIGN_MAX_CELLS}`);
    const twin = base();
    twin.cells[1].act = 'imp';
    expect(refused(twin)).toMatch(/cells "c1" and "c2" are both in act "imp", layer "domain"; merge them into one cell/);
    const lost = base();
    lost.cells[0].act = 'nope';
    const m = refused(lost);
    expect(m).toMatch(/cell "c1" names act "nope", which is not in acts/);
    const empty = base();
    empty.acts.push({ id: 'save', title: 'Save' });
    expect(refused(empty)).toMatch(/act "save" has no cell; drop it or give it one/);
    const plain = base();
    for (const c of plain.cells) c.pattern = null;
    expect(refused(plain)).toMatch(/no cell names a pattern/);
    const badChange = base();
    badChange.cells[0].change = 'added';
    expect(refused(badChange)).toMatch(/change "added" must be one of: new, changed, unchanged/);
  });

  it('ids: malformed and duplicate', () => {
    const d = base();
    d.cells[1].id = 'c1';
    expect(refused(d)).toMatch(/cell id "c1" is used twice/);
    const a = base();
    a.acts[1].id = 'has space';
    expect(refused(a)).toMatch(/act 2 id "has space" must be 1-24 letters/);
  });

  it('string lengths: title, caption, act title, label, pattern, arrow label, files per cell', () => {
    const d = base();
    d.title = 'x'.repeat(DESIGN_TITLE_MAX + 1);
    d.caption = 'One. Two. Three.';
    d.acts[0].title = 'y'.repeat(DESIGN_ACT_TITLE_MAX + 1);
    d.cells[0].label = 'z'.repeat(DESIGN_CELL_LABEL_MAX + 1);
    d.cells[1].pattern = 'p'.repeat(DESIGN_PATTERN_MAX + 1);
    d.arrows[0].label = 'one two three four';
    d.cells[2].files = Array.from({ length: DESIGN_CELL_FILES_MAX + 1 }, (_, i) => `f${i}.ts`);
    const v = validateDesign(d, PR);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const all = v.problems.join('\n');
    expect(all).toContain(`title is ${DESIGN_TITLE_MAX + 1} characters; shorten it to at most ${DESIGN_TITLE_MAX}`);
    expect(all).toContain('caption has 3 sentences; keep at most 2');
    expect(all).toContain(`act "imp" title is ${DESIGN_ACT_TITLE_MAX + 1} characters`);
    expect(all).toContain(`cell "c1" label is ${DESIGN_CELL_LABEL_MAX + 1} characters`);
    expect(all).toContain(`cell "c2" pattern is ${DESIGN_PATTERN_MAX + 1} characters`);
    expect(all).toContain('label has more than 3 words');
    expect(all).toContain(`cell "c3" lists ${DESIGN_CELL_FILES_MAX + 1} files; keep the ${DESIGN_CELL_FILES_MAX} most important`);
    expect(refused({ ...base(), caption: 'c'.repeat(DESIGN_CAPTION_MAX + 1) })).toContain(`at most ${DESIGN_CAPTION_MAX}`);
    const longArrow = base();
    longArrow.arrows[0].label = 'a'.repeat(DESIGN_ARROW_LABEL_MAX + 1);
    expect(refused(longArrow)).toContain(`at most ${DESIGN_ARROW_LABEL_MAX}`);
  });

  it('arrows: count, missing ends, self-loops, duplicates', () => {
    const d = base();
    d.arrows = Array.from({ length: DESIGN_MAX_ARROWS + 1 }, () => ({ from: 'c1', to: 'c2' }));
    const m = refused(d);
    expect(m).toContain(`${DESIGN_MAX_ARROWS + 1} arrows; keep only the ${DESIGN_MAX_ARROWS}`);
    expect(m).toMatch(/is drawn twice/);
    expect(refused({ ...base(), arrows: [{ from: 'c1', to: 'zz' }] })).toMatch(/must join two existing cell ids/);
    expect(refused({ ...base(), arrows: [{ from: 'c1', to: 'c1' }] })).toMatch(/points at itself/);
  });

  it('plain text only: tags and URLs refused anywhere', () => {
    const t = base();
    t.cells[0].label = 'Parse <script>';
    expect(refused(t)).toMatch(/tag-like/);
    const u = base();
    u.caption = 'See https://evil.example for more.';
    expect(refused(u)).toMatch(/link or URL/);
    const j = base();
    j.acts[0].title = 'javascript:alert(1)';
    expect(refused(j)).toMatch(/link or URL/);
    // A comparison is not a tag.
    const ok = base();
    ok.cells[0].label = 'Keep rates < 100';
    expect(validateDesign(ok, PR).ok).toBe(true);
  });

  it('lists every problem at once, capped', () => {
    const d = base();
    d.cells = Array.from({ length: 20 }, (_, i) => ({ id: 'dup', act: 'x', layer: 'nope', label: '', change: '?' }));
    const v = validateDesign(d, PR);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems.length).toBeGreaterThan(8);
    expect(v.message).toMatch(/and \d+ more problem\(s\)\./);
  });
});

describe('validateDesign — files and PR refs', () => {
  it('PR design: unknown paths are dropped (never refused); a prefixed path matches; pr is forced null', () => {
    const d = base();
    d.cells[0].files = ['src/import.ts', 'src/nope.ts', '/repo/checkout/src/rates.ts', './test/rates.test.ts'];
    d.cells[0].pr = 'PR1';
    const v = validateDesign(d, PR);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.design.cells[0]).toMatchObject({ pr: null, files: ['src/import.ts', 'src/rates.ts', 'test/rates.test.ts'] });
  });

  it('story: files are filtered to the named PR; an unknown ref is refused', () => {
    const d = base();
    d.cells[0] = { ...d.cells[0], pr: 'pr2', files: ['web/src/RatesPage.tsx', 'api/routes/rates.ts'] };
    const v = validateDesign(d, STORY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.design.cells[0]).toMatchObject({ pr: 'PR2', files: ['web/src/RatesPage.tsx'] });
    const bad = base();
    bad.cells[0].pr = 'PR9';
    expect(refused(bad, STORY)).toMatch(/names pr "PR9"; use one of: PR1, PR2, or null/);
  });

  it('story: a cell with no pr takes the member owning its first kept file', () => {
    const d = base();
    d.cells[0] = { ...d.cells[0], pr: null, files: ['nope.ts', 'api/db/rates.ts', 'web/src/RatesPage.tsx'] };
    const v = validateDesign(d, STORY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.design.cells[0]).toMatchObject({ pr: 'PR1', files: ['api/db/rates.ts'] });
    expect(v.value.design.cells[1]).toMatchObject({ pr: null, files: [] });
  });
});
