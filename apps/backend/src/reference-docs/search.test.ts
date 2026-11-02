// The library search's pure half (docs/REFERENCE-DOCS.md § Search): the query grammar, the ranking
// with its 5% tie rule, and the snippet. The DB half is search-db.test.ts.
import { describe, expect, it } from 'vitest';
import { buildSnippet, plainSnippetText, isTie, orderSearchHits, parseHighlighted, searchClauses, searchMatchPlan, type SearchHit } from './search.js';

/** The clauses every section must hold, written as one AND expression (the plan's `each`, or its one clause). */
const searchMatchQuery = (text: string): string => {
  const plan = searchMatchPlan(text);
  return plan.each.length > 0 ? plan.each.join(' AND ') : plan.any;
};

describe('searchMatchPlan', () => {
  it('finds passages by ANY clause and checks EACH clause per section', () => {
    expect(searchMatchPlan('"net gain" hedgerow')).toEqual({ any: '"net gain" OR "hedgerow"', each: ['"net gain"', '"hedgerow"'] });
    expect(searchMatchPlan('hedgerow')).toEqual({ any: '"hedgerow"', each: [] });
    expect(searchMatchPlan('  ')).toEqual({ any: '', each: [] });
  });
});

describe('searchMatchQuery', () => {
  it('AND-joins quoted words and keeps quoted runs as phrases', () => {
    expect(searchMatchQuery('Refund policy')).toBe('"refund" AND "policy"');
    expect(searchMatchQuery('"net gain" hedgerow')).toBe('"net gain" AND "hedgerow"');
    expect(searchMatchQuery('co-change index')).toBe('"co change" AND "index"');
  });

  it('never lets FTS5 syntax through', () => {
    for (const evil of ['"); drop table x; --', 'a OR b NOT c', 'title:x*', 'NEAR(a b)', '^start', '{text}: x', '"unclosed phrase']) {
      const m = searchMatchQuery(evil);
      // Only quoted runs of letters, digits and spaces, joined by AND.
      expect(m === '' || /^"[\p{L}\p{N} ]+"( AND "[\p{L}\p{N} ]+")*$/u.test(m)).toBe(true);
    }
    expect(searchMatchQuery('refund OR invoice')).toBe('"refund" AND "invoice"');
    expect(searchMatchQuery('"unclosed phrase')).toBe('"unclosed" AND "phrase"');
  });

  it('drops stopwords, unless nothing else is left; empty text searches nothing', () => {
    expect(searchMatchQuery('the habitat of a site')).toBe('"habitat" AND "site"');
    expect(searchMatchQuery('the')).toBe('"the"');
    expect(searchMatchQuery('   ')).toBe('');
    expect(searchMatchQuery('"" ""')).toBe('');
    // A phrase keeps its stopwords: it is matched word for word.
    expect(searchMatchQuery('"the rules of trading"')).toBe('"the rules of trading"');
    expect(searchMatchQuery('v2 5')).toBe('"v2" AND "5"');
  });

  it('removes repeats and caps the clause count', () => {
    expect(searchClauses('hedgerow Hedgerow HEDGEROW').clauses).toEqual([['hedgerow']]);
    const many = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    expect(searchClauses(many).clauses).toHaveLength(32);
  });
});

const hit = (path: string, rank: number, addedAt: number, docId = 1): SearchHit => ({ docId, path, chunkId: 0, rank, addedAt });

describe('orderSearchHits', () => {
  it('relevance: best bm25 first; scores within 5% are a tie, ordered newest first', () => {
    const hits = [hit('a', -10, 1), hit('b', -9.6, 3), hit('c', -9.4, 2), hit('d', -5, 9)];
    // -9.6 is within 5% of -10 (0.4 ≤ 0.5): tied, and newer → first. -9.4 is not (0.6 > 0.5): next run.
    expect(orderSearchHits(hits, 'relevance').map((h) => h.path)).toEqual(['b', 'a', 'c', 'd']);
    expect(isTie(-9.5, -10)).toBe(true);
    expect(isTie(-9.49, -10)).toBe(false);
  });

  it('a run is measured from its own best, never chained', () => {
    // -9.6 ties -10; -9.2 ties -9.6 but not -10, so it starts the next run.
    const hits = [hit('a', -10, 1), hit('b', -9.6, 1), hit('c', -9.2, 5)];
    expect(orderSearchHits(hits, 'relevance').map((h) => h.path)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic on a full tie (path), and newest sorts by date then relevance', () => {
    expect(orderSearchHits([hit('z', -1, 1), hit('a', -1, 1)], 'relevance').map((h) => h.path)).toEqual(['a', 'z']);
    const hits = [hit('old-best', -10, 1), hit('new-weak', -1, 5), hit('new-strong', -4, 5)];
    expect(orderSearchHits(hits, 'newest').map((h) => h.path)).toEqual(['new-strong', 'new-weak', 'old-best']);
  });
});

describe('buildSnippet', () => {
  it('leaves off the indexed prefix and marks the matches as plain runs', () => {
    const hl = 'Guide › \u0001Hedgerows\u0002\nHow they score.\n\nA \u0001hedgerow\u0002 lost on site is replaced.';
    const r = buildSnippet(hl);
    expect(r.snippet).toEqual([
      { text: 'A ', match: false },
      { text: 'hedgerow', match: true },
      { text: ' lost on site is replaced.', match: false },
    ]);
    expect(r.matchedWords).toEqual(['hedgerows', 'hedgerow']);
  });

  it('cuts a long passage around the densest matches, with ellipses', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    words[60] = '\u0001refund\u0002';
    words[62] = '\u0001refunds\u0002';
    const r = buildSnippet(`P\n\n${words.join(' ')}`);
    const text = r.snippet.map((p) => p.text).join('');
    expect(text.startsWith('… w52 ')).toBe(true);
    expect(text.endsWith(' …')).toBe(true);
    expect(r.snippet.filter((p) => p.match).map((p) => p.text)).toEqual(['refund', 'refunds']);
  });

  it('reads markdown as text: no emphasis, ticks, escapes or table walls', () => {
    expect(plainSnippetText('| `ref` | **bold** \\+ x |\n| --- | --- |\n| a | b |')).toBe('ref · bold + x · a · b');
    expect(plainSnippetText('## Heading\nText')).toBe('Heading\nText');
    expect(plainSnippetText('[Find out more] about it')).toBe('Find out more about it');
    expect(plainSnippetText('GPKG_X — *no geopackage fixture* (*a*), 5 * 3')).toBe('GPKG_X — no geopackage fixture (a), 5 * 3');
  });

  it('drops stray markers', () => {
    expect(parseHighlighted('a\u0002b\u0001c')).toEqual({ text: 'abc', ranges: [] });
  });
});
