// LIMN'S EGRESS PROXY (docs/SANDBOX.md § The egress proxy). The sandbox's ONLY way out: it runs in its
// own container on the session's `--internal` network AND the runtime's default bridge.
//
// ⚠ SELF-CONTAINED BY CONTRACT. This file is shipped into the proxy container as its whole program
// (`node --input-type=module -e <source>`, source.ts), so it imports `node:` built-ins ONLY, and uses
// erasable TypeScript only (no enums, no parameter properties, no namespaces) so its types can be
// stripped without a compiler. `source.test.ts` pins both.
//
// THREE LISTENERS on the internal network, one on the container's own loopback:
//   :3128  forward proxy — CONNECT (HTTPS, end-to-end TLS) and absolute-form HTTP, ALLOW-LIST by host
//          (and port). A refused request NEVER opens an upstream socket.
//   :8081  Anthropic injector — plain HTTP in, TLS out to api.anthropic.com. The sandbox holds only a
//          PLACEHOLDER credential; a request carrying it gets the real one, a request carrying ANY other
//          credential is refused (403) and never forwarded (spike 3).
//   :8082  ChatGPT injector — the same for chatgpt.com (Codex's ChatGPT sign-in).
//   127.0.0.1:3199  control — Limn sets the rules and the credentials here, through `docker exec`
//          (egress.ts). The sandbox cannot reach the container's loopback, and the forward proxy refuses
//          every loopback address.
//
// THE ADDRESS RULE: a name on the list is resolved HERE and the connection goes to the vetted address
// (no second lookup). Loopback, link-local (the cloud metadata address), unspecified, multicast and
// reserved addresses are refused always; a PRIVATE address (RFC 1918, CGNAT, IPv6 ULA) only when the
// rule that matched names the host EXACTLY — a `*.suffix` rule can never be turned into a way onto the
// reader's network by a DNS answer.
//
// Every request is ONE JSON line on stdout (`ProxyLogRow`): never a header value, never a body.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { domainToASCII } from 'node:url';

// ── rules ───────────────────────────────────────────────────────────────────────────────────────

export interface ProxyRule {
  /** `*` alone: everything (a recording run only; never a default). */
  any: boolean;
  /** ASCII host, or the suffix (with its leading dot) for a `*.` rule. */
  host: string;
  suffix: boolean;
  ip: boolean;
  /** null = 80 and 443 only; '*' = any port. */
  port: number | '*' | null;
  /** The rule as written, normalised. */
  text: string;
}

/** Lower-case ASCII (IDN → punycode), no trailing dot, no brackets. Null when not a valid host. */
export function normaliseHost(raw: string): string | null {
  let h = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '') return null;
  if (net.isIP(h) !== 0) return h;
  const ascii = domainToASCII(h);
  if (!ascii || ascii.length > 253) return null;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(ascii)) return null;
  if (ascii.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  return ascii;
}

/** `host`, `*.suffix`, `1.2.3.4`, `[::1]`, each optionally `:port` or `:*`; or `*`. Null when invalid. */
export function parseRule(text: string): ProxyRule | null {
  const t = String(text).trim().toLowerCase();
  if (t === '') return null;
  if (t === '*') return { any: true, host: '', suffix: false, ip: false, port: '*', text: '*' };
  const m = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}|\*))?$/.exec(t);
  if (!m || !m[1]) return null;
  let hostPart = m[1];
  const portPart = m[2];
  let port: number | '*' | null = null;
  if (portPart === '*') port = '*';
  else if (portPart !== undefined) {
    port = Number(portPart);
    if (!(port >= 1 && port <= 65535)) return null;
  }
  const suffix = hostPart.startsWith('*.');
  if (suffix) hostPart = hostPart.slice(2);
  const host = normaliseHost(hostPart);
  if (!host) return null;
  const ip = net.isIP(host) !== 0;
  // A suffix rule needs a registrable-looking domain: `*.com` would open a whole top-level domain.
  if (suffix && (ip || host.split('.').length < 2)) return null;
  const hostText = ip && host.includes(':') ? `[${host}]` : host;
  const portText = port === null ? '' : `:${port}`;
  return { any: false, host: suffix ? `.${host}` : host, suffix, ip, port, text: `${suffix ? '*.' : ''}${hostText}${portText}` };
}

export function parseRules(list: readonly string[]): ProxyRule[] {
  const out: ProxyRule[] = [];
  for (const r of list) {
    const p = parseRule(r);
    if (p) out.push(p);
  }
  return out;
}

function portMatches(rule: ProxyRule, port: number): boolean {
  if (rule.port === '*') return true;
  if (rule.port === null) return port === 80 || port === 443;
  return rule.port === port;
}

/** The first rule that lets (host, port) through, or null. IP literals match only an exact IP rule. */
export function matchRule(rules: readonly ProxyRule[], rawHost: string, port: number): ProxyRule | null {
  const host = normaliseHost(rawHost);
  if (!host) return null;
  const isIp = net.isIP(host) !== 0;
  for (const r of rules) {
    if (!portMatches(r, port)) continue;
    if (r.any) return r;
    if (r.suffix) {
      if (!isIp && host.endsWith(r.host) && host.length > r.host.length) return r;
    } else if (r.host === host) {
      return r;
    }
  }
  return null;
}

// ── addresses ───────────────────────────────────────────────────────────────────────────────────

export type AddressClass = 'public' | 'private' | 'loopback' | 'link_local' | 'unspecified' | 'multicast' | 'reserved';

// ONE table, checked with node's own BlockList: it matches every spelling of an address (compressed
// or not, any case) and checks an IPv4-MAPPED IPv6 address (`::ffff:7f00:1`) against the IPv4 rows.
// IPv6 forms that carry an IPv4 address to some other network (NAT64, 6to4, Teredo, IPv4-compatible)
// are `reserved`: a DNS answer must never reach the reader's network through a translator.
const ADDRESS_TABLE: ReadonlyArray<[Exclude<AddressClass, 'public'>, ReadonlyArray<[string, number]>]> = [
  ['unspecified', [['0.0.0.0', 8], ['::', 128]]],
  ['loopback', [['127.0.0.0', 8], ['::1', 128]]],
  ['link_local', [['169.254.0.0', 16], ['fe80::', 10]]],
  ['multicast', [['224.0.0.0', 4], ['ff00::', 8]]],
  [
    'reserved',
    [
      ['240.0.0.0', 4],
      ['fec0::', 10],
      ['64:ff9b::', 96],
      ['64:ff9b:1::', 48],
      ['2002::', 16],
      ['2001::', 32],
      ['::', 96],
      ['100::', 64],
    ],
  ],
  ['private', [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['198.18.0.0', 15], ['fc00::', 7]]],
];

const ADDRESS_LISTS: ReadonlyArray<[Exclude<AddressClass, 'public'>, net.BlockList]> = ADDRESS_TABLE.map(([cls, rows]) => {
  const list = new net.BlockList();
  for (const [base, prefix] of rows) list.addSubnet(base, prefix, net.isIP(base) === 4 ? 'ipv4' : 'ipv6');
  return [cls, list];
});

export function classifyAddress(ip: string): AddressClass {
  const kind = net.isIP(ip);
  if (kind === 0) return 'reserved';
  const family = kind === 4 ? 'ipv4' : 'ipv6';
  for (const [cls, list] of ADDRESS_LISTS) if (list.check(ip, family)) return cls;
  return 'public';
}

export type LookupAll = (host: string) => Promise<string[]>;

const defaultLookup: LookupAll = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type DenyReason = 'not_listed' | 'blocked_address' | 'private_address' | 'dns_failed' | 'bad_request';

export type Verdict = { allowed: true; address: string; rule: ProxyRule } | { allowed: false; reason: DenyReason };

// ── log ─────────────────────────────────────────────────────────────────────────────────────────

export interface ProxyLogRow {
  t: string;
  kind: 'connect' | 'http' | 'inject' | 'control' | 'ready' | 'error';
  /** The client's address (the sandbox or a service container), read when the request ARRIVES. */
  from?: string | null;
  host?: string;
  port?: number;
  method?: string;
  allowed?: boolean;
  reason?: DenyReason | 'unexpected_credential' | 'no_host_credential';
  status?: number;
  up?: number;
  down?: number;
  ms?: number;
  /** Injector rows: which injector, the path WITHOUT its query, what was swapped. */
  via?: 'anthropic' | 'chatgpt';
  path?: string;
  swapped?: 'bearer' | 'x-api-key' | null;
  /** Control rows: what was set (never a value). */
  action?: string;
  count?: number;
  error?: string;
}

// ── the proxy ───────────────────────────────────────────────────────────────────────────────────

export interface Upstream {
  protocol: 'https:' | 'http:';
  host: string;
  port: number;
}

export interface ProxyCredentials {
  anthropicOauth?: string | null;
  anthropicApiKey?: string | null;
  chatgptAccess?: string | null;
}

export interface ProxyConfig {
  /** 0 = any free port (tests). */
  forwardPort: number;
  anthropicPort: number;
  chatgptPort: number;
  controlPort: number;
  /** Where the three public listeners bind (the container: 0.0.0.0). */
  listenHost: string;
  /** The control listener's host: ALWAYS loopback in the container. */
  controlHost: string;
  /** microsandbox (runtime/microsandbox.ts): listen on these UNIX SOCKETS instead of the ports above.
   *  The proxy then runs on the HOST, and the VM reaches the three public sockets over vsock only. */
  socketPaths?: ProxySocketPaths;
  controlToken: string;
  rules: string[];
  /** What the sandbox holds instead of each credential. */
  placeholders: { anthropic: string; chatgpt: string };
  upstreams?: { anthropic?: Upstream; chatgpt?: Upstream };
  /** TESTS ONLY (never read from the environment): let loopback through so a local upstream works. */
  unsafeAllowLoopback?: boolean;
  lookup?: LookupAll;
  log?: (row: ProxyLogRow) => void;
}

export interface ProxySocketPaths {
  forward: string;
  anthropic: string;
  chatgpt: string;
  control: string;
}

export interface RunningProxy {
  ports: { forward: number; anthropic: number; chatgpt: number; control: number };
  setRules(rules: readonly string[]): number;
  setCredentials(c: ProxyCredentials): void;
  stop(): Promise<void>;
}

const HOP_BY_HOP = ['connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'upgrade', 'te', 'trailer'];

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

export function splitAuthority(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!m || !m[1]) return null;
  const port = Number(m[2] ?? defaultPort);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    });
  });
}

function listenPath(server: net.Server, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(0);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export function createProxy(config: ProxyConfig): { start(): Promise<RunningProxy> } {
  const log = config.log ?? ((row: ProxyLogRow) => process.stdout.write(`${JSON.stringify(row)}\n`));
  const emit = (row: Omit<ProxyLogRow, 't'>): void => {
    try {
      log({ t: new Date().toISOString(), ...row });
    } catch {
      /* a log sink failing must never take a request down */
    }
  };
  const lookup = config.lookup ?? defaultLookup;
  let rules = parseRules(config.rules);
  let creds: ProxyCredentials = {};
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket): void => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };

  async function vet(rawHost: string, port: number): Promise<Verdict> {
    const host = normaliseHost(rawHost);
    if (!host) return { allowed: false, reason: 'bad_request' };
    if (host === 'localhost' || host.endsWith('.localhost')) {
      if (!config.unsafeAllowLoopback) return { allowed: false, reason: 'blocked_address' };
    }
    const rule = matchRule(rules, host, port);
    if (!rule) return { allowed: false, reason: 'not_listed' };
    let addresses: string[];
    try {
      addresses = net.isIP(host) !== 0 ? [host] : await lookup(host);
    } catch {
      return { allowed: false, reason: 'dns_failed' };
    }
    if (addresses.length === 0) return { allowed: false, reason: 'dns_failed' };
    const exact = !rule.any && !rule.suffix;
    let firstPrivate = false;
    for (const address of addresses) {
      const cls = classifyAddress(address);
      if (cls === 'loopback' && config.unsafeAllowLoopback) continue;
      if (cls === 'private') {
        if (!exact) firstPrivate = true;
        continue;
      }
      if (cls !== 'public') return { allowed: false, reason: 'blocked_address' };
    }
    if (firstPrivate) return { allowed: false, reason: 'private_address' };
    return { allowed: true, address: addresses[0] as string, rule };
  }

  // ── :3128 ──
  const forward = http.createServer((req, res) => {
    const from = req.socket.remoteAddress ?? null;
    const started = Date.now();
    req.socket.on('error', () => undefined);
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      emit({ kind: 'http', from, method: req.method ?? '', allowed: false, reason: 'bad_request', status: 400, up: 0, down: 0, ms: 0 });
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Limn proxy: send requests through it as a proxy (absolute URL).\n');
      req.resume();
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || 80);
    const method = req.method ?? 'GET';
    const deny = (reason: DenyReason): void => {
      emit({ kind: 'http', from, host, port, method, allowed: false, reason, status: 403, up: 0, down: 0, ms: Date.now() - started });
      if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain' }).end(`Limn proxy: ${host} is not allowed (${reason}).\n`);
      req.resume();
    };
    if (url.protocol !== 'http:') {
      deny('bad_request');
      return;
    }
    void vet(host, port).then((v) => {
      if (!v.allowed) {
        deny(v.reason);
        return;
      }
      let up = 0;
      let down = 0;
      const headers = stripHopByHop(req.headers);
      // The Host header is the VETTED authority, never the client's: on a shared front end (a CDN)
      // another Host would reach a site that is not on the list.
      headers.host = url.host;
      const upstream = http.request(
        { host: v.address, port, method, path: `${url.pathname}${url.search}`, headers, setHost: false },
        (ures) => {
          res.writeHead(ures.statusCode ?? 502, ures.headers);
          ures.on('data', (c: Buffer) => (down += c.length));
          ures.pipe(res);
          ures.on('end', () => emit({ kind: 'http', from, host, port, method, allowed: true, status: ures.statusCode ?? 0, up, down, ms: Date.now() - started }));
          ures.on('error', () => res.destroy());
        },
      );
      upstream.on('error', (e: NodeJS.ErrnoException) => {
        emit({ kind: 'http', from, host, port, method, allowed: true, status: 502, up, down, ms: Date.now() - started, error: e.code ?? e.message });
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      req.on('data', (c: Buffer) => (up += c.length));
      req.pipe(upstream);
    });
  });
  forward.on('connection', track);
  forward.on('clientError', (_e, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* gone */
    }
  });
  forward.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    // A client that resets after a refusal must never take the proxy down (spike 3).
    client.on('error', () => undefined);
    const from = client.remoteAddress ?? null; // read NOW: it is gone once the socket closes
    const started = Date.now();
    const authority = splitAuthority(String(req.url ?? ''), 443);
    if (!authority) {
      emit({ kind: 'connect', from, method: 'CONNECT', allowed: false, reason: 'bad_request', status: 400, up: 0, down: 0, ms: 0 });
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const { host, port } = authority;
    void vet(host, port).then((v) => {
      if (!v.allowed) {
        emit({ kind: 'connect', from, host, port, method: 'CONNECT', allowed: false, reason: v.reason, status: 403, up: 0, down: 0, ms: Date.now() - started });
        client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nLimn proxy: ${host}:${port} is not allowed (${v.reason}).\n`);
        return;
      }
      let up = head.length;
      let down = 0;
      let done = false;
      const finish = (error?: string): void => {
        if (done) return;
        done = true;
        emit({ kind: 'connect', from, host, port, method: 'CONNECT', allowed: true, status: error ? 502 : 200, up, down, ms: Date.now() - started, ...(error ? { error } : {}) });
      };
      let connected = false;
      const upstream = net.connect({ host: v.address, port }, () => {
        connected = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      upstream.on('data', (c: Buffer) => (down += c.length));
      client.on('data', (c: Buffer) => (up += c.length));
      upstream.on('error', (e: NodeJS.ErrnoException) => {
        finish(e.code ?? e.message);
        if (!connected) {
          try {
            client.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
          } catch {
            /* gone */
          }
        } else client.destroy();
      });
      upstream.on('close', () => {
        finish();
        client.destroy();
      });
      client.on('close', () => upstream.destroy());
    });
  });

  // ── injectors ──
  type Swap = { swapped: 'bearer' | 'x-api-key' | null } | { refuse: 'unexpected_credential' | 'no_host_credential' };

  const bearerOf = (h: http.OutgoingHttpHeaders): string | null =>
    typeof h.authorization === 'string' ? h.authorization.replace(/^Bearer\s+/i, '') : null;

  const swapAnthropic = (h: http.OutgoingHttpHeaders): Swap => {
    let swapped: 'bearer' | 'x-api-key' | null = null;
    const bearer = bearerOf(h);
    if (bearer !== null) {
      if (bearer !== config.placeholders.anthropic) return { refuse: 'unexpected_credential' };
      if (!creds.anthropicOauth) return { refuse: 'no_host_credential' };
      h.authorization = `Bearer ${creds.anthropicOauth}`;
      swapped = 'bearer';
    }
    const key = h['x-api-key'];
    if (key !== undefined) {
      if (key !== config.placeholders.anthropic) return { refuse: 'unexpected_credential' };
      if (!creds.anthropicApiKey) return { refuse: 'no_host_credential' };
      h['x-api-key'] = creds.anthropicApiKey;
      swapped = 'x-api-key';
    }
    return { swapped };
  };

  const swapChatgpt = (h: http.OutgoingHttpHeaders): Swap => {
    if (h['x-api-key'] !== undefined) return { refuse: 'unexpected_credential' };
    const bearer = bearerOf(h);
    if (bearer === null) return { swapped: null };
    if (bearer !== config.placeholders.chatgpt) return { refuse: 'unexpected_credential' };
    if (!creds.chatgptAccess) return { refuse: 'no_host_credential' };
    h.authorization = `Bearer ${creds.chatgptAccess}`;
    return { swapped: 'bearer' };
  };

  function injector(via: 'anthropic' | 'chatgpt', upstream: Upstream, swap: (h: http.OutgoingHttpHeaders) => Swap): http.Server {
    const server = http.createServer((req, res) => {
      req.socket.on('error', () => undefined);
      const from = req.socket.remoteAddress ?? null;
      const started = Date.now();
      const method = req.method ?? 'GET';
      const path = String(req.url ?? '/');
      const bare = path.split('?')[0] ?? '/';
      if (!path.startsWith('/')) {
        emit({ kind: 'inject', via, from, method, allowed: false, reason: 'bad_request', status: 400, ms: 0 });
        res.writeHead(400).end();
        req.resume();
        return;
      }
      const headers = stripHopByHop(req.headers);
      headers.host = upstream.port === 443 || upstream.port === 80 ? upstream.host : `${upstream.host}:${upstream.port}`;
      const s = swap(headers);
      if ('refuse' in s) {
        emit({ kind: 'inject', via, from, host: upstream.host, port: upstream.port, method, path: bare, allowed: false, reason: s.refuse, status: 403, up: 0, down: 0, ms: 0 });
        const message = s.refuse === 'unexpected_credential' ? 'This request carried a credential Limn did not give the sandbox.' : 'The sign-in for this provider is missing on the host.';
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'limn_proxy', message } }));
        req.resume();
        return;
      }
      let up = 0;
      let down = 0;
      const request = upstream.protocol === 'https:' ? https.request : http.request;
      const p = request(
        { host: upstream.host, port: upstream.port, method, path, headers, ...(upstream.protocol === 'https:' ? { servername: upstream.host } : {}) },
        (ures) => {
          res.writeHead(ures.statusCode ?? 502, ures.headers);
          ures.on('data', (c: Buffer) => (down += c.length));
          ures.pipe(res);
          ures.on('end', () =>
            emit({ kind: 'inject', via, from, host: upstream.host, port: upstream.port, method, path: bare, allowed: true, swapped: s.swapped, status: ures.statusCode ?? 0, up, down, ms: Date.now() - started }),
          );
          ures.on('error', () => res.destroy());
        },
      );
      p.on('error', (e: NodeJS.ErrnoException) => {
        emit({ kind: 'inject', via, from, host: upstream.host, port: upstream.port, method, path: bare, allowed: true, swapped: s.swapped, status: 502, up, down, ms: Date.now() - started, error: e.code ?? e.message });
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      req.on('data', (c: Buffer) => (up += c.length));
      req.pipe(p);
    });
    server.on('connection', track);
    return server;
  }

  const anthropicUp = config.upstreams?.anthropic ?? { protocol: 'https:', host: 'api.anthropic.com', port: 443 };
  const chatgptUp = config.upstreams?.chatgpt ?? { protocol: 'https:', host: 'chatgpt.com', port: 443 };
  const anthropic = injector('anthropic', anthropicUp, swapAnthropic);
  const chatgpt = injector('chatgpt', chatgptUp, swapChatgpt);

  const setRules = (list: readonly string[]): number => {
    rules = parseRules(list);
    return rules.length;
  };
  const setCredentials = (c: ProxyCredentials): void => {
    creds = { ...creds };
    for (const k of ['anthropicOauth', 'anthropicApiKey', 'chatgptAccess'] as const) {
      if (c[k] !== undefined) creds[k] = c[k] || null;
    }
  };

  // ── control ──
  const control = http.createServer((req, res) => {
    req.socket.on('error', () => undefined);
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (config.controlToken.length < 16 || req.headers['x-limn-control'] !== config.controlToken) {
      reply(403, { ok: false });
      req.resume();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      reply(200, { ok: true, rules: rules.length });
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
      if (body.length > 256_000) req.destroy();
    });
    req.on('end', () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      } catch {
        reply(400, { ok: false });
        return;
      }
      if (req.method === 'POST' && req.url === '/rules' && Array.isArray(parsed.rules)) {
        const count = setRules(parsed.rules.map(String));
        emit({ kind: 'control', action: 'rules', count });
        reply(200, { ok: true, rules: count });
        return;
      }
      if (req.method === 'POST' && req.url === '/credentials') {
        const c: ProxyCredentials = {};
        for (const k of ['anthropicOauth', 'anthropicApiKey', 'chatgptAccess'] as const) {
          const v = parsed[k];
          if (typeof v === 'string' || v === null) c[k] = v;
        }
        setCredentials(c);
        emit({ kind: 'control', action: 'credentials', count: Object.keys(c).length });
        reply(200, { ok: true });
        return;
      }
      reply(404, { ok: false });
    });
  });

  return {
    async start(): Promise<RunningProxy> {
      const sp = config.socketPaths;
      const ports = sp
        ? {
            forward: await listenPath(forward, sp.forward),
            anthropic: await listenPath(anthropic, sp.anthropic),
            chatgpt: await listenPath(chatgpt, sp.chatgpt),
            control: await listenPath(control, sp.control),
          }
        : {
            forward: await listen(forward, config.forwardPort, config.listenHost),
            anthropic: await listen(anthropic, config.anthropicPort, config.listenHost),
            chatgpt: await listen(chatgpt, config.chatgptPort, config.listenHost),
            control: await listen(control, config.controlPort, config.controlHost),
          };
      emit({ kind: 'ready', count: rules.length });
      return {
        ports,
        setRules,
        setCredentials,
        async stop() {
          for (const s of sockets) s.destroy();
          await Promise.all([close(forward), close(anthropic), close(chatgpt), close(control)]);
        },
      };
    },
  };
}

// ── the container's entry point ───────────────────────────────────────────────────────────────

export const DEFAULT_PORTS = { forward: 3128, anthropic: 8081, chatgpt: 8082, control: 3199 } as const;

/** The proxy's environment variable: non-secret JSON (`ProxyEnvConfig`). */
export const PROXY_CONFIG_ENV = 'LIMN_PROXY_CONFIG';
export const PROXY_MAIN_ENV = 'LIMN_PROXY_MAIN';

export interface ProxyEnvConfig {
  rules: string[];
  placeholders: { anthropic: string; chatgpt: string };
  controlToken: string;
  /** microsandbox only: the four unix sockets (absolute paths) to listen on instead of the ports. */
  sockets?: ProxySocketPaths;
  /** microsandbox only: exit when stdin closes, so a proxy never outlives the Limn that started it. */
  exitOnStdinEnd?: boolean;
}

/** The four socket paths from the config, or undefined when any one is missing or not absolute. */
export function socketPathsOf(raw: unknown): ProxySocketPaths | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ['forward', 'anthropic', 'chatgpt', 'control']) {
    const v = r[k];
    if (typeof v !== 'string' || !v.startsWith('/') || v.includes('\0')) return undefined;
    out[k] = v;
  }
  return out as unknown as ProxySocketPaths;
}

export async function main(): Promise<void> {
  const raw = JSON.parse(process.env[PROXY_CONFIG_ENV] ?? '{}') as Partial<ProxyEnvConfig>;
  const proxy = createProxy({
    forwardPort: DEFAULT_PORTS.forward,
    anthropicPort: DEFAULT_PORTS.anthropic,
    chatgptPort: DEFAULT_PORTS.chatgpt,
    controlPort: DEFAULT_PORTS.control,
    listenHost: '0.0.0.0',
    controlHost: '127.0.0.1',
    ...(socketPathsOf(raw.sockets) ? { socketPaths: socketPathsOf(raw.sockets) } : {}),
    controlToken: String(raw.controlToken ?? ''),
    rules: Array.isArray(raw.rules) ? raw.rules.map(String) : [],
    placeholders: {
      anthropic: String(raw.placeholders?.anthropic ?? ''),
      chatgpt: String(raw.placeholders?.chatgpt ?? ''),
    },
  });
  // The proxy is the session's only way out: a stray error is logged, never fatal.
  process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), kind: 'error', error: e.code ?? e.message })}\n`);
  });
  process.on('SIGTERM', () => process.exit(0));
  if (raw.exitOnStdinEnd === true) {
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('error', () => process.exit(0));
    process.stdin.resume();
  }
  await proxy.start();
}

if (process.env[PROXY_MAIN_ENV] === '1') void main();
