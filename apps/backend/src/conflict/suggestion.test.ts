import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConflictSuggestionRefusal } from '@pierre-review/shared';
import {
  CONFLICT_FENCE_REGIONS,
  conflictFences,
  hunkRegionChars,
  nonceCollides,
  validateConflictSuggestion,
  type ConflictHunkContext,
} from './suggestion.js';

// THE VALIDATORS' TEST, AND IT RUNS IN CI — which is the entire reason these functions live in
// core rather than in the plugin (`packages/pro/test/` is neither run by `pnpm test` nor
// typechecked). They are what stands between an attacker-authored conflict hunk, a model's
// answer, and a blob in somebody's repository.
//
// The corpus in `__fixtures__/conflict-suggestions/` is iterated from the directory, the
// `sync/__fixtures__/threads/` pattern: adding a case is adding a file, and its README carries
// the shape. Everything that needs two answers, a reordering or a byte JSON cannot carry is
// written inline below.

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'conflict-suggestions',
);

const NONCE = 'a1b2c3d4e5f60789';
const FENCE = conflictFences(NONCE).RESOLVED;

interface Fixture {
  name: string;
  expected: 'ok' | ConflictSuggestionRefusal;
  keptCommonLines?: number;
  hunk: {
    base: string[];
    ours: string[];
    theirs: string[];
    contextBefore?: string[];
    contextAfter?: string[];
  };
  answer: string[];
}

/** The fixture's placeholders → the real markers. A fixture never hard-codes a nonce, so the
 *  corpus stays readable and a change to the marker format cannot leave it half-updated. */
function render(lines: string[]): string {
  return lines
    .join('\n')
    .replaceAll('<<BEGIN>>', FENCE.begin)
    .replaceAll('<<END>>', FENCE.end)
    .replaceAll('<<NONCE>>', NONCE)
    .replaceAll('<<NUL>>', '\0');
}

function hunkOf(f: Fixture): ConflictHunkContext {
  return {
    repoId: 1,
    path: 'src/thing.ts',
    headRef: 'feature/x',
    baseRef: 'main',
    base: f.hunk.base,
    ours: f.hunk.ours,
    theirs: f.hunk.theirs,
    contextBefore: f.hunk.contextBefore ?? [],
    contextAfter: f.hunk.contextAfter ?? [],
    endsWithNewline: true,
  };
}

const HUNK: ConflictHunkContext = {
  repoId: 1,
  path: 'src/thing.ts',
  headRef: 'feature/x',
  baseRef: 'main',
  base: ['const a = 1;', 'const b = 2;'],
  ours: ['const a = 1;', 'const b = 2;', 'const c = 3;'],
  theirs: ['const a = 1;', 'const b = 2;', 'const d = 4;'],
  contextBefore: ['function f() {', '  // setup', '  init();'],
  contextAfter: ['  return a;', '}', '// end'],
  endsWithNewline: true,
};

const block = (...lines: string[]): string => [FENCE.begin, ...lines, FENCE.end].join('\n');

const GOOD = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'];

describe('validateConflictSuggestion — the fixture corpus', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  it('has fixtures to iterate', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Fixture;
    it(`${file}: ${fixture.name}`, () => {
      const out = validateConflictSuggestion(hunkOf(fixture), NONCE, render(fixture.answer));
      if (fixture.expected === 'ok') {
        expect(out.ok, `expected ok, got ${out.ok ? '' : out.refusal}`).toBe(true);
        if (out.ok && fixture.keptCommonLines !== undefined) {
          expect(out.keptCommonLines).toBe(fixture.keptCommonLines);
        }
      } else {
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refusal).toBe(fixture.expected);
      }
    });
  }
});

describe('validateConflictSuggestion — the order of the checks', () => {
  // ⚠ THE ORDER IS PINNED, NOT INCIDENTAL. An answer that fails two checks reports the EARLIER
  // one, and this is the assertion that breaks if somebody reorders them for tidiness. A
  // surviving conflict marker is the fact worth telling the reader about; that it also ran long
  // is not.
  it('reports `markers` on an answer that also runs far too long', () => {
    const padding = Array.from({ length: 40 }, (_, i) => `// padding ${i}`);
    const out = validateConflictSuggestion(
      HUNK,
      NONCE,
      block('<<<<<<< HEAD', ...GOOD, ...padding),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('markers');
  });

  it('reports `cannot_reconcile` rather than `empty` — the designed refusal outranks both', () => {
    const out = validateConflictSuggestion(HUNK, NONCE, block('CANNOT RECONCILE'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('cannot_reconcile');
  });

  it('reports `dropped_common_lines` before `dropped_side_lines` when both are true', () => {
    // `const b = 2;` is in both sides (check 7) and `const c = 3;` is ours alone (check 8).
    const out = validateConflictSuggestion(HUNK, NONCE, block('const a = 1;', 'const d = 4;'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('dropped_common_lines');
  });
});

describe('validateConflictSuggestion — extraction', () => {
  it('keys the fence on the NONCE: a marker carrying another tag delimits nothing', () => {
    const foreign = conflictFences('ffffffffffffffff').RESOLVED;
    const out = validateConflictSuggestion(
      HUNK,
      NONCE,
      [foreign.begin, 'not this', foreign.end, block(...GOOD)].join('\n'),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lines).toEqual(GOOD);
  });

  it('refuses two RESOLVED blocks rather than picking one', () => {
    const out = validateConflictSuggestion(
      HUNK,
      NONCE,
      [block(...GOOD), block('const a = 1;')].join('\n'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('unparseable');
  });

  it('refuses an END that arrives before its BEGIN', () => {
    const out = validateConflictSuggestion(
      HUNK,
      NONCE,
      [FENCE.end, ...GOOD, FENCE.begin].join('\n'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('unparseable');
  });

  it('ignores everything outside the block, including prose the model added', () => {
    const out = validateConflictSuggestion(
      HUNK,
      NONCE,
      ['Happy to help! Here is the merge:', block(...GOOD), 'Let me know if that works.'].join(
        '\n',
      ),
    );
    expect(out.ok).toBe(true);
  });

  it('treats a CRLF answer exactly as its LF twin', () => {
    const lf = validateConflictSuggestion(HUNK, NONCE, block(...GOOD));
    const crlf = validateConflictSuggestion(
      HUNK,
      NONCE,
      block(...GOOD).split('\n').join('\r\n'),
    );
    expect(crlf).toEqual(lf);
    expect(crlf.ok).toBe(true);
  });

  it('strips one leading BOM but refuses a BOM inside the block', () => {
    expect(validateConflictSuggestion(HUNK, NONCE, `﻿${block(...GOOD)}`).ok).toBe(true);
    const inner = validateConflictSuggestion(
      HUNK,
      NONCE,
      block('const a = 1;', '﻿const b = 2;', 'const c = 3;', 'const d = 4;'),
    );
    expect(inner.ok).toBe(false);
    if (!inner.ok) expect(inner.refusal).toBe('not_text');
  });

  it('refuses a lone surrogate — legal in a JS string, not encodable as UTF-8', () => {
    const out = validateConflictSuggestion(HUNK, NONCE, block(...GOOD, 'const e = "\uD800";'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('not_text');
  });

  it('trims trailing blank lines and keeps leading indentation', () => {
    const out = validateConflictSuggestion(HUNK, NONCE, block(...GOOD, '', '   ', ''));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lines).toEqual(GOOD);
  });
});

describe('validateConflictSuggestion — what the checks protect', () => {
  it('counts kept common lines from the CODE, not from the model', () => {
    const out = validateConflictSuggestion(HUNK, NONCE, block(...GOOD));
    expect(out.ok).toBe(true);
    // `const a = 1;` and `const b = 2;` are in both sides; `c`/`d` belong to one each.
    if (out.ok) expect(out.keptCommonLines).toBe(2);
  });

  it('refuses the base branch alone even when every COMMON line survived', () => {
    // The headline regression, stated inline as well as in a fixture: check 7 is satisfied by an
    // answer that deletes the pull request's entire contribution, because those lines were never
    // common. Only check 8 catches it.
    const out = validateConflictSuggestion(
      HUNK,
      NONCE,
      block('const a = 1;', 'const b = 2;', 'const d = 4;'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('dropped_side_lines');
  });

  it('accepts a line one side added that the OTHER side deliberately deleted', () => {
    // `const gone = 0;` is in base and in ours, and theirs removed it. Ours has no EXCESS over
    // base for it, so nothing requires it back — otherwise a merge could never honour a deletion.
    const hunk: ConflictHunkContext = {
      ...HUNK,
      base: ['const gone = 0;', 'const a = 1;'],
      ours: ['const gone = 0;', 'const a = 1;', 'const c = 3;'],
      theirs: ['const a = 1;', 'const d = 4;'],
    };
    const out = validateConflictSuggestion(
      hunk,
      NONCE,
      block('const a = 1;', 'const c = 3;', 'const d = 4;'),
    );
    expect(out.ok).toBe(true);
  });

  it('requires a line both sides added exactly ONCE, not twice', () => {
    const hunk: ConflictHunkContext = {
      ...HUNK,
      base: ['const a = 1;'],
      ours: ['const a = 1;', 'import x from "x";'],
      theirs: ['const a = 1;', 'import x from "x";'],
    };
    const out = validateConflictSuggestion(hunk, NONCE, block('const a = 1;', 'import x from "x";'));
    expect(out.ok).toBe(true);
  });

  it('refuses an answer that repeats the lines it sits between, either side', () => {
    const before = validateConflictSuggestion(
      HUNK,
      NONCE,
      block(...HUNK.contextBefore, ...GOOD),
    );
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.refusal).toBe('context_duplicated');
    const after = validateConflictSuggestion(HUNK, NONCE, block(...GOOD, ...HUNK.contextAfter));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.refusal).toBe('context_duplicated');
  });

  it('does not fire the context check when there is no context to repeat', () => {
    const out = validateConflictSuggestion(
      { ...HUNK, contextBefore: [], contextAfter: [] },
      NONCE,
      block(...GOOD),
    );
    expect(out.ok).toBe(true);
  });

  it('bounds the answer in BYTES as well as in lines', () => {
    // One line, well inside the line cap, and far past the byte cap.
    const out = validateConflictSuggestion(HUNK, NONCE, block(...GOOD, 'x'.repeat(4000)));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('too_long');
  });
});

describe('the fences', () => {
  it('carries the nonce in all six regions, begin and end', () => {
    const fences = conflictFences(NONCE);
    expect(Object.keys(fences)).toHaveLength(6);
    for (const region of CONFLICT_FENCE_REGIONS) {
      expect(fences[region].begin).toBe(`---BEGIN ${region} ${NONCE}---`);
      expect(fences[region].end).toBe(`---END ${region} ${NONCE}---`);
    }
  });

  it('spots a nonce that already appears in the untrusted text, in any field', () => {
    expect(nonceCollides(HUNK, NONCE)).toBe(false);
    expect(nonceCollides({ ...HUNK, ours: [`// ${NONCE}`] }, NONCE)).toBe(true);
    expect(nonceCollides({ ...HUNK, contextAfter: [`x ${NONCE.toUpperCase()}`] }, NONCE)).toBe(
      true,
    );
    // A branch name is user-chosen too.
    expect(nonceCollides({ ...HUNK, headRef: `f/${NONCE}` }, NONCE)).toBe(true);
  });
});

describe('hunkRegionChars', () => {
  it('measures the three SIDES and nothing else — context cannot push a small hunk over', () => {
    const small = hunkRegionChars(HUNK.base, HUNK.ours, HUNK.theirs);
    expect(small).toBeGreaterThan(0);
    expect(hunkRegionChars([], [], [])).toBe(0);
    // A hunk's size is its own; the context lines the seam attaches are not part of it.
    expect(hunkRegionChars(HUNK.base, HUNK.ours, HUNK.theirs)).toBe(small);
  });
});
