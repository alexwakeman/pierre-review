import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

// RETRIEVAL OVER THE LIBRARY (docs/REFERENCE-DOCS.md § Retrieval; docs/DOCS-RAG.md). SQLite FTS5 over
// the passages chunks.ts writes, ranked by `bm25()`; a SECTION ranks by its best passage. It decides
// only WHAT a model reads first — never evidence: every reference is still checked against the text.
//
//   • THE QUERY IS UNTRUSTED (a story, a question). FTS5 syntax never reaches MATCH raw: the text is cut
//     into plain word terms, each one quoted, OR-joined (`ftsMatchQuery`).
//   • Only passages of a document's CURRENT build count (their `built_at` = the document's).
//   • `perDocCap` keeps one document from filling a short list when others match too (a story's own
//     spec in the library otherwise crowds out the reference it should be checked against); places it
//     would leave empty are filled in rank order.
//   • null ⇒ the workspace has no passages at all (a library built before this, until the boot backfill
//     reaches it): the caller falls back to what it did before. [] ⇒ indexed, and nothing matched.

/** The most passages read per query before grouping by section. */
export const RETRIEVE_PASSAGES = 200;
/** The most query terms sent to MATCH (a long story keeps its first ones). */
export const RETRIEVE_MAX_TERMS = 120;

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'the and for are but not you all any can had her was one our out has have him his how its may new now ' +
    'old see two way who did get let put say she too use that with this from they will would there their ' +
    'what about which when make like than then them these some into more other only also could should ' +
    'each must been were being does done such very just over under after before where while your ' +
    'able need needs given shall'
  ).split(' '),
);

/** Lower-cased word terms of the text (letters/digits, ≥ 3 characters, no stopwords), first seen first. */
export function retrievalTerms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
    if (out.size >= RETRIEVE_MAX_TERMS) break;
  }
  return [...out];
}

/** The FTS5 MATCH expression for untrusted text: quoted plain terms, OR-joined. '' ⇒ nothing to search. */
export function ftsMatchQuery(text: string): string {
  return retrievalTerms(text)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

export interface RetrievedSection {
  /** Library-relative `<slug>/sections/NN-name.md`. */
  path: string;
  docId: number;
  docTitle: string;
  /** The best passage's nearest heading anchor (null = the section's top). */
  anchor: string | null;
  /** The best passage, as indexed (prefix + text). */
  passage: string;
  /** FTS5 `bm25()` of the best passage: LOWER is better. */
  rank: number;
}

export interface PassageHit {
  docId: number;
  docTitle: string;
  sectionPath: string;
  anchor: string | null;
  text: string;
  rank: number;
}

/** Ranked passages → ranked sections (each by its best passage), the cap applied, at most k. Pure. */
export function rankSections(hits: readonly PassageHit[], k: number, perDocCap?: number): RetrievedSection[] {
  const best = new Map<string, RetrievedSection>();
  for (const h of hits) {
    const prev = best.get(h.sectionPath);
    if (prev == null || h.rank < prev.rank) {
      best.set(h.sectionPath, { path: h.sectionPath, docId: h.docId, docTitle: h.docTitle, anchor: h.anchor, passage: h.text, rank: h.rank });
    }
  }
  const ranked = [...best.values()].sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const limit = Math.max(0, k);
  if (perDocCap == null || new Set(ranked.map((s) => s.docId)).size < 2) return ranked.slice(0, limit);
  const out: RetrievedSection[] = [];
  const held: RetrievedSection[] = [];
  const perDoc = new Map<number, number>();
  for (const s of ranked) {
    if (out.length >= limit) break;
    const n = perDoc.get(s.docId) ?? 0;
    if (n < perDocCap) {
      out.push(s);
      perDoc.set(s.docId, n + 1);
    } else held.push(s);
  }
  // Never leave a place empty for the cap's sake: the held ones fill it, in rank order.
  for (const s of held) if (out.length < limit) out.push(s);
  return out.sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Does the workspace have any passage of a current build? */
export async function workspaceIndexed(accountId: number, workspaceId: number): Promise<boolean> {
  const c = schema.referenceDocChunks;
  const d = schema.referenceDocs;
  const rows = await db
    .select({ id: c.id })
    .from(c)
    .innerJoin(d, and(eq(d.id, c.docId), eq(d.accountId, c.accountId), eq(d.builtAt, c.builtAt)))
    .where(and(eq(c.accountId, accountId), eq(c.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

export interface RetrieveArgs {
  accountId: number;
  workspaceId: number;
  /** UNTRUSTED free text: a story, a question. */
  query: string;
  k: number;
  perDocCap?: number;
}

/** The sections of the workspace's library that best match the query; null ⇒ nothing indexed yet. */
export async function retrieveSections(a: RetrieveArgs): Promise<RetrievedSection[] | null> {
  const match = ftsMatchQuery(a.query);
  const c = schema.referenceDocChunks;
  const d = schema.referenceDocs;
  const hits: PassageHit[] =
    match === ''
      ? []
      : // FTS5's MATCH and bm25() have no query-builder form. Every value is a bound parameter.
        await db.all<PassageHit>(sql`
          select ${c.docId} as docId, ${d.title} as docTitle, ${c.sectionPath} as sectionPath, ${c.anchor} as anchor,
                 ${c.text} as text, bm25(reference_doc_chunks_fts) as rank
          from reference_doc_chunks_fts
          join ${c} on ${c.id} = reference_doc_chunks_fts.rowid
          join ${d} on ${d.id} = ${c.docId} and ${d.accountId} = ${c.accountId} and ${d.builtAt} = ${c.builtAt}
          where reference_doc_chunks_fts match ${match}
            and ${c.accountId} = ${a.accountId} and ${c.workspaceId} = ${a.workspaceId}
          order by rank
          limit ${RETRIEVE_PASSAGES}`);
  if (hits.length === 0) return (await workspaceIndexed(a.accountId, a.workspaceId)) ? [] : null;
  return rankSections(hits, a.k, a.perDocCap);
}
