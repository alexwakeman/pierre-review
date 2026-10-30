import { WIKI_PROVIDER_NAMES, type ReferenceDocWikiState } from '@pierre-review/shared';
import { figureDescriptionAvailable } from '../figure-describer.js';
import { figuresOf, type FigureSink } from '../figures.js';
import { getDocRow, patchDoc, wikiStateOf, type DocRow } from '../store.js';
import { resolveWikiCredential } from './credentials.js';
import { commitWikiPages, listWikiPages, readCachedPage, saveWikiSource } from './pages.js';
import './register.js';
import {
  WikiSourceError,
  unreachableReasonOf,
  wikiErrorMessage,
  wikiSourceFor,
  type WikiCredential,
  type WikiPageRef,
  type WikiSource,
} from './source.js';
import { bundleWikiMarkdown, checkWikiTree, newestEdit, syncWikiTree, type StoredWikiPage, type WikiSyncResult } from './sync.js';

// THE WIKI HALF OF A BUILD AND OF A CHECK (docs/REFERENCE-DOCS.md § Wiki sources). manager.ts calls
// `readWikiForBuild` in its converting stage and `commit()` once the new version is installed (or when
// nothing needs rebuilding); refresh.ts calls `quickCheckWikiDoc`. Neither ever deletes the built
// version: an unreachable wiki is RECORDED on the row (`unreachableSince`, the reason, a 429's
// `retryAfter`) and the last version stays readable.

/** The build ended without a new version, the last one kept (manager.ts → `ready`). */
export class WikiIdle extends Error {}
/** A first build that cannot read the wiki: the sentence to show (manager.ts → `failed`). */
export class WikiRefusal extends Error {}

export interface WikiRead {
  sync: WikiSyncResult;
  markdown: string;
  /** Persist the pages, their cached text, the bundled source and the refresh state. */
  commit(): Promise<void>;
}

interface Ready {
  state: ReferenceDocWikiState;
  source: WikiSource;
  site: WikiPageRef;
  credential: WikiCredential;
  stored: StoredWikiPage[];
}

function siteOf(state: ReferenceDocWikiState): WikiPageRef {
  return { provider: state.provider, origin: state.origin, host: new URL(state.origin).host.toLowerCase(), pageId: state.rootPageId, scope: state.scope ?? null };
}

async function prepare(row: DocRow): Promise<Ready> {
  const state = wikiStateOf(row.wiki);
  if (!state) throw new WikiRefusal('This document has no wiki page to read.');
  const source = wikiSourceFor(state.provider);
  if (!source) throw new WikiRefusal('This wiki is not supported here.');
  const site = siteOf(state);
  const cred = await resolveWikiCredential(row.accountId, row.workspaceId, site);
  if (cred.state !== 'ok') throw new WikiSourceError('no_credential');
  const stored = (await listWikiPages(row.accountId, row.id)).map((p) => ({
    pageId: p.pageId,
    parentPageId: p.parentPageId ?? null,
    depth: p.depth,
    position: p.position,
    title: p.title,
    version: p.version ?? null,
    lastEditedAt: p.lastEditedAt ?? null,
    contentHash: p.contentHash ?? null,
  }));
  return { state, source, site, credential: cred.credential, stored };
}

/** Record that the wiki could not be reached (keeps everything else). */
async function recordUnreachable(row: DocRow, err: unknown, now: number): Promise<void> {
  const fresh = (await getDocRow(row.accountId, row.id)) ?? row;
  const state = wikiStateOf(fresh.wiki);
  if (!state) return;
  const retry = err instanceof WikiSourceError && err.retryAfterMs != null ? now + err.retryAfterMs : null;
  await patchDoc(row.accountId, row.id, {
    wiki: { ...state, unreachableSince: state.unreachableSince ?? now, unreachableReason: unreachableReasonOf(err), retryAfter: retry },
  });
}

async function patchState(row: DocRow, patch: Partial<ReferenceDocWikiState>): Promise<void> {
  const fresh = (await getDocRow(row.accountId, row.id)) ?? row;
  const state = wikiStateOf(fresh.wiki);
  if (!state) return;
  await patchDoc(row.accountId, row.id, { wiki: { ...state, ...patch } });
}

/** The build's read. Throws WikiIdle (built version kept) or WikiRefusal (first build, a sentence). */
export async function readWikiForBuild(opts: {
  row: DocRow;
  full: boolean;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  now?: () => number;
  /** Where a fetched page's images go (figures.ts). */
  figures?: FigureSink;
}): Promise<WikiRead> {
  const { row } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  let ready: Ready | null = null;
  let sync: WikiSyncResult;
  try {
    ready = await prepare(row);
    const r = ready;
    sync = await syncWikiTree({
      source: r.source,
      site: r.site,
      state: r.state,
      stored: r.stored,
      credential: r.credential,
      readCached: (id) => readCachedPage(row.accountId, row.workspaceId, row.slug, id),
      full: opts.full,
      now: new Date(started),
      signal: opts.signal,
      onProgress: opts.onProgress,
      figures: opts.figures,
    });
  } catch (err) {
    if (err instanceof WikiRefusal) throw err;
    if (opts.signal?.aborted) throw new WikiRefusal('Cancelled.');
    if (!(err instanceof WikiSourceError)) throw err;
    await recordUnreachable(row, err, now());
    const name = WIKI_PROVIDER_NAMES[wikiStateOf(row.wiki)?.provider ?? 'confluence'];
    if (row.builtAt != null) throw new WikiIdle(wikiErrorMessage(name, err));
    throw new WikiRefusal(wikiErrorMessage(name, err));
  }
  const r = ready;
  const pages = sync.pages;
  const markdown = bundleWikiMarkdown(pages);
  return {
    sync,
    markdown,
    commit: async () => {
      await commitWikiPages(
        row.accountId,
        row.workspaceId,
        row.slug,
        row.id,
        pages.map((p) => ({
          pageId: p.pageId,
          parentPageId: p.parentPageId,
          depth: p.depth,
          position: p.position,
          title: p.title,
          version: p.version,
          lastEditedAt: p.lastEditedAt,
          contentHash: p.contentHash,
          lastFetchedAt: p.fetched ? new Date(started) : null,
          lastError: p.lastError,
          // Only a page read this time (or one with no cached file) is written to disk.
          markdown: p.fetched || readCachedPage(row.accountId, row.workspaceId, row.slug, p.pageId) == null ? p.markdown : null,
        })),
      );
      saveWikiSource(row.accountId, row.workspaceId, row.slug, markdown);
      await patchState(row, {
        lastCheckedAt: started,
        ...(sync.listed ? { lastListedAt: started } : {}),
        pageCount: pages.length,
        pagesLeftOut: sync.pagesLeftOut,
        lastChangedAt: newestEdit(pages) ?? r.state.lastChangedAt,
        unreachableSince: null,
        unreachableReason: null,
        retryAfter: null,
      });
    },
  };
}

export type QuickCheck = 'changed' | 'unchanged' | 'unreachable';

/**
 * THE CHEAP CHECK for one wiki document (the background cadence, the pre-review kick): no page body is
 * read. 'unchanged' stamps the check (and the daily list); 'unreachable' records why; 'changed' writes
 * nothing — the refresh build re-checks and commits.
 */
export async function quickCheckWikiDoc(row: DocRow, now: () => number = Date.now, signal?: AbortSignal): Promise<QuickCheck> {
  const started = now();
  try {
    const r = await prepare(row);
    const res = await checkWikiTree({
      source: r.source,
      site: r.site,
      state: r.state,
      stored: r.stored,
      credential: r.credential,
      now: new Date(started),
      signal,
    });
    if (res.changed) return 'changed';
    // Figures left waiting by an earlier refresh (the AI budget was spent) count as a change, once
    // Claude can describe them here: the refresh reads no page again, only describes them.
    if ((figuresOf(row.figures)?.pending ?? 0) > 0 && figureDescriptionAvailable().ok) return 'changed';
    await patchState(row, {
      lastCheckedAt: started,
      ...(res.listed ? { lastListedAt: started } : {}),
      unreachableSince: null,
      unreachableReason: null,
      retryAfter: null,
    });
    return 'unchanged';
  } catch (err) {
    if (err instanceof WikiRefusal) return 'unreachable';
    if (!(err instanceof WikiSourceError)) throw err;
    await recordUnreachable(row, err, now());
    return 'unreachable';
  }
}
