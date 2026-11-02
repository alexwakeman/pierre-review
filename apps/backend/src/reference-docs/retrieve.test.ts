// FULL-TEXT RETRIEVAL, the pure parts (docs/REFERENCE-DOCS.md § Retrieval). The DB half — FTS5, the
// triggers, tenancy, stale builds — is retrieve-db.test.ts. Pinned:
//   1. The chunker: paragraphs packed to ≤ CHUNK_WORDS, a long block cut, HTML and link targets out,
//      the prefix on every passage, the nearest heading's anchor.
//   2. The MATCH expression: untrusted text never carries FTS5 syntax.
//   3. Ranking: a section by its best passage, ties by path, the per-document cap that never leaves a
//      place empty.
//   4. The chat's search text and passage budget; the story-docs candidates keep only listed sections.
import { describe, expect, it } from 'vitest';
import type { ReferenceDocSectionEntry } from '@pierre-review/shared';
import { candidatesFromRetrieval } from '../review/story-docs/candidates.js';
import { chatPassagesOf, chatRetrievalQuery } from './chat.js';
import { CHUNK_WORDS, chunkDocument, chunkPrefix, chunkSection, plainText } from './chunks.js';
import { buildChatPrompt } from './prompts.js';
import { ftsMatchQuery, rankSections, retrievalTerms, type PassageHit } from './retrieve.js';

const para = (n: number, w = 'word'): string => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

describe('the chunker', () => {
  it('packs paragraphs to the word cap and cuts a long block', () => {
    const body = [para(100, 'a'), para(100, 'b'), para(100, 'c'), para(650, 'd')].join('\n\n');
    const out = chunkSection('P', body, 'Title');
    const counts = out.map((c) => c.text.replace(/^P\n\n/, '').split(/\s+/).length);
    // a+b fit (200), c starts a new one, d (650 > 300) is cut into 220-word pieces.
    expect(counts).toEqual([200, 100, 220, 220, 210]);
    expect(counts.every((n) => n <= CHUNK_WORDS)).toBe(true);
    expect(out.every((c) => c.text.startsWith('P\n\n'))).toBe(true);
  });

  it('indexes words, never markup or link targets', () => {
    expect(plainText('<table><tr><td>Very&nbsp;High</td><td>a &amp; b</td></tr></table>')).toBe('Very High a & b');
    expect(plainText('See [the rules](../x/sections/01-a.md#b) and <https://example.com/x>.')).toBe('See [the rules] and .');
  });

  it('carries the nearest heading anchor, numbered as the renderer numbers repeats', () => {
    const body = ['Intro text.', '## Refunds', para(250, 'r'), '## Notes', para(200, 'n'), '## Refunds', para(200, 'a')].join('\n\n');
    const out = chunkSection('P', body, 'Refund handbook');
    expect(out.map((c) => c.anchor)).toEqual([null, 'refunds', 'notes', 'refunds-1']);
  });

  it('prefixes the document, trail, section and summary, and numbers passages across the document', () => {
    const sec = (path: string, title: string): ReferenceDocSectionEntry => ({ path, title, summary: `About ${title}.`, depth: 1, trail: ['Part 1'], headings: [], words: 1 });
    const files: Record<string, string> = { 'h/sections/01-a.md': '<!-- limn reference section 1 of 2 -->\n# A\n\n> crumbs\n> nav\n\nalpha text', 'h/sections/02-b.md': 'beta text' };
    const out = chunkDocument('Handbook', [sec('h/sections/01-a.md', 'A'), sec('h/sections/02-b.md', 'B'), sec('h/sections/03-gone.md', 'C')], (p) => files[p] ?? null);
    expect(out.map((c) => [c.sectionPath, c.ordinal])).toEqual([['h/sections/01-a.md', 0], ['h/sections/02-b.md', 1]]);
    expect(out[0]!.text).toBe('Handbook › Part 1 › A\nAbout A.\n\nalpha text');
    expect(chunkPrefix('D', { title: 'S', trail: [], summary: '' })).toBe('D › S');
  });
});

describe('the MATCH expression', () => {
  it('quotes plain terms and OR-joins them; FTS5 syntax never survives', () => {
    expect(ftsMatchQuery('The "hedgerow" NEAR(condition*, 3) col:value AND NOT (x OR y) ^start')).toBe(
      '"hedgerow" OR "near" OR "condition" OR "col" OR "value" OR "start"',
    );
    expect(ftsMatchQuery('a an the -- ** ()')).toBe('');
    // Every term is letters/digits only, so a quote can never be closed early.
    for (const t of retrievalTerms('x"y "z" é-à 1234 Ünïcödé')) expect(t).toMatch(/^[\p{L}\p{N}]+$/u);
  });

  it('keeps the first terms of a very long text', () => {
    expect(retrievalTerms(para(500)).length).toBe(120);
  });
});

describe('ranking', () => {
  const hit = (sectionPath: string, docId: number, rank: number): PassageHit => ({ docId, docTitle: `D${docId}`, sectionPath, anchor: null, text: `${sectionPath}@${rank}`, rank });

  it('ranks a section by its best passage, ties by path', () => {
    const out = rankSections([hit('a/s/2.md', 1, -3), hit('a/s/1.md', 1, -5), hit('a/s/2.md', 1, -9), hit('a/s/0.md', 1, -5)], 10);
    expect(out.map((s) => [s.path, s.rank])).toEqual([['a/s/2.md', -9], ['a/s/0.md', -5], ['a/s/1.md', -5]]);
    expect(out[0]!.passage).toBe('a/s/2.md@-9');
  });

  it('caps one document when others match, and fills the places it would leave empty', () => {
    const hits = [hit('spec/1', 1, -10), hit('spec/2', 1, -9), hit('spec/3', 1, -8), hit('spec/4', 1, -7), hit('guide/1', 2, -1)];
    expect(rankSections(hits, 3, 2).map((s) => s.path)).toEqual(['spec/1', 'spec/2', 'guide/1']);
    expect(rankSections(hits, 4, 2).map((s) => s.path)).toEqual(['spec/1', 'spec/2', 'spec/3', 'guide/1']);
    // One document only: the cap does nothing.
    expect(rankSections(hits.slice(0, 4), 3, 1).map((s) => s.path)).toEqual(['spec/1', 'spec/2', 'spec/3']);
  });
});

describe('the chat', () => {
  it('searches with the previous question too', () => {
    expect(chatRetrievalQuery([], 'q2')).toBe('q2');
    expect(chatRetrievalQuery([{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }], 'and others?')).toBe('and others?\nq1');
  });

  it('keeps passages within the budget, best first, with the anchor in the link', () => {
    const f = (path: string, n: number, anchor: string | null = null) => ({ path, anchor, passage: 'x'.repeat(n) });
    expect(chatPassagesOf([f('a', 6, 'h'), f('b', 6), f('c', 3)], 10).map((p) => p.link)).toEqual(['a#h', 'c']);
  });

  it('the prompt is unchanged with no passages, and fences each one when there are', () => {
    expect(buildChatPrompt([], 'q?', 'N0', [])).toBe(buildChatPrompt([], 'q?', 'N0'));
    const p = buildChatPrompt([], 'q?', 'N0', [{ link: 'h/sections/01-a.md#b', text: 'alpha' }]);
    expect(p).toContain('---BEGIN PASSAGE 1 N0---\nh/sections/01-a.md#b\n\nalpha\n---END PASSAGE 1 N0---');
    expect(p.indexOf('PASSAGE 1')).toBeLessThan(p.indexOf('QUESTION'));
  });
});

describe('story-docs candidates', () => {
  it('keep only sections the shortlisted documents list, with their titles and summaries', () => {
    const docs = [{ title: 'Guide', sections: [{ path: 'g/sections/01-a.md', title: 'A', summary: 'sa' }] }];
    const found = [
      { path: 'g/sections/01-a.md', docId: 1, docTitle: 'Guide', anchor: null, passage: 'p', rank: -4 },
      { path: 'g/sections/09-gone.md', docId: 1, docTitle: 'Guide', anchor: null, passage: 'p', rank: -3 },
    ];
    expect(candidatesFromRetrieval(found, docs)).toEqual([{ path: 'g/sections/01-a.md', docTitle: 'Guide', title: 'A', summary: 'sa', score: 4 }]);
  });
});
