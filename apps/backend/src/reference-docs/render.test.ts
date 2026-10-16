import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderDocFolder, draftsFromWritten } from './assemble.js';
import { markdownLinkTargets, renderIndex, sectionFileNames, validateDocFolder } from './render.js';
import { splitMarkdown } from './split.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'limn-docs-render-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const para = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('INDEX.md', () => {
  const a = { slug: 'billing', title: 'Billing handbook', summary: 'How invoices and refunds work.', topics: ['refunds', 'invoices'], sourceName: 'billing.pdf', sectionCount: 12 };
  const b = { slug: 'api-guide', title: 'API guide', summary: 'The public REST API.', topics: [], sourceName: 'https://example.com/api', sectionCount: 3 };

  it('is deterministic: one entry per document, in title order, whatever the input order', () => {
    const one = renderIndex([a, b]);
    expect(renderIndex([b, a])).toBe(one);
    expect(one.indexOf('API guide')).toBeLessThan(one.indexOf('Billing handbook'));
    expect(markdownLinkTargets(one)).toEqual(['api-guide/CONTENTS.md', 'billing/CONTENTS.md']);
    expect(one).toContain('Topics: refunds, invoices · Source: billing.pdf · 12 sections');
  });

  it('says so when the library is empty', () => {
    expect(renderIndex([])).toContain('No documents yet.');
  });

  it('escapes a title that would break the link', () => {
    expect(renderIndex([{ ...a, title: 'Rates [draft]' }])).toContain('[Rates \\[draft\\]](billing/CONTENTS.md)');
  });
});

describe('a rendered document folder', () => {
  it('passes its own checks: every CONTENTS link and anchor resolves, and nothing else is there', () => {
    const md = `# Intro\n\nshort\n\n## Scope\n\n${para(300)}\n\n# Terms\n\n${para(1600)}\n\n# Long\n\n${para(4200)}`;
    const drafts = splitMarkdown(md, 'Doc').map((d) => ({ ...d, summary: `About ${d.title}` }));
    const out = join(dir, 'guide');
    const entries = renderDocFolder(out, { slug: 'guide', title: 'Guide', summary: 'A guide.', sourceLabel: 'guide.md' }, drafts);
    expect(validateDocFolder(out)).toEqual({ ok: true });
    expect(entries.map((e) => e.path)).toEqual(sectionFileNames(drafts.map((d) => d.title)).map((n) => `guide/sections/${n}`));
    const contents = readFileSync(join(out, 'CONTENTS.md'), 'utf8');
    expect(contents).toContain('(sections/01-intro.md) — About Intro');
    expect(contents).toContain('(sections/01-intro.md#scope)');
    const first = readFileSync(join(out, 'sections', '01-intro.md'), 'utf8');
    expect(first).toContain('[Contents](../CONTENTS.md)');
    expect(first).toContain('[Next](02-terms.md)');
  });

  it('refuses a broken link, a missing anchor, an unlisted file and a stray file', () => {
    const out = join(dir, 'doc');
    mkdirSync(join(out, 'sections'), { recursive: true });
    writeFileSync(join(out, 'sections', '01-a.md'), '# A\n\ntext\n');
    writeFileSync(join(out, 'sections', '02-b.md'), '# B\n\ntext\n');
    writeFileSync(join(out, 'notes.txt'), 'x');
    writeFileSync(join(out, 'CONTENTS.md'), '- [A](sections/01-a.md#nope)\n- [Gone](sections/09-gone.md)\n- [Out](../../etc/passwd)\n');
    const v = validateDocFolder(out);
    expect(v.ok).toBe(false);
    const problems = (v as { problems: string[] }).problems.join('\n');
    expect(problems).toMatch(/Unexpected file in the document folder: notes\.txt/);
    expect(problems).toMatch(/heading that does not exist: sections\/01-a\.md#nope/);
    expect(problems).toMatch(/does not exist: sections\/09-gone\.md/);
    expect(problems).toMatch(/does not exist: \.\.\/\.\.\/etc\/passwd/);
    expect(problems).toMatch(/sections\/02-b\.md is not in CONTENTS\.md/);
  });

  it('refuses a section over the size cap', () => {
    const out = join(dir, 'big');
    mkdirSync(join(out, 'sections'), { recursive: true });
    writeFileSync(join(out, 'sections', '01-a.md'), `# A\n\n${para(5000)}\n`);
    writeFileSync(join(out, 'CONTENTS.md'), '- [A](sections/01-a.md)\n');
    expect(JSON.stringify(validateDocFolder(out))).toMatch(/over the size cap/);
  });
});

describe('a PDF build’s written sections', () => {
  it('follow the recorded order and depths, split past the cap, and keep their summaries', () => {
    const files: Record<string, string> = {
      'b.md': `# Chapter 1\n\n${para(200)}`,
      'a.md': `# 1.1 Detail\n\n${para(4200)}`,
      'c.md': `# Chapter 2\n\n${para(50)}`,
    };
    const recorded = new Map([
      ['b.md', { title: 'Chapter 1', summary: 'one', depth: 1 }],
      ['a.md', { title: '1.1 Detail', summary: 'detail', depth: 2 }],
      ['c.md', { title: 'Chapter 2', summary: 'two', depth: 1 }],
    ]);
    const drafts = draftsFromWritten(['b.md', 'a.md', 'c.md'], recorded, (f) => files[f]!);
    expect(drafts[0]).toMatchObject({ title: 'Chapter 1', depth: 1, trail: [], summary: 'one' });
    expect(drafts[1]).toMatchObject({ depth: 2, trail: ['Chapter 1'], summary: 'detail' });
    expect(drafts[1]!.title).toMatch(/^1\.1 Detail \(part 1 of \d\)$/);
    expect(drafts[drafts.length - 1]).toMatchObject({ title: 'Chapter 2', depth: 1, trail: [] });
    const out = join(dir, 'pdf');
    renderDocFolder(out, { slug: 'pdf', title: 'PDF', summary: 's', sourceLabel: 'x.pdf' }, drafts);
    expect(validateDocFolder(out)).toEqual({ ok: true });
  });

  it('never lets a depth jump past one level below its parent', () => {
    const drafts = draftsFromWritten(['a.md'], new Map([['a.md', { title: 'Deep', summary: '', depth: 4 }]]), () => 'text');
    expect(drafts[0]!.depth).toBe(1);
  });
});
