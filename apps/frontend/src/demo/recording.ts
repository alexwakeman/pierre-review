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
 * IDENTITY PARAMETERS name WHOSE data a read is — a workspace, a bot, a person, a ticket, a
 * document. The query-less fallback may ignore every other parameter (a sort, a limit, a window,
 * a cursor), but never one of these: an entry recorded for another workspace, bot or ticket is
 * somebody else's answer. With no entry for the same identity the lookup answers nothing, and the
 * per-route fallback / 404 applies instead.
 */
export const IDENTITY_PARAMS: readonly string[] = [
  'workspace',
  'authorUserIds',
  'botUserId',
  'disagree',
  'userIds',
  'prIds',
  'repoId',
  'ident',
  'key',
  'keys',
  'doc',
  'docId',
  'path',
  'kind',
  'sourceReviewId',
  'q',
];

/** A comma list compares as a set; every other value as written. */
function identityValue(v: string | null): string | null {
  if (v == null) return null;
  return v.includes(',') ? v.split(',').sort().join(',') : v;
}

/**
 * Looks recorded entries up by method + normalised path, then by method + pathname alone among
 * the entries that agree on every IDENTITY parameter. When several agree, the query-less lookup
 * answers the FIRST one recorded — the recorder visits the default scope first.
 *
 * `?workspace=` follows the server's rule: absent or unknown means the DEFAULT workspace (read
 * off the recorded `GET /api/workspaces`), so `?workspace=1` and no parameter at all are the same
 * identity when 1 is the default. One recorded workspace is never answered with another's data.
 */
export class RecordingIndex {
  private readonly exact = new Map<string, RecordingEntry>();
  private readonly byPath = new Map<string, RecordingEntry[]>();
  private readonly knownWorkspaces = new Set<string>();
  private defaultWorkspace: string | null = null;

  constructor(entries: readonly RecordingEntry[]) {
    for (const e of entries) {
      const method = e.method.toUpperCase();
      const exactKey = `${method} ${normalisePath(e.path)}`;
      if (!this.exact.has(exactKey)) this.exact.set(exactKey, e);
      const pathKey = `${method} ${pathnameOf(e.path)}`;
      const list = this.byPath.get(pathKey);
      if (list) list.push(e);
      else this.byPath.set(pathKey, [e]);
      if (method === 'GET' && pathnameOf(e.path) === '/api/workspaces') this.learnWorkspaces(e.body);
    }
  }

  private learnWorkspaces(body: unknown): void {
    const list = body != null && typeof body === 'object' ? (body as { workspaces?: unknown }).workspaces : undefined;
    if (!Array.isArray(list)) return;
    for (const w of list) {
      if (w == null || typeof w !== 'object') continue;
      const { id, isDefault } = w as { id?: unknown; isDefault?: unknown };
      if (typeof id !== 'number') continue;
      this.knownWorkspaces.add(String(id));
      if (isDefault === true && this.defaultWorkspace == null) this.defaultWorkspace = String(id);
    }
  }

  /** The workspace a `?workspace=` value resolves to (the server's default-on-unknown rule). */
  private workspaceOf(v: string | null): string | null {
    if (this.defaultWorkspace == null) return v;
    return v != null && this.knownWorkspaces.has(v) ? v : this.defaultWorkspace;
  }

  private sameIdentity(asked: URLSearchParams, recorded: URLSearchParams): boolean {
    for (const name of IDENTITY_PARAMS) {
      const a = name === 'workspace' ? this.workspaceOf(asked.get(name)) : identityValue(asked.get(name));
      const r = name === 'workspace' ? this.workspaceOf(recorded.get(name)) : identityValue(recorded.get(name));
      if (a !== r) return false;
    }
    return true;
  }

  match(method: string, url: string): MatchResult | null {
    const m = method.toUpperCase();
    const exact = this.exact.get(`${m} ${normalisePath(url)}`);
    if (exact) return { entry: exact, how: 'exact' };
    const list = this.byPath.get(`${m} ${pathnameOf(url)}`);
    if (!list) return null;
    const asked = new URL(url, 'http://demo.invalid').searchParams;
    const hit = list.find((e) => this.sameIdentity(asked, new URL(e.path, 'http://demo.invalid').searchParams));
    return hit ? { entry: hit, how: 'path' } : null;
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
