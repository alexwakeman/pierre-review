// Static file serving: content types, caching, compression and byte ranges.
//
// Small on purpose — the site serves two directories of built files and nothing else.
// What it must get right:
//
//   · CACHING. Vite's hashed bundles under assets/ never change, so they are cached for
//     a year and marked immutable. HTML is `no-cache` (revalidated every time, so a
//     deploy shows at once). Everything else gets an hour.
//   · COMPRESSION. Text types are sent brotli or gzip when the browser asks. The build
//     writes `<file>.br` and `<file>.gz` beside each one (precompress.ts, at maximum
//     quality), and those are streamed as they are. A file with no such sidecar is
//     compressed on demand — ASYNCHRONOUSLY, at a modest quality, once per file per
//     encoding (concurrent first requests share the one job) and kept in memory.
//     ⚠ Never synchronous zlib here: brotli at a high quality on a multi-megabyte demo
//     bundle blocks the event loop for seconds, and every other request waits on it.
//   · RANGES. The walkthrough video is seeked by chapter, and a player can only seek
//     when the server answers `Range` with 206. Ranges are served for uncompressed
//     responses only, which is every binary type here.
import { createReadStream, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

export const COMPRESSIBLE = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.map', '.webmanifest', '.xml', '.txt', '.svg',
]);

/** Text files at or below this size are worth compressing. */
export const MIN_COMPRESS_BYTES = 1024;

/** Above this, a file with no precompressed sidecar is streamed as it is, never held in memory. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function contentTypeFor(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve a URL path inside `root`, or null if it escapes it or is malformed. The
 * path is decoded first, so `%2e%2e` cannot slip past the `..` check.
 */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..')) return null;
  const full = normalize(join(root, ...parts));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  if (full !== normalize(root) && !full.startsWith(base)) return null;
  return full;
}

/** The file's stats when it exists and is a regular file. */
export function fileAt(path: string | null): Stats | null {
  if (!path) return null;
  try {
    const st = statSync(path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export type CachePolicy = 'immutable' | 'html' | 'short' | 'none';

const CACHE_HEADER: Record<CachePolicy, string> = {
  immutable: 'public, max-age=31536000, immutable',
  html: 'no-cache',
  short: 'public, max-age=3600',
  none: 'no-store',
};

/** Pick the cache policy from where the file lives and what it is. */
export function cachePolicyFor(urlPath: string, file: string): CachePolicy {
  if (extname(file).toLowerCase() === '.html') return 'html';
  // Vite's content-hashed output, for the landing and for the demo build.
  if (urlPath.startsWith('/assets/') || urlPath.startsWith('/demo/assets/')) return 'immutable';
  return 'short';
}

export type Encoding = 'br' | 'gzip';

/** The sidecar suffix the build writes for each encoding. */
export const SIDECAR_EXT: Record<Encoding, string> = { br: '.br', gzip: '.gz' };

function pickEncoding(header: string | string[] | undefined): Encoding | null {
  const v = (Array.isArray(header) ? header.join(',') : header ?? '').toLowerCase();
  const accepts = (enc: string): boolean =>
    v.split(',').some((part) => {
      const [name, ...params] = part.trim().split(';');
      if (name?.trim() !== enc) return false;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return q === undefined || Number(q.slice(2)) > 0;
    });
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * One promise per (file, version, encoding). A second request for the same file while
 * the first is still compressing waits on the same job instead of starting another.
 */
const compressedCache = new Map<string, Promise<Buffer>>();

/** On-demand compression, for a file the build did not precompress. Quality is modest on purpose. */
export function compressedOnDemand(file: string, st: Stats, enc: Encoding): Promise<Buffer> {
  const key = `${file}\0${st.mtimeMs}\0${st.size}\0${enc}`;
  let job = compressedCache.get(key);
  if (!job) {
    job = readFile(file).then((body) =>
      enc === 'br'
        ? brotliAsync(body, {
            params: {
              [zlib.BROTLI_PARAM_QUALITY]: 5,
              [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          })
        : gzipAsync(body, { level: 6 }),
    );
    // A failed job must not be remembered, or the file is broken until a restart.
    job.catch(() => compressedCache.delete(key));
    compressedCache.set(key, job);
  }
  return job;
}

/** The build's precompressed sidecar for `file`, when there is one at least as new as the file. */
function sidecarFor(file: string, st: Stats, enc: Encoding): { path: string; st: Stats } | null {
  const path = file + SIDECAR_EXT[enc];
  const side = fileAt(path);
  return side && side.mtimeMs >= st.mtimeMs ? { path, st: side } : null;
}

function streamFile(res: ServerResponse, file: string, start?: number, end?: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

/** Parse a single `bytes=` range. Multi-range requests are answered in full. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // Suffix range: the last N bytes.
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export interface SendOptions {
  status?: number;
  cache: CachePolicy;
}

/** Send one file, honouring conditional requests, compression and ranges. */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  st: Stats,
  opts: SendOptions,
): Promise<void> {
  const ext = extname(file).toLowerCase();
  const status = opts.status ?? 200;
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

  res.setHeader('Content-Type', contentTypeFor(file));
  res.setHeader('Cache-Control', CACHE_HEADER[opts.cache]);
  if (status === 200) {
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
  }

  const head = req.method === 'HEAD';

  if (COMPRESSIBLE.has(ext) && st.size > MIN_COMPRESS_BYTES) {
    res.setHeader('Vary', 'Accept-Encoding');
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (enc) {
      const side = sidecarFor(file, st, enc);
      if (side) {
        res.statusCode = status;
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', side.st.size);
        if (head) {
          res.end();
          return;
        }
        await streamFile(res, side.path);
        return;
      }
      if (st.size <= MAX_BUFFERED_BYTES) {
        const out = await compressedOnDemand(file, st, enc);
        res.statusCode = status;
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', out.length);
        res.end(head ? undefined : out);
        return;
      }
    }
  }

  // Uncompressed: the bytes as they are on disk, ranges allowed.
  res.setHeader('Accept-Ranges', 'bytes');
  const range = status === 200 ? parseRange(req.headers.range, st.size) : null;
  if (range === 'unsatisfiable') {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${st.size}`);
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : st.size - 1;
  res.statusCode = range ? 206 : status;
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  res.setHeader('Content-Length', st.size === 0 ? 0 : end - start + 1);
  if (head || st.size === 0) {
    res.end();
    return;
  }
  await streamFile(res, file, start, end);
}
