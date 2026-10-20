import { createHash } from 'node:crypto';
import {
  REFERENCE_DOC_CRAWL_MAX_PAGES,
  REFERENCE_DOC_CRAWL_MIN_SCORE,
  REFERENCE_DOC_MAX_BYTES,
  type ReferenceDocCrawlSkipped,
} from '@pierre-review/shared';
import { ALLOW_ALL, DISALLOW_ALL, ROBOTS_MAX_BYTES, parseRobots, robotsAllows, type RobotsRules } from './robots.js';
import { UrlFetchError, type FetchedPage } from './url-fetch.js';

// FOLLOWING LINKS FROM A WEB PAGE (docs/REFERENCE-DOCS.md § Following links). A crawl reads the start
// page, asks Claude which of its links are worth reading for the same topic, reads those, and repeats
// to the depth the reader chose. The whole crawl becomes ONE document (each page a chapter), built by
// the ordinary pipeline. This module is the crawl itself: pure, with every side effect (the guarded
// fetch, the model, the clock, sleeping) injected, so the trap guards are tested without a network.
//
// THE RULES
//   • SAME SITE ONLY: a link is followed only on the start page's exact host (and port). `www.` is
//     NOT folded into the bare domain — they can be different servers. An http link on an https site
//     is upgraded; an https site never steps down to http.
//   • WEB PAGES ONLY: an address whose extension names a file (PDF, image, archive, feed, script…) is
//     dropped before any request, and a fetched page must say `text/html` or `application/xhtml+xml`
//     and decode as text. Each linked page is read under CRAWL_PAGE_MAX_BYTES.
//   • NO LOOPS: every address is NORMALISED (fragment dropped, tracking parameters dropped, query
//     sorted, `index.html` and a trailing slash folded, scheme ignored) into a key, and a key is read
//     at most once — including the address a redirect lands on and the page's own canonical link.
//     Two pages with the same text are read once. Addresses shaped like traps (very long, very deep,
//     a path segment repeated three times, many query parameters, deep pagination, calendars) are
//     dropped.
//   • ROBOTS.TXT is read once and obeyed, for the start page too and for the address a redirect
//     lands on (robots.ts). A 4xx robots.txt means no rules; one that is UNREACHABLE (5xx, timeout,
//     network failure) means read nothing past the start page's refusal (RFC 9309 § 2.3.1.4). Requests are spaced by
//     the site's Crawl-delay (capped at 5 s), else CRAWL_POLITE_MS.
//   • CLAUDE PICKS THE LINKS: each level's candidate links (anchor text, address, the heading above
//     the link) go to ONE ranking call per CRAWL_RANK_BATCH links (crawl-rank.ts), scored 0-3 for the
//     START page's topic; only links scoring REFERENCE_DOC_CRAWL_MIN_SCORE or more are followed, best
//     first, until the page cap. An unranked link is never followed.
//   • CAPS: REFERENCE_DOC_CRAWL_MAX_PAGES pages (the start page included), CRAWL_MAX_MS of wall clock,
//     REFERENCE_DOC_MAX_BYTES of HTML in all, CRAWL_MAX_LINKS_PER_PAGE links read off one page.

export const CRAWL_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const CRAWL_MAX_LINKS_PER_PAGE = 300;
export const CRAWL_RANK_BATCH = 80;
/** The most candidate links ranked for one level (two ranking calls). */
export const CRAWL_RANK_MAX_PER_LEVEL = 160;
export const CRAWL_MAX_MS = 3 * 60_000;
export const CRAWL_POLITE_MS = 500;
export const CRAWL_MAX_URL_CHARS = 400;
export const CRAWL_MAX_SEGMENTS = 12;
export const CRAWL_MAX_QUERY_PARAMS = 4;
export const CRAWL_MAX_PAGINATION = 5;

// ---- addresses ----

const TRACKING_PARAM = /^(?:utm_.*|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|_ga|_gl|ref|ref_src|igshid|yclid)$/i;
const NON_WEB_SCHEME = /^(?:mailto|javascript|tel|sms|data|ftp|file|blob|about|vbscript):/i;

export interface NormalizedUrl {
  /** What is fetched: resolved, fragment and tracking parameters gone, query sorted. */
  url: URL;
  /** What identifies the page: host + folded path + query (scheme ignored). */
  key: string;
}

/** Resolve and clean a link. Null for anything that is not an http(s) address. */
export function normalizeUrl(raw: string, base?: string | URL): NormalizedUrl | null {
  const trimmed = raw.trim();
  if (trimmed === '' || NON_WEB_SCHEME.test(trimmed)) return null;
  let u: URL;
  try {
    u = base != null ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  u.hash = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  params.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.(?:html?|php)$/i, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { url: u, key: `${u.host}${path}${u.search}` };
}

const NON_HTML_EXT = new Set([
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'dmg', 'exe', 'msi', 'pkg', 'deb', 'rpm', 'apk', 'iso', 'bin',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'm4a',
  'css', 'js', 'mjs', 'map', 'json', 'xml', 'rss', 'atom', 'csv', 'tsv', 'yaml', 'yml', 'txt', 'md',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub',
  'wasm', 'jar', 'dll', 'so', 'class', 'ics', 'vcf', 'swf',
]);

/** Does the address name a file rather than a page (decided before any request)? */
export function looksNonHtml(u: URL): boolean {
  const last = u.pathname.split('/').pop() ?? '';
  const m = /\.([a-z0-9]{1,6})$/i.exec(last);
  if (m && NON_HTML_EXT.has(m[1]!.toLowerCase())) return true;
  return /(?:^|\/)(?:feed|rss|atom)(?:\/|$)/i.test(u.pathname);
}

const PAGINATION_PARAM = /^(?:page|p|pg|paged|pagenum|page_num)$/i;
const CALENDAR_PARAM = /^(?:date|day|month|year|week|cal|calendar|ical|from|to)$/i;

/** Is the address shaped like a crawler trap? */
export function looksLikeTrap(u: URL): boolean {
  if (u.href.length > CRAWL_MAX_URL_CHARS) return true;
  const segments = u.pathname.split('/').filter((s) => s !== '');
  if (segments.length > CRAWL_MAX_SEGMENTS) return true;
  const counts = new Map<string, number>();
  for (const s of segments) {
    const n = (counts.get(s) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(s, n);
  }
  const keys = [...u.searchParams.keys()];
  if (keys.length > CRAWL_MAX_QUERY_PARAMS) return true;
  for (const [k, v] of u.searchParams) {
    if (PAGINATION_PARAM.test(k) && Number(v) > CRAWL_MAX_PAGINATION) return true;
    if (CALENDAR_PARAM.test(k)) return true;
  }
  // A dated archive deeper than year/month/day (e.g. /2026/10/20/14/…): the calendar trap in a path.
  if (/\/(?:19|20)\d{2}\/\d{1,2}\/\d{1,2}\/\d{1,2}(?:\/|$)/.test(u.pathname)) return true;
  // Pagination in the path past the cap (/page/40).
  const pm = /\/page\/(\d+)(?:\/|$)/i.exec(u.pathname);
  if (pm && Number(pm[1]) > CRAWL_MAX_PAGINATION) return true;
  return false;
}

// ---- reading a page ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// ⚠ EVERY SCANNER HERE IS LINEAR. A page is untrusted and up to 25 MB, and the matching is synchronous,
// so a lazy `<a>[\s\S]*?</a>` over 70,000 UNCLOSED `<a>` (each attempt scanning to the end of the
// page) stalled the local server for seconds, where neither cancel nor CRAWL_MAX_MS can reach. Spans
// are found by a forward search from the open tag (bounded to SPAN_WINDOW for a link or heading), and
// attribute runs stop at the next `<` as well as `>`, so no attempt can rescan the rest of the page.

/** How far past an `<a>` or `<hN>` its close is looked for; anchor and heading text is far shorter. */
export const SPAN_WINDOW = 8 * 1024;
/** Links are read off at most this much of one page (the start page may be larger). */
export const CRAWL_LINK_SCAN_BYTES = 2 * 1024 * 1024;

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs.slice(0, 4096));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const closeRes = new Map<string, RegExp>();
/** A global, case-insensitive matcher for `</tag>` (whitespace allowed before the `>`). */
function closeRe(tag: string): RegExp {
  let re = closeRes.get(tag);
  if (!re) {
    re = new RegExp(`<\\/${tag}\\s*>`, 'gi');
    closeRes.set(tag, re);
  }
  return re;
}

/** The next `</tag>` at or after `from` (within `limit` characters when given): [start, end] or null. */
function findClose(s: string, tag: string, from: number, limit?: number): [number, number] | null {
  const re = closeRe(tag);
  if (limit == null) {
    re.lastIndex = from;
    const m = re.exec(s);
    return m ? [m.index, m.index + m[0].length] : null;
  }
  // Copy only the window (a slice from 0 on every anchor would itself be quadratic).
  re.lastIndex = 0;
  const m = re.exec(s.slice(from, from + limit));
  return m ? [from + m.index, from + m.index + m[0].length] : null;
}

/** The first whole `<tag …>…</tag>` element, or null. One forward search: no later open can close either. */
function firstElement(html: string, tag: string): { whole: string; inner: string } | null {
  const open = new RegExp(`<${tag}(?:[\\s>][^<>]*)?>`, 'i').exec(html);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  const close = findClose(html, tag, innerStart);
  if (!close) return null;
  return { whole: html.slice(open.index, close[1]), inner: html.slice(innerStart, close[0]) };
}

/** The page's main content when it marks one (the same narrowing as htmlToMarkdown). */
function mainRegion(html: string): string | null {
  return firstElement(html, 'main')?.whole ?? firstElement(html, 'article')?.whole ?? null;
}

/** Drop script/style/noscript/template/svg elements and comments, in one forward pass. */
function dropNoise(html: string): string {
  const out: string[] = [];
  const open = /<(script|style|noscript|template|svg)\b|<!--/gi;
  const dead = new Set<string>(); // a tag with no close left after some point has none later either
  let pos = 0;
  let m: RegExpExecArray | null;
  open.lastIndex = 0;
  while ((m = open.exec(html)) != null) {
    const start = m.index;
    let end: number | null = null;
    if (m[0] === '<!--') {
      if (!dead.has('--')) {
        const c = html.indexOf('-->', start + 4);
        if (c < 0) dead.add('--');
        else end = c + 3;
      }
    } else {
      const tag = m[1]!.toLowerCase();
      if (!dead.has(tag)) {
        const c = findClose(html, tag, start + m[0].length);
        if (!c) dead.add(tag);
        else end = c[1];
      }
    }
    if (end == null) continue; // unclosed: left in place, exactly as the old lazy match did
    out.push(html.slice(pos, start), ' ');
    pos = end;
    open.lastIndex = end;
  }
  out.push(html.slice(pos));
  return out.join('');
}

export function pageTitle(html: string): string | null {
  const t = firstElement(html.slice(0, 200_000), 'title');
  const title = t ? stripTags(t.inner) : '';
  if (title) return title.slice(0, 200);
  const h = firstElement(html, 'h1');
  const h1 = h ? stripTags(h.inner) : '';
  return h1 ? h1.slice(0, 200) : null;
}

/** The page's readable text (main content when marked), for the ranking excerpt and the duplicate check. */
export function pageText(html: string): string {
  const clean = dropNoise(html);
  return stripTags(mainRegion(clean) ?? clean);
}

export interface PageLink {
  url: URL;
  key: string;
  /** Anchor text (or its title / aria-label), at most 120 characters. */
  text: string;
  /** The nearest heading above the link, when there is one. */
  heading: string | null;
}

export interface PageLinks {
  links: PageLink[];
  /** The page's own `<link rel="canonical">`, resolved. */
  canonical: NormalizedUrl | null;
}

/**
 * Every `<a>` and `<hN>` in document order, linearly: each close must sit within SPAN_WINDOW of its
 * open tag. The next close of each tag is remembered and only searched for again once the scan has
 * passed it, so the search position only moves forward (one pass over the region per tag). An anchor
 * whose close is not found keeps its attributes with empty text; a heading whose close is not found
 * is skipped. Either way the scan moves on past the open tag. `stop()` ends the scan early.
 */
function scanAnchorsAndHeadings(
  region: string,
  onAnchor: (attrs: string, inner: string) => void,
  onHeading: ((inner: string) => void) | null,
  stop: () => boolean,
): void {
  const open = onHeading ? /<(?:(h[1-6])|a)\b([^<>]*)>/gi : /<()a\b([^<>]*)>/gi;
  const nextClose = new Map<string, [number, number] | null>();
  const closeAfter = (tag: string, from: number): [number, number] | null => {
    const cached = nextClose.get(tag);
    if (cached === null) return null; // none left anywhere after an earlier point
    if (cached && cached[0] >= from) return cached;
    const found = findClose(region, tag, from);
    nextClose.set(tag, found);
    return found;
  };
  let m: RegExpExecArray | null;
  open.lastIndex = 0;
  while (!stop() && (m = open.exec(region)) != null) {
    const after = m.index + m[0].length;
    const tag = m[1] ? m[1].toLowerCase() : 'a';
    const c = closeAfter(tag, after);
    const close = c && c[0] - after <= SPAN_WINDOW ? c : null;
    const inner = close ? region.slice(after, close[0]) : '';
    if (tag === 'a') onAnchor(m[2] ?? '', inner);
    else if (close) onHeading!(inner);
    open.lastIndex = close ? close[1] : after;
  }
}

function linksIn(region: string, base: URL, out: PageLink[], seen: Set<string>): void {
  let heading: string | null = null;
  const take = (attrs: string, inner: string): void => {
    if (out.length >= CRAWL_MAX_LINKS_PER_PAGE) return;
    const href = attr(attrs, 'href');
    if (href == null) return;
    if (/\bnofollow\b/i.test(attr(attrs, 'rel') ?? '')) return;
    if (/(?:^|\s)download(?:\s|=|$)/i.test(attrs)) return;
    const n = normalizeUrl(href, base);
    if (!n || seen.has(n.key)) return;
    seen.add(n.key);
    const text = (stripTags(inner) || attr(attrs, 'aria-label') || attr(attrs, 'title') || '').slice(0, 120);
    out.push({ url: n.url, key: n.key, text, heading });
  };
  const full = (): boolean => out.length >= CRAWL_MAX_LINKS_PER_PAGE;
  scanAnchorsAndHeadings(
    region,
    take,
    (inner) => {
      heading = stripTags(inner).slice(0, 120) || heading;
      // A link inside the heading itself.
      scanAnchorsAndHeadings(inner, take, null, full);
    },
    full,
  );
}

/**
 * The page's links: those in its main content first (document order), then the rest of the page (a
 * documentation site's sidebar is often the best map of it). Deduplicated by key, capped.
 */
export function extractLinks(html: string, pageUrl: string): PageLinks {
  const clean = dropNoise(html.slice(0, CRAWL_LINK_SCAN_BYTES));
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return { links: [], canonical: null };
  }
  const baseTag = /<base\b([^<>]*)>/i.exec(clean);
  const baseHref = baseTag ? attr(baseTag[1]!, 'href') : null;
  if (baseHref) {
    const b = normalizeUrl(baseHref, base);
    if (b) base = b.url;
  }
  let canonical: NormalizedUrl | null = null;
  for (const m of clean.matchAll(/<link\b([^<>]*)>/gi)) {
    if (/\bcanonical\b/i.test(attr(m[1]!, 'rel') ?? '')) {
      const href = attr(m[1]!, 'href');
      canonical = href ? normalizeUrl(href, base) : null;
      break;
    }
  }
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const main = mainRegion(clean);
  if (main) linksIn(main, base, out, seen);
  const body = /<body[\s>][\s\S]*$/i.exec(clean)?.[0] ?? clean;
  linksIn(body, base, out, seen);
  return { links: out, canonical };
}

// ---- the crawl ----

export interface CrawledPage {
  url: string;
  title: string | null;
  /** Link hops from the start page (0 = the start page). */
  depth: number;
  html: string;
}

export interface RankLink {
  i: number;
  text: string;
  heading: string | null;
  /** Path + query (the host is the start page's). */
  path: string;
}

export interface RankRequest {
  topic: { title: string; url: string; excerpt: string };
  links: RankLink[];
}

export interface RankAnswer {
  /** Score per link index; null when the answer could not be read (every link then counts as low value). */
  scores: Map<number, number> | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export type RankFn = (req: RankRequest) => Promise<RankAnswer>;

/** The crawl cannot go on; the message is one sentence for the reader. */
export class CrawlRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlRefusal';
  }
}

export interface CrawlSeams {
  /** The guarded fetch (url-fetch.ts `fetchPage`), with a body cap. Throws on any failure. */
  fetch: (url: string, maxBytes: number) => Promise<FetchedPage>;
  rank: RankFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** After each page read: pages read so far, and the cap. */
  onProgress?: (read: number, max: number) => void;
}

export type CrawlOutcome =
  | {
      kind: 'crawl';
      pages: CrawledPage[];
      skipped: ReferenceDocCrawlSkipped;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }
  /** The start page is not HTML (a PDF, text…): the build reads it as a single page, as without a crawl. */
  | { kind: 'single'; page: FetchedPage };

export const emptySkipped = (): ReferenceDocCrawlSkipped => ({
  offSite: 0,
  notHtml: 0,
  robots: 0,
  lowValue: 0,
  overCap: 0,
  duplicate: 0,
  trap: 0,
  failed: 0,
});

export const isHtmlContentType = (ct: string): boolean => /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(ct);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

function decodeHtml(buf: Buffer): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch {
    return null;
  }
}

async function readRobots(seams: CrawlSeams, origin: string): Promise<RobotsRules> {
  try {
    const res = await seams.fetch(`${origin}/robots.txt`, ROBOTS_MAX_BYTES);
    if (isHtmlContentType(res.contentType)) return ALLOW_ALL; // a site that answers every path with a page
    const text = decodeHtml(res.body);
    return text == null ? ALLOW_ALL : parseRobots(text);
  } catch (err) {
    // RFC 9309 § 2.3.1.4: a server error or no answer at all means "assume complete disallow".
    // A 4xx, a redirect off the host, or a file too large to read means "no rules" (§ 2.3.1.3).
    if (err instanceof UrlFetchError) {
      if (err.code === 'timeout' || err.code === 'network') return DISALLOW_ALL;
      if (err.code === 'http' && err.status != null && err.status >= 500) return DISALLOW_ALL;
    }
    return ALLOW_ALL;
  }
}

const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function crawlSite(startRaw: string, depth: number, seams: CrawlSeams, maxPages: number = REFERENCE_DOC_CRAWL_MAX_PAGES): Promise<CrawlOutcome> {
  const now = seams.now ?? Date.now;
  const sleep = seams.sleep ?? defaultSleep;
  const started = now();
  const start = normalizeUrl(startRaw);
  if (!start) throw new CrawlRefusal('That is not a web address Limn can read. Use an http or https address.');
  const siteHost = start.url.host;
  const secure = start.url.protocol === 'https:';
  const aborted = (): boolean => seams.signal?.aborted === true;
  const skipped = emptySkipped();
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const robots = await readRobots(seams, start.url.origin);
  const gapMs = robots.crawlDelayMs ?? CRAWL_POLITE_MS;
  if (robots === DISALLOW_ALL) throw new CrawlRefusal('This site’s robots.txt did not answer, so Limn will not crawl it. Try again later.');
  if (!robotsAllows(robots, start.url.pathname + start.url.search)) {
    throw new CrawlRefusal('This site asks robots not to read that page.');
  }
  if (aborted()) throw new CrawlRefusal('Cancelled.');

  const first = await seams.fetch(start.url.href, REFERENCE_DOC_MAX_BYTES);
  if (!isHtmlContentType(first.contentType)) return { kind: 'single', page: first };
  const firstHtml = decodeHtml(first.body);
  if (firstHtml == null) return { kind: 'single', page: first };

  // Keys of every page read (requested, landed-on and canonical), and of every link already counted
  // in a skip bucket or queued — so one address is counted, and read, once.
  const visited = new Set<string>([start.key]);
  const counted = new Set<string>();
  const texts = new Set<string>();
  const firstLanded = normalizeUrl(first.url);
  if (firstLanded) visited.add(firstLanded.key);
  // A start page that redirected somewhere robots.txt disallows: it was read before we could know,
  // so it is not kept.
  if (firstLanded && firstLanded.key !== start.key && !robotsAllows(robots, firstLanded.url.pathname + firstLanded.url.search)) {
    throw new CrawlRefusal('This site asks robots not to read that page.');
  }
  const firstLinks = extractLinks(firstHtml, first.url);
  if (firstLinks.canonical && firstLinks.canonical.url.host === siteHost) visited.add(firstLinks.canonical.key);
  const firstText = pageText(firstHtml);
  texts.add(textHash(firstText));

  const startPage: CrawledPage = { url: first.url, title: pageTitle(firstHtml), depth: 0, html: firstHtml };
  const pages: CrawledPage[] = [startPage];
  let totalBytes = first.body.length;
  seams.onProgress?.(pages.length, maxPages);
  const topic = { title: startPage.title ?? first.url, url: first.url, excerpt: firstText.slice(0, 1500) };

  let frontier: Array<{ page: CrawledPage; links: PageLink[] }> = [{ page: startPage, links: firstLinks.links }];
  let lastFetchAt = now();
  let outOfTime = false;

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    if (aborted()) throw new CrawlRefusal('Cancelled.');
    // 1. The level's candidates: every link off the previous level's pages that may be followed.
    const candidates: PageLink[] = [];
    for (const { links } of frontier) {
      for (const raw of links) {
        let link = raw;
        if (counted.has(link.key)) continue;
        if (link.url.host !== siteHost) {
          counted.add(link.key);
          skipped.offSite += 1;
          continue;
        }
        if (secure && link.url.protocol === 'http:') {
          const up = new URL(link.url.href);
          up.protocol = 'https:';
          link = { ...link, url: up };
        }
        counted.add(link.key);
        if (visited.has(link.key)) skipped.duplicate += 1;
        else if (looksNonHtml(link.url)) skipped.notHtml += 1;
        else if (looksLikeTrap(link.url)) skipped.trap += 1;
        else if (!robotsAllows(robots, link.url.pathname + link.url.search)) skipped.robots += 1;
        else candidates.push(link);
      }
    }
    // The same caps the read loop checks, BEFORE ranking: a level that cannot read anything must not
    // pay for a ranking call whose every answer is then thrown away.
    if (pages.length >= maxPages || outOfTime || now() - started > CRAWL_MAX_MS || totalBytes >= REFERENCE_DOC_MAX_BYTES) {
      skipped.overCap += candidates.length;
      break;
    }
    const ranked = candidates.slice(0, CRAWL_RANK_MAX_PER_LEVEL);
    skipped.overCap += candidates.length - ranked.length;

    // 2. Claude scores them for the start page's topic; only the high scorers are followed.
    const scored: Array<{ link: PageLink; score: number; order: number }> = [];
    for (let off = 0; off < ranked.length; off += CRAWL_RANK_BATCH) {
      if (aborted()) throw new CrawlRefusal('Cancelled.');
      const batch = ranked.slice(off, off + CRAWL_RANK_BATCH);
      const answer = await seams.rank({
        topic,
        links: batch.map((l, i) => ({ i, text: l.text, heading: l.heading, path: `${l.url.pathname}${l.url.search}` })),
      });
      costUsd += answer.costUsd;
      inputTokens += answer.inputTokens;
      outputTokens += answer.outputTokens;
      batch.forEach((link, i) => {
        const score = answer.scores?.get(i) ?? 0;
        if (score >= REFERENCE_DOC_CRAWL_MIN_SCORE) scored.push({ link, score, order: off + i });
        else skipped.lowValue += 1;
      });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);

    // 3. Read them, best first, until the page cap.
    const next: Array<{ page: CrawledPage; links: PageLink[] }> = [];
    for (let idx = 0; idx < scored.length; idx += 1) {
      const { link } = scored[idx]!;
      if (aborted()) throw new CrawlRefusal('Cancelled.');
      if (pages.length >= maxPages || outOfTime || now() - started > CRAWL_MAX_MS || totalBytes >= REFERENCE_DOC_MAX_BYTES) {
        outOfTime = outOfTime || now() - started > CRAWL_MAX_MS;
        skipped.overCap += scored.length - idx;
        break;
      }
      const wait = gapMs - (now() - lastFetchAt);
      if (wait > 0) await sleep(wait, seams.signal);
      if (aborted()) throw new CrawlRefusal('Cancelled.');
      visited.add(link.key);
      let res: FetchedPage;
      try {
        res = await seams.fetch(link.url.href, CRAWL_PAGE_MAX_BYTES);
      } catch {
        skipped.failed += 1;
        continue;
      } finally {
        lastFetchAt = now();
      }
      if (!isHtmlContentType(res.contentType)) {
        skipped.notHtml += 1;
        continue;
      }
      const html = decodeHtml(res.body);
      if (html == null) {
        skipped.notHtml += 1;
        continue;
      }
      // A redirect that landed on a page already read (or off the site: fetchPage refuses that).
      const landed = normalizeUrl(res.url);
      if (landed && landed.key !== link.key) {
        if (visited.has(landed.key) || landed.url.host !== siteHost) {
          skipped.duplicate += 1;
          continue;
        }
        visited.add(landed.key);
        // The redirect target gets the same checks as a link: robots, traps, file-shaped addresses.
        if (!robotsAllows(robots, landed.url.pathname + landed.url.search)) {
          skipped.robots += 1;
          continue;
        }
        if (looksLikeTrap(landed.url) || looksNonHtml(landed.url)) {
          skipped.trap += 1;
          continue;
        }
      }
      const found = extractLinks(html, res.url);
      // The canonical only stops a LATER read of that address. It never drops this page by itself: a
      // misconfigured site points every page's canonical at its home page, and the text check below
      // decides what is really a copy.
      if (found.canonical && found.canonical.url.host === siteHost) visited.add(found.canonical.key);
      const h = textHash(pageText(html));
      if (texts.has(h)) {
        skipped.duplicate += 1;
        continue;
      }
      if (totalBytes + res.body.length > REFERENCE_DOC_MAX_BYTES) {
        skipped.overCap += 1;
        totalBytes = REFERENCE_DOC_MAX_BYTES;
        continue;
      }
      texts.add(h);
      totalBytes += res.body.length;
      const page: CrawledPage = { url: res.url, title: pageTitle(html), depth: level, html };
      pages.push(page);
      seams.onProgress?.(pages.length, maxPages);
      next.push({ page, links: found.links });
    }
    frontier = next;
  }
  return { kind: 'crawl', pages, skipped, costUsd, inputTokens, outputTokens };
}

// ---- one document from many pages ----

export interface BundlePage {
  url: string;
  title: string | null;
  markdown: string;
}

/** Push every ATX heading down one level (outside code fences), so a page's own `#` sits under its chapter. */
export function demoteHeadings(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence == null) fence = f[1]![0]!;
        else if (f[1]![0] === fence) fence = null;
        return line;
      }
      if (fence != null) return line;
      return /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join('\n');
}

const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The crawl as ONE markdown source: a chapter (`#`) per page, in reading order, each naming its
 * address; the page's own headings sit one level below. A page whose text came out empty is dropped.
 */
export function bundleCrawlMarkdown(pages: BundlePage[]): string {
  const chapters: string[] = [];
  for (const p of pages) {
    let md = p.markdown.trim();
    if (md === '') continue;
    const lead = /^#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(md);
    const title = (lead?.[1] ?? p.title ?? p.url).replace(/\s+/g, ' ').trim();
    if (lead && sameTitle(lead[1]!, title)) md = md.slice(lead[0].length).trim();
    chapters.push(`# ${title}\n\nSource: <${p.url}>\n\n${demoteHeadings(md)}`);
  }
  return chapters.join('\n\n');
}
