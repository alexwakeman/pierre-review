import { WIKI_PROVIDER_NAMES, type ReferenceDocSourceKind, type WikiProviderId } from '@pierre-review/shared';

// THE LIBRARY SEARCH, the SPA's pure half (docs/REFERENCE-DOCS.md § Search): the words on a result,
// and the fold that finds the matched words in an opened section (DocsViewer paints them).

/** A document's source, in a word or two. */
export const DOC_SOURCE_LABEL: Record<ReferenceDocSourceKind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  text: 'Text',
  markdown: 'Markdown',
  html: 'Web page',
  url: 'Web page',
  wiki: 'Wiki',
};

/** The source label: a wiki tree's own name (Confluence, Notion, GitHub), else the file kind. */
export function docSourceLabel(kind: ReferenceDocSourceKind, wikiProvider: WikiProviderId | null): string {
  return wikiProvider != null ? WIKI_PROVIDER_NAMES[wikiProvider] : DOC_SOURCE_LABEL[kind];
}

/** "1 result", "142 results", "2000+ results". */
export function resultCountWords(total: number, capped: boolean): string {
  if (capped) return `${total}+ results`;
  return `${total} result${total === 1 ? '' : 's'}`;
}

export interface TermRange {
  /** Index into the text runs. */
  seg: number;
  start: number;
  end: number;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every whole-word, case-insensitive occurrence of any of `words` in the text runs from `from` on.
 * `words` are the server's matched words (letters and digits); anything else in one is escaped.
 */
export function findTermRanges(texts: readonly string[], words: readonly string[], from = 0): TermRange[] {
  const clean = [...new Set(words.map((w) => w.trim()).filter((w) => w !== ''))];
  if (clean.length === 0) return [];
  // Longest first, so "refunds" wins over "refund" at the same place.
  clean.sort((a, b) => b.length - a.length);
  // A phrase's words may be split by any whitespace in the rendered text (a wrapped line).
  const alt = clean.map((w) => w.split(/\s+/).map(escapeRegExp).join('\\s+')).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');
  const out: TermRange[] = [];
  for (let i = Math.max(0, from); i < texts.length; i++) {
    for (const m of texts[i]!.matchAll(re)) out.push({ seg: i, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export type TermsOutcome = 'painted' | 'found' | 'missing';

/** The line above the section after a search result opened it. */
export function termsStripText(outcome: TermsOutcome): string {
  if (outcome === 'painted') return 'Your search words are highlighted.';
  if (outcome === 'found') return 'Scrolled to your search words.';
  return 'Your search words are not in this section any more.';
}
