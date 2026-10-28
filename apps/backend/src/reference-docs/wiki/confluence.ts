import { parseConfluencePageUrl } from '@pierre-review/shared';
import {
  JiraFetchError,
  checkJiraUrl,
  guardedLookup,
  nodeTransport,
  type JiraTransport,
} from '../../tracker/jira/fetch.js';
import { storageToMarkdown } from './confluence-storage.js';
import {
  WikiSourceError,
  type WikiCallOptions,
  type WikiCredential,
  type WikiPage,
  type WikiPageMeta,
  type WikiPageRef,
  type WikiSource,
} from './source.js';

// CONFLUENCE CLOUD — the first WikiSource (docs/REFERENCE-DOCS.md § Wiki sources).
//
//   page        GET /wiki/api/v2/pages/{id}[?body-format=storage]        title, parentId, version
//   tree        GET /wiki/api/v2/pages/{id}/descendants?depth=N&limit=   ids, parents, depth, order
//   changes     GET /wiki/rest/api/content/search?cql=ancestor = {id} AND type = page AND
//                   lastmodified > "yyyy-MM-dd HH:mm"&expand=version        (v2 has no CQL search)
//
// ⚠ THE SITE IS TYPED BY THE CUSTOMER, so every request goes through the tracker's guarded transport
// (tracker/jira/fetch.ts): https ONLY and PUBLIC addresses only (the cloud policy — Confluence Cloud is
// on the internet, so a private address is never a Confluence site), judged at connect time against
// DNS rebinding; NO redirects (a 3xx would forward the credential to a host nobody chose); a timeout
// and a size cap; JSON only. A `next` link from a listing is followed only when it stays on the same
// site and under the same API path. Auth: HTTP Basic `email:apiToken`.
//
// 429: Confluence sends Retry-After (seconds). The adapter waits it out — up to RATE_WAIT_MAX_MS in
// all, cancellable — and retries; past that it throws `rate_limited` with the wait, and the refresh
// stores it (`retryAfter`) so the background check does not ask again before then.
//
// ⚠ NEVER LOG the headers: they carry the credential.

export const CONFLUENCE_TIMEOUT_MS = 15_000;
export const CONFLUENCE_MAX_BYTES = 8 * 1024 * 1024;
export const RATE_WAIT_MAX_MS = 60_000;
const MAX_RATE_RETRIES = 3;
const LIST_PAGE_LIMIT = 250;
const SEARCH_LIMIT = 100;
const MAX_LIST_REQUESTS = 40;

export interface ConfluenceDeps {
  transport?: JiraTransport;
  /** Waits (a test passes a fake clock). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
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

export function authHeader(c: WikiCredential): string {
  const email = c.email?.trim() ?? '';
  return email !== '' ? `Basic ${Buffer.from(`${email}:${c.token}`, 'utf8').toString('base64')}` : `Bearer ${c.token}`;
}

/** Retry-After (seconds or an HTTP date) → ms, or null. */
export function retryAfterMs(raw: string | undefined, now = Date.now()): number | null {
  if (raw == null || raw.trim() === '') return null;
  const t = raw.trim();
  if (/^\d{1,6}$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const mapFetchError = (err: unknown): WikiSourceError => {
  if (err instanceof WikiSourceError) return err;
  if (err instanceof JiraFetchError) {
    switch (err.code) {
      case 'bad_url':
        return new WikiSourceError('bad_url');
      case 'blocked':
        return new WikiSourceError('blocked');
      case 'timeout':
        return new WikiSourceError('timeout');
      case 'redirect':
        return new WikiSourceError('redirect', err.status);
      case 'too_large':
        return new WikiSourceError('too_large', err.status);
      default:
        return new WikiSourceError('network');
    }
  }
  return new WikiSourceError('network');
};

/** GET one Confluence URL as JSON under the guard, honouring 429. Exported for its test. */
export async function confluenceGetJson(url: string, opts: WikiCallOptions, deps: ConfluenceDeps = {}): Promise<unknown> {
  const transport = deps.transport ?? nodeTransport;
  const sleep = deps.sleep ?? realSleep;
  let checked: URL;
  try {
    checked = checkJiraUrl(url, { cloud: true });
  } catch (err) {
    throw mapFetchError(err);
  }
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new WikiSourceError('network');
    let res;
    try {
      res = await transport(
        checked,
        { accept: 'application/json', 'user-agent': 'Limn', authorization: authHeader(opts.credential) },
        { lookup: guardedLookup(), timeoutMs: CONFLUENCE_TIMEOUT_MS, maxBytes: CONFLUENCE_MAX_BYTES },
      );
    } catch (err) {
      throw mapFetchError(err);
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers?.['retry-after']) ?? 5_000 * (attempt + 1);
      if (attempt >= MAX_RATE_RETRIES || waited + wait > RATE_WAIT_MAX_MS) throw new WikiSourceError('rate_limited', 429, wait);
      waited += wait;
      await sleep(wait, opts.signal);
      continue;
    }
    if (res.status >= 300 && res.status < 400) throw new WikiSourceError('redirect', res.status);
    if (res.status === 401) throw new WikiSourceError('unauthorized', 401);
    if (res.status === 403) throw new WikiSourceError('forbidden', 403);
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

// ---- reading the answers (defensive: the body is a stranger's JSON) ----

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const PAGE_ID = /^\d{1,20}$/;
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};
const cleanTitle = (v: unknown): string => (str(v) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled';

/** A v2 page answer → a page (exported for its test). */
export function toWikiPage(raw: unknown, origin: string): WikiPage {
  const o = obj(raw);
  const id = str(o?.id);
  if (!o || !id || !PAGE_ID.test(id)) throw new WikiSourceError('not_json');
  const version = obj(o.version);
  const body = obj(obj(o.body)?.storage);
  const links = obj(o._links);
  const webui = str(links?.webui);
  const parentId = str(o.parentId);
  return {
    id,
    title: cleanTitle(o.title),
    parentId: parentId && PAGE_ID.test(parentId) && str(o.parentType) !== 'space' ? parentId : null,
    version: num(version?.number),
    editedAt: date(version?.createdAt),
    depth: 0,
    position: num(o.position),
    body: str(body?.value) ?? '',
    webUrl: webui && webui.startsWith('/') ? `${origin}/wiki${webui}` : null,
  };
}

/** Same site, under the same API path — the only `next` links a listing follows. */
export function nextUrl(origin: string, next: unknown, prefix: string): string | null {
  const n = str(next);
  if (!n) return null;
  let u: URL;
  try {
    u = new URL(n, `${origin}/`);
  } catch {
    return null;
  }
  if (`${u.protocol}//${u.host}` !== origin) return null;
  // v2 answers `/wiki/api/v2/…`; some answer without the `/wiki` context path.
  const path = u.pathname.startsWith('/wiki/') ? u.pathname : `/wiki${u.pathname}`;
  if (!path.startsWith(prefix)) return null;
  return `${origin}${path}${u.search}`;
}

/** The CQL instant: UTC "yyyy-MM-dd HH:mm" a day early (CQL reads it in the account's own zone). */
export function cqlSince(since: Date): string {
  const d = new Date(since.getTime() - 24 * 3600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function confluenceSource(deps: ConfluenceDeps = {}): WikiSource {
  const get = (url: string, opts: WikiCallOptions): Promise<unknown> => confluenceGetJson(url, opts, deps);
  return {
    provider: 'confluence',
    resolveRef(rawUrl) {
      const a = parseConfluencePageUrl(rawUrl);
      return a ? { provider: 'confluence', origin: a.origin, host: a.host, pageId: a.pageId } : null;
    },
    async getPage(site: WikiPageRef, pageId, opts) {
      if (!PAGE_ID.test(pageId)) throw new WikiSourceError('bad_url');
      const raw = await get(`${site.origin}/wiki/api/v2/pages/${pageId}${opts.body ? '?body-format=storage' : ''}`, opts);
      return toWikiPage(raw, site.origin);
    },
    async listDescendants(site, rootId, depth, cap, opts) {
      if (!PAGE_ID.test(rootId)) throw new WikiSourceError('bad_url');
      if (depth <= 0) return { pages: [], more: false };
      const all: Array<WikiPageMeta & { type: string }> = [];
      let url: string | null = `${site.origin}/wiki/api/v2/pages/${rootId}/descendants?depth=${Math.min(5, depth)}&limit=${LIST_PAGE_LIMIT}`;
      for (let n = 0; url && n < MAX_LIST_REQUESTS; n++) {
        const raw = obj(await get(url, opts));
        const results = Array.isArray(raw?.results) ? raw!.results : [];
        for (const r of results) {
          const o = obj(r);
          const id = str(o?.id);
          if (!o || !id || !PAGE_ID.test(id)) continue;
          if (str(o.status) && str(o.status) !== 'current') continue;
          const parent = str(o.parentId);
          all.push({
            id,
            type: str(o.type) ?? 'page',
            title: cleanTitle(o.title),
            parentId: parent && PAGE_ID.test(parent) ? parent : null,
            version: null,
            editedAt: null,
            depth: num(o.depth) ?? 1,
            position: num(o.childPosition),
          });
        }
        url = nextUrl(site.origin, obj(raw?._links)?.next, `/wiki/api/v2/pages/${rootId}/descendants`);
      }
      return orderTree(rootId, all, depth, cap);
    },
    async changedSince(site, rootId, since, opts) {
      if (!PAGE_ID.test(rootId)) throw new WikiSourceError('bad_url');
      const cql = `ancestor = ${rootId} AND type = page AND lastmodified > "${cqlSince(since)}"`;
      const out: WikiPageMeta[] = [];
      let url: string | null = `${site.origin}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=version&limit=${SEARCH_LIMIT}`;
      for (let n = 0; url && n < MAX_LIST_REQUESTS; n++) {
        const raw = obj(await get(url, opts));
        const results = Array.isArray(raw?.results) ? raw!.results : [];
        for (const r of results) {
          const o = obj(r);
          const id = str(o?.id);
          if (!o || !id || !PAGE_ID.test(id)) continue;
          const v = obj(o.version);
          out.push({ id, title: cleanTitle(o.title), parentId: null, version: num(v?.number), editedAt: date(v?.when), depth: 0, position: null });
        }
        url = nextUrl(site.origin, obj(raw?._links)?.next, '/wiki/rest/api/content/search');
      }
      return out;
    },
    toMarkdown: (page) => storageToMarkdown(page.body),
    pageUrl: (site, pageId) => `${site.origin}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`,
  };
}

/**
 * The listing → PAGES in reading order (depth-first, siblings by position), each with its nearest
 * PAGE ancestor as its parent (a folder or whiteboard between them is transparent and never listed),
 * its depth recounted over pages only, and the cap applied in reading order. Exported for its test.
 */
export function orderTree(
  rootId: string,
  items: ReadonlyArray<WikiPageMeta & { type: string }>,
  depth: number,
  cap: number,
): { pages: WikiPageMeta[]; more: boolean } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<string, Array<WikiPageMeta & { type: string }>>();
  for (const i of items) {
    const p = i.parentId ?? rootId;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(i);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const out: WikiPageMeta[] = [];
  let more = false;
  const seen = new Set<string>([rootId]);
  // Iterative DFS (a stranger's tree may be deep); `pageParent` is the nearest page above.
  const stack: Array<{ id: string; pageParent: string; pageDepth: number }> = [];
  const pushKids = (of: string, pageParent: string, pageDepth: number): void => {
    const list = kids.get(of) ?? [];
    for (let k = list.length - 1; k >= 0; k--) stack.push({ id: list[k]!.id, pageParent, pageDepth });
  };
  pushKids(rootId, rootId, 0);
  while (stack.length > 0) {
    const { id, pageParent, pageDepth } = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    if (!item) continue;
    if (item.type === 'page') {
      const d = pageDepth + 1;
      if (d > depth) continue;
      if (out.length >= cap) {
        more = true;
        continue;
      }
      out.push({ id, title: item.title, parentId: pageParent, version: null, editedAt: null, depth: d, position: item.position });
      pushKids(id, id, d);
    } else {
      pushKids(id, pageParent, pageDepth);
    }
  }
  return { pages: out, more };
}
