// THE NETWORK PANEL'S DATA (docs/SANDBOX.md § The request log). The proxy prints one JSON line per
// request; this folds them into ONE ROW PER (source, host, port, verdict) with a count and bytes, so a
// looping client (spike 4: 92,890 denied requests in three minutes) is one row whose count climbs, not a
// flood. The source is the client's container name on the session network (the IP is looked up once).
//
// Listeners get the row that changed — the session's SSE stream (WP7) forwards it as a `network` event.
// Updates are coalesced per row to at most one per `throttleMs`; a new row is sent at once.
import type { ProxyLogRow } from './server.js';

export interface NetworkEntry {
  key: string;
  /** The client's container name, else its address, else null. */
  source: string | null;
  host: string;
  port: number;
  allowed: boolean;
  /** Why it was refused, when it was. */
  reason: string | null;
  /** `forward` (CONNECT / HTTP) or the injector that carried a model call. */
  via: 'forward' | 'anthropic' | 'chatgpt';
  count: number;
  up: number;
  down: number;
  lastStatus: number | null;
  firstAt: string;
  lastAt: string;
}

export interface NetworkLogOptions {
  /** Distinct rows kept; past it, new rows fold into one "other hosts" row per verdict. */
  maxEntries?: number;
  throttleMs?: number;
  /** IP → container name; called once per new address. */
  sourceOf?: (ip: string) => string | null | Promise<string | null>;
  now?: () => number;
}

export function parseLogLine(line: string): ProxyLogRow | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    if (!v || typeof v !== 'object' || typeof (v as { kind?: unknown }).kind !== 'string') return null;
    return v as ProxyLogRow;
  } catch {
    return null;
  }
}

export class NetworkLog {
  private entries = new Map<string, NetworkEntry>();
  private listeners = new Set<(e: NetworkEntry) => void>();
  private names = new Map<string, string | null>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSent = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly throttleMs: number;
  private readonly now: () => number;
  ready = false;

  constructor(private readonly opts: NetworkLogOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.throttleMs = opts.throttleMs ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  onChange(listener: (e: NetworkEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every row, newest activity first. */
  snapshot(): NetworkEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** Feed one line of proxy output. Returns the row it touched, if any. */
  async ingestLine(line: string): Promise<NetworkEntry | null> {
    const row = parseLogLine(line);
    if (!row) return null;
    if (row.kind === 'ready') {
      this.ready = true;
      return null;
    }
    if (row.kind !== 'connect' && row.kind !== 'http' && row.kind !== 'inject') return null;
    if (!row.host || typeof row.port !== 'number') return null;
    const source = row.from ? await this.nameOf(row.from) : null;
    return this.ingest(row, source);
  }

  private async nameOf(ip: string): Promise<string | null> {
    const bare = ip.replace(/^::ffff:/, '');
    if (this.names.has(bare)) return this.names.get(bare) ?? bare;
    let name: string | null = null;
    try {
      name = (await this.opts.sourceOf?.(bare)) ?? null;
    } catch {
      name = null;
    }
    this.names.set(bare, name);
    return name ?? bare;
  }

  ingest(row: ProxyLogRow, source: string | null): NetworkEntry {
    const allowed = row.allowed === true;
    const via = row.kind === 'inject' ? (row.via ?? 'anthropic') : 'forward';
    let host = row.host ?? '';
    let port = row.port ?? 0;
    let key = `${source ?? ''}|${via}|${host}|${port}|${allowed ? 1 : 0}`;
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      host = '(other hosts)';
      port = 0;
      key = `*|${allowed ? 1 : 0}`;
    }
    const at = new Date(this.now()).toISOString();
    let e = this.entries.get(key);
    const isNew = !e;
    if (!e) {
      e = { key, source, host, port, allowed, reason: null, via, count: 0, up: 0, down: 0, lastStatus: null, firstAt: at, lastAt: at };
      this.entries.set(key, e);
    }
    e.count += 1;
    e.up += row.up ?? 0;
    e.down += row.down ?? 0;
    e.lastStatus = typeof row.status === 'number' ? row.status : e.lastStatus;
    e.reason = allowed ? null : (row.reason ?? e.reason ?? 'not_listed');
    e.lastAt = at;
    this.notify(e, isNew);
    return e;
  }

  private notify(e: NetworkEntry, immediate: boolean): void {
    const send = (): void => {
      this.pending.delete(e.key);
      this.lastSent.set(e.key, this.now());
      for (const l of this.listeners) {
        try {
          l({ ...e });
        } catch {
          /* a listener's failure is its own */
        }
      }
    };
    const since = this.now() - (this.lastSent.get(e.key) ?? -Infinity);
    if (immediate || since >= this.throttleMs) {
      const t = this.pending.get(e.key);
      if (t) clearTimeout(t);
      send();
      return;
    }
    if (!this.pending.has(e.key)) this.pending.set(e.key, setTimeout(send, this.throttleMs - since));
  }

  /** Stop pending timers (session end). */
  close(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.listeners.clear();
  }
}
