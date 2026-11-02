import { describe, expect, it } from 'vitest';
import { DOCS_OFFER_BYTES_PER_WORD, DOCS_OFFER_MIN_WORDS, DOCS_OFFER_RESCAN_DAYS, REFERENCE_DOC_WIKI_MAX_PAGES } from '@pierre-review/shared';
import { estimateWords, offerScanDue, qualifyingDocFolders } from './repo-offers.js';
import { foldersOverlap, inLibrary } from './repo-offers-store.js';
import type { RepoTree, RepoTreeEntry } from './wiki/github.js';

// THE QUALIFYING RULE (docs/REFERENCE-DOCS.md § Docs offered from your repositories). Pure: a tree in,
// the folders worth offering out. No file is read — words come from the tree's sizes.

let n = 0;
const sha = (): string => (n++).toString(16).padStart(40, '0');
/** Enough bytes for `words` words at the estimate's rate. */
const bytesFor = (words: number): number => words * DOCS_OFFER_BYTES_PER_WORD;
const file = (path: string, words = 800): RepoTreeEntry => ({ path, type: 'blob', sha: sha(), size: bytesFor(words) });
const tree = (...entries: RepoTreeEntry[]): RepoTree => ({ entries, truncated: false });

describe('qualifyingDocFolders', () => {
  it('offers a docs-style folder with three documents and enough words', () => {
    const got = qualifyingDocFolders(tree(file('docs/a.md'), file('docs/b.md'), file('docs/c.md'), file('src/index.ts')));
    expect(got).toEqual([{ path: 'docs', docs: 3, words: 2400, pages: 4, tooLarge: false }]);
  });

  it('never offers a README alone, nor a folder of READMEs only', () => {
    expect(qualifyingDocFolders(tree(file('docs/README.md', 5000)))).toEqual([]);
    expect(qualifyingDocFolders(tree(file('docs/README.md'), file('docs/a/README.md'), file('docs/b/index.md')))).toEqual([]);
    // The repository's own README never makes the top folder an offer.
    expect(qualifyingDocFolders(tree(file('README.md', 9000), file('CONTRIBUTING.md', 9000), file('SECURITY.md', 9000)))).toEqual([]);
  });

  it('refuses a small folder: too few documents, or too few words', () => {
    expect(qualifyingDocFolders(tree(file('docs/a.md', 2000), file('docs/b.md', 2000)))).toEqual([]);
    const thin = Math.floor(DOCS_OFFER_MIN_WORDS / 3) - 10;
    expect(qualifyingDocFolders(tree(file('docs/a.md', thin), file('docs/b.md', thin), file('docs/c.md', thin)))).toEqual([]);
  });

  it('offers the outer folder only: a qualifying folder inside one is not offered separately', () => {
    const got = qualifyingDocFolders(
      tree(file('docs/a.md'), file('docs/adr/0001.md'), file('docs/adr/0002.md'), file('docs/adr/0003.md'), file('docs/guide/x.md')),
    );
    expect(got.map((g) => g.path)).toEqual(['docs']);
    expect(got[0]!.docs).toBe(5);
    // pages: docs, a.md, adr/, its three, guide/, x.md
    expect(got[0]!.pages).toBe(1 + 1 + 1 + 3 + 1 + 1);
  });

  it('finds a docs-style folder at any depth, and two of them side by side', () => {
    const got = qualifyingDocFolders(
      tree(
        file('packages/api/docs/a.md'),
        file('packages/api/docs/b.md'),
        file('packages/api/docs/c.md'),
        file('handbook/one.md'),
        file('handbook/two.md'),
        file('handbook/three.md'),
      ),
    );
    expect(got.map((g) => g.path)).toEqual(['handbook', 'packages/api/docs']);
  });

  it('offers any folder holding five documents directly, but not four', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((x) => file(`guides/${x}.md`, 400));
    expect(qualifyingDocFolders(tree(...five)).map((g) => g.path)).toEqual(['guides']);
    expect(qualifyingDocFolders(tree(...five.slice(0, 4)))).toEqual([]);
    // Five spread over sub-folders is not "directly".
    expect(qualifyingDocFolders(tree(file('notes/a/x.md'), file('notes/a/y.md'), file('notes/b/x.md'), file('notes/b/y.md'), file('notes/c/x.md')))).toEqual([]);
  });

  it('marks a folder past one document’s page limit as too large (still offered, never added)', () => {
    const many = Array.from({ length: REFERENCE_DOC_WIKI_MAX_PAGES + 5 }, (_, i) => file(`docs/p${i}.md`, 100));
    const [got] = qualifyingDocFolders(tree(...many));
    expect(got?.path).toBe('docs');
    expect(got?.tooLarge).toBe(true);
  });

  it('reads only text documents outside vendored and dot folders', () => {
    expect(qualifyingDocFolders(tree(file('node_modules/x/docs/a.md'), file('node_modules/x/docs/b.md'), file('node_modules/x/docs/c.md')))).toEqual([]);
    expect(qualifyingDocFolders(tree(file('.github/docs/a.md'), file('.github/docs/b.md'), file('.github/docs/c.md')))).toEqual([]);
    expect(qualifyingDocFolders(tree(file('docs/a.png', 9000), file('docs/b.ts', 9000), file('docs/c.md')))).toEqual([]);
  });
});

describe('the rest of the rule', () => {
  it('estimates words from bytes', () => {
    expect(estimateWords(6000)).toBe(1000);
  });

  it('looks again only after the rescan interval', () => {
    const now = Date.now();
    expect(offerScanDue(null, now)).toBe(true);
    expect(offerScanDue(new Date(now - 3600_000), now)).toBe(false);
    expect(offerScanDue(new Date(now - DOCS_OFFER_RESCAN_DAYS * 86_400_000), now)).toBe(true);
  });

  it('treats a folder as in the library when it, a folder holding it, or one inside it was added', () => {
    expect(foldersOverlap('docs', 'docs')).toBe(true);
    expect(foldersOverlap('docs', 'docs/adr')).toBe(true);
    expect(foldersOverlap('docs/adr', 'docs')).toBe(true);
    expect(foldersOverlap('', 'docs')).toBe(true);
    expect(foldersOverlap('docs', 'docsite')).toBe(false);
    const lib = [{ repo: 'acme/api', path: 'docs/adr' }];
    expect(inLibrary('Acme/API', 'docs', lib)).toBe(true);
    expect(inLibrary('acme/web', 'docs', lib)).toBe(false);
    expect(inLibrary('acme/api', 'handbook', lib)).toBe(false);
  });
});
