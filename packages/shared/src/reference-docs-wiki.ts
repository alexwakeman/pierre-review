// WIKI SOURCES FOR THE REFERENCE LIBRARY (docs/REFERENCE-DOCS.md § Wiki sources). A page tree in a
// team wiki — Confluence Cloud today, Notion next — imported as ONE document: the root page and its
// child pages become the document's chapters. The server keeps one row per page (its version and a
// hash of its converted text) so a refresh re-reads only the pages that changed and re-summarises only
// the sections whose text changed.

/** The wikis Limn can read. Each is one `WikiSource` adapter on the server. */
export type WikiProviderId = 'confluence' | 'notion';

export const WIKI_PROVIDER_NAMES: Record<WikiProviderId, string> = { confluence: 'Confluence', notion: 'Notion' };

/** Every wiki, in the order the SPA lists them. */
export const WIKI_PROVIDERS: readonly WikiProviderId[] = ['confluence', 'notion'];

/** Child-page levels an import may include (0 = the page only). The crawl's 1–3, reused. */
export const REFERENCE_DOC_WIKI_MAX_DEPTH = 3;
/** The most pages one wiki document holds, the root included. Past it the rest are left out (counted). */
export const REFERENCE_DOC_WIKI_MAX_PAGES = 100;

/** Why the wiki could not be read on the last check. The last built version stays readable. */
export type WikiUnreachableReason = 'not_found' | 'forbidden' | 'unauthorized' | 'no_credential' | 'network' | 'rate_limited';

export interface ReferenceDocWiki {
  provider: WikiProviderId;
  /** The wiki site's host, e.g. `acme.atlassian.net`. */
  site: string;
  rootPageId: string;
  /** The page address the reader added. */
  rootUrl: string;
  /** Child-page levels included (0 = the page only). */
  depth: number;
  /** Pages in the last built version; null before the first build. */
  pageCount: number | null;
  /** Child pages past REFERENCE_DOC_WIKI_MAX_PAGES left out of the last build. */
  pagesLeftOut: number;
  /** When Limn last asked the wiki whether anything changed (successfully). */
  lastCheckedAt: string | null;
  /** The newest page edit in the built version, as the wiki reports it. */
  lastChangedAt: string | null;
  /** Set while the wiki cannot be reached: the first failed check since the last good one. */
  unreachableSince: string | null;
  unreachableReason: WikiUnreachableReason | null;
}

/**
 * STORED on the document row (`reference_docs.wiki_json`) — the server's own record; the wire shape
 * (`ReferenceDocWiki`) is folded from it. Timestamps are epoch ms. `lastListedAt` drives the daily
 * full id-list read (adds, moves, deletes); `lastCheckedAt` is the `since` of the cheap change check.
 */
export interface ReferenceDocWikiState {
  provider: WikiProviderId;
  /** `https://<host>` — the site root. */
  origin: string;
  rootPageId: string;
  rootUrl: string;
  depth: number;
  pageCount: number | null;
  pagesLeftOut: number;
  lastCheckedAt: number | null;
  lastListedAt: number | null;
  lastChangedAt: number | null;
  unreachableSince: number | null;
  unreachableReason: WikiUnreachableReason | null;
  /** Not before this instant (a 429's Retry-After): the background check waits for it. */
  retryAfter: number | null;
}

/**
 * STORED (`reference_docs.summary_cache_json`): what the last successful build said, keyed so an
 * unchanged section is never summarised again. `sections` maps a section's content hash (its title,
 * trail and text) to its one-line summary; `doc` is the document's summary and topics.
 */
export interface ReferenceDocSummaryCache {
  v: 1;
  sections: Record<string, string>;
  doc: { title: string; summary: string; topics: string[] } | null;
}

/** POST /api/docs/wiki — add a wiki page (and, optionally, its child pages) as one document. */
export interface AddReferenceDocWikiBody {
  /** Absent ⇒ the default workspace. */
  workspaceId?: number;
  url: string;
  /** Child-page levels to include, 1 to REFERENCE_DOC_WIKI_MAX_DEPTH. Absent / 0 ⇒ the page only. */
  childDepth?: number;
}

/** GET / PUT /api/workspaces/:id/wiki-credentials. ⚠ The token is write-only: never returned. */
export interface WikiCredentialsSettings {
  workspaceId: number;
  confluence: {
    /** The Confluence site this token is for, e.g. `https://acme.atlassian.net`. */
    siteUrl: string | null;
    email: string | null;
    hasToken: boolean;
    /** The workspace's Jira site (host), when Jira is its tracker with an email and a token: a
     *  Confluence page on that same host is read with the Jira credential. Null otherwise. */
    jiraSite: string | null;
  };
  /** Notion: ONE internal-integration token per workspace (api.notion.com is the only host). */
  notion: {
    hasToken: boolean;
  };
}

/** PUT body: a partial patch of one wiki or both. `token: null` removes the saved token; absent leaves it. */
export interface WikiCredentialsUpdate {
  confluence?: { siteUrl?: string | null; email?: string | null; token?: string | null };
  notion?: { token?: string | null };
}

/** POST /api/workspaces/:id/wiki-credentials/check body. Absent provider ⇒ Confluence. */
export interface WikiCredentialsCheckBody {
  provider?: WikiProviderId;
}

/**
 * A Notion internal-integration token's shape: `ntn_…` (issued since September 2024) or the older
 * `secret_…`, then letters and digits. Checked before saving, so a pasted page address or a stray
 * word never becomes the stored token.
 */
export const NOTION_TOKEN_RE = /^(?:secret_|ntn_)[A-Za-z0-9]{20,200}$/;

/** POST /api/workspaces/:id/wiki-credentials/check — one read with the saved credential. */
export interface WikiCredentialsCheckResponse {
  ok: boolean;
  message: string;
}

export interface ConfluencePageAddress {
  /** `https://<host>` — Confluence Cloud's site root (the API lives under `/wiki/api/v2`). */
  origin: string;
  host: string;
  pageId: string;
}

/**
 * A Confluence Cloud PAGE address → its site and page id, or null when the address names no page.
 * Accepted: `/wiki/spaces/<KEY>/pages/<id>[/<title>]`, `/wiki/spaces/<KEY>/pages/edit-v2/<id>`,
 * `/wiki/pages/viewpage.action?pageId=<id>` (+ `/wiki/pages/edit-v2/<id>`). https only. A short
 * link (`/wiki/x/…`) or a space's home names no page id and is not accepted. Pure: the SPA uses it to
 * route a pasted address to the wiki import, the server to resolve it.
 */
// The WHATWG URL both runtimes have; this package carries no DOM or Node lib types (claude-review.ts precedent).
interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  host: string;
  pathname: string;
  searchParams: { get(name: string): string | null };
}
declare const URL: new (input: string) => ParsedUrl;

export function parseConfluencePageUrl(raw: string): ConfluencePageAddress | null {
  let u: ParsedUrl;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  const host = u.hostname.toLowerCase();
  if (host === '' || !host.includes('.')) return null;
  const path = u.pathname;
  if (!path.startsWith('/wiki/')) return null;
  let id: string | null = null;
  const spaced = /^\/wiki\/spaces\/[^/]+\/pages\/(?:edit-v2\/|edit\/)?(\d{1,20})(?:\/|$)/.exec(path);
  if (spaced) id = spaced[1]!;
  const loose = /^\/wiki\/pages\/(?:edit-v2\/|edit\/)?(\d{1,20})(?:\/|$)/.exec(path);
  if (!id && loose) id = loose[1]!;
  if (!id && /^\/wiki\/pages\/viewpage\.action$/.test(path)) {
    const q = u.searchParams.get('pageId');
    if (q && /^\d{1,20}$/.test(q)) id = q;
  }
  if (!id) return null;
  return { origin: `https://${u.host.toLowerCase()}`, host: u.host.toLowerCase(), pageId: id };
}

export interface NotionPageAddress {
  /** Always `https://www.notion.so` — Notion's own address for any page, whatever host it was pasted from. */
  origin: string;
  host: string;
  /** The page id as Notion's API writes it: a lower-case, dashed UUID. */
  pageId: string;
}

const NOTION_HOSTS = /^(?:www\.)?notion\.(?:so|com)$|^[a-z0-9-]{1,63}\.notion\.site$/;
const HEX32 = /^[0-9a-f]{32}$/;
const DASHED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 32 hex digits (or the dashed UUID form) → the dashed lower-case UUID, or null. */
export function notionIdOf(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  const bare = DASHED_ID.test(t) ? t.replace(/-/g, '') : t;
  if (!HEX32.test(bare)) return null;
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
}

/**
 * A Notion PAGE address (or a bare page id) → its id, or null. Accepted: `notion.so` / `www.notion.so` /
 * `notion.com` / `<name>.notion.site` addresses whose last path segment ENDS in the 32-hex id (with or
 * without dashes) — `/Title-<id>`, `/<workspace>/Title-<id>`, `/<id>` — and a page opened from a
 * database (`?p=<id>`). A database VIEW (`?v=…` with no `p`) names no page and is refused; so is any
 * other host, http, or credentials in the address. Pure: the SPA routes a pasted address with it, the
 * server resolves it.
 */
export function parseNotionPageUrl(raw: string): NotionPageAddress | null {
  const text = raw.trim();
  const out = (id: string | null): NotionPageAddress | null => (id ? { origin: 'https://www.notion.so', host: 'www.notion.so', pageId: id } : null);
  if (!text.includes('/') && !text.includes('.')) return out(notionIdOf(text));
  let u: ParsedUrl;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  if (!NOTION_HOSTS.test(u.hostname.toLowerCase())) return null;
  const peek = u.searchParams.get('p');
  if (peek) return out(notionIdOf(peek));
  if (u.searchParams.get('v')) return null;
  const segs = u.pathname.split('/').filter((x) => x !== '');
  const last = segs[segs.length - 1];
  if (!last) return null;
  const tail = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(last);
  return tail ? out(notionIdOf(tail[1]!)) : null;
}

/** Which wiki a pasted address names (Confluence or Notion), or null for an ordinary web page. Pure. */
export function wikiProviderOfUrl(raw: string): WikiProviderId | null {
  if (parseConfluencePageUrl(raw)) return 'confluence';
  if (parseNotionPageUrl(raw)) return 'notion';
  return null;
}

/** "Can't reach this page in Confluence since 3 Oct"— the document line's words for a failed check. */
export function wikiUnreachableWords(provider: WikiProviderId, reason: WikiUnreachableReason): string {
  const name = WIKI_PROVIDER_NAMES[provider];
  switch (reason) {
    case 'not_found':
      return `The page is gone from ${name}, or the saved token cannot see it.`;
    case 'forbidden':
      return `The saved ${name} token may not read this page.`;
    case 'unauthorized':
      return provider === 'notion' ? 'Notion did not accept the saved token.' : `${name} did not accept the saved email and token.`;
    case 'no_credential':
      return provider === 'notion'
        ? 'Add a Notion token in Settings → AI review → Notion.'
        : `Add a ${name} API token in Settings → AI review → ${name}.`;
    case 'rate_limited':
      return `${name} asked Limn to slow down. It will try again later.`;
    case 'network':
    default:
      return `${name} could not be reached.`;
  }
}
