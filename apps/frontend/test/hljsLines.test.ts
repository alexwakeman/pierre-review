import { describe, expect, it } from 'vitest';
import {
  MAX_HIGHLIGHT_LINES,
  highlightLines,
  languageForPath,
  splitHighlighted,
} from '../src/lib/hljsLines.js';

// ── PER-CELL HIGHLIGHTING, CUT BY LINE ───────────────────────────────────────────────────────
//
// ⚠ HAND-RUN. `./apps/backend/node_modules/.bin/vitest run --root apps/frontend`.
//
// The one thing worth proving here is that the cut keeps the span stack balanced. A cell's HTML
// goes into `dangerouslySetInnerHTML` one line at a time, so an unclosed `<span>` on line 3 does
// not "look slightly off" — the browser repairs it by re-parenting the rest of the cell, and a
// block comment's colour bleeds over the code beneath it for the rest of the region.

const balanced = (line: string): boolean =>
  (line.match(/<span\b/g) ?? []).length === (line.match(/<\/span>/g) ?? []).length;

describe('splitHighlighted', () => {
  it('closes and re-opens an open tag at every newline', () => {
    const lines = splitHighlighted('<span class="hljs-comment">/* a\nb\nc */</span>');
    expect(lines).toHaveLength(3);
    expect(lines.every(balanced)).toBe(true);
    expect(lines[0]).toBe('<span class="hljs-comment">/* a</span>');
    expect(lines[1]).toBe('<span class="hljs-comment">b</span>');
    expect(lines[2]).toBe('<span class="hljs-comment">c */</span>');
  });

  it('handles nesting', () => {
    const lines = splitHighlighted('<span class="a"><span class="b">x\ny</span>z</span>');
    expect(lines).toHaveLength(2);
    expect(lines.every(balanced)).toBe(true);
  });

  it('leaves plain text alone', () => {
    expect(splitHighlighted('one\ntwo')).toEqual(['one', 'two']);
  });
});

describe('highlightLines', () => {
  it('keeps a block comment split across lines balanced on every line', () => {
    const src = ['/**', ' * hello', ' */', 'const x = 1;'];
    const out = highlightLines(src, 'typescript');
    expect(out).not.toBeNull();
    expect(out).toHaveLength(src.length);
    expect(out!.every(balanced)).toBe(true);
    // The comment is still a comment on its middle line — the defect this exists to catch is the
    // second line coming back as ordinary code.
    expect(out![1]).toContain('hljs-comment');
  });

  it('returns null when there is no language to use', () => {
    // ⚠ NEVER `highlightAuto`. A guess that lands on the wrong lexer colours a three-line hunk as
    // something it is not, which is a claim about the code rather than a decoration.
    expect(highlightLines(['const x = 1;'], null)).toBeNull();
    expect(highlightLines(['const x = 1;'], 'not-a-language')).toBeNull();
  });

  it('returns null past the line gate', () => {
    const many = Array.from({ length: MAX_HIGHLIGHT_LINES + 100 }, (_, i) => `const x${i} = ${i};`);
    expect(highlightLines(many, 'typescript')).toBeNull();
    expect(highlightLines([], 'typescript')).toBeNull();
  });

  it('returns one entry per input line', () => {
    const src = ['a', '', 'b'];
    expect(highlightLines(src, 'typescript')).toHaveLength(3);
  });
});

describe('languageForPath', () => {
  it('resolves from the extension and refuses to guess', () => {
    expect(languageForPath('apps/backend/src/db/queries.ts')).toBe('typescript');
    expect(languageForPath('src/App.tsx')).toBe('typescript');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('deploy/Dockerfile')).toBe('dockerfile');
    // An extension three languages claim, and a file with none at all.
    expect(languageForPath('src/thing.m')).toBeNull();
    expect(languageForPath('LICENSE')).toBeNull();
    expect(languageForPath('.gitignore')).toBeNull();
  });
});
