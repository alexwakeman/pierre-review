import { describe, expect, it } from 'vitest';
import { markdownToAdf, markdownToJiraWiki } from './adf.js';

describe('markdownToAdf', () => {
  it('paragraphs, with consecutive lines joined by hard breaks', () => {
    expect(markdownToAdf('one\ntwo\n\nthree').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('a heading header, then a bullet list with a nested ordered list', () => {
    const doc = markdownToAdf('## ENG-1 · Title\n\n- first\n  1. inner\n- second');
    expect(doc).toMatchObject({ type: 'doc', version: 1 });
    expect(doc.content[0]).toEqual({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'ENG-1 · Title' }] });
    expect(doc.content[1]).toEqual({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] }] },
          ],
        },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
      ],
    });
  });

  it('bold, italic, inline code and https links become marks', () => {
    const [p] = markdownToAdf('**Bold** and *it* in `src/a.ts` see [docs](https://x.example/a)').content as Array<{ content: unknown[] }>;
    expect(p!.content).toEqual([
      { type: 'text', text: 'Bold', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'it', marks: [{ type: 'em' }] },
      { type: 'text', text: ' in ' },
      { type: 'text', text: 'src/a.ts', marks: [{ type: 'code' }] },
      { type: 'text', text: ' see ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://x.example/a' } }] },
    ]);
  });

  it('a non-https link keeps only its text', () => {
    const [p] = markdownToAdf('[x](javascript:alert(1)) [y](http://a.b)').content as Array<{ content: Array<{ marks?: unknown }> }>;
    expect(p!.content.every((n) => n.marks == null)).toBe(true);
  });

  it('snake_case words are not italic', () => {
    const [p] = markdownToAdf('use user_id_field here').content as Array<{ content: unknown[] }>;
    expect(p!.content).toEqual([{ type: 'text', text: 'use user_id_field here' }]);
  });

  it('fenced code is a code block, its content literal', () => {
    expect(markdownToAdf('```ts\nconst **a** = 1;\n```').content).toEqual([
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const **a** = 1;' }] },
    ]);
  });

  it('never emits an empty text node', () => {
    const json = JSON.stringify(markdownToAdf('****\n\n- \n\n``\n'));
    expect(json).not.toContain('"text":""');
  });
});

describe('markdownToJiraWiki', () => {
  it('converts headings, nested lists, marks, code and links', () => {
    expect(markdownToJiraWiki('## Title\n- a **b**\n  - c `d`\n1. e\n[l](https://x.example)\n```\nx\n```')).toBe(
      'h2. Title\n* a *b*\n** c {{d}}\n# e\n[l|https://x.example/]\n{code}\nx\n{code}',
    );
  });
});
