// The demo's recording: what the recorder writes and what the runtime replays.
// The format is documented in ./README.md; keep the two in step.

/** One server-sent event of a recorded stream. `data` is the JSON payload of the `data:` line. */
export interface RecordedStreamFrame {
  /** The SSE `event:` name. The SPA reads only `data:`, so this is informational ('message'). */
  event: string;
  data: unknown;
  /** Wait this long before sending the frame (relative to the previous frame). */
  delayMs: number;
}

export interface RecordingEntry {
  method: string;
  /** Pathname plus the SORTED query string, e.g. `/api/open-prs?repoIds=1,2&workspace=1`. */
  path: string;
  status: number;
  /** The JSON body. Absent when `stream` is set, or for a 204. */
  body?: unknown;
  /** A `text/event-stream` response, replayed frame by frame. */
  stream?: RecordedStreamFrame[];
}

export interface DemoRecording {
  version: 1;
  /** When the data was captured (ISO-8601). Every timestamp is shifted by `now - capturedAt`. */
  capturedAt: string;
  entries: RecordingEntry[];
}

export function isDemoRecording(v: unknown): v is DemoRecording {
  if (v == null || typeof v !== 'object') return false;
  const r = v as Partial<DemoRecording>;
  return r.version === 1 && typeof r.capturedAt === 'string' && Array.isArray(r.entries);
}

// ── Query normalisation ─────────────────────────────────────────────────────────────────────────
// Window and clock parameters carry timestamps that differ between the recording session and the
// demo session, so they are dropped before matching. So is any value that LOOKS like a timestamp
// (an ISO date or a 12–13 digit epoch-milliseconds number) whatever its name.

const TIME_PARAM_NAMES = new Set([
  'from',
  'to',
  'since',
  'until',
  'before',
  'after',
  'start',
  'end',
  'asOf',
  'now',
  'fromMs',
  'toMs',
  't',
  '_',
]);

const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_MS_VALUE = /^\d{12,13}$/;

function isTimeParam(name: string, value: string): boolean {
  return TIME_PARAM_NAMES.has(name) || ISO_DATE_VALUE.test(value) || EPOCH_MS_VALUE.test(value);
}

/**
 * `pathname?sorted-query`, with time-like parameters removed. Accepts a full URL, a root-relative
 * path, or a recorded `path`. Values are decoded then re-encoded so `%2C` and `,` compare equal.
 */
export function normalisePath(input: string): string {
  const u = new URL(input, 'http://demo.invalid');
  const pairs: [string, string][] = [];
  u.searchParams.forEach((value, name) => {
    if (!isTimeParam(name, value)) pairs.push([name, value]);
  });
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`).join('&');
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}

export function pathnameOf(input: string): string {
  return new URL(input, 'http://demo.invalid').pathname;
}

// ── The index ───────────────────────────────────────────────────────────────────────────────────

export interface MatchResult {
  entry: RecordingEntry;
  /** How the entry was found — `exact` (method + path + query) or `path` (query ignored). */
  how: 'exact' | 'path';
}

/**
 * Looks recorded entries up by method + normalised path, then by method + pathname alone.
 * When a pathname was recorded more than once, the query-less lookup answers the FIRST one
 * recorded — the recorder visits the default scope first.
 */
export class RecordingIndex {
  private readonly exact = new Map<string, RecordingEntry>();
  private readonly byPath = new Map<string, RecordingEntry[]>();

  constructor(entries: readonly RecordingEntry[]) {
    for (const e of entries) {
      const method = e.method.toUpperCase();
      const exactKey = `${method} ${normalisePath(e.path)}`;
      if (!this.exact.has(exactKey)) this.exact.set(exactKey, e);
      const pathKey = `${method} ${pathnameOf(e.path)}`;
      const list = this.byPath.get(pathKey);
      if (list) list.push(e);
      else this.byPath.set(pathKey, [e]);
    }
  }

  match(method: string, url: string): MatchResult | null {
    const m = method.toUpperCase();
    const exact = this.exact.get(`${m} ${normalisePath(url)}`);
    if (exact) return { entry: exact, how: 'exact' };
    const list = this.byPath.get(`${m} ${pathnameOf(url)}`);
    if (list && list[0]) return { entry: list[0], how: 'path' };
    return null;
  }

  /** Every entry recorded for a method + pathname (used by the batched read POSTs). */
  all(method: string, pathname: string): RecordingEntry[] {
    return this.byPath.get(`${method.toUpperCase()} ${pathname}`) ?? [];
  }

  /** Every GET entry whose pathname matches `re`, in recording order. */
  findGets(re: RegExp): RecordingEntry[] {
    const out: RecordingEntry[] = [];
    for (const [key, list] of this.byPath) {
      if (!key.startsWith('GET ')) continue;
      if (re.test(key.slice(4))) out.push(...list);
    }
    return out;
  }
}
