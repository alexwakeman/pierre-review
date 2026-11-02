import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { ReferenceDocSectionEntry } from '@pierre-review/shared';
import { db, runTransaction, schema } from '../db/client.js';
import { readLibraryFile } from './library.js';
import { parseLibraryPath } from './paths.js';
import { sectionBodyOf } from './review-refs.js';
import { cleanHeadingTitle, headingAnchor } from './split.js';
import { getDocRow } from './store.js';

// THE FULL-TEXT PASSAGES (docs/REFERENCE-DOCS.md § Retrieval; migration 0152). A built document's
// section text, cut into passages that `retrieve.ts` searches with SQLite FTS5.
//
//   CHUNKING (pure, `chunkSection`): within ONE section (the citation unit), paragraphs packed to
//   ≤ CHUNK_WORDS words; a paragraph over CHUNK_SPLIT_WORDS words is cut into CHUNK_WORDS-word pieces.
//   HTML (tables arrive as HTML) is reduced to its text and link targets are dropped: the index holds
//   words, never markup. Each passage is prefixed with "Document › trail › section" and the section's
//   stored one-line summary, so a passage that never names its subject is still found by it.
//   WRITING (`indexDocChunks`): DERIVED from the files on disk, after the document is installed. The
//   document's passages are replaced WHOLE, in one transaction (the FTS5 index follows by trigger).
//   BACKFILL (`backfillDocChunks`, boot): every built document whose passages are missing or from an
//   older build. DB + disk only, one document at a time.
// A passage is never evidence: every reference is still checked against the section's text.

export const CHUNK_WORDS = 220;
export const CHUNK_SPLIT_WORDS = 300;
const INSERT_BATCH = 100;

export interface ChunkDraft {
  /** The nearest heading's anchor at or above the passage's first paragraph; null = the section's top. */
  anchor: string | null;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** The words of a markdown/HTML block: tags, link targets and entities out, whitespace collapsed. */
export function plainText(block: string): string {
  return block
    .replace(/<[^>]*>/g, ' ')
    .replace(/\]\([^)\s]*\)/g, ']')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e] ?? ' ')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .trim();
}

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== '');

/**
 * One section's passages. `body` is the section file's own text (`sectionBodyOf`); `title` is the
 * section's heading, counted first for the anchor numbering, as the file's own `# title` line is.
 */
export function chunkSection(prefix: string, body: string, title: string): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  const seen = new Map<string, number>([[headingAnchor(title), 1]]);
  let anchor: string | null = null;
  let cur: string[] = [];
  let curWords = 0;
  let curAnchor: string | null = null;
  const flush = (): void => {
    if (cur.length > 0) out.push({ anchor: curAnchor, text: `${prefix}\n\n${cur.join('\n\n')}` });
    cur = [];
    curWords = 0;
  };
  for (const raw of body.split(/\n[ \t]*\n/)) {
    const h = /^#{1,6}[ \t]+(.+)$/.exec(raw.trim());
    if (h) {
      const base = headingAnchor(cleanHeadingTitle(h[1]!));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchor = n === 0 ? base : `${base}-${n}`;
    }
    const text = plainText(raw);
    if (text === '') continue;
    const w = words(text);
    if (w.length > CHUNK_SPLIT_WORDS) {
      flush();
      for (let i = 0; i < w.length; i += CHUNK_WORDS) {
        cur = [w.slice(i, i + CHUNK_WORDS).join(' ')];
        curAnchor = anchor;
        flush();
      }
      continue;
    }
    if (curWords > 0 && curWords + w.length > CHUNK_WORDS) flush();
    if (cur.length === 0) curAnchor = anchor;
    cur.push(text);
    curWords += w.length;
  }
  flush();
  return out;
}

/** The prefix every passage of a section carries. */
export function chunkPrefix(docTitle: string, sec: Pick<ReferenceDocSectionEntry, 'title' | 'trail' | 'summary'>): string {
  const crumbs = [docTitle, ...sec.trail, sec.title].map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s !== '');
  return [crumbs.join(' › '), sec.summary.replace(/\s+/g, ' ').trim()].filter((s) => s !== '').join('\n');
}

export interface DocChunk extends ChunkDraft {
  sectionPath: string;
  ordinal: number;
}

/** Every passage of a document, in reading order. `read` gives a section file's text (null = missing). */
export function chunkDocument(
  docTitle: string,
  sections: readonly ReferenceDocSectionEntry[],
  read: (path: string) => string | null,
): DocChunk[] {
  const out: DocChunk[] = [];
  for (const sec of sections) {
    const raw = read(sec.path);
    if (raw == null) continue;
    for (const c of chunkSection(chunkPrefix(docTitle, sec), sectionBodyOf(raw), sec.title)) {
      out.push({ ...c, sectionPath: sec.path, ordinal: out.length });
    }
  }
  return out;
}

/**
 * Replace one built document's passages with ones cut from its files on disk. Returns how many were
 * written, or null when the document is gone or not built (nothing is touched then).
 */
export async function indexDocChunks(accountId: number, docId: number): Promise<number | null> {
  const row = await getDocRow(accountId, docId);
  if (row == null || row.builtAt == null || row.sections == null) return null;
  const builtAt = row.builtAt;
  // The files are read BEFORE the transaction: it holds the one write lock, so it awaits DB work only.
  const chunks = chunkDocument(row.title, row.sections, (path) => {
    const parsed = parseLibraryPath(path);
    return parsed != null ? readLibraryFile(accountId, row.workspaceId, parsed.path) : null;
  });
  const t = schema.referenceDocChunks;
  await runTransaction(async (tx) => {
    await tx.delete(t).where(and(eq(t.accountId, accountId), eq(t.docId, docId))).execute();
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      await tx
        .insert(t)
        .values(
          chunks.slice(i, i + INSERT_BATCH).map((c) => ({
            accountId,
            workspaceId: row.workspaceId,
            docId,
            builtAt,
            sectionPath: c.sectionPath,
            anchor: c.anchor,
            ordinal: c.ordinal,
            text: c.text,
          })),
        )
        .execute();
    }
  });
  return chunks.length;
}

/** Built documents whose passages are missing or were cut from an older build. */
export async function docsNeedingChunks(): Promise<Array<{ accountId: number; id: number }>> {
  const d = schema.referenceDocs;
  const c = schema.referenceDocChunks;
  return db
    .select({ accountId: d.accountId, id: d.id })
    .from(d)
    .where(
      and(
        isNotNull(d.builtAt),
        sql`not exists (select 1 from ${c} where ${c.docId} = ${d.id} and ${c.accountId} = ${d.accountId} and ${c.builtAt} = ${d.builtAt})`,
      ),
    )
    .orderBy(d.id)
    .execute();
}

/** BOOT: index every built document that needs it, one at a time. Returns how many were indexed. */
export async function backfillDocChunks(onError: (docId: number, err: unknown) => void = () => {}): Promise<number> {
  let n = 0;
  for (const d of await docsNeedingChunks()) {
    try {
      if ((await indexDocChunks(d.accountId, d.id)) != null) n += 1;
    } catch (err) {
      onError(d.id, err);
    }
    await new Promise((r) => setImmediate(r));
  }
  return n;
}
