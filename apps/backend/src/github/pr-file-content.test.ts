// The Changes tab's "load more" helpers: the path guard, one-page file listing, and the unified
// patch synthesised for a file GitHub sent no patch for. Pure apart from `fetchPrFilesPage`, whose
// REST read is stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghRestGetFor = vi.fn();
vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghRestGetFor,
}));

const {
  fetchPrFilesPage,
  findPrFileWithPatch,
  isSafeRepoPath,
  resolvePrDiffRefs,
  clearMergeBaseCache,
  synthesizeUnifiedPatch,
} = await import('./pr-file-content.js');

/** Apply a header-less unified patch to `old` — the inverse the synthesiser must agree with. */
function applyPatch(oldText: string, patch: string): string {
  const a = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let ap = 0;
  for (const line of patch.split('\n')) {
    const m = /^@@ -(\d+),(\d+) \+\d+,\d+ @@/.exec(line);
    if (m) {
      const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
      while (ap < start) out.push(a[ap++]!);
      continue;
    }
    if (line.startsWith(' ')) {
      out.push(a[ap++]!);
    } else if (line.startsWith('-')) {
      ap += 1;
    } else if (line.startsWith('+')) {
      out.push(line.slice(1));
    }
  }
  while (ap < a.length) out.push(a[ap++]!);
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

describe('isSafeRepoPath', () => {
  it('accepts ordinary repo-relative paths', () => {
    for (const ok of ['a.ts', 'src/a b/c.ts', '.github/workflows/ci.yml', 'x/.hidden']) {
      expect(isSafeRepoPath(ok), ok).toBe(true);
    }
  });
  it('refuses anything that climbs, is absolute, is empty or carries a NUL', () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', 'a\0b', 'a\\b']) {
      expect(isSafeRepoPath(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isSafeRepoPath(42)).toBe(false);
  });
});

describe('fetchPrFilesPage', () => {
  beforeEach(() => ghRestGetFor.mockReset());
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}` }));

  it('names the next page only when this one came back full', async () => {
    ghRestGetFor.mockResolvedValueOnce(page(100));
    expect(await fetchPrFilesPage('t', 'o', 'r', 1, 1)).toMatchObject({
      nextPage: 2,
      ceilingReached: false,
    });
    expect(ghRestGetFor).toHaveBeenCalledWith('t', '/repos/o/r/pulls/1/files?per_page=100&page=1');
    ghRestGetFor.mockResolvedValueOnce(page(7));
    expect(await fetchPrFilesPage('t', 'o', 'r', 1, 2)).toMatchObject({
      nextPage: null,
      ceilingReached: false,
    });
  });

  it('stops at GitHub’s 3,000-file ceiling and says so', async () => {
    ghRestGetFor.mockResolvedValueOnce(page(100));
    expect(await fetchPrFilesPage('t', 'o', 'r', 1, 30)).toMatchObject({
      nextPage: null,
      ceilingReached: true,
    });
  });

  it('findPrFileWithPatch pages until the file turns up', async () => {
    ghRestGetFor.mockResolvedValueOnce(page(100));
    ghRestGetFor.mockResolvedValueOnce([{ filename: 'deep.ts', patch: '@@ -1 +1 @@' }]);
    const hit = await findPrFileWithPatch('t', 'o', 'r', 1, 'deep.ts');
    expect(hit?.filename).toBe('deep.ts');
    expect(ghRestGetFor).toHaveBeenCalledTimes(2);
  });
});

describe('resolvePrDiffRefs', () => {
  beforeEach(() => {
    ghRestGetFor.mockReset();
    clearMergeBaseCache();
  });

  it('reads the merge base once per (account, PR, head)', async () => {
    ghRestGetFor.mockImplementation(async (_t: string, path: string) =>
      path.includes('/compare/')
        ? { merge_base_commit: { sha: 'mb' } }
        : { head: { sha: 'live' }, base: { sha: 'tip' } },
    );
    const a = await resolvePrDiffRefs('t', 1, 9, 'o', 'r', 3, 'h1');
    const b = await resolvePrDiffRefs('t', 1, 9, 'o', 'r', 3, 'h1');
    expect(a).toEqual({ headSha: 'h1', mergeBase: 'mb' });
    expect(b).toEqual(a);
    expect(ghRestGetFor).toHaveBeenCalledTimes(2);
    expect(ghRestGetFor).toHaveBeenCalledWith('t', '/repos/o/r/compare/tip...h1?per_page=1');
    // Another account never reads this one's resolution.
    await resolvePrDiffRefs('t', 2, 9, 'o', 'r', 3, 'h1');
    expect(ghRestGetFor).toHaveBeenCalledTimes(4);
  });

  it('falls back to the live head when none is stored, and does not cache it', async () => {
    ghRestGetFor.mockImplementation(async (_t: string, path: string) =>
      path.includes('/compare/')
        ? { merge_base_commit: { sha: 'mb' } }
        : { head: { sha: 'live' }, base: { sha: 'tip' } },
    );
    expect(await resolvePrDiffRefs('t', 1, 9, 'o', 'r', 3, null)).toEqual({
      headSha: 'live',
      mergeBase: 'mb',
    });
    await resolvePrDiffRefs('t', 1, 9, 'o', 'r', 3, null);
    expect(ghRestGetFor).toHaveBeenCalledTimes(4);
  });
});

describe('synthesizeUnifiedPatch', () => {
  it('writes GitHub’s header-less shape with three lines of context', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const neu = old.replace('l10\n', 'L10\n');
    const { patch, additions, deletions } = synthesizeUnifiedPatch(old, neu);
    expect(patch).toBe(
      ['@@ -7,7 +7,7 @@', ' l7', ' l8', ' l9', '-l10', '+L10', ' l11', ' l12', ' l13'].join('\n'),
    );
    expect({ additions, deletions }).toEqual({ additions: 1, deletions: 1 });
  });

  it('splits far-apart changes into separate hunks and joins near ones', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
    const neu = [...lines];
    neu[2] = 'X3';
    neu[30] = 'X31';
    const far = synthesizeUnifiedPatch(`${lines.join('\n')}\n`, `${neu.join('\n')}\n`);
    expect(far.patch.match(/^@@/gm)).toHaveLength(2);
    const near = [...lines];
    near[2] = 'X3';
    near[8] = 'X9';
    const joined = synthesizeUnifiedPatch(`${lines.join('\n')}\n`, `${near.join('\n')}\n`);
    expect(joined.patch.match(/^@@/gm)).toHaveLength(1);
  });

  it('handles an added and a deleted file', () => {
    expect(synthesizeUnifiedPatch('', 'a\nb\n').patch).toBe('@@ -0,0 +1,2 @@\n+a\n+b');
    expect(synthesizeUnifiedPatch('a\nb\n', '').patch).toBe('@@ -1,2 +0,0 @@\n-a\n-b');
  });

  it('returns an empty patch for line-identical sides', () => {
    expect(synthesizeUnifiedPatch('a\r\nb\n', 'a\nb').patch).toBe('');
  });

  it('round-trips: applying the patch to the old side gives the new side', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let trial = 0; trial < 30; trial += 1) {
      const a = Array.from({ length: 5 + rnd(60) }, () => `v${rnd(12)}`);
      const b = [...a];
      for (let k = 0; k < 1 + rnd(6); k += 1) {
        const at = rnd(b.length + 1);
        if (rnd(2) === 0) b.splice(at, 1);
        else b.splice(at, 0, `n${rnd(50)}`);
      }
      const oldText = `${a.join('\n')}\n`;
      const newText = b.length === 0 ? '' : `${b.join('\n')}\n`;
      const { patch } = synthesizeUnifiedPatch(oldText, newText);
      expect(applyPatch(oldText, patch), `trial ${trial}`).toBe(newText);
    }
  });
});
