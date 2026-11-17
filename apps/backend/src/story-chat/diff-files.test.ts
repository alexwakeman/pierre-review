// The story chat's diffs as files the agent reads WHOLE (diff-files.ts): split per file, parts within Read's
// bounds, long lines wrapped, GitHub's "not shown" files named, an INDEX that lists every part.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIFF_LINE_MAX, DIFF_PART_CHARS, DIFF_PART_LINES, LONG_LINE_MARK, partsOf, planDiffFolder, safeName, splitDiff, writeDiffFolder } from './diff-files.js';

const fileDiff = (path: string, adds: number, opts: { hunkEvery?: number; head?: string[] } = {}): string => {
  const lines = [`diff --git a/${path} b/${path}`, ...(opts.head ?? []), `--- a/${path}`, `+++ b/${path}`];
  for (let i = 0; i < adds; i++) {
    if (opts.hunkEvery && i % opts.hunkEvery === 0) lines.push(`@@ -${i},0 +${i},${opts.hunkEvery} @@`);
    else if (i === 0) lines.push('@@ -0,0 +1,1 @@');
    lines.push(`+line ${i}`);
  }
  return lines.join('\n');
};

describe('splitDiff', () => {
  it('one entry per file with its status and churn', () => {
    const text = [
      fileDiff('a.ts', 3),
      'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-x\n+y',
      fileDiff('b.ts', 1, { head: ['new file mode 100644'] }),
      'diff --git a/c.png b/c.png\n(diff not shown — status=modified, +0/-0; likely binary or too large)',
      'diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b',
    ].join('\n');
    expect(splitDiff(text).map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions])).toEqual([
      ['a.ts', null, 'modified', 3, 0],
      ['new.ts', 'old.ts', 'renamed', 1, 1],
      ['b.ts', null, 'added', 1, 0],
      ['c.png', null, 'not shown', 0, 0],
      ['d.ts', null, 'deleted', 0, 2],
    ]);
  });
});

describe('parts', () => {
  it('no part is past the line or character bound, and together they are the whole file', () => {
    const lines = fileDiff('big.ts', 1879, { hunkEvery: 50 }).split('\n');
    const parts = partsOf(lines);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(DIFF_PART_LINES);
      expect(p.join('\n').length).toBeLessThanOrEqual(DIFF_PART_CHARS);
    }
    expect(parts.flat()).toEqual(lines);
    // Broken at a hunk where one is near.
    expect(parts.slice(1).every((p) => p[0]!.startsWith('@@'))).toBe(true);
  });

  it('wraps a line too long for one Read line', () => {
    const long = `+${'x'.repeat(DIFF_LINE_MAX * 2 + 5)}`;
    const [part] = partsOf([long]);
    expect(part).toHaveLength(3);
    expect(part!.every((l) => l.length <= DIFF_LINE_MAX + LONG_LINE_MARK.length)).toBe(true);
    expect(part![1]!.startsWith(LONG_LINE_MARK)).toBe(true);
  });

  it('a safe file name for any path', () => {
    expect(safeName('src/a b/c.ts')).toBe('src__a_b__c.ts');
    expect(safeName('x/'.repeat(100)).length).toBeLessThanOrEqual(120);
  });
});

describe('the folder', () => {
  it('an INDEX listing every file and every part; every part on disk', () => {
    const text = [fileDiff('src/big.ts', 1879, { hunkEvery: 50 }), fileDiff('small.ts', 2), 'diff --git a/c.png b/c.png\n(diff not shown — status=added, +0/-0; likely binary or too large)'].join('\n');
    const plan = planDiffFolder('acme/api#620 "Refunds"', text);
    const index = plan.files[0]!;
    expect(index.name).toBe('INDEX.md');
    expect(index.text).toContain('# acme/api#620 "Refunds": its whole diff, one file per changed file');
    expect(index.text).toContain('3 files, +1881 −0');
    expect(index.text).toMatch(/- src\/big\.ts \(changed, \+1879 −0\): 001-src__big\.ts\.part1\.diff, 001-src__big\.ts\.part2\.diff/);
    expect(index.text).toContain('- small.ts (changed, +2 −0): 002-small.ts.diff');
    expect(index.text).toContain('c.png (no diff from GitHub (binary or too large): read the file in the checkout');
    const dir = mkdtempSync(join(tmpdir(), 'sc-diff-'));
    try {
      const got = writeDiffFolder(dir, 't', text);
      expect(readdirSync(dir)).toHaveLength(plan.files.length);
      expect(readFileSync(got.index, 'utf8')).toContain('3 files');
      expect(readFileSync(join(dir, '001-src__big.ts.part2.diff'), 'utf8')).toMatch(/^# src\/big\.ts: part 2 of \d+ of this file's diff\n@@/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty diff says so', () => {
    expect(planDiffFolder('t', '').files[0]!.text).toContain('(This diff is empty.)');
  });
});
