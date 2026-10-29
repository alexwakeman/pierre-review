import { createHash } from 'node:crypto';
import { REFERENCE_DOC_WIKI_MAX_PAGES, type ReferenceDocWikiState } from '@pierre-review/shared';
import { demoteHeadings } from '../crawl.js';
import type { FigureSink } from '../figures.js';
import { WikiSourceError, type WikiCredential, type WikiPageMeta, type WikiPageRef, type WikiSource } from './source.js';

// THE WIKI TREE, READ EFFICIENTLY (docs/REFERENCE-DOCS.md § Wiki sources → Refresh). Provider-blind:
// everything goes through a `WikiSource`.
//
//   checkWikiTree   THE CHEAP CHECK — has anything changed since the last good check? The root's
//                   metadata (one request, no body), the descendants edited since then (one search),
//                   each compared by VERSION with the stored row; and, once a day, the full id list
//                   (adds, moves, deletes). No page body is read. Used by the background cadence and the
//                   pre-review kick, which start a refresh only when it says "changed".
//   syncWikiTree    THE BUILD'S READ — the same check, then the BODIES of only the new or changed pages
//                   (every page on a full build), converted to markdown and hashed; every other page's
//                   markdown comes from the on-disk cache. `contentChanged` is false when every hash,
//                   title and place in the tree is what is stored — the build then rebuilds nothing.
//   bundleWikiMarkdown  the tree as ONE markdown source: a heading per page at its tree depth (root `#`),
//                   the page's own headings pushed below it, and its address.
//
// Errors: a root page that cannot be read throws (the caller keeps the last version and records why); a
// CHILD page that is gone (404) leaves the tree; a child that fails otherwise keeps its cached text.

export const WIKI_LIST_INTERVAL_MS = 24 * 3600_000;

export interface StoredWikiPage {
  pageId: string;
  parentPageId: string | null;
  depth: number;
  position: number;
  title: string;
  version: number | null;
  lastEditedAt: Date | null;
  contentHash: string | null;
}

export interface SyncedWikiPage {
  pageId: string;
  parentPageId: string | null;
  depth: number;
  position: number;
  title: string;
  version: number | null;
  lastEditedAt: Date | null;
  markdown: string;
  contentHash: string;
  /** Read from the wiki on this sync (else from the cache). */
  fetched: boolean;
  lastError: string | null;
  url: string;
}

export interface WikiSyncArgs {
  source: WikiSource;
  site: WikiPageRef;
  state: ReferenceDocWikiState;
  stored: readonly StoredWikiPage[];
  credential: WikiCredential;
  readCached(pageId: string): string | null;
  /** Ignore what is stored: list the tree and read every page. */
  full: boolean;
  now: Date;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** Where a fetched page's images go (figures.ts). Absent ⇒ images keep their names. */
  figures?: FigureSink;
}

export interface WikiSyncResult {
  pages: SyncedWikiPage[];
  listed: boolean;
  pagesLeftOut: number;
  contentChanged: boolean;
  fetched: number;
}

export const hashMarkdown = (title: string, markdown: string): string =>
  createHash('sha256').update(title).update('\n\u0000\n').update(markdown).digest('hex');

const listDue = (state: ReferenceDocWikiState, now: Date): boolean =>
  state.lastListedAt == null || now.getTime() - state.lastListedAt >= WIKI_LIST_INTERVAL_MS;

/** Pages edited since the last good check whose version differs from the stored one (ids → meta). */
async function changedPages(args: Pick<WikiSyncArgs, 'source' | 'site' | 'state' | 'stored' | 'credential' | 'signal'>): Promise<Map<string, WikiPageMeta>> {
  const out = new Map<string, WikiPageMeta>();
  if (args.state.depth <= 0) return out;
  const since = new Date(args.state.lastCheckedAt ?? 0);
  const byId = new Map(args.stored.map((p) => [p.pageId, p]));
  const known = new Set(args.stored.map((p) => p.pageId));
  for (const m of await args.source.changedSince(args.site, args.state.rootPageId, since, { credential: args.credential, signal: args.signal, known })) {
    const s = byId.get(m.id);
    const moved = s == null || (m.version != null ? m.version !== s.version : m.editedAt != null && (s.lastEditedAt?.getTime() ?? 0) < m.editedAt.getTime());
    if (moved) out.set(m.id, m);
  }
  return out;
}

const rootMoved = (meta: WikiPageMeta, stored: StoredWikiPage | undefined): boolean =>
  stored == null ||
  (meta.version != null ? meta.version !== stored.version : meta.editedAt != null && (stored.lastEditedAt?.getTime() ?? 0) < meta.editedAt.getTime()) ||
  meta.title !== stored.title;

const sameShape = (a: readonly { pageId: string; parentPageId: string | null }[], b: readonly { pageId: string; parentPageId: string | null }[]): boolean =>
  a.length === b.length && a.every((p, i) => p.pageId === b[i]!.pageId && p.parentPageId === b[i]!.parentPageId);

/**
 * THE CHEAP CHECK. `changed` when the root moved, a descendant's version moved, a page is new, or (on
 * the daily list) the set or order of pages moved. Reads no body. Throws a WikiSourceError on a root
 * that cannot be reached.
 */
export async function checkWikiTree(
  args: Pick<WikiSyncArgs, 'source' | 'site' | 'state' | 'stored' | 'credential' | 'now' | 'signal'>,
): Promise<{ changed: boolean; listed: boolean }> {
  const { source, site, state, stored, credential, signal } = args;
  const root = await source.getPage(site, state.rootPageId, { credential, signal, body: false });
  const storedRoot = stored.find((p) => p.pageId === state.rootPageId);
  if (stored.length === 0 || rootMoved(root, storedRoot)) return { changed: true, listed: false };
  const changed = await changedPages(args);
  if (changed.size > 0) return { changed: true, listed: false };
  if (state.depth > 0 && listDue(state, args.now)) {
    const { pages } = await source.listDescendants(site, state.rootPageId, state.depth, REFERENCE_DOC_WIKI_MAX_PAGES - 1, { credential, signal });
    const children = stored.filter((p) => p.pageId !== state.rootPageId).sort((a, b) => a.position - b.position);
    const listed = pages.map((p) => ({ pageId: p.id, parentPageId: p.parentId }));
    return { changed: !sameShape(children, listed) || pages.some((p, i) => p.title !== children[i]?.title), listed: true };
  }
  return { changed: false, listed: false };
}

/** THE BUILD'S READ (header). */
export async function syncWikiTree(args: WikiSyncArgs): Promise<WikiSyncResult> {
  const { source, site, state, credential, signal } = args;
  const stored = args.full ? [] : args.stored;
  const byId = new Map(stored.map((p) => [p.pageId, p]));
  const call = { credential, signal };
  const rootMeta = await source.getPage(site, state.rootPageId, { ...call, body: false });

  // The tree: listed (first build, daily, or a page the stored tree does not know) or the stored one.
  const changed = stored.length > 0 ? await changedPages({ source, site, state, stored, credential, signal }) : new Map<string, WikiPageMeta>();
  let listed = false;
  let pagesLeftOut = state.pagesLeftOut ?? 0;
  let tree: WikiPageMeta[];
  const mustList = state.depth > 0 && (stored.length === 0 || listDue(state, args.now) || [...changed.keys()].some((id) => !byId.has(id)));
  if (mustList) {
    const res = await source.listDescendants(site, state.rootPageId, state.depth, REFERENCE_DOC_WIKI_MAX_PAGES - 1, call);
    tree = res.pages;
    listed = true;
    pagesLeftOut = res.more ? Math.max(1, pagesLeftOut) : 0;
  } else {
    tree = stored
      .filter((p) => p.pageId !== state.rootPageId)
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ id: p.pageId, title: p.title, parentId: p.parentPageId, version: p.version, editedAt: p.lastEditedAt, depth: p.depth, position: p.position }));
  }

  const order: WikiPageMeta[] = [{ ...rootMeta, parentId: null, depth: 0 }, ...tree];
  const out: SyncedWikiPage[] = [];
  let fetched = 0;
  for (let i = 0; i < order.length; i++) {
    if (signal?.aborted) throw new WikiSourceError('network');
    const meta = order[i]!;
    const isRoot = i === 0;
    const prev = byId.get(meta.id);
    const cached = prev ? args.readCached(meta.id) : null;
    // The root: its own metadata, or the search naming it (a wiki whose search sees the root — Notion).
    const stale = isRoot ? rootMoved(rootMeta, prev) || changed.has(meta.id) : changed.has(meta.id) || (prev != null && meta.title !== prev.title && listed);
    const url = source.pageUrl(site, meta.id);
    args.onProgress?.(i + 1, order.length);
    if (prev && cached != null && !stale) {
      out.push({
        pageId: meta.id,
        parentPageId: isRoot ? null : meta.parentId,
        depth: meta.depth,
        position: i,
        title: isRoot ? rootMeta.title : meta.title,
        version: prev.version,
        lastEditedAt: prev.lastEditedAt,
        markdown: cached,
        contentHash: prev.contentHash ?? hashMarkdown(meta.title, cached),
        fetched: false,
        lastError: null,
        url,
      });
      continue;
    }
    try {
      const page = await source.getPage(site, meta.id, { ...call, body: true });
      const markdown = (await source.toMarkdown(page, { ...call, figures: args.figures })).trim();
      fetched += 1;
      out.push({
        pageId: meta.id,
        parentPageId: isRoot ? null : meta.parentId,
        depth: meta.depth,
        position: i,
        title: page.title,
        version: page.version,
        lastEditedAt: page.editedAt,
        markdown,
        contentHash: hashMarkdown(page.title, markdown),
        fetched: true,
        lastError: null,
        // ⚠ Always the adapter's own address form: a fetched and a cached page must bundle to the SAME
        // text, or every refresh would miss the summary cache.
        url,
      });
    } catch (err) {
      // The root must be read; a child that is gone leaves the tree; any other failure keeps the
      // child's last good text (when there is one) and records the code.
      if (isRoot || !(err instanceof WikiSourceError)) throw err;
      if (err.code === 'unauthorized' || err.code === 'rate_limited') throw err;
      if (err.code === 'not_found' || cached == null || prev == null) continue;
      out.push({
        pageId: meta.id,
        parentPageId: meta.parentId,
        depth: meta.depth,
        position: i,
        title: prev.title,
        version: prev.version,
        lastEditedAt: prev.lastEditedAt,
        markdown: cached,
        contentHash: prev.contentHash ?? hashMarkdown(prev.title, cached),
        fetched: false,
        lastError: err.code,
        url,
      });
    }
  }
  // Positions are reading order after the drops.
  out.forEach((p, i) => (p.position = i));
  const storedOrder = [...args.stored].sort((a, b) => a.position - b.position);
  const contentChanged =
    args.full ||
    out.length !== storedOrder.length ||
    out.some((p, i) => {
      const s = storedOrder[i]!;
      return s.pageId !== p.pageId || s.parentPageId !== p.parentPageId || s.depth !== p.depth || s.title !== p.title || s.contentHash !== p.contentHash;
    });
  return { pages: out, listed, pagesLeftOut, contentChanged, fetched };
}

/** The tree as ONE markdown source (header). */
export function bundleWikiMarkdown(pages: readonly Pick<SyncedWikiPage, 'title' | 'depth' | 'markdown' | 'url'>[]): string {
  const parts: string[] = [];
  for (const p of pages) {
    const level = Math.min(6, p.depth + 1);
    let md = p.markdown.trim();
    const lead = /^#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(md);
    if (lead && lead[1]!.trim().toLowerCase() === p.title.trim().toLowerCase()) md = md.slice(lead[0].length).trim();
    for (let k = 0; k < level; k++) md = demoteHeadings(md);
    const title = p.title.replace(/\s+/g, ' ').trim() || 'Untitled';
    parts.push(`${'#'.repeat(level)} ${title}\n\nSource: <${p.url}>${md ? `\n\n${md}` : ''}`);
  }
  return parts.join('\n\n');
}

/** The newest edit among the pages (the document line's "updated"). */
export function newestEdit(pages: readonly Pick<SyncedWikiPage, 'lastEditedAt'>[]): number | null {
  let max: number | null = null;
  for (const p of pages) {
    const t = p.lastEditedAt?.getTime();
    if (t != null && (max == null || t > max)) max = t;
  }
  return max;
}
