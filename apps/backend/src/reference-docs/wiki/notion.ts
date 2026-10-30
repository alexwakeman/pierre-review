import { notionIdOf, parseNotionPageUrl } from '@pierre-review/shared';
import { JiraFetchError, checkJiraUrl, guardedLookup, nodeTransport, type JiraTransport } from '../../tracker/jira/fetch.js';
import { noteNotionRetryAfter, waitNotionSlot } from '../../tracker/notion/client.js';
import { PUBLIC_ONLY, fetchImageBytes } from '../figure-fetch.js';
import type { PageTransport } from '../url-fetch.js';
import { retryAfterMs } from './confluence.js';
import { notionBlocksToMarkdown, notionImageRefs, type NotionBlock } from './notion-blocks.js';
import { WikiSourceError, type WikiCallOptions, type WikiPage, type WikiPageMeta, type WikiPageRef, type WikiSource } from './source.js';

// NOTION — the second WikiSource (docs/REFERENCE-DOCS.md § Wiki sources → Notion).
//
//   page        GET  /v1/pages/{id}                       title (the `title` property), last edit, parent
//   body        GET  /v1/blocks/{id}/children (paginated)  recursing into blocks with children — bounded
//   tree        the same block walk, collecting `child_page` blocks and the rows of `child_database`
//               blocks (POST /v1/databases/{id}/query) — child pages are CHAPTERS, never inline text
//   changes     POST /v1/search, pages, newest edit first, read until a page older than `since`; kept:
//               the document's own pages and new children of them (`known`) — see `changedSince`
//   access      GET  /v1/users/me
//
// ⚠ ONE FIXED HOST (api.notion.com), through the tracker's guarded transport: https, public addresses
// judged at connect time, NO redirects, a timeout and a size cap, JSON only. Auth: `Bearer <token>`
// (an internal integration's), `Notion-Version` PINNED. ⚠ NEVER LOG the headers.
//
// RATE: Notion allows about three requests a second per integration. Every request waits its turn on
// the token's ONE lane, shared with the Notion tracker (tracker/notion/client.ts `waitNotionSlot`), so a
// workspace using one integration for both is paced once; a 429 is noted on that lane and waited out (Retry-After, ≤
// RATE_WAIT_MAX_MS in all, cancellable) before it becomes `rate_limited` with the wait.
//
// Notion has NO "version" — `last_edited_time` (rounded to the minute) is the change marker, so the
// search reports each page a minute LATER than Notion says: an edit made in the same minute as the last
// read still reads as newer (one extra read of an unchanged page costs a request, never a model call).

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
export const NOTION_TIMEOUT_MS = 15_000;
export const NOTION_MAX_BYTES = 8 * 1024 * 1024;
export const NOTION_RATE_WAIT_MAX_MS = 60_000;
const MAX_RATE_RETRIES = 3;
/** One page's block read: at most this many blocks, requests and levels. */
export const NOTION_MAX_BLOCKS = 5000;
export const NOTION_MAX_BLOCK_REQUESTS = 250;
export const NOTION_MAX_BLOCK_DEPTH = 8;
/** The change search reads at most this many result pages (100 each); past it, every known page is reported. */
export const NOTION_MAX_SEARCH_REQUESTS = 30;
const DB_ROWS_CAP = 100;
/** Each search hit is reported this much later than Notion's minute-rounded time (header). */
export const NOTION_EDIT_FUZZ_MS = 60_000;

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WikiSourceError('network'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new WikiSourceError('network'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Spaces requests `intervalMs` apart (every caller of one limiter shares the schedule). */
export function rateLimiter(intervalMs: number, now: () => number = Date.now, sleep: Sleep = realSleep): (signal?: AbortSignal) => Promise<void> {
  let next = 0;
  return async (signal) => {
    const t = now();
    const at = Math.max(t, next);
    next = at + intervalMs;
    if (at > t) await sleep(at - t, signal);
  };
}


export interface NotionDeps {
  transport?: JiraTransport;
  /** The credential-free image download (a Notion file address carries its own signature). */
  pageTransport?: PageTransport;
  sleep?: Sleep;
  /** Waits for a request slot. Absent ⇒ the token's lane, shared with the Notion tracker. */
  limit?: (signal?: AbortSignal) => Promise<void>;
}

const mapFetchError = (err: unknown): WikiSourceError => {
  if (err instanceof WikiSourceError) return err;
  if (err instanceof JiraFetchError) {
    switch (err.code) {
      case 'blocked':
        return new WikiSourceError('blocked');
      case 'timeout':
        return new WikiSourceError('timeout');
      case 'redirect':
        return new WikiSourceError('redirect', err.status);
      case 'too_large':
        return new WikiSourceError('too_large', err.status);
      case 'bad_url':
        return new WikiSourceError('bad_url');
      default:
        return new WikiSourceError('network');
    }
  }
  return new WikiSourceError('network');
};

/** One Notion API call as JSON, under the guard and the limiter, honouring 429. Exported for its test. */
export async function notionRequest(
  path: string,
  opts: WikiCallOptions,
  deps: NotionDeps = {},
  body?: unknown,
): Promise<unknown> {
  const transport = deps.transport ?? nodeTransport;
  const sleep = deps.sleep ?? realSleep;
  const limit = deps.limit ?? (() => waitNotionSlot(opts.credential.token));
  let url: URL;
  try {
    url = checkJiraUrl(`${NOTION_API}${path}`, { cloud: true });
  } catch (err) {
    throw mapFetchError(err);
  }
  if (url.host !== 'api.notion.com') throw new WikiSourceError('blocked');
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new WikiSourceError('network');
    await limit(opts.signal);
    let res;
    try {
      res = await transport(
        url,
        {
          accept: 'application/json',
          'user-agent': 'Limn',
          authorization: `Bearer ${opts.credential.token}`,
          'notion-version': NOTION_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        { lookup: guardedLookup(), timeoutMs: NOTION_TIMEOUT_MS, maxBytes: NOTION_MAX_BYTES },
        body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : undefined,
      );
    } catch (err) {
      throw mapFetchError(err);
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers?.['retry-after']) ?? 1_000 * (attempt + 1);
      if (deps.limit == null) noteNotionRetryAfter(opts.credential.token, wait);
      if (attempt >= MAX_RATE_RETRIES || waited + wait > NOTION_RATE_WAIT_MAX_MS) throw new WikiSourceError('rate_limited', 429, wait);
      waited += wait;
      await sleep(wait, opts.signal);
      continue;
    }
    if (res.status >= 300 && res.status < 400) throw new WikiSourceError('redirect', res.status);
    if (res.status === 401) throw new WikiSourceError('unauthorized', 401);
    if (res.status === 403) throw new WikiSourceError('forbidden', 403);
    // Notion answers 404 both for no such page and for a page not shared with the integration.
    if (res.status === 404) throw new WikiSourceError('not_found', 404);
    if (res.status < 200 || res.status >= 300) throw new WikiSourceError('http', res.status);
    if (!/\bjson\b/i.test(res.contentType)) throw new WikiSourceError('not_json', res.status);
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new WikiSourceError('not_json', res.status);
    }
  }
}

// ---- reading the answers (defensive: a stranger's JSON) ----

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};
const cleanTitle = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled';
const idOf = (v: unknown): string | null => {
  const s = str(v);
  return s ? notionIdOf(s) : null;
};

const plain = (rt: unknown): string =>
  (Array.isArray(rt) ? rt : [])
    .map((i) => str(obj(i)?.plain_text) ?? '')
    .join('');

/** A page object's title: the one property whose type is `title`. */
export function pageTitle(page: Obj): string {
  const props = obj(page.properties) ?? {};
  for (const v of Object.values(props)) {
    const p = obj(v);
    if (p?.type === 'title') return cleanTitle(plain(p.title));
  }
  return 'Untitled';
}

/** The page a page sits under, when it is a page (a database row's is the database: null here). */
const parentPageOf = (page: Obj): string | null => {
  const p = obj(page.parent);
  return p?.type === 'page_id' ? idOf(p.page_id) : null;
};

/** A page answer → the page (no body). Exported for its test. */
export function toNotionPage(raw: unknown): WikiPage {
  const o = obj(raw);
  const id = idOf(o?.id);
  if (!o || !id || o.object !== 'page') throw new WikiSourceError('not_json');
  // A page in the trash is gone, as far as the library is concerned.
  if (o.in_trash === true || o.archived === true) throw new WikiSourceError('not_found', 404);
  const url = str(o.url);
  return {
    id,
    title: pageTitle(o),
    parentId: parentPageOf(o),
    version: null,
    editedAt: date(o.last_edited_time),
    depth: 0,
    position: null,
    body: '',
    webUrl: url && /^https:\/\/(?:www\.)?notion\.(?:so|site|com)\//.test(url) ? url : null,
  };
}

interface ReadBudget {
  blocks: number;
  requests: number;
}

/** One block's children, every page of them. */
async function listChildren(blockId: string, opts: WikiCallOptions, deps: NotionDeps, budget: ReadBudget): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | null = null;
  do {
    if (budget.requests >= NOTION_MAX_BLOCK_REQUESTS || budget.blocks >= NOTION_MAX_BLOCKS) break;
    budget.requests += 1;
    const q = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
    const raw = obj(await notionRequest(`/blocks/${blockId}/children${q}`, opts, deps));
    for (const r of Array.isArray(raw?.results) ? raw!.results : []) {
      const b = obj(r);
      const id = idOf(b?.id);
      if (!b || !id || typeof b.type !== 'string') continue;
      if (budget.blocks >= NOTION_MAX_BLOCKS) break;
      budget.blocks += 1;
      out.push({ ...(b as Obj), id, type: b.type } as NotionBlock);
    }
    cursor = raw?.has_more === true ? str(raw.next_cursor) : null;
  } while (cursor);
  return out;
}

const DESCENDANT_TYPES = new Set(['child_page', 'child_database']);

/**
 * A block tree, children attached, bounded (NOTION_MAX_BLOCKS / _REQUESTS / _DEPTH). A child page or
 * database is NOT entered (it is a chapter of its own); a synced block reads its ORIGINAL's children.
 */
export async function readBlockTree(rootId: string, opts: WikiCallOptions, deps: NotionDeps = {}): Promise<NotionBlock[]> {
  const budget: ReadBudget = { blocks: 0, requests: 0 };
  const visited = new Set<string>([rootId]);
  const walk = async (id: string, depth: number): Promise<NotionBlock[]> => {
    const blocks = await listChildren(id, opts, deps, budget);
    for (const b of blocks) {
      if (opts.signal?.aborted) throw new WikiSourceError('network');
      if (b.has_children !== true || DESCENDANT_TYPES.has(b.type) || depth + 1 > NOTION_MAX_BLOCK_DEPTH) continue;
      let from = b.id;
      if (b.type === 'synced_block') {
        const original = idOf(obj(obj(b.synced_block)?.synced_from)?.block_id);
        if (original) from = original;
      }
      if (visited.has(from)) continue;
      visited.add(from);
      try {
        b.children = await walk(from, depth + 1);
      } catch (err) {
        // A synced block whose original the integration may not read keeps nothing; anything else stops.
        if (b.type === 'synced_block' && err instanceof WikiSourceError && (err.code === 'not_found' || err.code === 'forbidden')) continue;
        throw err;
      }
    }
    return blocks;
  };
  return walk(rootId, 0);
}

/** The child pages / databases of a page, in reading order, found anywhere in its block tree. */
function descendantRefs(blocks: readonly NotionBlock[]): Array<{ id: string; type: 'page' | 'database'; title: string }> {
  const out: Array<{ id: string; type: 'page' | 'database'; title: string }> = [];
  const stack = [...blocks].reverse();
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (b.type === 'child_page') out.push({ id: b.id, type: 'page', title: cleanTitle(str(obj(b.child_page)?.title) ?? '') });
    else if (b.type === 'child_database') out.push({ id: b.id, type: 'database', title: cleanTitle(str(obj(b.child_database)?.title) ?? '') });
    for (let k = (b.children ?? []).length - 1; k >= 0; k--) stack.push(b.children![k]!);
  }
  return out;
}

async function databaseRows(dbId: string, opts: WikiCallOptions, deps: NotionDeps): Promise<Array<{ id: string; title: string; editedAt: Date | null }>> {
  const out: Array<{ id: string; title: string; editedAt: Date | null }> = [];
  let cursor: string | null = null;
  for (let n = 0; n < 5; n++) {
    let raw: Obj | null;
    try {
      raw = obj(await notionRequest(`/databases/${dbId}/query`, opts, deps, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
    } catch (err) {
      // A linked database the integration may not read is left out, not a failure of the tree.
      if (err instanceof WikiSourceError && (err.code === 'not_found' || err.code === 'forbidden' || err.code === 'http')) return out;
      throw err;
    }
    for (const r of Array.isArray(raw?.results) ? raw!.results : []) {
      const p = obj(r);
      const id = idOf(p?.id);
      if (!p || !id || p.object !== 'page' || p.in_trash === true || p.archived === true) continue;
      out.push({ id, title: pageTitle(p), editedAt: date(p.last_edited_time) });
      if (out.length >= DB_ROWS_CAP) return out;
    }
    cursor = raw?.has_more === true ? str(raw.next_cursor) : null;
    if (!cursor) break;
  }
  return out;
}

export function notionSource(deps: NotionDeps = {}): WikiSource {
  const NOTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const checkId = (id: string): string => {
    const n = notionIdOf(id);
    if (!n || !NOTION_ID.test(n)) throw new WikiSourceError('bad_url');
    return n;
  };
  return {
    provider: 'notion',
    resolveRef(rawUrl) {
      const a = parseNotionPageUrl(rawUrl);
      return a ? { provider: 'notion', origin: a.origin, host: a.host, pageId: a.pageId } : null;
    },
    async getPage(_site, pageId, opts) {
      const id = checkId(pageId);
      const page = toNotionPage(await notionRequest(`/pages/${id}`, opts, deps));
      if (!opts.body) return page;
      const blocks = await readBlockTree(id, opts, deps);
      return { ...page, body: JSON.stringify({ v: 1, blocks }) };
    },
    async resolveRoot(ref, opts) {
      const id = checkId(ref.pageId);
      const raw = obj(await notionRequest(`/pages/${id}`, opts, deps));
      const page = toNotionPage(raw);
      // A TOP-LEVEL page (its parent is the workspace) is the wiki's home: the whole wiki is read.
      // Traversal is the same either way — the page and every page below it.
      const top = obj(raw?.parent)?.type === 'workspace';
      const scope = top ? { kind: 'space' as const, name: page.title, key: null, id: null } : { kind: 'tree' as const };
      return { ref: { ...ref, scope }, title: page.title, scope };
    },
    async listDescendants(_site, rootId, depth, cap, opts) {
      const root = checkId(rootId);
      const pages: WikiPageMeta[] = [];
      let more = false;
      const seen = new Set<string>([root]);
      const walk = async (pageId: string, d: number): Promise<void> => {
        if (d >= depth || more) return;
        const refs = descendantRefs(await readBlockTree(pageId, opts, deps));
        let position = 0;
        const add = async (id: string, title: string): Promise<void> => {
          if (seen.has(id) || more) return;
          seen.add(id);
          if (pages.length >= cap) {
            more = true;
            return;
          }
          pages.push({ id, title, parentId: pageId, version: null, editedAt: null, depth: d + 1, position: position++ });
          await walk(id, d + 1);
        };
        for (const r of refs) {
          if (opts.signal?.aborted) throw new WikiSourceError('network');
          // A database is transparent: its rows are the containing page's children.
          if (r.type === 'database') for (const row of await databaseRows(r.id, opts, deps)) await add(row.id, row.title);
          else await add(r.id, r.title);
        }
      };
      await walk(root, 0);
      return { pages, more };
    },
    async changedSince(_site, _rootId, since, opts) {
      const floor = since.getTime() - 2 * NOTION_EDIT_FUZZ_MS;
      const known = opts.known;
      const out: WikiPageMeta[] = [];
      const reported = new Set<string>();
      let cursor: string | null = null;
      let reachedFloor = false;
      for (let n = 0; n < NOTION_MAX_SEARCH_REQUESTS; n++) {
        const raw = obj(
          await notionRequest('/search', opts, deps, {
            filter: { property: 'object', value: 'page' },
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        );
        for (const r of Array.isArray(raw?.results) ? raw!.results : []) {
          const p = obj(r);
          const id = idOf(p?.id);
          const edited = date(p?.last_edited_time);
          if (!p || !id || !edited) continue;
          if (edited.getTime() < floor) {
            reachedFloor = true;
            break;
          }
          const parent = parentPageOf(p);
          // This document's own pages, and NEW pages under one of them (a new child's parent was edited too).
          if (known && !known.has(id) && !(parent && known.has(parent))) continue;
          reported.add(id);
          out.push({ id, title: pageTitle(p), parentId: parent, version: null, editedAt: new Date(edited.getTime() + NOTION_EDIT_FUZZ_MS), depth: 0, position: null });
        }
        if (reachedFloor) break;
        cursor = raw?.has_more === true ? str(raw.next_cursor) : null;
        if (!cursor) {
          reachedFloor = true;
          break;
        }
      }
      // Too many recent edits in the workspace to read back to `since`: over-report every known page
      // (each is then read again — a request each, never a model call), never under-report.
      if (!reachedFloor && known) {
        const now = new Date(Date.now() + NOTION_EDIT_FUZZ_MS);
        for (const id of known) if (!reported.has(id)) out.push({ id, title: '', parentId: null, version: null, editedAt: now, depth: 0, position: null });
      }
      return out;
    },
    async toMarkdown(page, opts) {
      let blocks: NotionBlock[] = [];
      try {
        const parsed = obj(JSON.parse(page.body || '{}'));
        blocks = Array.isArray(parsed?.blocks) ? (parsed!.blocks as NotionBlock[]) : [];
      } catch {
        blocks = [];
      }
      const figures = new Map<string, string>();
      const sink = opts?.figures;
      if (sink) {
        for (const ref of notionImageRefs(blocks)) {
          if (opts?.signal?.aborted) break;
          const bytes = await fetchImageBytes(ref.url, sink, PUBLIC_ONLY, deps.pageTransport);
          const marker = bytes ? sink.add(bytes, ref.fallback) : null;
          if (marker) figures.set(ref.blockId, marker);
        }
      }
      return notionBlocksToMarkdown(blocks, figures);
    },
    async checkAccess(_site, opts) {
      await notionRequest('/users/me', opts, deps);
    },
    pageUrl: (_site, pageId) => `https://www.notion.so/${pageId.replace(/-/g, '')}`,
  };
}

/** The site every Notion page lives on (the credential ladder and the settings check use it). */
export const NOTION_SITE: Pick<WikiPageRef, 'provider' | 'origin' | 'host'> = { provider: 'notion', origin: 'https://www.notion.so', host: 'www.notion.so' };
