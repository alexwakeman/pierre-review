import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema, runTransaction } from '../../db/client.js';
import { sourcesDir } from '../paths.js';

// A WIKI DOCUMENT'S PAGES (`reference_doc_wiki_pages`, migration 0140) and their converted markdown on
// disk (`sources/<slug>/pages/<pageId>.md`). Every read and write carries the ACCOUNT predicate; the
// rows are upserted on (doc_id, page_id) and go with their document (composite FK, cascade — and the
// delete paths remove them explicitly too). ⚠ Written ONLY by `commitWikiPages`, after a successful
// build or a check that found nothing to rebuild: a failed or skipped refresh never advances a version.

export type WikiPageRow = typeof schema.referenceDocWikiPages.$inferSelect;

const PAGE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function listWikiPages(accountId: number, docId: number): Promise<WikiPageRow[]> {
  const t = schema.referenceDocWikiPages;
  return db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.docId, docId)))
    .orderBy(asc(t.position), asc(t.id))
    .execute();
}

export interface WikiPageWrite {
  pageId: string;
  parentPageId: string | null;
  depth: number;
  position: number;
  title: string;
  version: number | null;
  lastEditedAt: Date | null;
  contentHash: string | null;
  lastFetchedAt: Date | null;
  lastError: string | null;
}

/** The page cache folder of one wiki document. */
export function wikiPagesDir(accountId: number, workspaceId: number, slug: string): string {
  return join(sourcesDir(accountId, workspaceId, slug), 'pages');
}

/** A cached page's markdown, or null. */
export function readCachedPage(accountId: number, workspaceId: number, slug: string, pageId: string): string | null {
  if (!PAGE_FILE_ID.test(pageId)) return null;
  const p = join(wikiPagesDir(accountId, workspaceId, slug), `${pageId}.md`);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Make the stored tree EXACTLY `pages`: upsert each (on doc_id, page_id), delete the rows of pages no
 * longer in it, write the markdown of the pages read this time and remove the files of the pages gone.
 * The account predicate holds on every statement; a doc of another account matches nothing.
 */
export async function commitWikiPages(
  accountId: number,
  workspaceId: number,
  slug: string,
  docId: number,
  pages: ReadonlyArray<WikiPageWrite & { markdown?: string | null }>,
): Promise<void> {
  const t = schema.referenceDocWikiPages;
  const keep = new Set(pages.map((p) => p.pageId));
  const now = new Date();
  const existing = await listWikiPages(accountId, docId);
  await runTransaction(async (tx) => {
    for (const r of existing) {
      if (!keep.has(r.pageId)) await tx.delete(t).where(and(eq(t.accountId, accountId), eq(t.id, r.id))).execute();
    }
    for (const p of pages) {
      const cols = {
        parentPageId: p.parentPageId,
        depth: p.depth,
        position: p.position,
        title: p.title,
        version: p.version,
        lastEditedAt: p.lastEditedAt,
        contentHash: p.contentHash,
        lastFetchedAt: p.lastFetchedAt,
        lastError: p.lastError,
        updatedAt: now,
      };
      await tx
        .insert(t)
        .values({ accountId, docId, pageId: p.pageId, ...cols, createdAt: now })
        .onConflictDoUpdate({ target: [t.docId, t.pageId], set: cols, where: eq(t.accountId, accountId) })
        .execute();
    }
  });
  const dir = wikiPagesDir(accountId, workspaceId, slug);
  mkdirSync(dir, { recursive: true });
  for (const p of pages) {
    if (p.markdown == null || !PAGE_FILE_ID.test(p.pageId)) continue;
    const file = join(dir, `${p.pageId}.md`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, p.markdown);
    renameSync(tmp, file);
  }
  for (const r of existing) {
    if (!keep.has(r.pageId) && PAGE_FILE_ID.test(r.pageId)) rmSync(join(dir, `${r.pageId}.md`), { force: true });
  }
}

/** A delete path: every page row of a document (the FK cascades too; this is explicit anyway). */
export async function deleteWikiPages(accountId: number, docId: number): Promise<number> {
  const t = schema.referenceDocWikiPages;
  const rows = await db
    .delete(t)
    .where(and(eq(t.accountId, accountId), eq(t.docId, docId)))
    .returning({ id: t.id })
    .execute();
  return rows.length;
}

/** Write the bundled markdown as the document's source (`sources/<slug>/source.md`), keeping pages/. */
export function saveWikiSource(accountId: number, workspaceId: number, slug: string, markdown: string): void {
  const dir = sourcesDir(accountId, workspaceId, slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'source.md');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, markdown);
  renameSync(tmp, file);
}
