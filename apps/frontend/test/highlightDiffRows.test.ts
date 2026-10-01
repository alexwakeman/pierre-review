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
  patchEnd,
  patchMatchesFile,
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

describe('highlightDiffRows — one lex per hunk', () => {
  it('does not carry an open block comment from one hunk into the next', () => {
    // THE REAL CASE (DEFRA/bng-metric-backend#426, enrich-baseline-units.js): hunk A ends on a
    // context `/**` whose `*/` sits in the hidden gap. Lexed as one joined side, the comment never
    // closed and every row of hunk B came out as one flat comment colour.
    const rows = parsePatch(
      [
        '@@ -40,3 +40,3 @@ function a() {',
        ' const x = 1;',
        '-const y = 2;',
        '+const y = 3;',
        ' /**',
        '@@ -98,3 +98,3 @@',
        ' function enrich(parcel) {',
        '-  return parcel;',
        '+  return { ...parcel };',
        ' }',
      ].join('\n'),
    );
    const html = highlightDiffRows(rows, 'javascript')!;
    expect(html).not.toBeNull();
    // Hunk A's trailing `/**` is still a comment…
    expect(html[4]).toContain('hljs-comment');
    // …and hunk B is code again, from its first row.
    for (const i of [6, 7, 8, 9]) {
      expect(html[i], `row ${i}`).not.toContain('hljs-comment');
    }
    expect(html[6]).toContain('hljs-keyword');
    expect(html[7]).toContain('hljs-keyword');
  });

  it('blanks only the hunk that refuses, not the whole file', () => {
    // Two hunks; the per-side gate is counted over the WHOLE file, so a file under it lexes each
    // hunk on its own and a hunk the lexer refuses would leave the other one coloured. Here both
    // colour — the pin is that each hunk's output is independent of the other's.
    const rows = parsePatch(
      ['@@ -1,1 +1,1 @@', '-let a = `x', '+let a = 1;', '@@ -50,1 +50,1 @@', ' const b = 2;'].join(
        '\n',
      ),
    );
    const html = highlightDiffRows(rows, 'javascript')!;
    // The unterminated template literal on hunk 1's OLD side does not reach hunk 2.
    expect(html[4]).toContain('hljs-keyword');
    expect(html[4]).not.toContain('hljs-string');
  });

  it('keeps the whole-file line gate, summed across hunks', () => {
    const half = MAX_HIGHLIGHT_LINES / 2 + 1;
    const hunk = (start: number): string[] => [
      `@@ -${start},${half} +${start},${half} @@`,
      ...Array.from({ length: half }, (_, i) => ` const x${start + i} = 1;`),
    ];
    const rows = parsePatch([...hunk(1), ...hunk(1000)].join('\n'));
    expect(highlightDiffRows(rows, 'typescript')).toBeNull();
  });
});

describe('parsePatch — the gap before each hunk', () => {
  it('counts the unchanged lines GitHub left out, and carries the function context', () => {
    const rows = parsePatch(
      [
        '@@ -18,3 +18,3 @@ import {',
        ' a',
        '-b',
        '+B',
        ' z',
        '@@ -45,2 +45,3 @@ function isReady(feature) {',
        ' c',
        '+d',
        ' e',
      ].join('\n'),
    );
    expect(rows[0]!.gap).toEqual({ count: 17, oldFrom: 1, newFrom: 1, context: 'import {' });
    // Hunk 1 ends at old 20 / new 20, so 21..44 are hidden on both sides.
    expect(rows[5]!.gap).toEqual({
      count: 24,
      oldFrom: 21,
      newFrom: 21,
      context: 'function isReady(feature) {',
    });
    expect(patchEnd(rows)).toEqual({ oldNext: 47, newNext: 48 });
  });

  it('draws no gap before a first hunk that starts at line 1, or for an added file', () => {
    expect(parsePatch('@@ -1,2 +1,2 @@\n-a\n+b\n c')[0]!.gap?.count).toBe(0);
    expect(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b')[0]!.gap?.count).toBe(0);
    expect(parsePatch('@@ -1,2 +0,0 @@\n-a\n-b')[0]!.gap?.count).toBe(0);
  });

  it('measures a pure-insertion hunk from its new side', () => {
    // `-10,0` names the line BEFORE the insertion; the new side is the honest count.
    const rows = parsePatch(['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -10,0 +11,2 @@', '+x', '+y'].join('\n'));
    expect(rows[3]!.gap).toMatchObject({ count: 9, oldFrom: 2, newFrom: 2 });
  });
});

describe('patchMatchesFile — may a loaded file fill the gaps?', () => {
  const rows = parsePatch(['@@ -2,2 +2,3 @@ fn', ' b', '-c', '+C', '+D'].join('\n'));
  it('accepts the file the patch was taken from, on either side', () => {
    expect(patchMatchesFile(rows, ['a', 'b', 'C', 'D', 'e'], 'head')).toBe(true);
    expect(patchMatchesFile(rows, ['a', 'b', 'c', 'e'], 'base')).toBe(true);
  });
  it('refuses a file read at another commit', () => {
    expect(patchMatchesFile(rows, ['a', 'X', 'b', 'C', 'D'], 'head')).toBe(false);
    expect(patchMatchesFile(rows, ['a', 'b'], 'head')).toBe(false);
  });
});
