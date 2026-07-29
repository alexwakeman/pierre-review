import type { CheckLogsResponse } from '@pierre-review/shared';
import { ghRestGetRaw } from './client.js';

// Fetch a WINDOW of a GitHub Actions job's log, live (never stored). Extracted from the
// /api/prs/:id/checks/:jobId/logs route so both that route and the Pro CI-analysis seam
// share one implementation. Takes an explicit account token as its first arg (so it works
// in cloud too). Degrades to { available:false, reason } on any GitHub error (expired
// logs / re-run / no actions:read / network) instead of throwing.
//
// HOW IT WORKS (empirically verified against a real job log):
//   GET /repos/{o}/{r}/actions/jobs/{id}/logs 302s to a SHORT-LIVED SIGNED BLOB URL
//   holding the full plain-text log, and that blob URL DOES honour HTTP `Range`
//   (returns 206 + `Content-Range: bytes X-Y/Z`). So we resolve the redirect ourselves
//   (`redirect:'manual'`) and issue ONE ranged GET for exactly the window we want — which
//   is what makes a scrollable, chunked viewer possible without ever downloading a
//   multi-MB log. The signed URL is used server-side only and NEVER returned to a client:
//   it is unauthenticated and would bypass the route's per-account ownership check.
//
// MEMORY BOUND: every path is capped at MAX_LOG_BYTES. Even when the source ignores our
// Range header and streams the whole log back, we read through a rolling buffer that
// keeps at most ~2×cap in memory and reports `truncated:true`. (The previous
// implementation did a bare `await res.text()` on the WHOLE log — and the Pro CI-analysis
// path calls it with tail=0, i.e. the whole thing — so a big log was an unbounded
// allocation on the shared event loop.)
//
// BYTE OFFSETS ARE IN SOURCE-BYTE SPACE. The returned `text` is line-ending-normalised for
// display, but `startByte`/`endByte`/`totalBytes` always refer to the raw bytes GitHub
// serves, so feeding a response's `startByte` back in as the next `endByte` is exact.

export const MAX_LOG_BYTES = 8 * 1024 * 1024; // hard per-request cap
export const DEFAULT_LOG_WINDOW_BYTES = 128 * 1024; // one "page" of the viewer
const MAX_TAIL_LINES = 5000;
// Rough bytes/line for an Actions log (each line carries a 28-char ISO timestamp), used
// only to size the byte window a legacy `tail=<lines>` request needs.
const BYTES_PER_LINE_ESTIMATE = 220;
const FETCH_TIMEOUT_MS = 30_000;
const NEWLINE = 0x0a;

// What slice of the log to fetch. Exactly one shape wins, in this order:
//   startByte/endByte — an EXPLICIT byte window (the viewer's "load earlier" step;
//                       `endByte` is EXCLUSIVE, matching the response field)
//   tail <= 0         — the FULL log (still capped; anchored at the END, since a log
//                       over the cap is far more useful from its tail)
//   tail > 0          — the last N LINES (the legacy form; still fetched as a bounded
//                       byte window, then trimmed to N lines)
//   nothing           — the default tail-anchored DEFAULT_LOG_WINDOW_BYTES page
export interface JobLogWindow {
  tail?: number;
  startByte?: number;
  endByte?: number;
}

function unavailable(reason: string): CheckLogsResponse {
  return {
    available: false,
    reason,
    text: '',
    totalLines: 0,
    returnedLines: 0,
    totalBytes: null,
    startByte: null,
    endByte: null,
    hasMore: false,
    truncated: false,
  };
}

function reasonForStatus(status: number): string {
  if (status === 404 || status === 410) {
    return 'Logs are no longer available (expired, or the job was re-run).';
  }
  if (status === 403) {
    return 'No permission to read GitHub Actions logs for this repo.';
  }
  return `Couldn't fetch logs (GitHub returned ${status}).`;
}

// `Content-Range: bytes 100-199/4096` → { start:100, endExclusive:200, total:4096 }.
// A `*` total (unknown length) yields total:null.
//
// It ALSO has to parse the start-less `bytes */4096` form, which is the shape RFC 7233
// mandates on a 416 and the ONLY way we ever learn the log's true size when our window fell
// past the end. A start-anchored-only regex silently returns null there, which made the 416
// recovery below unreachable dead code. `start`/`endExclusive` are null for that form —
// callers on the 2xx path must check `start != null` before using it.
function parseContentRange(
  value: string | null,
): { start: number | null; endExclusive: number | null; total: number | null } | null {
  if (!value) return null;
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  const total = m[3] === '*' ? null : Number(m[3]);
  // `bytes */<total>`: no range was served, only the size is being reported.
  if (m[1] == null || m[2] == null) return { start: null, endExclusive: null, total };
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, endExclusive: end + 1, total };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Read a response body, keeping at most `cap` bytes.
//   anchor 'head' — stop (and cancel the stream) once `cap` bytes have arrived. The total
//                   size stays unknown unless Content-Length said so.
//   anchor 'tail' — read to the end but keep only the LAST `cap` bytes, dropping whole
//                   chunks off the front as we go, so peak memory is ~2×cap regardless of
//                   how big the log is. `dropped` counts the bytes discarded ahead of the
//                   kept window, which makes the absolute offsets exact.
async function readCapped(
  res: Response,
  cap: number,
  anchor: 'head' | 'tail',
): Promise<{ bytes: Uint8Array; dropped: number; readAll: boolean }> {
  const body = res.body;
  if (!body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength <= cap) return { bytes: all, dropped: 0, readAll: true };
    return anchor === 'tail'
      ? {
          bytes: all.slice(all.byteLength - cap),
          dropped: all.byteLength - cap,
          readAll: true,
        }
      : { bytes: all.slice(0, cap), dropped: 0, readAll: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  let dropped = 0;
  let readAll = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        readAll = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      held += value.byteLength;
      if (held <= cap) continue;
      if (anchor === 'head') break;
      // Tail anchor: shed whole chunks off the front while the remainder still covers cap.
      while (chunks.length > 1 && held - (chunks[0] as Uint8Array).byteLength >= cap) {
        const shed = chunks.shift() as Uint8Array;
        held -= shed.byteLength;
        dropped += shed.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const joined = concat(chunks, held);
  if (joined.byteLength <= cap) return { bytes: joined, dropped, readAll };
  return anchor === 'tail'
    ? {
        bytes: joined.slice(joined.byteLength - cap),
        dropped: dropped + (joined.byteLength - cap),
        readAll,
      }
    : { bytes: joined.slice(0, cap), dropped, readAll: false };
}

function indexOfByte(buf: Uint8Array, byte: number, from: number, to: number): number {
  for (let i = from; i < to; i++) if (buf[i] === byte) return i;
  return -1;
}

// Byte offset of the start of the `count`-th line from the END of [from,to), or `from`
// when the window holds fewer lines than that. A single trailing newline terminates the
// last line and is not itself a separator.
function tailLineStart(
  buf: Uint8Array,
  from: number,
  to: number,
  count: number,
): number {
  let seen = 0;
  let i = to - 1;
  if (i >= from && buf[i] === NEWLINE) i--; // skip the terminator
  for (; i >= from; i--) {
    if (buf[i] !== NEWLINE) continue;
    seen++;
    if (seen === count) return i + 1;
  }
  return from;
}

export async function fetchActionsJobLog(
  token: string,
  owner: string,
  name: string,
  jobId: number,
  opts: number | JobLogWindow = {},
): Promise<CheckLogsResponse> {
  const w: JobLogWindow = typeof opts === 'number' ? { tail: opts } : (opts ?? {});

  // ---- decide the window we want, in bytes ----
  const explicit = w.startByte != null || w.endByte != null;
  let reqStart: number | null = null; // null ⇒ anchor at the tail (suffix range)
  let reqEndExclusive: number | null = null;
  let cap = DEFAULT_LOG_WINDOW_BYTES;
  let anchor: 'head' | 'tail' = 'tail';
  let lineTail = 0;

  if (explicit) {
    anchor = 'head';
    reqStart = Math.max(0, Math.floor(w.startByte ?? 0));
    const rawEnd =
      w.endByte != null ? Math.floor(w.endByte) : reqStart + DEFAULT_LOG_WINDOW_BYTES;
    reqEndExclusive = Math.min(
      Math.max(rawEnd, reqStart + 1),
      reqStart + MAX_LOG_BYTES,
    );
    cap = reqEndExclusive - reqStart;
  } else if (w.tail != null && w.tail <= 0) {
    cap = MAX_LOG_BYTES; // the WHOLE log, capped, anchored at its end
  } else if (w.tail != null && w.tail > 0) {
    lineTail = Math.min(Math.floor(w.tail), MAX_TAIL_LINES);
    cap = Math.min(
      MAX_LOG_BYTES,
      Math.max(DEFAULT_LOG_WINDOW_BYTES, lineTail * BYTES_PER_LINE_ESTIMATE),
    );
  }

  const rangeHeader =
    reqStart == null
      ? `bytes=-${cap}`
      : `bytes=${reqStart}-${(reqEndExclusive as number) - 1}`;

  try {
    // ---- 1. resolve the 302 to the signed blob URL (body never read here) ----
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const redirect = await ghRestGetRaw(
      token,
      `/repos/${owner}/${name}/actions/jobs/${jobId}/logs`,
      { signal },
    );
    const location = redirect.headers.get('location');
    const isRedirect = redirect.status >= 300 && redirect.status < 400;

    let res: Response;
    if (isRedirect && location) {
      await redirect.body?.cancel().catch(() => {});
      // The signed URL is pre-authorised — do NOT forward our token to it.
      res = await fetch(location, {
        method: 'GET',
        headers: { range: rangeHeader },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } else if (redirect.status >= 200 && redirect.status < 300) {
      // Some responses hand back the log inline instead of redirecting.
      res = redirect;
    } else {
      await redirect.body?.cancel().catch(() => {});
      return unavailable(reasonForStatus(redirect.status));
    }

    if (res.status === 416) {
      // Our window sits entirely past the end of the log — almost always a STALE offset (the
      // job was re-run and its log is now shorter, or a client replayed a cached endByte).
      // The 416 is required to carry `bytes */<total>`, so we learn the real size here and can
      // clamp to it and serve the tail ONCE, instead of handing the viewer a blank pane with
      // no offset it could use to recover. Bounded to a single retry: the clamped range is by
      // construction inside [0,total), so it cannot 416 again against a sane server, and if it
      // does we fall through to the honest empty window below.
      await res.body?.cancel().catch(() => {});
      const total = parseContentRange(res.headers.get('content-range'))?.total ?? null;
      if (total != null && total > 0 && location) {
        const window = Math.min(cap, total);
        reqStart = total - window;
        reqEndExclusive = total;
        cap = window;
        anchor = 'head';
        res = await fetch(location, {
          method: 'GET',
          headers: { range: `bytes=${reqStart}-${total - 1}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      }
      if (res.status === 416) {
        // No total offered, an empty log, or a server that refuses the clamped range too.
        await res.body?.cancel().catch(() => {});
        return {
          available: true,
          text: '',
          totalLines: 0,
          returnedLines: 0,
          totalBytes: total,
          startByte: reqStart ?? 0,
          endByte: reqStart ?? 0,
          hasMore: false,
          truncated: true,
        };
      }
    }
    if (!(res.status >= 200 && res.status < 300)) {
      await res.body?.cancel().catch(() => {});
      return unavailable(reasonForStatus(res.status));
    }

    // ---- 2. read the window (capped), and work out where it sits in the log ----
    const contentRange = parseContentRange(res.headers.get('content-range'));
    // A 206 always names a concrete `bytes X-Y/Z`; the start-less `bytes */Z` form belongs to
    // the 416 handled above. Requiring a real start keeps that shape from being mistaken for a
    // served range now that the parser accepts both.
    const rangeStart = contentRange?.start ?? null;
    const honouredRange = res.status === 206 && contentRange != null && rangeStart != null;
    // If the source IGNORED our Range and streamed the whole log (200), an explicit
    // window has to be carved out of that stream instead: read from the top up to the
    // requested end, then slice. (The signed blob URL does honour Range — this is the
    // defensive path.)
    const ignoredExplicit = !honouredRange && explicit;
    const readCap = ignoredExplicit
      ? Math.min(MAX_LOG_BYTES, reqEndExclusive as number)
      : cap;
    const read = await readCapped(
      res,
      readCap,
      honouredRange || ignoredExplicit ? 'head' : anchor,
    );
    let bytes = read.bytes;

    let windowStart: number;
    let totalBytes: number | null;
    if (honouredRange && contentRange && rangeStart != null) {
      windowStart = rangeStart + read.dropped;
      totalBytes = contentRange.total;
    } else if (ignoredExplicit) {
      const from = Math.min(reqStart as number, bytes.byteLength);
      bytes = bytes.subarray(from);
      windowStart = from;
      const len = Number(res.headers.get('content-length'));
      totalBytes = read.readAll
        ? from + bytes.byteLength
        : Number.isFinite(len) && len > 0
          ? len
          : null;
    } else if (anchor === 'tail') {
      // Range ignored: we streamed everything and kept the tail, so we know the true size.
      windowStart = read.dropped;
      totalBytes = read.readAll ? read.dropped + bytes.byteLength : null;
    } else {
      windowStart = 0;
      const len = Number(res.headers.get('content-length'));
      totalBytes = Number.isFinite(len) && len > 0 ? len : null;
    }

    // ---- 3. align to whole lines (this is also the UTF-8 guard: a newline is ASCII and
    //         can never appear inside a multi-byte sequence, so cutting at one is safe) ----
    let s = 0;
    let e = bytes.byteLength;
    if (windowStart > 0) {
      const nl = indexOfByte(bytes, NEWLINE, 0, e);
      if (nl >= 0 && nl + 1 < e) s = nl + 1; // drop the partial first line
    }
    const windowEndExclusive = windowStart + bytes.byteLength;
    const endsMidLog = totalBytes != null && windowEndExclusive < totalBytes;
    if (endsMidLog && e > s && bytes[e - 1] !== NEWLINE) {
      let nl = -1;
      for (let i = e - 1; i >= s; i--) {
        if (bytes[i] === NEWLINE) {
          nl = i;
          break;
        }
      }
      if (nl > s) e = nl + 1; // drop the partial last line
    }
    if (lineTail > 0) s = Math.max(s, tailLineStart(bytes, s, e, lineTail));

    const startByte = windowStart + s;
    const endByte = windowStart + e;
    const decoded = new TextDecoder('utf-8').decode(bytes.subarray(s, e));
    // Normalise for DISPLAY only — the byte offsets above stay in source-byte space.
    const text = decoded.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const lines = text === '' ? [] : text.split('\n');

    const truncated =
      startByte > 0 || (totalBytes != null && endByte < totalBytes) || !read.readAll;

    return {
      available: true,
      text,
      // Exact only when this window IS the whole log; otherwise it is the window's own
      // line count (the full count can't be known without downloading everything, which
      // is the very thing the windowing exists to avoid). The UI labels partial windows
      // by BYTES, not "N of M lines".
      totalLines: lines.length,
      returnedLines: lines.length,
      totalBytes,
      startByte,
      endByte,
      hasMore: startByte > 0,
      truncated,
    };
  } catch {
    return unavailable("Couldn't reach GitHub to fetch the logs.");
  }
}
