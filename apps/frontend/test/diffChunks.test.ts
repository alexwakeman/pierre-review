// `diffChunks` — the Changes tab's unit of lazy mounting (FileDiffView's `DiffChunk`). A file's rows
// are cut into stretches that mount as they near the screen; these pin that the cut covers every row
// exactly once, prefers a hunk boundary, still cuts inside a giant single hunk, and that a reveal can
// find the chunk holding its row (`chunkIndexOf`), which is what mounts a thread's pill on demand.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  DIFF_CHUNK_ROWS,
  chunkIndexOf,
  diffChunks,
  highlightDiffRows,
  parsePatch,
  type DiffRow,
} from '../src/lib/diff.js';
import { MAX_FILE_DIFF_HIGHLIGHT_LINES } from '../src/lib/hljsLines.js';

function hunks(sizes: number[]): string {
  const out: string[] = [];
  let at = 1;
  for (const n of sizes) {
    out.push(`@@ -${at},${n} +${at},${n} @@`);
    for (let k = 0; k < n; k += 1) out.push(` const v${at + k} = ${at + k};`);
    at += n + 50;
  }
  return out.join('\n');
}

function covers(rows: readonly DiffRow[], chunks: { from: number; to: number }[]): void {
  let next = 0;
  for (const c of chunks) {
    expect(c.from).toBe(next);
    expect(c.to).toBeGreaterThan(c.from);
    next = c.to;
  }
  expect(next).toBe(rows.length);
}

describe('diffChunks', () => {
  it('is no chunks for an empty file and one chunk for a small one', () => {
    expect(diffChunks([])).toEqual([]);
    const rows = parsePatch(hunks([10]));
    expect(diffChunks(rows)).toEqual([{ from: 0, to: rows.length }]);
  });

  it('cuts at a hunk row once a chunk reaches the target', () => {
    const rows = parsePatch(hunks([80, 80, 80, 80]));
    const chunks = diffChunks(rows, 100);
    covers(rows, chunks);
    // Every cut lands on a hunk row (the expander row opens its chunk).
    for (const c of chunks.slice(1)) expect(rows[c.from]!.kind).toBe('hunk');
    expect(chunks.length).toBe(2);
  });

  it('cuts INSIDE a giant single hunk at twice the target, so no chunk is the whole file', () => {
    const rows = parsePatch(hunks([1000]));
    const chunks = diffChunks(rows);
    covers(rows, chunks);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.to - c.from).toBeLessThanOrEqual(DIFF_CHUNK_ROWS * 2);
  });

  it('finds the chunk holding a row, and -1 past the end', () => {
    const rows = parsePatch(hunks([1000]));
    const chunks = diffChunks(rows);
    const last = rows.length - 1;
    expect(chunkIndexOf(chunks, 0)).toBe(0);
    expect(chunkIndexOf(chunks, last)).toBe(chunks.length - 1);
    const mid = chunks[2]!;
    expect(chunkIndexOf(chunks, mid.from)).toBe(2);
    expect(chunkIndexOf(chunks, mid.to - 1)).toBe(2);
    expect(chunkIndexOf(chunks, rows.length)).toBe(-1);
  });
});

describe('highlightDiffRows with a range (one chunk at a time)', () => {
  const patch = [
    '@@ -1,4 +1,4 @@ function a() {',
    ' const s = "a',
    '-  b";',
    '+  c";',
    ' done();',
    '@@ -40,3 +40,3 @@',
    ' /* open',
    '-x */ const y = 1;',
    '+x */ const y = 2;',
  ].join('\n');
  const rows = parsePatch(patch);
  const full = highlightDiffRows(rows, 'typescript', MAX_FILE_DIFF_HIGHLIGHT_LINES)!;

  it('colours a range exactly as the whole-file call does, and nothing outside it', () => {
    expect(full).not.toBeNull();
    for (const [from, to] of [
      [0, rows.length],
      [0, 3],
      // A range that starts MID-HUNK still lexes that hunk whole.
      [2, 7],
      [5, rows.length],
    ] as const) {
      const part = highlightDiffRows(rows, 'typescript', MAX_FILE_DIFF_HIGHLIGHT_LINES, { from, to })!;
      expect(part).not.toBeNull();
      rows.forEach((_r, i) => {
        expect(part[i]).toBe(i >= from && i < to ? full[i] : null);
      });
    }
  });

  it('keeps the WHOLE-FILE gate: a range of a file past the gate stays plain', () => {
    const big = parsePatch(hunks([30, 30]));
    expect(highlightDiffRows(big, 'typescript', 40, { from: 0, to: 5 })).toBeNull();
    expect(highlightDiffRows(big, 'typescript', 100, { from: 0, to: 5 })).not.toBeNull();
  });

  it('is null when nothing in the range is code', () => {
    // Row 0 is the first hunk header alone.
    expect(highlightDiffRows(rows, 'typescript', MAX_FILE_DIFF_HIGHLIGHT_LINES, { from: 0, to: 1 })).toBeNull();
  });
});
