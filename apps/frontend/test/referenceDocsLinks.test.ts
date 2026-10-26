// Activity → Docs: the link resolver, the contents-tree rows and the heading anchors.
//
// ⚠ EVERY LINK THE PANE FOLLOWS GOES THROUGH `resolveDocLink`. The library's files are written by
// the server with RELATIVE links (INDEX → `<slug>/CONTENTS.md`, CONTENTS → `sections/NN-x.md#a`, a
// section → `02-next.md` / `../CONTENTS.md`), and the chat cites from the library root. A resolver
// that joined paths wrongly would open the wrong file; one that let `..` past the root, or a
// percent-encoded path, through would hand the server a path its grammar refuses (a 400 on screen).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend referenceDocsLinks
import { describe, expect, it } from 'vitest';
import type { ReferenceDocSectionEntry } from '@pierre-review/shared';
import {
  citationLabel,
  docStageLabel,
  docTreeBranchKeys,
  docTreeNodes,
  docTreeRows,
  headingAnchor,
  headingAnchors,
  markHeadingAnchors,
  parseLibraryPath,
  resolveDocLink,
  uploadRefusal,
} from '../src/lib/referenceDocs.js';

const lib = (fromPath: string, href: string) => {
  const r = resolveDocLink(fromPath, href);
  return r.kind === 'library' ? `${r.location.path}${r.location.anchor != null ? `#${r.location.anchor}` : ''}` : r.kind;
};

describe('parseLibraryPath (the client copy of the server grammar)', () => {
  it('accepts the three levels and an anchor', () => {
    expect(parseLibraryPath('INDEX.md')).toMatchObject({ kind: 'index', slug: null, anchor: null });
    expect(parseLibraryPath('billing/CONTENTS.md')).toMatchObject({ kind: 'contents', slug: 'billing' });
    expect(parseLibraryPath('billing/sections/03-refunds.md#late-fees')).toMatchObject({
      kind: 'section',
      path: 'billing/sections/03-refunds.md',
      slug: 'billing',
      anchor: 'late-fees',
    });
  });

  it('refuses anything else', () => {
    for (const bad of ['', '../INDEX.md', '/INDEX.md', 'billing/notes.md', 'Billing/CONTENTS.md', 'billing/sections/x.md', 'a/b/c/d.md', 'billing/sections/03-a%2e.md']) {
      expect(parseLibraryPath(bad)).toBeNull();
    }
  });

  it('drops an anchor that is not a plain one, keeping the path', () => {
    expect(parseLibraryPath('billing/CONTENTS.md#<x>')).toMatchObject({ path: 'billing/CONTENTS.md', anchor: null });
  });
});

describe('resolveDocLink', () => {
  it('carries the quote its lookup names for the resolved path and anchor (a chat citation’s)', () => {
    const quoteFor = (path: string, anchor: string | null): string | null =>
      path === 'billing/sections/03-refunds.md' && anchor === 'fees' ? 'paid within fourteen days' : null;
    const hit = resolveDocLink('INDEX.md', 'billing/sections/03-refunds.md#fees', quoteFor);
    expect(hit).toMatchObject({ kind: 'library', quote: 'paid within fourteen days' });
    expect(resolveDocLink('INDEX.md', 'billing/sections/03-refunds.md', quoteFor)).toMatchObject({ quote: null });
    expect(resolveDocLink('INDEX.md', 'billing/sections/03-refunds.md#fees')).toMatchObject({ quote: null });
  });

  it('follows INDEX.md links to a document’s contents', () => {
    expect(lib('INDEX.md', 'billing/CONTENTS.md')).toBe('billing/CONTENTS.md');
  });

  it('follows CONTENTS.md links to sections and their headings', () => {
    expect(lib('billing/CONTENTS.md', 'sections/01-intro.md')).toBe('billing/sections/01-intro.md');
    expect(lib('billing/CONTENTS.md', 'sections/01-intro.md#scope')).toBe('billing/sections/01-intro.md#scope');
  });

  it('follows a section’s Previous / Contents / Next links', () => {
    const from = 'billing/sections/02-terms.md';
    expect(lib(from, '01-intro.md')).toBe('billing/sections/01-intro.md');
    expect(lib(from, '03-long.md')).toBe('billing/sections/03-long.md');
    expect(lib(from, '../CONTENTS.md')).toBe('billing/CONTENTS.md');
    expect(lib(from, '../../INDEX.md')).toBe('INDEX.md');
  });

  it('reads a chat answer’s citations from the library root', () => {
    expect(lib('INDEX.md', 'billing/sections/03-refunds.md#late-fees')).toBe('billing/sections/03-refunds.md#late-fees');
    expect(lib('INDEX.md', './billing/sections/03-refunds.md')).toBe('billing/sections/03-refunds.md');
    expect(lib('INDEX.md', '<billing/CONTENTS.md>')).toBe('billing/CONTENTS.md');
  });

  it('keeps a same-file anchor as an anchor', () => {
    expect(resolveDocLink('billing/sections/01-intro.md', '#scope')).toEqual({ kind: 'anchor', anchor: 'scope' });
    expect(resolveDocLink('billing/sections/01-intro.md', '#')).toEqual({ kind: 'none' });
  });

  it('hands an absolute URL back as external (the caller still runs safeExternalUrl)', () => {
    expect(resolveDocLink('INDEX.md', 'https://example.com/a')).toEqual({ kind: 'external', href: 'https://example.com/a' });
    expect(resolveDocLink('INDEX.md', 'javascript:alert(1)')).toEqual({ kind: 'external', href: 'javascript:alert(1)' });
  });

  it('refuses paths that escape the library or that the server grammar would refuse', () => {
    expect(lib('INDEX.md', '../secrets/CONTENTS.md')).toBe('none');
    expect(lib('billing/sections/01-intro.md', '../../../etc/passwd')).toBe('none');
    expect(lib('INDEX.md', '/billing/CONTENTS.md')).toBe('none');
    expect(lib('INDEX.md', '//evil.example/CONTENTS.md')).toBe('none');
    expect(lib('INDEX.md', 'billing%2FCONTENTS.md')).toBe('none');
    expect(lib('INDEX.md', 'billing/CONTENTS.md?x=1')).toBe('none');
    expect(lib('INDEX.md', 'billing\\CONTENTS.md')).toBe('none');
    expect(lib('INDEX.md', 'billing/sources/source.pdf')).toBe('none');
    expect(lib('INDEX.md', '')).toBe('none');
    expect(resolveDocLink('INDEX.md', undefined)).toEqual({ kind: 'none' });
  });
});

describe('heading anchors (match the server’s split.ts)', () => {
  it('slugs a heading and numbers duplicates', () => {
    expect(headingAnchor('Late fees & refunds')).toBe('late-fees-refunds');
    expect(headingAnchors(['Scope', 'Terms', 'Scope'])).toEqual(['scope', 'terms', 'scope-1']);
    expect(headingAnchor('概要')).toMatch(/^h-[a-z0-9]+$/);
  });

  it('marks each rendered heading with data-doc-anchor', () => {
    const h = (tag: string, text: string) => ({ type: 'element', tagName: tag, properties: {}, children: [{ type: 'text', value: text }] });
    const tree = {
      type: 'root',
      children: [h('h1', 'Intro'), { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'x' }] }, h('h2', 'Scope'), h('h2', 'Scope')],
    };
    markHeadingAnchors(tree);
    const anchors = tree.children.map((c) => (c as { properties?: { dataDocAnchor?: string } }).properties?.dataDocAnchor);
    expect(anchors).toEqual(['intro', undefined, 'scope', 'scope-1']);
  });
});

describe('docTreeRows (the same shape as CONTENTS.md)', () => {
  const entry = (over: Partial<ReferenceDocSectionEntry>): ReferenceDocSectionEntry => ({
    path: 'guide/sections/01-intro.md',
    title: 'Intro',
    summary: '',
    depth: 1,
    trail: [],
    headings: [],
    words: 100,
    ...over,
  });

  it('nests sections by depth, lists merged headings as anchors, and prints an enclosing heading once', () => {
    const rows = docTreeRows([
      entry({ summary: 'What it is.', headings: [{ title: 'Scope', depth: 2, anchor: 'scope' }] }),
      entry({ path: 'guide/sections/02-a.md', title: 'A', depth: 2, trail: ['Part one'] }),
      entry({ path: 'guide/sections/03-b.md', title: 'B', depth: 2, trail: ['Part one'] }),
    ]);
    expect(rows.map((r) => [r.kind, r.title, r.depth])).toEqual([
      ['section', 'Intro', 1],
      ['heading', 'Scope', 2],
      ['group', 'Part one', 1],
      ['section', 'A', 2],
      ['section', 'B', 2],
    ]);
    expect(rows[0]).toMatchObject({ path: 'guide/sections/01-intro.md', summary: 'What it is.' });
    expect(rows[1]).toMatchObject({ path: 'guide/sections/01-intro.md', anchor: 'scope' });
  });

  it('is empty for a document with no sections', () => {
    expect(docTreeRows([])).toEqual([]);
  });

  it('nests the rows into a tree whose top level is the chapters, and lists every branch for Expand all', () => {
    const nodes = docTreeNodes(
      docTreeRows([
        entry({ summary: 'What it is.', headings: [{ title: 'Scope', depth: 2, anchor: 'scope' }] }),
        entry({ path: 'guide/sections/02-a.md', title: 'A', depth: 2, trail: ['Part one'], headings: [{ title: 'Detail', depth: 3, anchor: 'detail' }] }),
        entry({ path: 'guide/sections/03-b.md', title: 'B', depth: 2, trail: ['Part one'] }),
        entry({ path: 'guide/sections/04-c.md', title: 'C', depth: 1 }),
      ]),
    );
    const shape = (ns: typeof nodes): unknown[] => ns.map((n) => (n.children.length ? [n.row.title, shape(n.children)] : n.row.title));
    expect(shape(nodes)).toEqual([['Intro', ['Scope']], ['Part one', [['A', ['Detail']], 'B']], 'C']);
    expect(docTreeBranchKeys(nodes)).toEqual(['s:guide/sections/01-intro.md', 'g:Part one', 's:guide/sections/02-a.md']);
    expect(docTreeNodes([])).toEqual([]);
  });
});

describe('labels', () => {
  it('names each build stage', () => {
    expect(docStageLabel('converting')).toBe('Converting');
    expect(docStageLabel('sectioning')).toBe('Splitting into sections');
    expect(docStageLabel('indexing')).toBe('Indexing');
  });

  it('names a citation by document and section', () => {
    const c = { path: 'b/sections/01-a.md', anchor: null, docSlug: 'b', docTitle: 'Billing', sectionTitle: 'Refunds' };
    expect(citationLabel(c)).toBe('Billing › Refunds');
    expect(citationLabel({ ...c, sectionTitle: null })).toBe('Billing');
  });

  it('refuses only what the client can be sure of', () => {
    expect(uploadRefusal('old.doc', 10, 100)).toBe('Save it as .docx first.');
    expect(uploadRefusal('empty.txt', 0, 100)).toBe('The file is empty.');
    expect(uploadRefusal('big.pdf', 200, 100)).toMatch(/over/);
    expect(uploadRefusal('notes.rst', 10, 100)).toBeNull();
    expect(uploadRefusal('spec.pdf', 10, 100)).toBeNull();
  });
});
