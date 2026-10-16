import type { IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { REFERENCE_DOC_MAX_BYTES } from '@pierre-review/shared';
import { JiraFetchError, guardedLookup, isBlockedAddress, type LookupFn } from '../tracker/jira/fetch.js';

// FETCHING A WEB PAGE FOR THE LIBRARY — a server-side request to an address the reader typed
// (docs/REFERENCE-DOCS.md § Adding a web page). The reader is the only caller (the route is local
// only), but the page is a stranger's, and a URL is the classic way to make a server reach what it
// should not, so the guard is the tracker's (tracker/jira/fetch.ts), STRICTER, in BOTH modes:
//
//   • http and https only; no user:password@ in the address;
//   • NO PRIVATE ADDRESSES: loopback, RFC1918, CGNAT, link-local (the cloud metadata address),
//     unique-local, multicast and reserved — for an IP-literal host up front, and for a name AT
//     CONNECT TIME through the socket's own `lookup`, so DNS rebinding has no second answer to give;
//   • redirects are followed ONLY on the same host (at most 3; http → https allowed), each one
//     re-checked; a redirect to another host is refused;
//   • a hard TIMEOUT for each exchange and a SIZE CAP (the upload cap) while reading the body.

export const URL_FETCH_TIMEOUT_MS = 20_000;
export const URL_FETCH_MAX_REDIRECTS = 3;

export type UrlFetchErrorCode =
  | 'bad_url'
  | 'blocked'
  | 'redirect_off_host'
  | 'too_many_redirects'
  | 'timeout'
  | 'network'
  | 'http'
  | 'too_large';

export const URL_FETCH_MESSAGES: Record<UrlFetchErrorCode, string> = {
  bad_url: 'That is not a web address Limn can read. Use an http or https address.',
  blocked: 'That address points at a private or local network, which Limn does not read.',
  redirect_off_host: 'That page redirects to another site. Add the address it redirects to instead.',
  too_many_redirects: 'That page redirects too many times.',
  timeout: 'The page took too long to answer.',
  network: 'The page could not be reached.',
  http: 'The page answered with an error.',
  too_large: `The page is too large. The limit is ${REFERENCE_DOC_MAX_BYTES / (1024 * 1024)} MB.`,
};

export class UrlFetchError extends Error {
  constructor(
    readonly code: UrlFetchErrorCode,
    readonly status: number | null = null,
  ) {
    super(URL_FETCH_MESSAGES[code] + (code === 'http' && status != null ? ` (${status})` : ''));
    this.name = 'UrlFetchError';
  }
}

/** Parse and vet an address before any socket opens. */
export function checkPageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlFetchError('bad_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UrlFetchError('bad_url');
  if (url.username !== '' || url.password !== '') throw new UrlFetchError('bad_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') throw new UrlFetchError('bad_url');
  if (isIP(host) !== 0 && isBlockedAddress(host)) throw new UrlFetchError('blocked');
  const lowered = host.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered.endsWith('.local') || !lowered.includes('.')) {
    if (isIP(host) === 0) throw new UrlFetchError('blocked');
  }
  url.hash = '';
  return url;
}

export interface PageResponse {
  status: number;
  contentType: string;
  location: string | null;
  body: Buffer;
}

export type PageTransport = (
  url: URL,
  opts: { lookup: LookupFn; timeoutMs: number; maxBytes: number },
) => Promise<PageResponse>;

export const nodePageTransport: PageTransport = (url, opts) =>
  new Promise<PageResponse>((resolve, reject) => {
    const reqOpts: RequestOptions = {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf;q=0.9,*/*;q=0.1',
        'user-agent': 'Limn reference docs',
      },
      lookup: opts.lookup as unknown as RequestOptions['lookup'],
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (e: UrlFetchError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(e);
    };
    const req = send(url, reqOpts, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      if (status >= 300 && status < 400) {
        res.resume();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, contentType, location: String(res.headers.location ?? '') || null, body: Buffer.alloc(0) });
        return;
      }
      const declared = Number(res.headers['content-length'] ?? '');
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.resume();
        return fail(new UrlFetchError('too_large'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) return fail(new UrlFetchError('too_large'));
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, contentType, location: null, body: Buffer.concat(chunks) });
      });
      res.on('error', () => fail(new UrlFetchError('network')));
    });
    const timer = setTimeout(() => fail(new UrlFetchError('timeout')), opts.timeoutMs);
    // The guarded lookup refuses a private address with the tracker's own error type.
    req.on('error', (err: unknown) =>
      fail(err instanceof JiraFetchError && err.code === 'blocked' ? new UrlFetchError('blocked') : new UrlFetchError('network')),
    );
    req.end();
  });

export interface FetchedPage {
  url: string;
  contentType: string;
  body: Buffer;
}

/** GET a page under the guard above. Throws UrlFetchError (its message is safe to show). */
export async function fetchPage(raw: string, transport: PageTransport = nodePageTransport): Promise<FetchedPage> {
  let url = checkPageUrl(raw);
  const host = url.hostname.toLowerCase();
  for (let hop = 0; ; hop++) {
    let res: PageResponse;
    try {
      res = await transport(url, { lookup: guardedLookup(), timeoutMs: URL_FETCH_TIMEOUT_MS, maxBytes: REFERENCE_DOC_MAX_BYTES });
    } catch (err) {
      if (err instanceof UrlFetchError) throw err;
      throw new UrlFetchError(err instanceof JiraFetchError && err.code === 'blocked' ? 'blocked' : 'network');
    }
    if (res.status >= 300 && res.status < 400) {
      if (hop >= URL_FETCH_MAX_REDIRECTS) throw new UrlFetchError('too_many_redirects');
      if (!res.location) throw new UrlFetchError('http', res.status);
      let next: URL;
      try {
        next = checkPageUrl(new URL(res.location, url).href);
      } catch (err) {
        throw err instanceof UrlFetchError ? err : new UrlFetchError('bad_url');
      }
      if (next.hostname.toLowerCase() !== host) throw new UrlFetchError('redirect_off_host');
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new UrlFetchError('redirect_off_host');
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new UrlFetchError('http', res.status);
    return { url: url.href, contentType: res.contentType, body: res.body };
  }
}
