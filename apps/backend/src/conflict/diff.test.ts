import { describe, expect, it } from 'vitest';
import { diffTokens, threeWayChunks } from './diff.js';
import type { DiffChange, ThreeWayRegion } from './diff.js';
import { TokenInterner, internAll, splitLines, tokenizeWords } from './tokens.js';

// PURE. No git, no config, no I/O — this file is the algorithm, and it is the half that has
// to be right before anything downstream can be.

function ids(...tokens: string[]): number[] {
  const interner = new TokenInterner();
  return internAll(tokens, interner);
}

/** Intern three sides against ONE interner, which is what makes their ids comparable. */
function three(
  base: string[],
  ours: string[],
  theirs: string[],
): { b: number[]; o: number[]; t: number[] } {
  const interner = new TokenInterner();
  return {
    b: internAll(base, interner),
    o: internAll(ours, interner),
    t: internAll(theirs, interner),
  };
}

function chunk(
  base: string[],
  ours: string[],
  theirs: string[],
  maxD = 1000,
): ThreeWayRegion[] {
  const { b, o, t } = three(base, ours, theirs);
  const od = diffTokens(b, o, maxD);
  const td = diffTokens(b, t, maxD);
  if (!od || !td) throw new Error('diff budget exhausted');
  return threeWayChunks(b, o, t, od, td);
}

function kinds(regions: ThreeWayRegion[]): string[] {
  return regions.map((r) => r.kind);
}

describe('diffTokens', () => {
  it('finds nothing between identical sequences', () => {
    expect(diffTokens(ids('a', 'b', 'c'), ids('a', 'b', 'c'), 100)).toEqual([]);
  });

  it('reports a replacement in the middle', () => {
    const interner = new TokenInterner();
    const a = internAll(['a', 'b', 'c'], interner);
    const b = internAll(['a', 'X', 'c'], interner);
    expect(diffTokens(a, b, 100)).toEqual<DiffChange[]>([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    ]);
  });

  it('reports an insertion as an empty a-range and a deletion as an empty b-range', () => {
    const i1 = new TokenInterner();
    const a1 = internAll(['a', 'c'], i1);
    const b1 = internAll(['a', 'b', 'c'], i1);
    expect(diffTokens(a1, b1, 100)).toEqual([{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);

    const i2 = new TokenInterner();
    const a2 = internAll(['a', 'b', 'c'], i2);
    const b2 = internAll(['a', 'c'], i2);
    expect(diffTokens(a2, b2, 100)).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
  });

  it('handles changes at index 0 and at EOF', () => {
    const i = new TokenInterner();
    const a = internAll(['a', 'b', 'c'], i);
    const b = internAll(['X', 'b', 'Y'], i);
    expect(diffTokens(a, b, 100)).toEqual([
      { aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 },
      { aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 },
    ]);
  });

  it('returns null when the budget runs out rather than a wrong split', () => {
    // Nothing in common at all: the optimal script is as long as both inputs together, so
    // a budget of 1 cannot cover it.
    const i = new TokenInterner();
    const a = internAll(['a', 'b', 'c', 'd', 'e', 'f'], i);
    const b = internAll(['u', 'v', 'w', 'x', 'y', 'z'], i);
    expect(diffTokens(a, b, 1)).toBeNull();
    // The same pair with room to work is fine, which is what makes the null above a budget
    // result and not a bug.
    expect(diffTokens(a, b, 100)).toEqual([{ aStart: 0, aEnd: 6, bStart: 0, bEnd: 6 }]);
  });

  it('never emits two changes with nothing between them', () => {
    const i = new TokenInterner();
    const a = internAll('one two three four five six seven eight'.split(' '), i);
    const b = internAll('one X Y four Z six seven W'.split(' '), i);
    const changes = diffTokens(a, b, 500);
    expect(changes).not.toBeNull();
    for (let k = 1; k < (changes as DiffChange[]).length; k++) {
      const prev = (changes as DiffChange[])[k - 1] as DiffChange;
      const cur = (changes as DiffChange[])[k] as DiffChange;
      expect(cur.aStart > prev.aEnd || cur.bStart > prev.bEnd).toBe(true);
    }
  });
});

describe('threeWayChunks', () => {
  it('classifies a one-sided change on ours', () => {
    const regions = chunk(['a', 'b', 'c'], ['a', 'OURS', 'c'], ['a', 'b', 'c']);
    expect(kinds(regions)).toEqual(['unchanged', 'ours_only', 'unchanged']);
    const mid = regions[1] as ThreeWayRegion;
    expect(mid.baseStart).toBe(1);
    expect(mid.oursStart).toBe(1);
    expect(mid.theirsStart).toBe(1);
    expect(mid.theirsEnd).toBe(2);
  });

  it('classifies a one-sided change on theirs', () => {
    expect(kinds(chunk(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'T', 'c']))).toEqual([
      'unchanged',
      'theirs_only',
      'unchanged',
    ]);
  });

  it('keeps `both_same` as its own kind', () => {
    // ⚠ NOT collapsed into ours_only. The wand settled nothing here — both authors already
    // agreed — and folding it into a one-sided kind makes the wand's own count wrong.
    expect(kinds(chunk(['a', 'b', 'c'], ['a', 'S', 'c'], ['a', 'S', 'c']))).toEqual([
      'unchanged',
      'both_same',
      'unchanged',
    ]);
  });

  it('classifies a genuine contest', () => {
    expect(kinds(chunk(['a', 'b', 'c'], ['a', 'O', 'c'], ['a', 'T', 'c']))).toEqual([
      'unchanged',
      'conflict',
      'unchanged',
    ]);
  });

  it('keeps two far-apart contested regions separate', () => {
    const base = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const ours = ['O', '2', '3', '4', '5', '6', '7', 'O8'];
    const theirs = ['T', '2', '3', '4', '5', '6', '7', 'T8'];
    expect(kinds(chunk(base, ours, theirs))).toEqual([
      'conflict',
      'unchanged',
      'conflict',
    ]);
  });

  it('absorbs ADJACENT changes from opposite sides into ONE region', () => {
    // Two edits that touch are one contested region. Offering them separately lets the
    // reader take ours from the first and theirs from the second and produce text neither
    // author wrote.
    const base = ['a', 'b', 'c', 'd'];
    const ours = ['a', 'OURS', 'c', 'd'];
    const theirs = ['a', 'b', 'THEIRS', 'd'];
    const regions = chunk(base, ours, theirs);
    expect(kinds(regions)).toEqual(['unchanged', 'conflict', 'unchanged']);
    const mid = regions[1] as ThreeWayRegion;
    expect(mid.baseStart).toBe(1);
    expect(mid.baseEnd).toBe(3);
  });

  it('handles a change at index 0 and one at EOF', () => {
    expect(kinds(chunk(['a', 'b'], ['O', 'b'], ['a', 'b']))).toEqual([
      'ours_only',
      'unchanged',
    ]);
    expect(kinds(chunk(['a', 'b'], ['a', 'b'], ['a', 'T']))).toEqual([
      'unchanged',
      'theirs_only',
    ]);
  });

  it('covers every side end to end, with no gaps and no overlaps', () => {
    const base = ['1', '2', '3', '4', '5', '6'];
    const ours = ['1', 'O', '3', '4', 'O5', '6', 'O7'];
    const theirs = ['0', '1', '2', '3', 'T', '5', '6'];
    const regions = chunk(base, ours, theirs);
    let b = 0;
    let o = 0;
    let t = 0;
    for (const r of regions) {
      expect(r.baseStart).toBe(b);
      expect(r.oursStart).toBe(o);
      expect(r.theirsStart).toBe(t);
      b = r.baseEnd;
      o = r.oursEnd;
      t = r.theirsEnd;
    }
    expect(b).toBe(base.length);
    expect(o).toBe(ours.length);
    expect(t).toBe(theirs.length);
  });

  it('handles an empty base with content added on both sides', () => {
    const regions = chunk([], ['O'], ['T']);
    expect(kinds(regions)).toEqual(['conflict']);
  });
});

describe('tokenizeWords', () => {
  const roundTrips = (input: string): void => {
    expect(tokenizeWords(input).join('')).toBe(input);
  };

  it('round-trips a code sample byte for byte', () => {
    // ⚠ THE HARD INVARIANT. The wand reassembles a region by concatenating token runs, so a
    // tokeniser that dropped or normalised anything would commit text nobody read.
    roundTrips("export function foo(a, b) {\n  return a + b; // note\n}\n");
  });

  it('round-trips CRLF and tabs', () => {
    roundTrips('line one\r\n\tindented\r\n');
  });

  it('round-trips unicode identifiers and emoji', () => {
    roundTrips('const ünicode = "héllo 🎉👩‍💻";\n');
  });

  it('round-trips an empty string and pure whitespace', () => {
    roundTrips('');
    roundTrips('   \n\t\n');
  });

  it('keeps an identifier together and a punctuation run apart', () => {
    expect(tokenizeWords('foo(a, b)')).toEqual(['foo', '(', 'a', ',', ' ', 'b', ')']);
  });

  it('keeps an astral code point as ONE token', () => {
    expect(tokenizeWords('🎉')).toEqual(['🎉']);
  });
});

describe('splitLines', () => {
  it('drops the terminator and remembers it', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], finalNewline: true });
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], finalNewline: false });
  });

  it('treats an empty file as zero lines, not one empty one', () => {
    // Otherwise committing an empty file writes a newline into a file that never had one.
    expect(splitLines('')).toEqual({ lines: [], finalNewline: false });
  });

  it('keeps `\\r` attached so CRLF round-trips', () => {
    expect(splitLines('a\r\n').lines).toEqual(['a\r']);
  });
});
