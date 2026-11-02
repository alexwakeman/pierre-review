import type { ReferenceDocSourceKind } from './reference-docs.js';
import type { WikiProviderId } from './reference-docs-wiki.js';

// SEARCH THE LIBRARY (docs/REFERENCE-DOCS.md § Search; docs/API.md § Reference docs).
// `GET /api/docs/search?workspace=&q=&sort=&page=` — DB only, over the same FTS5 index the chat and the
// story-docs check use. EVERY word must match (AND); `"quoted words"` match as a phrase; words are
// stemmed like the index ("refunds" finds "refund"). One result per SECTION, by its best passage.

export type DocsSearchSort = 'relevance' | 'newest';

/** Results per page. */
export const DOCS_SEARCH_PAGE_SIZE = 20;
/** The most sections one search counts; past it the total reads "2000+". */
export const DOCS_SEARCH_MAX_RESULTS = 2000;
/** The longest query text the route accepts. */
export const DOCS_SEARCH_MAX_QUERY_CHARS = 500;

/** One run of the quoted passage: plain text, matched (highlighted) or not. Never markup. */
export interface DocsSearchSnippetPart {
  text: string;
  match: boolean;
}

export interface DocsSearchResult {
  docId: number;
  docTitle: string;
  sourceKind: ReferenceDocSourceKind;
  /** The uploaded file's name, or the page's URL. */
  sourceName: string;
  sourceUrl: string | null;
  /** A wiki tree's provider (its name is the source label); null for every other source. */
  wikiProvider: WikiProviderId | null;
  /** When the document was added to the library (ISO-8601). */
  docAddedAt: string;
  /** Library-relative `<slug>/sections/NN-name.md`. */
  path: string;
  sectionTitle: string;
  /** The headings above the section, outermost first. */
  trail: string[];
  /** The best passage's nearest heading anchor; null = the section's top. */
  anchor: string | null;
  /** A short quote from the best passage, the matched words marked. */
  snippet: DocsSearchSnippetPart[];
  /** The words the search matched in that passage, lower-cased — the viewer highlights them. */
  matchedWords: string[];
}

export interface DocsSearchResponse {
  workspaceId: number;
  query: string;
  sort: DocsSearchSort;
  page: number;
  pageSize: number;
  /** Sections matched, at most DOCS_SEARCH_MAX_RESULTS. */
  total: number;
  /** True when more sections matched than were counted ("2000+"). */
  totalCapped: boolean;
  results: DocsSearchResult[];
  /** False when nothing in this workspace's library is indexed yet (an empty library, or one still building). */
  indexed: boolean;
}
