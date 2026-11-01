import { describe, expect, it } from 'vitest';
import { buildWorklist, reconcileCoverage, worklistPromptSection, WORKLIST_MAX } from './worklist.js';
import { coverageFromStored } from './persist.js';
import { buildSubmitReviewShape } from '../schema.js';
import { loadZod } from '../../ai/runtime.js';

// THE REVIEW PLAN (docs/CLAUDE-REVIEW.md § The review plan): the changed files ranked by CODE, the
// same every time, reported on by the run.

function fileDiff(path: string, added: string[], removed: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');
}

describe('buildWorklist', () => {
  const diff = [
    fileDiff('src/util/format.js', ['export const pad = (s) => s.padStart(2, "0");']),
    fileDiff('src/routes/orders.js', ['router.post("/orders", async (req) => {', '  if (!req.body.id) return 400;', '  await db.insert(orders).values(req.body);', '});']),
    fileDiff('db/migrations/0042_orders.sql', ['ALTER TABLE orders ADD note text;']),
    fileDiff('src/routes/orders.test.js', ['it("saves", () => { if (x) expect(1).toBe(1); });']),
    fileDiff('README.md', ['Orders can carry a note.']),
  ].join('\n');

  it('ranks by risk and names the reasons, the same every time', () => {
    const w = buildWorklist({ diff });
    expect(w.items.map((i) => i.path)).toEqual([
      'src/routes/orders.js',
      'db/migrations/0042_orders.sql',
      'src/util/format.js',
      'src/routes/orders.test.js',
    ]);
    expect(w.items.map((i) => i.ref)).toEqual(['W1', 'W2', 'W3', 'W4']);
    const orders = w.items[0]!;
    expect(orders.reasons).toEqual(expect.arrayContaining(['writes stored data', 'handles input', '1 new branch']));
    // A test for orders.js changed, so "no test changed" is not said of it; format.js has none.
    expect(orders.reasons).not.toContain('no test changed');
    expect(w.items[2]!.reasons).toContain('no test changed');
    // A contract file names its surface, never "no test changed".
    expect(w.items[1]!.reasons[0]).toMatch(/^contract: /);
    expect(w.items[1]!.reasons).not.toContain('no test changed');
    // Docs are not planned, only named.
    expect(w.others).toEqual(['README.md']);
    expect(buildWorklist({ diff })).toEqual(w);
  });

  it('a hub and past findings raise a file; a template never "writes stored data"', () => {
    const d = [
      fileDiff('src/a.js', ['const x = 1;']),
      fileDiff('src/b.js', ['const y = 2;']),
      fileDiff('views/page.njk', ['{{ form.set("x") }}']),
    ].join('\n');
    const w = buildWorklist({ diff: d, hubs: new Map([['src/b.js', 90]]), pastFindings: new Map([['src/b.js', 2]]) });
    expect(w.items[0]!.path).toBe('src/b.js');
    expect(w.items[0]!.reasons).toEqual(expect.arrayContaining(['changes with many other files (hub)', '2 past findings here']));
    expect(w.items.find((i) => i.path === 'views/page.njk')?.reasons ?? []).not.toContain('writes stored data');
  });

  it(`plans at most ${WORKLIST_MAX} files; the rest are named`, () => {
    const many = Array.from({ length: WORKLIST_MAX + 3 }, (_, i) => fileDiff(`src/f${i}.js`, ['const a = 1;'])).join('\n');
    const w = buildWorklist({ diff: many });
    expect(w.items).toHaveLength(WORKLIST_MAX);
    expect(w.others).toHaveLength(3);
  });

  it('the prompt section lists the plan in order and asks for coverage; paths are cleaned', () => {
    const w = buildWorklist({ diff: fileDiff('src/x`y.js', ['const a = 1;']) });
    const s = worklistPromptSection(w);
    expect(s).toContain('## Review plan');
    expect(s).toContain('W1 `src/xy.js`');
    expect(s).toContain('add one entry to `coverage`');
    expect(worklistPromptSection({ items: [], others: [] })).toBe('');
  });
});

describe('reconcileCoverage', () => {
  const w = buildWorklist({
    diff: [fileDiff('src/a.js', ['if (a) b();']), fileDiff('src/b.js', ['x();']), fileDiff('src/c.js', ['y();'])].join('\n'),
  });
  it('one entry per item in plan order; a gap is not_reviewed; a finding makes it issues', () => {
    const refOf = (p: string): string => w.items.find((i) => i.path === p)!.ref;
    const out = reconcileCoverage(
      w,
      [
        { ref: refOf('src/b.js'), status: 'no_issues', note: '  checked the call  ' },
        { ref: refOf('src/a.js'), status: 'no_issues' },
        { ref: 'W99', status: 'issues' },
      ],
      ['src/a.js'],
    );
    expect(out.map((o) => o.ref)).toEqual(w.items.map((i) => i.ref));
    expect(out.find((o) => o.path === 'src/a.js')!.status).toBe('issues');
    expect(out.find((o) => o.path === 'src/b.js')).toMatchObject({ status: 'no_issues', note: 'checked the call' });
    expect(out.find((o) => o.path === 'src/c.js')).toMatchObject({ status: 'not_reviewed', note: null });
  });
});

describe('the stored plan and the submit shape', () => {
  it('coverageFromStored keeps well-formed items and reads anything else as null', () => {
    const item = { ref: 'W1', path: 'a.js', reasons: ['+1 −0'], status: 'no_issues', note: null };
    expect(coverageFromStored([item, { ref: 'W2' }])).toEqual([item]);
    expect(coverageFromStored(null)).toBeNull();
    expect(coverageFromStored([])).toBeNull();
  });

  it('only a planned run gains `coverage`', async () => {
    const z = await loadZod();
    expect(Object.keys(buildSubmitReviewShape(z))).not.toContain('coverage');
    expect(Object.keys(buildSubmitReviewShape(z, { plan: true }))).toContain('coverage');
    expect(Object.keys(buildSubmitReviewShape(z, { docs: true, plan: true }))).toContain('coverage');
  });
});
