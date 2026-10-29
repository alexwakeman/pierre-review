import { fetchPage, nodePageTransport, type PagePolicy, type PageTransport } from './url-fetch.js';
import type { FigureSink } from './figures.js';

// DOWNLOADING AN IMAGE FOR A FIGURE (docs/REFERENCE-DOCS.md § Figures). Every download goes through the
// library's guarded page fetch (`fetchPage`: http(s) only, no credentials in the address, the address
// judged at connect time, redirects only on the same host, a timeout, the byte cap) and carries NO
// credential: a Notion file address and Atlassian's media address are signed in their own query, and an
// external image is a stranger's. A failure of any kind answers null — the image keeps its name.

/** A wiki's files are on the public internet: never a private address. */
export const PUBLIC_ONLY: PagePolicy = { privateNetwork: false };

export async function fetchImageBytes(
  url: string,
  sink: Pick<FigureSink, 'canFetch' | 'noteFetch' | 'maxBytes'>,
  policy: PagePolicy,
  transport: PageTransport = nodePageTransport,
): Promise<Buffer | null> {
  if (!sink.canFetch()) return null;
  sink.noteFetch();
  try {
    const page = await fetchPage(url, transport, policy, sink.maxBytes);
    return page.body.length > 0 ? page.body : null;
  } catch {
    return null;
  }
}

/** Entities an address in an attribute carries. */
const decodeAttr = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * The `<img src>` addresses of a page, resolved against its address, in order, once each, at most
 * `cap` (inline `data:` images are read from the page itself, never fetched). LINEAR: indexOf over a
 * lower-cased copy, each tag's attributes read off a bounded window (a page is a stranger's).
 */
export function imageSources(html: string, baseUrl: string, cap: number): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  let at = lower.indexOf('<img');
  while (at >= 0 && out.length < cap) {
    const end = lower.indexOf('>', at);
    const tag = html.slice(at, end < 0 ? Math.min(html.length, at + 4096) : Math.min(end, at + 4096));
    const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const raw = m ? decodeAttr((m[1] ?? m[2] ?? m[3] ?? '').trim()) : '';
    if (raw && !/^data:/i.test(raw)) {
      try {
        const abs = new URL(raw, baseUrl);
        if ((abs.protocol === 'https:' || abs.protocol === 'http:') && !seen.has(abs.href)) {
          seen.add(abs.href);
          out.push(abs.href);
        }
      } catch {
        /* not an address */
      }
    }
    at = lower.indexOf('<img', end < 0 ? at + 4 : end);
  }
  return out;
}

/** An `<img src>` / data: address → its bytes when it is inline base64 (a Word file's images). */
export function dataUriBytes(src: string): Buffer | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(src.slice(0, 100));
  if (!m) return null;
  try {
    return Buffer.from(src.slice(m[0].length), 'base64');
  } catch {
    return null;
  }
}
