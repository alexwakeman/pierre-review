// THE HIGHLIGHTS IN A RENDERED TICKET (lib/storyHighlights.ts) and the proposed-text diff
// (lib/wordDiff.ts) — Reports → This sprint, the opened card.
//
//   1. A quote is matched across inline nodes within ONE block, whitespace-normalised, curly quotes
//      straight, case-insensitive as a fallback, Markdown marks stripped as a last resort.
//   2. Findings sharing a quote share ONE mark; a quote is marked once; only the first piece is a tab stop.
//   3. Never inside a code block; never across two blocks.
//   4. Soft line breaks become <br> outside code, and a quote still matches across them.
//   5. The mark colours clear AA (4.5:1) in both themes.
//   6. Word diff: kept / added / removed words; list diff pairs each proposed item with its nearest.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyHighlights.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { highlightTree, rehypeSoftBreaks, storyAnchors, stripMarkdownMarks } from '../src/lib/storyHighlights.js';
import { listDiff, wordDiff } from '../src/lib/wordDiff.js';

type N = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: N[] };

const text = (value: string): N => ({ type: 'text', value });
const el = (tagName: string, ...children: N[]): N => ({ type: 'element', tagName, properties: {}, children });
const root = (...children: N[]): N => ({ type: 'root', children });

/** The tree as a compact string: marks as [key|ids:text]. */
function show(n: N): string {
  if (n.type === 'text') return n.value ?? '';
  if (n.type === 'element' && n.tagName === 'mark') {
    const p = n.properties ?? {};
    const tab = p.tabIndex === 0 ? '*' : '';
    return `[${tab}${String(p.dataMark)}|${String(p.dataFindings)}:${(n.children ?? []).map(show).join('')}]`;
  }
  if (n.type === 'element' && n.tagName === 'br') return '⏎';
  const inner = (n.children ?? []).map(show).join('');
  return n.type === 'root' ? inner : `<${n.tagName}>${inner}</${n.tagName}>`;
}

function run(tree: N, findings: Array<{ id: string; quote: string | null }>): string {
  highlightTree(tree as never, storyAnchors(findings));
  return show(tree);
}

describe('storyAnchors', () => {
  it('groups findings by normalised quote and skips unanchored ones', () => {
    const a = storyAnchors([
      { id: 'u-c1', quote: 'fast  enough' },
      { id: 'g-0', quote: null },
      { id: 'claude-0', quote: 'fast enough' },
      { id: 'b-0', quote: 'BMD-12' },
    ]);
    expect(a).toEqual([
      { key: 'm0', quote: 'fast enough', ids: ['u-c1', 'claude-0'] },
      { key: 'm1', quote: 'BMD-12', ids: ['b-0'] },
    ]);
  });
});

describe('highlightTree', () => {
  it('marks a quote inside one text node', () => {
    const t = root(el('p', text('The page should load fast enough for users.')));
    expect(run(t, [{ id: 'a', quote: 'load fast enough' }])).toBe('<p>The page should [*m0|a:load fast enough] for users.</p>');
  });

  it('matches across inline nodes, whitespace-normalised; only the first piece is a tab stop', () => {
    const t = root(el('p', text('Show the '), el('strong', text('total   units')), text('\n required')));
    expect(run(t, [{ id: 'a', quote: 'the total units required' }])).toBe(
      '<p>Show [*m0|a:the ]<strong>[m0|a:total   units]</strong>[m0|a:\n required]</p>',
    );
  });

  it('reads curly quotes as straight and falls back to case-insensitive', () => {
    const t = root(el('li', text('Gain Target: “Not applicable”')));
    expect(run(t, [{ id: 'a', quote: 'gain target: "not applicable"' }])).toBe(
      '<li>[*m0|a:Gain Target: “Not applicable”]</li>',
    );
  });

  it('strips Markdown marks from a quote verified against the source', () => {
    expect(stripMarkdownMarks('- [ ] **GTM** snippet is _added_')).toBe('GTM snippet is added');
    const t = root(el('li', el('input'), text(' '), el('strong', text('GTM')), text(' snippet is added')));
    expect(run(t, [{ id: 'a', quote: '- [ ] **GTM** snippet is added' }])).toBe(
      '<li><input></input> <strong>[*m0|a:GTM]</strong>[m0|a: snippet is added]</li>',
    );
  });

  it('one mark for findings sharing a quote; each quote marked once', () => {
    const t = root(el('p', text('fast fast')), el('p', text('fast')));
    expect(
      run(t, [
        { id: 'a', quote: 'fast' },
        { id: 'b', quote: 'fast' },
      ]),
    ).toBe('<p>[*m0|a b:fast] fast</p><p>fast</p>');
  });

  it('never matches across two blocks, never inside a code block, never on taken text', () => {
    const t = root(el('p', text('first line')), el('p', text('second line')), el('pre', el('code', text('fast code'))));
    expect(
      run(t, [
        { id: 'a', quote: 'line second' },
        { id: 'b', quote: 'fast code' },
      ]),
    ).toBe('<p>first line</p><p>second line</p><pre><code>fast code</code></pre>');
    const u = root(el('p', text('the quick brown fox')));
    expect(
      run(u, [
        { id: 'short', quote: 'quick' },
        { id: 'long', quote: 'the quick brown' },
      ]),
    ).toBe('<p>[*m1|long:the quick brown] fox</p>');
  });

  it('a list item’s own text is one block; its nested list another', () => {
    const t = root(el('ul', el('li', text('Tile 1: Target %'), el('ul', el('li', text('Subheading: Target'))))));
    expect(run(t, [{ id: 'a', quote: 'Target % Subheading' }])).toBe(
      '<ul><li>Tile 1: Target %<ul><li>Subheading: Target</li></ul></li></ul>',
    );
    const u = root(el('ul', el('li', text('Tile 1: Target %'), el('ul', el('li', text('Subheading: Target'))))));
    expect(run(u, [{ id: 'a', quote: 'Subheading: Target' }])).toBe(
      '<ul><li>Tile 1: Target %<ul><li>[*m0|a:Subheading: Target]</li></ul></li></ul>',
    );
  });
});

describe('rehypeSoftBreaks', () => {
  it('turns newlines in prose into <br>, leaves code and layout whitespace alone', () => {
    const t = root(el('p', text('GIVEN a project\nAND a baseline')), text('\n'), el('pre', el('code', text('a\nb'))));
    rehypeSoftBreaks()(t as never);
    expect(show(t)).toBe('<p>GIVEN a project⏎AND a baseline</p>\n<pre><code>a\nb</code></pre>');
    // react-markdown reads `properties` on every element: a <br> without it crashes the render.
    expect(t.children![0]!.children![1]).toEqual({ type: 'element', tagName: 'br', properties: {}, children: [] });
  });

  it('a quote still matches across a soft break', () => {
    const t = root(el('p', text('GIVEN a project\nAND a baseline')));
    rehypeSoftBreaks()(t as never);
    expect(run(t, [{ id: 'a', quote: 'project AND a' }])).toBe('<p>GIVEN a [*m0|a:project]⏎[m0|a:AND a] baseline</p>');
  });
});

// ── 5. Contrast of the highlight, both themes ────────────────────────────────────────────────────

function lum(hex: string): number {
  const h = hex.replace('#', '');
  const f = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}
const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
function over(fg: [number, number, number], alpha: number, bg: string): string {
  const h = bg.replace('#', '');
  return `#${fg
    .map((c, i) => Math.round(c * alpha + parseInt(h.slice(i * 2, i * 2 + 2), 16) * (1 - alpha)))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

describe('the highlight colours', () => {
  const css = readFileSync(join(__dirname, '../src/index.css'), 'utf8');
  it('are the measured ones', () => {
    expect(css).toMatch(/\.story-mark \{[^}]*background-color: #fef08a;[^}]*color: #111827;/);
    expect(css).toMatch(/\.dark \.story-mark \{[^}]*background-color: rgba\(253, 224, 71, 0\.25\);[^}]*color: #fefce8;/);
    // The draft's revision highlight wears the same measured pair.
    expect(css).toMatch(/ins\.story-rev \{[^}]*background-color: #fef08a;[^}]*color: #111827;/);
    expect(css).toMatch(/\.dark ins\.story-rev \{[^}]*background-color: rgba\(253, 224, 71, 0\.25\);[^}]*color: #fefce8;/);
  });
  it('clear AA in light and in dark (on the page and on a gray-900 panel)', () => {
    expect(ratio('#111827', '#fef08a')).toBeGreaterThanOrEqual(4.5);
    for (const ground of ['#030712', '#111827']) {
      expect(ratio('#fefce8', over([253, 224, 71], 0.25, ground))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ── 6. Word diff ─────────────────────────────────────────────────────────────────────────────────

describe('wordDiff', () => {
  it('keeps, adds and removes words; ignores re-wrapping and curly quotes', () => {
    expect(wordDiff('The page loads fast', 'The page loads within 2 seconds')).toEqual([
      { kind: 'same', text: 'The page loads ' },
      { kind: 'removed', text: 'fast ' },
      { kind: 'added', text: 'within 2 seconds' },
    ]);
    expect(wordDiff('a  “b”\nc', 'a "b" c').every((p) => p.kind === 'same')).toBe(true);
  });
});

describe('listDiff', () => {
  it('pairs each proposed item with its nearest current one; the rest are new or removed', () => {
    const { items, removed } = listDiff(
      ['The user can upload a file', 'It is fast', 'Errors are shown'],
      ['The user can upload a CSV file', 'Errors are shown', 'A failed upload names the bad row'],
    );
    expect(items.map((i) => i.kind)).toEqual(['changed', 'same', 'added']);
    expect(items[0]!.parts).toEqual([
      { kind: 'same', text: 'The user can upload a ' },
      { kind: 'added', text: 'CSV ' },
      { kind: 'same', text: 'file' },
    ]);
    expect(removed).toEqual(['It is fast']);
  });

  it('pairs a short item with its own longer rewrite', () => {
    const { items, removed } = listDiff(['Subheading: “Targets”'], ['Subheading: “Targets” is shown above the tiles']);
    expect(items.map((i) => i.kind)).toEqual(['changed']);
    expect(removed).toEqual([]);
  });
});
