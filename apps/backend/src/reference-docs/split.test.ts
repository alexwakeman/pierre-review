import { describe, expect, it } from 'vitest';
import {
  DocumentTooLongError,
  HARD_CAP_CHARS,
  HARD_CAP_WORDS,
  MAX_DOC_WORDS,
  MAX_WORDS,
  countWords,
  headingAnchor,
  parseBlocks,
  splitMarkdown,
  splitWrittenSection,
} from './split.js';

const words = (n: number, w = 'word'): string => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
const para = (n: number): string => {
  // Paragraphs of ~100 words so the splitter has boundaries to use.
  const out: string[] = [];
  for (let left = n; left > 0; left -= 100) out.push(words(Math.min(100, left)));
  return out.join('\n\n');
};

describe('parseBlocks', () => {
  it('never reads a heading inside a code fence, and keeps the fence whole', () => {
    const blocks = parseBlocks('# Title\n\n```md\n# not a heading\n```\n\ntext');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'code', 'para']);
    expect(blocks[1]).toMatchObject({ kind: 'code', lines: ['# not a heading'] });
  });

  it('reads setext headings and tables', () => {
    const blocks = parseBlocks('Big\n===\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nSmall\n---');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'table', 'heading']);
    expect(blocks[0]).toMatchObject({ level: 1, title: 'Big' });
    expect(blocks[2]).toMatchObject({ level: 2, title: 'Small' });
  });
});

describe('splitMarkdown', () => {
  it('splits along the headings, with structural depth and trails', () => {
    const md = `# Guide\n\n${para(900)}\n\n## Install\n\n${para(900)}\n\n### Linux\n\n${para(900)}\n\n# Reference\n\n${para(900)}`;
    const s = splitMarkdown(md, 'Doc');
    expect(s.map((x) => [x.title, x.depth, x.trail])).toEqual([
      ['Guide', 1, []],
      ['Install', 2, ['Guide']],
      ['Linux', 3, ['Guide', 'Install']],
      ['Reference', 1, []],
    ]);
  });

  it('depth follows nesting, not the raw # count', () => {
    const s = splitMarkdown(`## A\n\n${para(900)}\n\n#### B\n\n${para(900)}`, 'Doc');
    expect(s.map((x) => x.depth)).toEqual([1, 2]);
  });

  it('merges a short section with its next sibling or child, and keeps the heading as an anchor', () => {
    const s = splitMarkdown(`# A\n\nshort intro\n\n## B\n\n${para(300)}\n\n## C\n\n${para(1300)}`, 'Doc');
    expect(s[0]!.title).toBe('A');
    expect(s[0]!.subheadings.map((h) => [h.title, h.anchor])).toEqual([['B', 'b']]);
    expect(s[0]!.body).toContain('## B');
  });

  it('never merges upward out of a section’s own scope', () => {
    const s = splitMarkdown(`# A\n\n${para(900)}\n\n## A1\n\nshort\n\n# B\n\n${para(100)}`, 'Doc');
    expect(s.map((x) => x.title)).toEqual(['A', 'A1', 'B']);
    expect(s.find((x) => x.title === 'B')!.trail).toEqual([]);
  });

  it('names text before the first heading after the fallback title', () => {
    const s = splitMarkdown(`${para(1000)}\n\n# Next\n\n${para(1000)}`, 'Handbook');
    expect(s[0]!.title).toBe('Handbook');
  });

  it('splits a section over the hard cap into parts, every part under the cap', () => {
    const s = splitMarkdown(`# Long\n\n${para(5000)}`, 'Doc');
    expect(s.length).toBeGreaterThan(2);
    expect(s[0]!.title).toMatch(/^Long \(part 1 of \d+\)$/);
    for (const part of s) {
      expect(part.words).toBeLessThanOrEqual(HARD_CAP_WORDS);
      expect(part.chars).toBeLessThanOrEqual(HARD_CAP_CHARS);
    }
  });

  it('keeps a section between the target and the hard cap whole', () => {
    const s = splitMarkdown(`# Mid\n\n${para(1800)}`, 'Doc');
    expect(s).toHaveLength(1);
  });

  it('keeps a table and a code block intact when there is anywhere else to split', () => {
    const table = ['| k | v |', '| --- | --- |', ...Array.from({ length: 30 }, (_, i) => `| k${i} | v${i} |`)].join('\n');
    const code = ['```ts', ...Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`), '```'].join('\n');
    const s = splitMarkdown(`# T\n\n${para(1400)}\n\n${table}\n\n${para(1400)}\n\n${code}\n\n${para(600)}`, 'Doc');
    const all = s.map((x) => x.body).join('\n\n');
    expect(s.filter((x) => x.body.includes('| k0 | v0 |'))).toHaveLength(1);
    expect(s.find((x) => x.body.includes('| k0 | v0 |'))!.body).toContain('| k29 | v29 |');
    expect(s.find((x) => x.body.includes('const x0 = 0;'))!.body).toContain('const x29 = 29;');
    expect(all).toContain('```ts');
  });

  it('cuts a table bigger than the cap by rows, repeating its header row', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `| key${i} | ${words(6, `v${i}x`)} |`);
    const s = splitMarkdown(`# Big table\n\n| k | v |\n| --- | --- |\n${rows.join('\n')}`, 'Doc');
    expect(s.length).toBeGreaterThan(1);
    for (const part of s) {
      expect(part.body.startsWith('| k | v |\n| --- | --- |')).toBe(true);
      expect(part.words).toBeLessThanOrEqual(HARD_CAP_WORDS);
    }
  });

  it('cuts a code block bigger than the cap by lines, re-opening the fence in each part', () => {
    const lines = Array.from({ length: 900 }, (_, i) => `let value${i} = compute(${i}, "${'x'.repeat(10)}");`);
    const s = splitMarkdown(`# Code\n\n\`\`\`js\n${lines.join('\n')}\n\`\`\``, 'Doc');
    expect(s.length).toBeGreaterThan(1);
    for (const part of s) {
      expect(part.body.startsWith('```js')).toBe(true);
      expect(part.body.trimEnd().endsWith('```')).toBe(true);
      expect(part.chars).toBeLessThanOrEqual(HARD_CAP_CHARS);
    }
  });

  it('cuts one enormous line (no paragraph breaks at all)', () => {
    const s = splitMarkdown(`# Wall\n\n${words(6000)}`, 'Doc');
    expect(s.length).toBeGreaterThan(3);
    for (const part of s) expect(part.words).toBeLessThanOrEqual(MAX_WORDS);
  });

  it('cuts text with no spaces by characters', () => {
    const s = splitMarkdown(`# Dense\n\n${'字'.repeat(40_000)}`, 'Doc');
    for (const part of s) expect(part.chars).toBeLessThanOrEqual(HARD_CAP_CHARS);
  });

  it('refuses a document past the word limit', () => {
    expect(() => splitMarkdown(words(MAX_DOC_WORDS + 10), 'Doc')).toThrow(DocumentTooLongError);
  });

  it('drops a heading with no text of its own (its title stays in the trail below it)', () => {
    const s = splitMarkdown(`# Part one\n\n## Chapter\n\n${para(1600)}`, 'Doc');
    expect(s.map((x) => x.title)).toEqual(['Chapter']);
    expect(s[0]!.trail).toEqual(['Part one']);
  });
});

describe('splitWrittenSection (a PDF build)', () => {
  it('drops a leading heading that repeats the title and turns other headings into anchors', () => {
    const [s] = splitWrittenSection('Payment terms', 1, [], `# Payment terms\n\nPay within 30 days.\n\n## Late fees\n\n2% a month.`);
    expect(s!.body.startsWith('Pay within')).toBe(true);
    expect(s!.subheadings).toEqual([{ title: 'Late fees', depth: 2, anchor: 'late-fees' }]);
  });

  it('applies the same hard cap', () => {
    const parts = splitWrittenSection('Long', 1, [], para(4500));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.words).toBeLessThanOrEqual(HARD_CAP_WORDS);
  });
});

describe('helpers', () => {
  it('anchors like GitHub, with a hash fallback for non-ASCII headings', () => {
    expect(headingAnchor('Refunds & Returns (v2)')).toBe('refunds-returns-v2');
    expect(headingAnchor('支払い')).toMatch(/^[a-z0-9_-]+$/);
  });
  it('counts words', () => {
    expect(countWords('  one two\nthree ')).toBe(3);
  });
});
