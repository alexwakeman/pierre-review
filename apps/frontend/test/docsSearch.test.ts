// Library → Search (docs/REFERENCE-DOCS.md § Search): the link round-trips through the REAL
// serializer (`?activityRepo=docs-search&docsQ=&docsSort=&docsPage=`), the store's page rule, the
// sidebar entry's gate, and the pure helpers (the in-document word fold, the count words).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend docsSearch
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters, type FilterState } from '../src/store/filters.js';
import { usePinnedTabs } from '../src/store/pinnedTabs.js';
import { useDocsView } from '../src/store/docsView.js';
import { docSourceLabel, findTermRanges, resultCountWords } from '../src/lib/docsSearch.js';
import { DESTINATIONS, currentLocation, shownDestinations } from '../src/components/shell/nav.js';

const location = { pathname: '/app/', search: '' };
(globalThis as unknown as { window: unknown }).window = {
  location,
  history: {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      const [path, qs] = String(url).split('?');
      location.pathname = path ?? '/app/';
      location.search = qs ? `?${qs}` : '';
    },
    pushState: (_state: unknown, _title: string, url: string): void => {
      const [path, qs] = String(url).split('?');
      location.pathname = path ?? '/app/';
      location.search = qs ? `?${qs}` : '';
    },
  },
};

const { readFromUrl, writeToUrl } = await import('../src/hooks/useUrlState.js');
const state = (over: Partial<FilterState>): FilterState => ({ ...useFilters.getState(), ...over });

describe('the search link', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    useFilters.setState({ docsSearch: { q: '', sort: 'relevance', page: 1 } });
    location.pathname = '/app/';
    location.search = '';
    usePinnedTabs.setState({ activeTab: 'activity' });
  });

  it('round-trips the text, sort and page', () => {
    writeToUrl(state({ activityRepoId: 'docs-search', docsSearch: { q: '"net gain" hedgerow', sort: 'newest', page: 3 } }));
    expect(location.search).toContain('activityRepo=docs-search');
    const back = readFromUrl();
    expect(back.activityRepoId).toBe('docs-search');
    expect(back.docsSearch).toEqual({ q: '"net gain" hedgerow', sort: 'newest', page: 3 });
  });

  it('omits the defaults, and reads junk as the defaults', () => {
    writeToUrl(state({ activityRepoId: 'docs-search', docsSearch: { q: 'habitat', sort: 'relevance', page: 1 } }));
    expect(location.search).toContain('docsQ=habitat');
    expect(location.search).not.toContain('docsSort');
    expect(location.search).not.toContain('docsPage');
    location.search = '?activityRepo=docs-search&docsSort=evil&docsPage=-4';
    expect(readFromUrl().docsSearch).toEqual({ q: '', sort: 'relevance', page: 1 });
    // A padded text is read trimmed, so the box's own trimmed write does not reset the page.
    location.search = '?activityRepo=docs-search&docsQ=%20habitat%20&docsPage=2';
    expect(readFromUrl().docsSearch).toEqual({ q: 'habitat', sort: 'relevance', page: 2 });
    location.search = '?activityRepo=docs-search&docsPage=9999';
    expect(readFromUrl().docsSearch?.page).toBe(1);
  });

  it('emits the search keys only while Search is on screen', () => {
    writeToUrl(state({ activityRepoId: 'docs', docsSearch: { q: 'habitat', sort: 'newest', page: 2 } }));
    for (const k of ['docsQ', 'docsSort', 'docsPage']) expect(location.search).not.toContain(k);
  });

  it('a new text or sort goes back to page 1; a page alone keeps the text', () => {
    const f = useFilters.getState();
    f.setDocsSearch({ q: 'habitat' });
    f.setDocsSearch({ page: 4 });
    expect(useFilters.getState().docsSearch).toEqual({ q: 'habitat', sort: 'relevance', page: 4 });
    f.setDocsSearch({ sort: 'newest' });
    expect(useFilters.getState().docsSearch.page).toBe(1);
    f.setDocsSearch({ page: 2 });
    f.setDocsSearch({ q: 'hedgerow' });
    expect(useFilters.getState().docsSearch).toEqual({ q: 'hedgerow', sort: 'newest', page: 1 });
  });
});

describe('the sidebar entry', () => {
  it('sits directly above Docs under Library, and only where AI runs', () => {
    const library = DESTINATIONS.filter((d) => d.group === 'library').map((d) => d.id);
    expect(library.slice(0, 2)).toEqual(['docs-search', 'docs']);
    expect(shownDestinations({ aiOn: false, features: undefined }).some((d) => d.id === 'docs-search')).toBe(false);
    expect(shownDestinations({ aiOn: true, features: undefined }).some((d) => d.id === 'docs-search')).toBe(true);
    expect(currentLocation('activity', [], 'docs-search')).toBe('docs-search');
  });
});

describe('opening a result', () => {
  it('carries the words into the Docs open, and any later open drops them', () => {
    const v = useDocsView.getState();
    v.openPath(1, 'g/sections/01-a.md', 'h', null, true, ['hedgerow']);
    expect(useDocsView.getState().open[1]?.terms).toEqual(['hedgerow']);
    v.openPath(1, 'g/sections/02-b.md', null);
    expect(useDocsView.getState().open[1]?.terms).toBeUndefined();
    // A quote wins: the two are never set together.
    v.openPath(1, 'g/sections/01-a.md', null, 'quoted words', false, ['hedgerow']);
    expect(useDocsView.getState().open[1]?.terms).toBeUndefined();
  });
});

describe('findTermRanges', () => {
  it('finds whole words, any case, from the body on', () => {
    const texts = ['Hedgerows header', 'A hedgerow, then HEDGEROWS and hedgerowing.', 'no match'];
    expect(findTermRanges(texts, ['hedgerow', 'hedgerows'], 1)).toEqual([
      { seg: 1, start: 2, end: 10 },
      { seg: 1, start: 17, end: 26 },
    ]);
    expect(findTermRanges(texts, [])).toEqual([]);
    // Regex characters in a word are literal.
    expect(findTermRanges(['a.b axb'], ['a.b'])).toEqual([{ seg: 0, start: 0, end: 3 }]);
    // A phrase matches across a line break in the rendered text.
    expect(findTermRanges(['biodiversity net\n gain here'], ['net gain'])).toEqual([{ seg: 0, start: 13, end: 22 }]);
  });
});

describe('words', () => {
  it('counts and sources', () => {
    expect(resultCountWords(1, false)).toBe('1 result');
    expect(resultCountWords(142, false)).toBe('142 results');
    expect(resultCountWords(2000, true)).toBe('2000+ results');
    expect(docSourceLabel('docx', null)).toBe('Word');
    expect(docSourceLabel('wiki', 'confluence')).toBe('Confluence');
  });
});
