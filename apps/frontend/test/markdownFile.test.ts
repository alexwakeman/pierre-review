// The Changes tab's rendered Markdown view — the pure half (lib/markdownFile.ts): which files get
// it, what text it renders before the whole file is read (the patch's new side, one segment per
// hunk), when it must say "Only the changed parts are shown", and which links / images survive.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parsePatch } from '../src/lib/diff.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/components/Markdown.js';
import {
  ADDED_BLOCK_CLASS,
  addedNewLines,
  isMarkdownPath,
  markdownFileLinkHref,
  markdownFromPatch,
  rehypeDropRelativeImages,
  rehypeMarkAddedBlocks,
} from '../src/lib/markdownFile.js';

describe('isMarkdownPath', () => {
  it('takes .md, .mdx and .markdown, any case, at any depth', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/guide/Intro.MDX')).toBe(true);
    expect(isMarkdownPath('notes.markdown')).toBe(true);
  });
  it('refuses everything else', () => {
    expect(isMarkdownPath('src/md.ts')).toBe(false);
    expect(isMarkdownPath('docs.md/index.ts')).toBe(false);
    expect(isMarkdownPath('.md')).toBe(false);
    expect(isMarkdownPath('Makefile')).toBe(false);
    expect(isMarkdownPath('notes.mdown.txt')).toBe(false);
  });
});

describe('markdownFromPatch', () => {
  it('an added file is the whole file: every line, not partial', () => {
    const rows = parsePatch(['@@ -0,0 +1,3 @@', '+# Title', '+', '+Some text.'].join('\n'));
    expect(markdownFromPatch(rows)).toEqual({
      segments: [{ text: '# Title\n\nSome text.', hiddenBefore: 0, added: [1, 2, 3] }],
      partial: false,
    });
  });

  it('keeps added + unchanged lines in order and drops removed ones', () => {
    const rows = parsePatch(
      ['@@ -1,4 +1,4 @@', ' # Title', '-Old line.', '+New line.', ' ', ' End.', '\\ No newline at end of file'].join(
        '\n',
      ),
    );
    const out = markdownFromPatch(rows);
    expect(out.segments).toEqual([{ text: '# Title\nNew line.\n\nEnd.', hiddenBefore: 0, added: [2] }]);
    // Starts at line 1 and the no-newline marker proves it reaches the end.
    expect(out.partial).toBe(false);
  });

  it('one segment per hunk, with the hidden count before each; partial when lines are hidden', () => {
    const rows = parsePatch(
      [
        '@@ -10,4 +10,4 @@ ## Install',
        ' a',
        ' b',
        '-c',
        '+C',
        ' d',
        '@@ -30,3 +30,4 @@',
        ' x',
        '+y',
        ' z',
        ' w',
      ].join('\n'),
    );
    const out = markdownFromPatch(rows);
    expect(out.segments).toEqual([
      { text: 'a\nb\nC\nd', hiddenBefore: 9, added: [3] },
      { text: 'x\ny\nz\nw', hiddenBefore: 16, added: [2] },
    ]);
    expect(out.partial).toBe(true);
  });

  it('is partial when the patch cannot prove it reaches the end of the file', () => {
    // Starts at line 1, but three context lines after the last change: more may follow.
    const rows = parsePatch(['@@ -1,4 +1,4 @@', '-a', '+A', ' b', ' c', ' d'].join('\n'));
    expect(markdownFromPatch(rows).partial).toBe(true);
  });

  it('strips a carriage return', () => {
    const rows = parsePatch(['@@ -0,0 +1,1 @@', '+Line\r'].join('\n'));
    expect(markdownFromPatch(rows).segments[0]?.text).toBe('Line');
  });
});

describe('markdownFileLinkHref', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:4000' } });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('keeps an absolute http(s) URL', () => {
    expect(markdownFileLinkHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(markdownFileLinkHref('http://example.com')).toBe('http://example.com');
  });
  it('refuses relative links — they name a file in the repository, not a page here', () => {
    expect(markdownFileLinkHref('./setup.md')).toBeNull();
    expect(markdownFileLinkHref('/docs/setup.md')).toBeNull();
    expect(markdownFileLinkHref('#install')).toBeNull();
    expect(markdownFileLinkHref('//evil.example/x')).toBeNull();
  });
  it('refuses every other scheme', () => {
    expect(markdownFileLinkHref('javascript:alert(1)')).toBeNull();
    expect(markdownFileLinkHref('data:text/html,hi')).toBeNull();
    expect(markdownFileLinkHref('mailto:a@b.c')).toBeNull();
    expect(markdownFileLinkHref(undefined)).toBeNull();
  });
});

describe('rehypeDropRelativeImages', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:4000' } });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('keeps an absolute image, turns a relative one into its alt text, drops one with no alt', () => {
    const img = (src: string, alt?: string) => ({
      type: 'element',
      tagName: 'img',
      properties: alt != null ? { src, alt } : { src },
      children: [],
    });
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [img('https://example.com/a.png', 'A'), img('./diagram.png', 'Diagram'), img('logo.svg')],
        },
      ],
    };
    rehypeDropRelativeImages()(tree);
    expect(tree.children[0]?.children).toEqual([
      img('https://example.com/a.png', 'A'),
      { type: 'text', value: 'Diagram' },
    ]);
  });
});

describe('addedNewLines', () => {
  it('lists the new-side line numbers of the added rows only', () => {
    const rows = parsePatch(['@@ -10,3 +10,4 @@', ' a', '-b', '+B', '+B2', ' c'].join('\n'));
    expect(addedNewLines(rows)).toEqual([11, 12]);
  });
});

describe('rehypeMarkAddedBlocks', () => {
  // Through the real pipeline (raw → sanitize → highlight → the plugin), so the source positions
  // the plugin reads are the ones the sanitizer actually keeps.
  const render = (text: string, added: number[]): string =>
    renderToStaticMarkup(
      createElement(Markdown, { rehypeExtra: [rehypeMarkAddedBlocks(added)], children: text }),
    );
  const marked = (html: string): number => html.split(ADDED_BLOCK_CLASS).length - 1;

  it('wraps a top-level block that holds an added line; leaves unchanged blocks alone', () => {
    const html = render(['# Title', '', 'Old text.', '', 'New text.'].join('\n'), [5]);
    expect(marked(html)).toBe(1);
    expect(html).toContain(`<div class="${ADDED_BLOCK_CLASS}"><p>New text.</p></div>`);
    expect(html).toContain('<h1>Title</h1>');
  });

  it('marks a block in which only one line is added (a paragraph, a fenced code block)', () => {
    const html = render(['Line one', 'line two', '', '```ts', 'const a = 1;', '```'].join('\n'), [2, 5]);
    expect(marked(html)).toBe(2);
  });

  it('marks list ITEMS, not the whole list, and a parent item only for its own lines', () => {
    const html = render(['- one', '- two', '  - nested', '- three'].join('\n'), [3]);
    expect(marked(html)).toBe(1);
    expect(html).toMatch(new RegExp(`<li class="${ADDED_BLOCK_CLASS}">nested</li>`));
    expect(html).toContain('<ul>');
  });

  it('marks nothing when no line is added', () => {
    expect(marked(render('# Title\n\nText.', []))).toBe(0);
  });

  it('a raw HTML block that survives the sanitizer keeps its provenance', () => {
    const html = render(['Intro.', '', '<details><summary>More</summary>Body</details>'].join('\n'), [3]);
    expect(marked(html)).toBe(1);
  });
});
