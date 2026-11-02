import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DOCS_SEARCH_MAX_RESULTS,
  DOCS_SEARCH_PAGE_SIZE,
  type DocsSearchResponse,
  type DocsSearchResult,
  type DocsSearchSnippetPart,
  type DocsSearchSort,
  type ReferenceDocSourceKind,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { STOPWORDS, workspaceIndexed } from './retrieve.js';

// SEARCH THE LIBRARY (docs/REFERENCE-DOCS.md § Search). The reader's search box, over the SAME FTS5
// index as `retrieve.ts` — whose OR-joined query (wide recall for a model) is NOT changed by this file.
//
//   • THE QUERY IS UNTRUSTED. FTS5 syntax never reaches MATCH raw: the text is cut into plain word
//     terms (letters and digits only), each one quoted (`searchClauses`). `"quoted words"` and a
//     hyphenated word ("co-change") become one quoted multi-word string — FTS5's phrase. Quoting does
//     not stop stemming: the porter tokenizer still stems inside the quotes.
//   • EVERY CLAUSE MUST MATCH THE SECTION, not one passage (`searchMatchPlan`): passages are found and
//     ranked by the OR of the clauses, then kept only where each clause matches some passage of the
//     same section. Most sections are several passages, so a passage-level AND missed real hits.
//   • Only passages of a document's CURRENT build count; account + workspace predicates on every row.
//   • One result per SECTION, by its best passage. At most DOCS_SEARCH_MAX_RESULTS sections are
//     counted; past that the total says so (`totalCapped`).
//   • RANKING (`orderSearchHits`, pure): relevance = bm25 (lower is better), and scores within
//     SEARCH_TIE (5%) of a run's best count as EQUAL — that run is ordered newest document first.
//     `newest` = the document's added date, newest first, then relevance.
//   • THE SNIPPET is built here from FTS5's `highlight()` (control-character markers), as plain text
//     runs flagged matched or not — the SPA renders them without HTML.

/** Scores within this share of a run's best are a tie, ordered by recency. */
export const SEARCH_TIE = 0.05;
/** The most clauses (words or phrases) sent to MATCH. */
export const SEARCH_MAX_CLAUSES = 32;
/** The snippet's length in words, and how many words of lead-in before the first match. */
export const SNIPPET_WORDS = 36;
const SNIPPET_LEAD = 8;

const OPEN = '\u0001';
const CLOSE = '\u0002';

/** Two-letter words too common to narrow a search (retrieve.ts's STOPWORDS are three letters and up). */
const SHORT_STOPWORDS = new Set('an as at be by do if in is it no of on or so to up us we'.split(' '));
const isStopword = (w: string): boolean => STOPWORDS.has(w) || SHORT_STOPWORDS.has(w);

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export interface SearchClauses {
  /** Each clause: one word, or the words of one phrase (matched in order, adjacent). */
  clauses: string[][];
}

/** The reader's text → clauses. Quoted runs are phrases; bare stopwords drop out unless nothing else is left. */
export function searchClauses(text: string): SearchClauses {
  const parts = text.split('"');
  // An unclosed quote: its text is read as bare words.
  const closed = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  const phrases: string[][] = [];
  const bare: string[][] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 1 && i < closed) {
      const w = wordsOf(part);
      if (w.length > 0) phrases.push(w);
      continue;
    }
    for (const token of part.split(/\s+/)) {
      const w = wordsOf(token);
      if (w.length === 0) continue;
      bare.push(w); // a hyphenated word stays one clause, matched as a phrase
    }
  }
  const meaningful = bare.filter((w) => w.length > 1 || (!isStopword(w[0]!) && (w[0]!.length > 1 || /\p{N}/u.test(w[0]!))));
  const all = [...phrases, ...(meaningful.length > 0 || phrases.length > 0 ? meaningful : bare)];
  const seen = new Set<string>();
  const clauses: string[][] = [];
  for (const c of all) {
    const key = c.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    clauses.push(c);
    if (clauses.length >= SEARCH_MAX_CLAUSES) break;
  }
  return { clauses };
}

const quoted = (c: readonly string[]): string => `"${c.join(' ')}"`;

/**
 * The MATCH expressions the search runs: `any` (every clause quoted, OR-joined) finds and ranks the
 * passages and marks their words; `each` (one per clause, only when there are two or more) proves a
 * SECTION has every clause somewhere — a section is cut into passages of ~220 words, so one passage
 * need not hold them all. '' / [] ⇒ nothing to search.
 */
export function searchMatchPlan(text: string): { any: string; each: string[] } {
  const { clauses } = searchClauses(text);
  return { any: clauses.map(quoted).join(' OR '), each: clauses.length > 1 ? clauses.map(quoted) : [] };
}

export interface SearchHit {
  docId: number;
  path: string;
  chunkId: number;
  /** bm25 of the section's best passage: LOWER is better. */
  rank: number;
  /** The document's added time (any monotonic number: larger = newer). */
  addedAt: number;
}

const byPath = (a: SearchHit, b: SearchHit): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.docId - b.docId);

/** Is `rank` within SEARCH_TIE of `best`? (bm25 is negative; compare magnitudes.) */
export function isTie(rank: number, best: number): boolean {
  return Math.abs(rank - best) <= SEARCH_TIE * Math.abs(best);
}

/** The hits in reading order. Pure and deterministic. */
export function orderSearchHits(hits: readonly SearchHit[], sort: DocsSearchSort): SearchHit[] {
  if (sort === 'newest') return [...hits].sort((a, b) => b.addedAt - a.addedAt || a.rank - b.rank || byPath(a, b));
  const ranked = [...hits].sort((a, b) => a.rank - b.rank || byPath(a, b));
  const out: SearchHit[] = [];
  let i = 0;
  while (i < ranked.length) {
    const best = ranked[i]!.rank;
    let j = i + 1;
    while (j < ranked.length && isTie(ranked[j]!.rank, best)) j++;
    out.push(...ranked.slice(i, j).sort((a, b) => b.addedAt - a.addedAt || a.rank - b.rank || byPath(a, b)));
    i = j;
  }
  return out;
}

/** `highlight()` output → the plain text and its marked ranges. Stray markers are dropped. */
export function parseHighlighted(marked: string): { text: string; ranges: Array<[number, number]> } {
  let text = '';
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (const ch of marked) {
    if (ch === OPEN) {
      if (start < 0) start = text.length;
    } else if (ch === CLOSE) {
      if (start >= 0 && text.length > start) ranges.push([start, text.length]);
      start = -1;
    } else text += ch;
  }
  return { text, ranges };
}

/**
 * Markdown's marks out of a passage, so a quote reads as text: emphasis, code ticks, backslash escapes,
 * link brackets, heading hashes, table rules; a table's cell walls become " · ". The highlight markers are control
 * characters none of these touch.
 */
export function plainSnippetText(s: string): string {
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/\*\*|__|`/g, '')
    // Single-star emphasis around words (`*no fixture*`); a lone star (`5 * 3`) stays.
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/\[([^\]\n]*)\]/g, '$1')
    .replace(/(^|\n)#{1,6}[ \t]+/g, '$1')
    .replace(/:?-{3,}:?/g, '')
    .replace(/\s*\|(?:\s*\|)*\s*/g, ' · ')
    .replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, '');
}

/**
 * The snippet of one passage: its body (the indexed prefix — document › trail › section and the
 * summary — left off), whitespace collapsed, cut to SNIPPET_WORDS words around the densest run of
 * matches, "…" where it was cut. Plus every matched word of the WHOLE passage, lower-cased.
 */
export function buildSnippet(highlighted: string): { snippet: DocsSearchSnippetPart[]; matchedWords: string[] } {
  const split = highlighted.indexOf('\n\n');
  const prefix = split >= 0 ? highlighted.slice(0, split) : '';
  const bodyMarked = plainSnippetText(split >= 0 ? highlighted.slice(split + 2) : highlighted).replace(/\s+/g, ' ').trim();
  const body = parseHighlighted(bodyMarked);
  const head = parseHighlighted(prefix);
  const matchedWords = [
    ...new Set([...head.ranges.map(([a, b]) => head.text.slice(a, b)), ...body.ranges.map(([a, b]) => body.text.slice(a, b))].map((w) => w.toLowerCase())),
  ];

  // Word spans of the body.
  const spans: Array<[number, number]> = [];
  for (const m of body.text.matchAll(/\S+/g)) spans.push([m.index, m.index + m[0].length]);
  const isMatch = spans.map(([a, b]) => body.ranges.some(([s, e]) => s < b && e > a));
  let from = 0;
  if (spans.length > SNIPPET_WORDS) {
    let bestCount = -1;
    for (let i = 0; i < spans.length; i++) {
      if (!isMatch[i]) continue;
      const s = Math.max(0, Math.min(i - SNIPPET_LEAD, spans.length - SNIPPET_WORDS));
      let n = 0;
      for (let k = s; k < s + SNIPPET_WORDS; k++) if (isMatch[k]) n++;
      if (n > bestCount) {
        bestCount = n;
        from = s;
      }
    }
  }
  const to = Math.min(spans.length, from + SNIPPET_WORDS);
  if (spans.length === 0) return { snippet: [], matchedWords };
  const startChar = spans[from]![0];
  const endChar = spans[to - 1]![1];
  const parts: DocsSearchSnippetPart[] = [];
  const push = (text: string, match: boolean): void => {
    if (text === '') return;
    const last = parts[parts.length - 1];
    if (last != null && last.match === match) last.text += text;
    else parts.push({ text, match });
  };
  if (from > 0) push('… ', false);
  let at = startChar;
  for (const [s0, e0] of body.ranges) {
    const s = Math.max(s0, startChar);
    const e = Math.min(e0, endChar);
    if (e <= s) continue;
    push(body.text.slice(at, s), false);
    push(body.text.slice(s, e), true);
    at = e;
  }
  push(body.text.slice(at, endChar), false);
  if (to < spans.length) push(' …', false);
  return { snippet: parts, matchedWords };
}

export interface SearchArgs {
  accountId: number;
  workspaceId: number;
  /** UNTRUSTED: the reader's search text. */
  query: string;
  sort: DocsSearchSort;
  /** 1-based. */
  page: number;
}

type HitRow = { docId: number; path: string; chunkId: number; rank: number; addedAt: number };

/** One page of results. DB only. */
export async function searchDocs(a: SearchArgs): Promise<DocsSearchResponse> {
  const { any: match, each } = searchMatchPlan(a.query);
  const page = Math.max(1, Math.floor(a.page));
  const base: DocsSearchResponse = {
    workspaceId: a.workspaceId,
    query: a.query,
    sort: a.sort,
    page,
    pageSize: DOCS_SEARCH_PAGE_SIZE,
    total: 0,
    totalCapped: false,
    results: [],
    indexed: true,
  };
  const c = schema.referenceDocChunks;
  const d = schema.referenceDocs;
  // Stage 1: every SECTION with a passage matching ANY clause, by its best such passage (bm25, then
  // reading order); then only the sections holding EVERY clause (stage 1b); at most one more than the
  // cap, so the total can say "more". FTS5's MATCH and bm25() have no query-builder form; every value
  // is a bound parameter.
  const anyRows: HitRow[] =
    match === ''
      ? []
      : await db.all<HitRow>(sql`
          select docId, path, chunkId, rank, addedAt from (
            select docId, path, chunkId, rank, addedAt,
                   row_number() over (partition by docId, path order by rank, ordinal) as rn
            from (
              select ${c.docId} as docId, ${c.sectionPath} as path, ${c.id} as chunkId, ${c.ordinal} as ordinal,
                     bm25(reference_doc_chunks_fts) as rank, ${d.createdAt} as addedAt
              from reference_doc_chunks_fts
              join ${c} on ${c.id} = reference_doc_chunks_fts.rowid
              join ${d} on ${d.id} = ${c.docId} and ${d.accountId} = ${c.accountId} and ${d.builtAt} = ${c.builtAt}
              where reference_doc_chunks_fts match ${match}
                and ${c.accountId} = ${a.accountId} and ${c.workspaceId} = ${a.workspaceId}
            )
          )
          where rn = 1
          order by rank, path`);
  // Stage 1b (two or more clauses): the sections where each clause matches some passage, intersected.
  let rows = anyRows;
  if (each.length > 0 && anyRows.length > 0) {
    let keep: Set<string> | null = null;
    for (const clause of each) {
      const secs = await db.all<{ docId: number; path: string }>(sql`
        select distinct ${c.docId} as docId, ${c.sectionPath} as path
        from reference_doc_chunks_fts
        join ${c} on ${c.id} = reference_doc_chunks_fts.rowid
        join ${d} on ${d.id} = ${c.docId} and ${d.accountId} = ${c.accountId} and ${d.builtAt} = ${c.builtAt}
        where reference_doc_chunks_fts match ${clause}
          and ${c.accountId} = ${a.accountId} and ${c.workspaceId} = ${a.workspaceId}`);
      const next = new Set<string>();
      for (const r of secs) {
        const key = `${r.docId}\u0000${r.path}`;
        if (keep == null || keep.has(key)) next.add(key);
      }
      keep = next;
      if (keep.size === 0) break;
    }
    rows = anyRows.filter((r) => keep?.has(`${r.docId}\u0000${r.path}`) === true);
  }
  rows = rows.slice(0, DOCS_SEARCH_MAX_RESULTS + 1);
  if (rows.length === 0) return { ...base, indexed: await workspaceIndexed(a.accountId, a.workspaceId) };
  const totalCapped = rows.length > DOCS_SEARCH_MAX_RESULTS;
  const hits = orderSearchHits(rows.slice(0, DOCS_SEARCH_MAX_RESULTS), a.sort);
  const pageHits = hits.slice((page - 1) * DOCS_SEARCH_PAGE_SIZE, page * DOCS_SEARCH_PAGE_SIZE);
  const out: DocsSearchResponse = { ...base, total: hits.length, totalCapped };
  if (pageHits.length === 0) return out;

  // Stage 2: the page's passages, highlighted, and their documents.
  const ids = pageHits.map((h) => h.chunkId);
  const marked = await db.all<{ id: number; anchor: string | null; hl: string }>(sql`
    select ${c.id} as id, ${c.anchor} as anchor, highlight(reference_doc_chunks_fts, 0, ${OPEN}, ${CLOSE}) as hl
    from reference_doc_chunks_fts
    join ${c} on ${c.id} = reference_doc_chunks_fts.rowid
    where reference_doc_chunks_fts match ${match}
      and ${c.accountId} = ${a.accountId} and ${c.workspaceId} = ${a.workspaceId}
      and ${c.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  const byChunk = new Map(marked.map((m) => [m.id, m]));
  const docIds = [...new Set(pageHits.map((h) => h.docId))];
  const docs = await db
    .select({
      id: d.id,
      title: d.title,
      sourceKind: d.sourceKind,
      sourceName: d.sourceName,
      sourceUrl: d.sourceUrl,
      wiki: d.wiki,
      createdAt: d.createdAt,
      sections: d.sections,
    })
    .from(d)
    .where(and(eq(d.accountId, a.accountId), eq(d.workspaceId, a.workspaceId), inArray(d.id, docIds)))
    .execute();
  const byDoc = new Map(docs.map((r) => [r.id, r]));
  const results: DocsSearchResult[] = [];
  for (const h of pageHits) {
    const doc = byDoc.get(h.docId);
    const m = byChunk.get(h.chunkId);
    if (doc == null || m == null) continue;
    const sec = (doc.sections ?? []).find((s) => s.path === h.path);
    const { snippet, matchedWords } = buildSnippet(m.hl);
    results.push({
      docId: doc.id,
      docTitle: doc.title,
      sourceKind: doc.sourceKind as ReferenceDocSourceKind,
      sourceName: doc.sourceName,
      sourceUrl: doc.sourceUrl,
      wikiProvider: doc.wiki?.provider ?? null,
      docAddedAt: doc.createdAt.toISOString(),
      path: h.path,
      sectionTitle: sec?.title ?? doc.title,
      trail: sec?.trail ?? [],
      anchor: m.anchor,
      snippet,
      matchedWords,
    });
  }
  return { ...out, results };
}
