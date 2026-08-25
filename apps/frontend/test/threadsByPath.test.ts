// The Changes tab's inline-thread plumbing: `indexThreadsByPath` (the ONE rename-aware
// per-file fold ChangesTab builds and shares with the diff blocks, the tree rollups and the
// header mix) and `anchorRowFor` (the ladder deciding which diff row a thread's pill renders
// at — the SAME ladder PrDetail's "In Changes ~" jump uses, so the two must agree).
//
// Both are pure so they can be pinned here; the components over them are not testable in
// this suite (vitest.config pins `test/**/*.test.ts`, no JSX). Run by hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { anchorRowFor, indexThreadsByPath, parsePatch } from '../src/lib/diff.js';

describe('indexThreadsByPath', () => {
  const files = [
    { path: 'src/a.ts' },
    { path: 'src/new.ts', previousPath: 'src/old.ts' },
  ];

  it('keys threads on their current file path', () => {
    const m = indexThreadsByPath([{ path: 'src/a.ts' }, { path: 'src/a.ts' }], files);
    expect(m.get('src/a.ts')).toHaveLength(2);
  });

  it('re-homes a thread keyed on a previousPath under the CURRENT path', () => {
    // The live defect this fold fixes: the old per-view fold keyed on `t.path` while blocks
    // looked up `f.path`, so a thread written before a rename was invisible in Changes.
    const m = indexThreadsByPath([{ path: 'src/old.ts' }], files);
    expect(m.get('src/new.ts')).toHaveLength(1);
    expect(m.has('src/old.ts')).toBe(false);
  });

  it('an exact current-path match beats a previousPath re-home (the COPY case)', () => {
    // b.ts was copied from a.ts, so a.ts is BOTH a current path and b.ts's previousPath —
    // a thread on a.ts belongs to the file that literally has it.
    const copied = [{ path: 'src/a.ts' }, { path: 'src/b.ts', previousPath: 'src/a.ts' }];
    const m = indexThreadsByPath([{ path: 'src/a.ts' }], copied);
    expect(m.get('src/a.ts')).toHaveLength(1);
    expect(m.has('src/b.ts')).toBe(false);
  });

  it('leaves a thread matching neither path out of the map', () => {
    // A file beyond the diff's 100-file cap renders only in the Threads tab — same as before.
    const m = indexThreadsByPath([{ path: 'elsewhere.ts' }], files);
    expect(m.size).toBe(0);
  });

  it('preserves thread order within a bucket', () => {
    const threads = [
      { path: 'src/a.ts', id: 1 },
      { path: 'src/old.ts', id: 2 },
      { path: 'src/a.ts', id: 3 },
    ];
    const m = indexThreadsByPath(threads, files);
    expect(m.get('src/a.ts')?.map((t) => t.id)).toEqual([1, 3]);
  });
});

// The patch under test. Line numbers per row:
//   ' context-a'    old 10 / new 10
//   '-removed-line' old 11
//   '+added-one'    new 11
//   '+added-two'    new 12
//   ' context-b'    old 12 / new 13
const PATCH = [
  '@@ -10,4 +10,5 @@',
  ' context-a',
  '-removed-line',
  '+added-one',
  '+added-two',
  ' context-b',
].join('\n');

function thread(
  line: number | null,
  diffHunk: string | null = null,
): { line: number | null; comments: { diffHunk: string | null }[] } {
  return { line, comments: diffHunk == null ? [] : [{ diffHunk }] };
}

describe('anchorRowFor', () => {
  const rows = parsePatch(PATCH);

  it('rung 1 — a live line anchors exactly, RIGHT side preferred, never approximate', () => {
    // Line 11 has a REAL candidate on BOTH sides (old 11 = '-removed-line' LEFT, new 11 =
    // '+added-one' RIGHT): the RIGHT (new-file) side wins — that is where GitHub pins an
    // inline thread. Line 11, not 12: `commentTarget` maps a context row to RIGHT/newLine
    // only, so ' context-b' (old 12) offers no LEFT candidate and a line-12 test would pass
    // with the preference flipped (`left ?? right`) — verified by mutation.
    const hit = anchorRowFor(rows, thread(11));
    expect(hit).not.toBeNull();
    expect(rows[hit!.index]?.text).toBe('+added-one');
    expect(hit!.approximate).toBe(false);
  });

  it('rung 1 never falls through to the hunk — a live line beats a contradicting hunk', () => {
    // The stored line is GitHub's live truth; when it is not in the visible patch the hunks
    // moved on, and a hunk reconstruction would contradict it. File grain instead.
    const hunkForLine11 = ['@@ -10,1 +10,2 @@', ' context-a', '+added-one'].join('\n');
    expect(anchorRowFor(rows, thread(999, hunkForLine11))).toBeNull();
  });

  it('rung 2 — a line-less thread anchors via its hunk, marked approximate', () => {
    // The hunk ends at '+added-one' → new line 11 (RIGHT), which IS in the current rows.
    const hunk = ['@@ -10,1 +10,2 @@', ' context-a', '+added-one'].join('\n');
    const hit = anchorRowFor(rows, thread(null, hunk));
    expect(hit).not.toBeNull();
    expect(rows[hit!.index]?.text).toBe('+added-one');
    expect(hit!.approximate).toBe(true);
  });

  it('rung 2 matches the hunk-derived side honestly (LEFT stays LEFT)', () => {
    // A hunk ending in a deletion anchors old line 11 on the LEFT — which must land on
    // '-removed-line', not on new line 11 ('+added-one') as a RIGHT-preferring match would.
    const hunk = ['@@ -11,1 +11,0 @@', '-removed-line'].join('\n');
    const hit = anchorRowFor(rows, thread(null, hunk));
    expect(hit).not.toBeNull();
    expect(rows[hit!.index]?.text).toBe('-removed-line');
    expect(hit!.approximate).toBe(true);
  });

  it('rung 3 — no live line and no usable hunk returns null (file grain)', () => {
    // Reconstructed line not in the current rows.
    const drifted = ['@@ -100,1 +200,2 @@', ' x', '+y'].join('\n');
    expect(anchorRowFor(rows, thread(null, drifted))).toBeNull();
    // No hunk at all / no comments — total over sparse data, never a throw.
    expect(anchorRowFor(rows, thread(null))).toBeNull();
    expect(anchorRowFor(rows, thread(null, ''))).toBeNull();
    expect(anchorRowFor([], thread(null, PATCH))).toBeNull();
  });
});
