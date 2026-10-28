import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStorage, storageToHtml, storageToMarkdown } from './confluence-storage.js';

// CONFLUENCE STORAGE FORMAT → MARKDOWN (docs/REFERENCE-DOCS.md § Wiki sources → Converting a page).
// The fixture is a hand-recorded storage body carrying every macro shape the converter handles.

const fixture = readFileSync(join(__dirname, '__fixtures__/confluence/storage-macros.xhtml'), 'utf8');

describe('storageToMarkdown — a page with macros', () => {
  it('keeps the text, the headings, the table and the code', async () => {
    const md = await storageToMarkdown(fixture);
    expect(md).toContain('# Payments service');
    expect(md).toContain('## Settlement');
    expect(md).toMatch(/\| Currency \| Fee \|/);
    expect(md).toMatch(/\| EUR \| 1\.4% \|/);
    // The code macro: a fenced block with its language, the CDATA text intact (not HTML-decoded twice).
    expect(md).toContain('```typescript');
    expect(md).toContain('throw new Error("<negative>");');
    expect(md).toContain('if (amount < 0 && x > 1) {');
    expect(md).toContain('**settle.ts**');
  });

  it('turns panels into headed quotes and an expand into its title and body', async () => {
    const md = await storageToMarkdown(fixture);
    expect(md).toMatch(/> \*\*Info: Cut-off\*\*/);
    expect(md).toMatch(/> Payments after 17:00 UTC settle the next working day\./);
    expect(md).toMatch(/> \*\*Warning:\*\*/);
    expect(md).toContain('**Edge cases**');
    expect(md).toMatch(/-\s+Chargebacks reverse the settlement\./);
    expect(md).toMatch(/> \*\*Note:\*\*/);
    expect(md).toContain('New-editor panel body.');
    expect(md).not.toContain('Fallback should not appear');
  });

  it('keeps a text diagram source and leaves a placeholder for a drawn one', async () => {
    const md = await storageToMarkdown(fixture);
    expect(md).toContain('```mermaid');
    expect(md).toContain('A[Authorised] --> B[Captured]');
    expect(md).toContain('[Diagram: settlement-flow]');
    expect(md).toContain('[Diagram: Ledger states]');
    // A mermaid macro with no source in the body (an attachment) is a placeholder too.
    expect(md).toContain('[Diagram: old-flow]');
  });

  it('links read as text, images as their alt or file name, tasks as marks, words for status and Jira', async () => {
    const md = await storageToMarkdown(fixture);
    expect(md).toContain('the refund policy');
    expect(md).toContain('[the spec](https://example.com/spec)');
    // A relative wiki link keeps its text and loses its target.
    expect(md).toContain('a wiki path');
    expect(md).not.toContain('/wiki/spaces/ENG/pages/9');
    expect(md).toContain('[Image: Settlement timeline]');
    expect(md).toContain('[Image: fees.png]');
    expect(md).toMatch(/\[x\] Add GBP/);
    expect(md).toMatch(/\[ \] Add JPY/);
    expect(md).toContain('[In progress]');
    expect(md).toContain('[Jira: PAY-12]');
    expect(md).toContain('Left cell text.');
    expect(md).toContain('Right cell text.');
    expect(md).toContain('@user');
    expect(md).toContain('✅');
    expect(md).toMatch(/& done\s+today\./);
    expect(md).toContain('Kept body of an unknown macro.');
  });

  it('drops navigation macros, scripts and macro parameters', async () => {
    const md = await storageToMarkdown(fixture);
    expect(md).not.toContain('maxLevel');
    expect(md).not.toContain('alert(1)');
    expect(md).not.toMatch(/\b600\b/);
    expect(md).not.toContain('Yellow');
  });
});

describe('the tokenizer is linear and tolerant', () => {
  it('survives unclosed tags, stray closes and an unterminated CDATA', () => {
    expect(storageToHtml('<p>one <strong>two</p> three</em>')).toContain('one');
    expect(storageToHtml('<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x < y')).toContain('x &lt; y');
    expect(storageToHtml('<p a="1 > 2">quoted gt</p>')).toBe('<p>quoted gt</p>');
  });

  it('a page of 100,000 unclosed tags parses in well under a second', () => {
    const evil = '<div>'.repeat(100_000) + '</span>'.repeat(50_000) + 'end';
    const t0 = Date.now();
    const tree = parseStorage(evil);
    const html = storageToHtml(evil);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(tree.children.length).toBe(1);
    expect(html).toContain('end');
  });
});
