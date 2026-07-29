import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOG_WINDOW_BYTES,
  MAX_LOG_BYTES,
  fetchActionsJobLog,
} from './actions-logs.js';

// Locks the byte-window semantics of the Actions job-log fetcher: the memory cap, the
// Range-based chunking against the signed blob URL, whole-line alignment at both edges,
// and the fields the scrollable viewer navigates by (startByte/endByte/hasMore/truncated).
// The signed URL must never escape the server, so everything is exercised through a fake
// fetch that plays the part of both api.github.com and the blob store.

const SIGNED = 'https://pipelines.actions.blob.core.windows.net/log?sig=secret';

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      // Deliberately chunked so the rolling tail buffer is actually exercised.
      for (let i = 0; i < bytes.byteLength; i += 1024) {
        c.enqueue(bytes.subarray(i, Math.min(i + 1024, bytes.byteLength)));
      }
      c.close();
    },
  });
}

function fakeResponse(
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array,
): Response {
  return {
    status,
    headers: new Headers(headers),
    body: body ? stream(body) : null,
    arrayBuffer: async () => (body ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

// Parses `bytes=a-b` / `bytes=-n` exactly as a real blob store does.
function serveRange(log: Uint8Array, range: string | null): Response {
  const total = log.byteLength;
  if (!range) return fakeResponse(200, { 'content-length': String(total) }, log);
  const suffix = /^bytes=-(\d+)$/.exec(range);
  const explicit = /^bytes=(\d+)-(\d+)$/.exec(range);
  let start: number;
  let endInclusive: number;
  if (suffix) {
    start = Math.max(0, total - Number(suffix[1]));
    endInclusive = total - 1;
  } else if (explicit) {
    start = Number(explicit[1]);
    endInclusive = Math.min(Number(explicit[2]), total - 1);
  } else {
    return fakeResponse(200, { 'content-length': String(total) }, log);
  }
  if (start >= total) {
    return fakeResponse(416, { 'content-range': `bytes */${total}` });
  }
  return fakeResponse(
    206,
    { 'content-range': `bytes ${start}-${endInclusive}/${total}` },
    log.slice(start, endInclusive + 1),
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

function installFetch(
  log: Uint8Array,
  opts?: { redirectStatus?: number; honourRange?: boolean },
): void {
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.startsWith('https://api.github.com')) {
      const status = opts?.redirectStatus ?? 302;
      if (status >= 300 && status < 400) {
        return fakeResponse(status, { location: SIGNED });
      }
      return fakeResponse(status, {}, status < 300 ? log : undefined);
    }
    expect(href).toBe(SIGNED);
    // The account token must NEVER be forwarded to the signed URL.
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBeNull();
    if (opts?.honourRange === false) {
      return fakeResponse(200, { 'content-length': String(log.byteLength) }, log);
    }
    return serveRange(log, headers.get('range'));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

// A log of `n` numbered lines, each padded to a fixed width so byte maths is exact.
function makeLog(n: number): { bytes: Uint8Array; lines: string[] } {
  const lines = Array.from({ length: n }, (_, i) => `line-${String(i).padStart(6, '0')}`);
  return { bytes: new TextEncoder().encode(lines.join('\n') + '\n'), lines };
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchActionsJobLog — byte windows', () => {
  it('serves the whole log when it fits, with exact byte accounting', async () => {
    const { bytes, lines } = makeLog(50);
    installFetch(bytes);
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1, { tail: 0 });
    expect(r.available).toBe(true);
    expect(r.text.split('\n')).toEqual(lines);
    expect(r.totalBytes).toBe(bytes.byteLength);
    expect(r.startByte).toBe(0);
    expect(r.endByte).toBe(bytes.byteLength);
    expect(r.hasMore).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('defaults to a TAIL window and reports hasMore for the earlier chunk', async () => {
    // Comfortably larger than one page so the default window is a strict tail.
    const { bytes, lines } = makeLog(40_000);
    expect(bytes.byteLength).toBeGreaterThan(DEFAULT_LOG_WINDOW_BYTES);
    installFetch(bytes);
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1);
    expect(r.available).toBe(true);
    expect(r.totalBytes).toBe(bytes.byteLength);
    expect(r.startByte).toBeGreaterThan(0);
    expect(r.endByte).toBe(bytes.byteLength);
    expect(r.hasMore).toBe(true);
    expect(r.truncated).toBe(true);
    // Whole lines only — no partial first line.
    const got = r.text.split('\n');
    expect(got[0]).toMatch(/^line-\d{6}$/);
    expect(got[got.length - 1]).toBe(lines[lines.length - 1]);
  });

  it('walks UP: feeding startByte back as endByte yields the adjacent earlier chunk', async () => {
    const { bytes, lines } = makeLog(40_000);
    installFetch(bytes);
    const tail = await fetchActionsJobLog('tok', 'o', 'n', 1);
    const earlier = await fetchActionsJobLog('tok', 'o', 'n', 1, {
      startByte: Math.max(0, (tail.startByte ?? 0) - DEFAULT_LOG_WINDOW_BYTES),
      endByte: tail.startByte ?? 0,
    });
    expect(earlier.available).toBe(true);
    expect(earlier.endByte).toBe(tail.startByte);
    // The two windows abut with no gap and no overlap: concatenating them reproduces
    // a contiguous run of the original lines.
    const joined = [...earlier.text.split('\n'), ...tail.text.split('\n')];
    const firstIdx = lines.indexOf(joined[0] as string);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(joined).toEqual(lines.slice(firstIdx));
  });

  it('trims a partial LAST line when the window ends mid-log', async () => {
    const { bytes } = makeLog(40_000);
    installFetch(bytes);
    // An end offset deliberately in the middle of a line.
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1, {
      startByte: 0,
      endByte: 10_005,
    });
    expect(r.startByte).toBe(0);
    expect(r.endByte).toBeLessThan(10_005);
    expect(bytes[(r.endByte as number) - 1]).toBe(0x0a); // ends exactly on a newline
    for (const l of r.text.split('\n')) expect(l).toMatch(/^line-\d{6}$/);
  });

  it('honours a legacy tail=<lines> request', async () => {
    const { bytes, lines } = makeLog(40_000);
    installFetch(bytes);
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1, { tail: 25 });
    expect(r.returnedLines).toBe(25);
    expect(r.text.split('\n')).toEqual(lines.slice(-25));
    expect(r.endByte).toBe(bytes.byteLength);
    expect(r.hasMore).toBe(true);
  });

  it('caps a huge log at MAX_LOG_BYTES instead of buffering it whole', async () => {
    // 9 MiB of log; the 8 MiB cap must bite and the response must say so.
    const n = Math.ceil((9 * 1024 * 1024) / 12); // 'line-NNNNNN\n' = 12 bytes
    const { bytes } = makeLog(n);
    expect(bytes.byteLength).toBeGreaterThan(MAX_LOG_BYTES);
    installFetch(bytes);
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1, { tail: 0 });
    expect(r.available).toBe(true);
    expect(r.truncated).toBe(true);
    expect((r.endByte as number) - (r.startByte as number)).toBeLessThanOrEqual(
      MAX_LOG_BYTES,
    );
    expect(r.endByte).toBe(bytes.byteLength); // anchored at the END of the log
    expect(r.hasMore).toBe(true);
  });

  it('still returns the right window when the source IGNORES Range', async () => {
    const { bytes, lines } = makeLog(40_000);
    installFetch(bytes, { honourRange: false });
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1, { tail: 25 });
    expect(r.text.split('\n')).toEqual(lines.slice(-25));
    expect(r.totalBytes).toBe(bytes.byteLength);
  });

  it('degrades (never throws) on an expired log', async () => {
    installFetch(new Uint8Array(), { redirectStatus: 410 });
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1);
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/no longer available/i);
    expect(r.text).toBe('');
    expect(r.hasMore).toBe(false);
  });

  it('degrades on a missing actions:read scope', async () => {
    installFetch(new Uint8Array(), { redirectStatus: 403 });
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1);
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/permission/i);
  });

  it('reports an empty window (not an error) past the end of the log', async () => {
    const { bytes } = makeLog(10);
    installFetch(bytes);
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1, {
      startByte: bytes.byteLength + 100,
      endByte: bytes.byteLength + 200,
    });
    expect(r.available).toBe(true);
    expect(r.text).toBe('');
    expect(r.returnedLines).toBe(0);
  });

  it('does not split a multi-byte UTF-8 sequence at a chunk boundary', async () => {
    const line = 'ok ✓ — ünïcödé ✗ 🚀';
    const src = Array.from({ length: 20_000 }, () => line).join('\n') + '\n';
    const bytes = new TextEncoder().encode(src);
    installFetch(bytes);
    const r = await fetchActionsJobLog('tok', 'o', 'n', 1);
    expect(r.text).not.toContain('�'); // no replacement characters
    for (const l of r.text.split('\n')) expect(l).toBe(line);
  });
});
