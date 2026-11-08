import { describe, expect, it } from 'vitest';
import { capDiffRanked, impactTier, rankFiles } from './diff-rank.js';
import { analyzeDiff } from './prepare.js';
import { capDiff, splitDiffByFile } from './post-review.js';

// One file's unified diff with `n` added lines.
function fileDiff(path: string, n: number, line = 'const x = 1;'): string {
  const body = Array.from({ length: n }, () => `+${line}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${n} @@`,
    body,
  ].join('\n');
}

function build(files: [string, number][]): string {
  return files.map(([p, n]) => fileDiff(p, n)).join('\n');
}

function keptPaths(diff: string): string[] {
  return splitDiffByFile(diff).map((s) => s.path);
}

// Alphabetical (GitHub's diff order): low-impact early, contract file late.
const FILES: [string, number][] = [
  ['README.md', 10],
  ['src/a.ts', 10],
  ['src/b.test.ts', 10],
  ['src/c.ts', 10],
  ['zz/migrations/0001_init.sql', 10],
];
const DIFF = build(FILES);
const METRICS = analyzeDiff(DIFF);
const segLen = (p: string) => splitDiffByFile(DIFF).find((s) => s.path === p)!.text.length + 1;

describe('impactTier', () => {
  it('ranks contract files, then code, then tests, then non-code', () => {
    expect(impactTier('zz/migrations/0001_init.sql')).toBe(0);
    expect(impactTier('src/auth/session.ts')).toBe(0);
    expect(impactTier('src/a.ts')).toBe(1);
    expect(impactTier('src/b.test.ts')).toBe(2);
    expect(impactTier('README.md')).toBe(3);
  });
});

describe('rankFiles', () => {
  it('puts the contract file first and breaks ties on path', () => {
    const paths = FILES.map(([p]) => p);
    const order = rankFiles(paths, METRICS).map((i) => paths[i]);
    expect(order).toEqual([
      'zz/migrations/0001_init.sql',
      'src/a.ts',
      'src/c.ts',
      'src/b.test.ts',
      'README.md',
    ]);
  });
});

describe('capDiffRanked', () => {
  it('returns the diff unchanged when it fits the budget', () => {
    const r = capDiffRanked(DIFF, DIFF.length, METRICS);
    expect(r).toEqual({ diff: DIFF, capped: false, omittedFiles: [], totalBytes: DIFF.length });
  });

  it('keeps a late-alphabet migration ahead of early non-contract files', () => {
    const budget = segLen('zz/migrations/0001_init.sql') + segLen('src/a.ts');
    const r = capDiffRanked(DIFF, budget, METRICS);
    expect(r.capped).toBe(true);
    expect(keptPaths(r.diff)).toEqual(['src/a.ts', 'zz/migrations/0001_init.sql']);
    // The plain cap, by contrast, keeps the alphabetical head and drops the migration.
    expect(capDiff(DIFF, budget).omittedFiles).toContain('zz/migrations/0001_init.sql');
  });

  it('emits kept files and omitted files in diff order', () => {
    const budget =
      segLen('zz/migrations/0001_init.sql') + segLen('src/a.ts') + segLen('src/c.ts');
    const r = capDiffRanked(DIFF, budget, METRICS);
    expect(keptPaths(r.diff)).toEqual(['src/a.ts', 'src/c.ts', 'zz/migrations/0001_init.sql']);
    expect(r.omittedFiles).toEqual(['README.md', 'src/b.test.ts']);
    // Kept segments are byte-identical to the originals.
    for (const seg of splitDiffByFile(r.diff)) {
      expect(DIFF).toContain(seg.text);
    }
  });

  it('gives the same output for the same input', () => {
    const budget = segLen('src/a.ts') * 2;
    const a = capDiffRanked(DIFF, budget, METRICS);
    const b = capDiffRanked(DIFF, budget, analyzeDiff(DIFF));
    expect(b).toEqual(a);
  });

  it('skips one oversized top-ranked file so smaller files still fit', () => {
    const diff = build([
      ['db/migrations/0002_big.sql', 2000],
      ['src/a.ts', 5],
      ['src/b.ts', 5],
    ]);
    const segs = splitDiffByFile(diff);
    const budget = segs[1]!.text.length + segs[2]!.text.length + 2;
    const r = capDiffRanked(diff, budget, analyzeDiff(diff));
    expect(keptPaths(r.diff)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.omittedFiles).toEqual(['db/migrations/0002_big.sql']);
  });

  it('keeps the top-ranked file alone when nothing fits', () => {
    const r = capDiffRanked(DIFF, 1, METRICS);
    expect(keptPaths(r.diff)).toEqual(['zz/migrations/0001_init.sql']);
    expect(r.omittedFiles).toEqual(['README.md', 'src/a.ts', 'src/b.test.ts', 'src/c.ts']);
  });
});

describe('capDiff (other callers) is unchanged', () => {
  it('still keeps files in diff order and always keeps the first', () => {
    const budget = segLen('README.md') + segLen('src/a.ts');
    expect(keptPaths(capDiff(DIFF, budget).diff)).toEqual(['README.md', 'src/a.ts']);
    expect(keptPaths(capDiff(DIFF, 1).diff)).toEqual(['README.md']);
  });
});
