// `highlightDiffRows` — syntax-colouring a unified diff without lying about what the code says.
//
// WHY IT EXISTS. `hljsLines.ts` already highlights a block of SOURCE. A unified diff is not source:
// consecutive `-` and `+` lines are two versions of ONE line, and handing that to a single lexer
// pass leaves it in a state no version of the file was ever in. The failure is not subtle — a
// del/add pair that opens a string on one side only mis-colours everything after it, which is the
// same defect `hljsLines.ts`'s header forbids for line-by-line highlighting, one disguise along.
//
// So: reconstruct the OLD side (context + del) and the NEW side (context + add), highlight each,
// zip each row back to its own side. These tests pin the zip, the marker strip, and the two rows
// that are not code at all (the `@@` header, and `\ No newline at end of file`).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  highlightDiffRows,
  isNoNewlineRow,
  parsePatch,
  splitDiffMarker,
  type DiffRow,
} from '../src/lib/diff.js';
import { MAX_FILE_DIFF_HIGHLIGHT_LINES, MAX_HIGHLIGHT_LINES } from '../src/lib/hljsLines.js';

/** Strip the markup back out, so a test can assert on the TEXT the reader ends up seeing. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

describe('splitDiffMarker', () => {
  it('splits a marked line into notation and code', () => {
    const rows = parsePatch(['@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 2;', ' done'].join('\n'));
    expect(rows.map((r) => splitDiffMarker(r))).toEqual([
      { marker: '', body: '@@ -1,2 +1,2 @@' },
      { marker: '-', body: 'const a = 1;' },
      { marker: '+', body: 'const a = 2;' },
      { marker: ' ', body: 'done' },
    ]);
  });

  it('leaves an UNMARKED line whole', () => {
    // ⚠ `parsePatch` classifies any unmarked line as context — a truncated hunk that opens on real
    // code, or a body that is not a diff at all. An unconditional `slice(1)` there silently eats
    // the line's first character, and the reader sees `onst a = 1;`.
    const [row] = parsePatch('const a = 1;');
    expect(splitDiffMarker(row as DiffRow)).toEqual({ marker: '', body: 'const a = 1;' });
  });

  it('leaves the no-newline annotation whole', () => {
    const rows = parsePatch(['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n'));
    const last = rows.at(-1)!;
    expect(isNoNewlineRow(last)).toBe(true);
    expect(splitDiffMarker(last)).toEqual({ marker: '', body: '\\ No newline at end of file' });
  });
});

describe('highlightDiffRows', () => {
  it('colours each row and prints it back without its marker', () => {
    const rows = parsePatch(
      ['@@ -1,3 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;'].join('\n'),
    );
    const html = highlightDiffRows(rows, 'typescript');
    expect(html).not.toBeNull();
    expect(html).toHaveLength(rows.length);
    // The `@@` header is not code and gets no markup at all.
    expect(html![0]).toBeNull();
    expect(textOf(html![1]!)).toBe('const a = 1;');
    expect(textOf(html![2]!)).toBe('const b = 2;');
    expect(textOf(html![3]!)).toBe('const b = 3;');
    // And it really is highlighted, not just escaped.
    expect(html![1]).toContain('hljs-keyword');
  });

  it('keeps a del/add pair that opens a string on ONE side only from bleeding', () => {
    // THE DEFECT THIS FUNCTION EXISTS FOR. In file order the rows read
    //   -const s = 'x;
    //   +const s = 'x';
    //    const after = 1;
    // and a single lexer pass sees an unterminated string opened by the del line, swallows the add
    // line into it, and colours `const after = 1;` as string content for the rest of the file.
    // Two passes cannot: neither reconstructed side contains both versions.
    const rows = parsePatch(
      ['@@ -1,2 +1,2 @@', "-const s = 'x;", "+const s = 'x';", ' const after = 1;'].join('\n'),
    );
    const html = highlightDiffRows(rows, 'typescript')!;
    expect(html).not.toBeNull();
    // The context row after the pair is ordinary code: it still has its keyword.
    expect(html[3]).toContain('hljs-keyword');
    // And the added line's string closed properly on its own side.
    expect(html[2]).toContain('hljs-string');
  });

  it('keeps a block comment coloured across the lines it spans', () => {
    // The other half of "highlight the whole thing, then cut": a comment opened on one context row
    // must still be a comment on the next.
    const rows = parsePatch(['@@ -1,4 +1,4 @@', ' /*', ' * note', ' */', '+const a = 1;'].join('\n'));
    const html = highlightDiffRows(rows, 'typescript')!;
    expect(html[2]).toContain('hljs-comment');
    expect(html[3]).toContain('hljs-comment');
  });

  it('skips the hunk header and the no-newline annotation', () => {
    const rows = parsePatch(['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n'));
    const html = highlightDiffRows(rows, 'typescript')!;
    expect(html[0], 'the @@ header is not code').toBeNull();
    expect(html[3], 'the no-newline annotation is not code').toBeNull();
    // ⚠ And it never reached the lexer: slicing its first character would have fed the lexer
    // " No newline at end of file", which happily colours as an identifier list.
    expect(html.filter((h) => h != null)).toHaveLength(2);
  });

  it('highlights a file with no OLD side at all', () => {
    // ⚠ A newly-added file has only `+` rows, so the reconstructed old side is EMPTY and
    // `highlightLines([])` refuses by its own gate. Treating that as a failure would leave every
    // added file in the Changes tab uncoloured — the common case, silently.
    const rows = parsePatch(['@@ -0,0 +1,2 @@', '+const a = 1;', '+const b = 2;'].join('\n'));
    const html = highlightDiffRows(rows, 'typescript')!;
    expect(html).not.toBeNull();
    expect(html[1]).toContain('hljs-keyword');
    expect(html[2]).toContain('hljs-keyword');
  });

  it('refuses with no language, with no rows, and past the line gate', () => {
    const rows = parsePatch(['@@ -1 +1 @@', '+const a = 1;'].join('\n'));
    expect(highlightDiffRows(rows, null)).toBeNull();
    expect(highlightDiffRows([], 'typescript')).toBeNull();
    const many = [
      '@@ -1,1000 +1,1000 @@',
      ...Array.from({ length: MAX_HIGHLIGHT_LINES + 10 }, (_, i) => ` const x${i} = ${i};`),
    ].join('\n');
    expect(highlightDiffRows(parsePatch(many), 'typescript')).toBeNull();
  });

  it('colours an ADDED file past the shared gate when the call site passes its own limit', () => {
    // The real case: a newly-added 412-line .js file rendered wholly plain in the Changes tab,
    // because an added file's whole patch is its NEW side and 412 > MAX_HIGHLIGHT_LINES.
    const n = MAX_HIGHLIGHT_LINES + 12;
    const added = [
      `@@ -0,0 +1,${n} @@`,
      ...Array.from({ length: n }, (_, i) => `+const x${i} = ${i};`),
    ].join('\n');
    const rows = parsePatch(added);
    expect(highlightDiffRows(rows, 'javascript')).toBeNull();
    const html = highlightDiffRows(rows, 'javascript', MAX_FILE_DIFF_HIGHLIGHT_LINES)!;
    expect(html).toHaveLength(rows.length);
    expect(html[n]).toContain('hljs-keyword');
    expect(textOf(html[n]!)).toBe(`const x${n - 1} = ${n - 1};`);
    // …and the raised limit is still a limit.
    const tooMany = [
      '@@ -0,0 +1,1 @@',
      ...Array.from({ length: MAX_FILE_DIFF_HIGHLIGHT_LINES + 1 }, (_, i) => `+const x${i} = ${i};`),
    ].join('\n');
    expect(
      highlightDiffRows(parsePatch(tooMany), 'javascript', MAX_FILE_DIFF_HIGHLIGHT_LINES),
    ).toBeNull();
  });

  it('gives a context row the NEW side’s entry', () => {
    // They agree by construction — a context line is the same text on both sides — so this pins the
    // rule rather than a difference. What it catches is an off-by-one in the two index maps.
    const rows = parsePatch(['@@ -1,2 +1,2 @@', '-let a = 1;', ' const b = 2;'].join('\n'));
    const html = highlightDiffRows(rows, 'typescript')!;
    expect(textOf(html[2]!)).toBe('const b = 2;');
  });
});
