// The Changes tab's rendered Markdown view — the pure half (lib/markdownFile.ts): which files get
// it, what text it renders before the whole file is read (the patch's new side, one segment per
// hunk), when it must say "Only the changed parts are shown", and which links / images survive.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parsePatch } from '../src/lib/diff.js';
import {
  isMarkdownPath,
  markdownFileLinkHref,
  markdownFromPatch,
  rehypeDropRelativeImages,
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
      segments: [{ text: '# Title\n\nSome text.', hiddenBefore: 0 }],
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
    expect(out.segments).toEqual([{ text: '# Title\nNew line.\n\nEnd.', hiddenBefore: 0 }]);
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
      { text: 'a\nb\nC\nd', hiddenBefore: 9 },
      { text: 'x\ny\nz\nw', hiddenBefore: 16 },
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
