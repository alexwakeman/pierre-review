// THE DEMO SERVER — answers every `/api/*` request of the static demo in the browser.
//
// Order of resolution for one request:
//   1. the agentic run simulator (./runs.ts) — starts, reads and streams of a run started here;
//   2. the hand-written routes (./routes.ts) — /api/me, "nothing changed" sync answers, batched
//      read POSTs, and every write the SPA can make (simulated into the in-memory overlay);
//   3. the recording (exact method + path, then the path with its query ignored), with the
//      overlay's patches applied;
//   4. the per-route fallback table (./routes.ts `GET_FALLBACKS`);
//   5. a 404 `{ error: 'NotInDemo' }` for a GET, a 409 with the same body for a write.
// Nothing here touches the network. Every body leaves as a fresh JSON string, so a caller can
// never mutate the recording or the overlay through a response.

import { RecordingIndex, pathnameOf } from './recording.js';
import type { DemoRecording, RecordedStreamFrame, RecordingEntry } from './recording.js';
import { makeRebaser, type Rebaser } from './rebase.js';
import { sseResponse } from './sse.js';
import { DemoOverlay } from './overlay.js';
import { RunSimulator } from './runs.js';
import { ROUTES, GET_FALLBACKS, patchRecordedGet } from './routes.js';
import { clone, notInDemo } from './util.js';

export { NOT_IN_DEMO_MESSAGE, notInDemo } from './util.js';

export interface DemoRequest {
  method: string;
  /** Pathname + search exactly as requested. */
  url: string;
  pathname: string;
  query: URLSearchParams;
  /** The parsed JSON body, or undefined. */
  body: unknown;
  signal: AbortSignal | null;
}

/** What a route answers: JSON, a stream of frames, or null to fall through to the next stage. */
export type DemoReply =
  | { status: number; body?: unknown }
  | { stream: RecordedStreamFrame[] }
  | null;

export interface DemoRoute {
  method: string | readonly string[];
  re: RegExp;
  run: (req: DemoRequest, m: RegExpMatchArray, srv: DemoServer) => DemoReply;
}

export interface DemoServerOptions {
  now?: () => number;
  /** Timer used by simulated streams (tests pass a fake one). */
  schedule?: (fn: () => void, ms: number) => unknown;
}

export class DemoServer {
  readonly index: RecordingIndex;
  readonly rebaser: Rebaser;
  readonly overlay = new DemoOverlay();
  readonly runs: RunSimulator;
  readonly now: () => number;
  private readonly schedule: DemoServerOptions['schedule'];
  private readonly rebased = new Map<RecordingEntry, unknown>();
  /** Every request answered, and by which stage — for debugging a recording (`window.__limnDemo`). */
  readonly log: Array<{ method: string; url: string; stage: string; status: number }> = [];
  private stage = '';
  private nextIdValue = 900_000_001;

  constructor(readonly recording: DemoRecording, opts: DemoServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule;
    this.index = new RecordingIndex(recording.entries);
    this.rebaser = makeRebaser(recording.capturedAt, this.now());
    this.runs = new RunSimulator(this);
  }

  /** Fresh ids for things the demo creates (comments, runs). Far above any recorded id. */
  nextId(): number {
    return this.nextIdValue++;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** The rebased body of a recorded entry, computed once and cloned on every read. */
  bodyOf(entry: RecordingEntry): unknown {
    if (!this.rebased.has(entry)) this.rebased.set(entry, this.rebaser.rebase(entry.body));
    return clone(this.rebased.get(entry));
  }

  /** The recorded (rebased, cloned) body for a GET, or undefined when nothing was recorded. */
  recorded(method: string, url: string): unknown {
    const hit = this.index.match(method, url);
    if (!hit || hit.entry.stream || hit.entry.status >= 400) return undefined;
    return this.bodyOf(hit.entry);
  }

  /** Every recorded GET body whose pathname matches `re` (rebased, cloned), with its pathname. */
  recordedGets(re: RegExp): Array<{ pathname: string; body: unknown }> {
    return this.index
      .findGets(re)
      .filter((e) => !e.stream && e.status < 400)
      .map((e) => ({ pathname: pathnameOf(e.path), body: this.bodyOf(e) }));
  }

  async handle(method: string, url: string, bodyText: string | null, signal: AbortSignal | null): Promise<Response> {
    const m = method.toUpperCase();
    const u = new URL(url, 'http://demo.invalid');
    let body: unknown;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = undefined;
      }
    }
    const req: DemoRequest = { method: m, url: u.pathname + u.search, pathname: u.pathname, query: u.searchParams, body, signal };
    let reply: DemoReply = null;
    try {
      reply = this.resolve(req);
    } catch (err) {
      // A simulator bug must never surface as a broken page: answer the route's error shape.
      console.warn('[demo] simulator error', m, u.pathname, err);
      reply = notInDemo(m === 'GET' ? 404 : 409);
    }
    const final = reply ?? notInDemo(m === 'GET' ? 404 : 409);
    if (this.log.length < 2000) {
      this.log.push({ method: m, url: req.url, stage: this.stage || 'missing', status: 'stream' in final ? 200 : final.status });
    }
    return this.toResponse(final, signal);
  }

  private resolve(req: DemoRequest): DemoReply {
    this.stage = 'runs';
    const fromRuns = this.runs.route(req);
    if (fromRuns) return fromRuns;
    this.stage = 'route';

    for (const r of ROUTES) {
      if (!methodMatches(r.method, req.method)) continue;
      const m = req.pathname.match(r.re);
      if (!m) continue;
      const out = r.run(req, m, this);
      if (out) return out;
    }

    const hit = this.index.match(req.method, req.url);
    this.stage = `recording:${hit?.how ?? ''}`;
    if (hit) {
      if (hit.entry.stream) return { stream: this.rebaser.rebase(hit.entry.stream) };
      if (hit.entry.status >= 400) return { status: hit.entry.status, body: this.bodyOf(hit.entry) };
      let out = this.bodyOf(hit.entry);
      if (req.method === 'GET') {
        out = clampPagedTotal(out, req, this);
        out = patchRecordedGet(req, out, this);
      }
      return { status: hit.entry.status, body: out };
    }

    this.stage = 'fallback';
    if (req.method === 'GET') {
      for (const r of GET_FALLBACKS) {
        const m = req.pathname.match(r.re);
        if (!m) continue;
        const out = r.run(req, m, this);
        if (out) return out;
      }
      // An unrecorded stream simply ends: the SPA's hooks treat a closed stream as "finished".
      if (req.pathname.endsWith('/stream')) return { stream: [] };
      this.stage = 'missing';
      return notInDemo(404);
    }
    if (req.method === 'DELETE') return { status: 204 };
    return notInDemo(409);
  }

  private toResponse(reply: Exclude<DemoReply, null>, signal: AbortSignal | null): Response {
    if ('stream' in reply) {
      return sseResponse(reply.stream, { signal, schedule: this.schedule });
    }
    if (reply.status === 204 || reply.body === undefined) {
      return new Response(null, { status: reply.status === 200 ? 204 : reply.status });
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

function methodMatches(want: string | readonly string[], got: string): boolean {
  return typeof want === 'string' ? want === got : want.includes(got);
}

/**
 * A paged list (`{ items: [], total }`) whose NEXT page was not recorded would otherwise ask for
 * it forever: the query-less match answers page one again. So `total` is clamped to what the
 * recording can actually serve from this offset.
 */
function clampPagedTotal(body: unknown, req: DemoRequest, srv: DemoServer): unknown {
  if (body == null || typeof body !== 'object') return body;
  const b = body as { items?: unknown; total?: unknown };
  if (!Array.isArray(b.items) || typeof b.total !== 'number') return body;
  const offset = Number(req.query.get('offset') ?? '0') || 0;
  const recordedHere = srv.index.match(req.method, req.url);
  // A page served by the query-less fallback is a repeat of another page: serve it empty.
  if (offset > 0 && recordedHere?.how !== 'exact') {
    return { ...b, items: [], total: offset };
  }
  const nextOffset = offset + b.items.length;
  if (nextOffset >= b.total) return body;
  const nextUrl = new URL(req.url, 'http://demo.invalid');
  nextUrl.searchParams.set('offset', String(nextOffset));
  const next = srv.index.match(req.method, nextUrl.pathname + nextUrl.search);
  if (next?.how === 'exact') return body;
  return { ...b, total: nextOffset };
}
