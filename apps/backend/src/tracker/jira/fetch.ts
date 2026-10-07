import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

// ⚠ THE ONE OUTBOUND HELPER FOR EVERY JIRA CALL. The Jira base URL is TYPED BY THE CUSTOMER, so a
// request to it is a server-side request to wherever they point it — the Slack webhook taught this
// codebase that the hard way (SECURITY.md § Slack webhook SSRF). Everything that reaches Jira goes
// through `jiraGetJson`, and nothing else in core talks to a customer-named host (the Slack webhook has its own guard).
//
// What it enforces, in BOTH modes:
//   • GET only (the ONE exception is the Linear GraphQL POST to its FIXED host — linear/client.ts —
//     which passes a body through the same transport), a hard TIMEOUT (10s for the whole exchange) and a RESPONSE SIZE CAP;
//   • NO REDIRECTS. Node's http client never follows one, and any 3xx is an error — following it
//     would forward the Authorization header to a host nobody chose;
//   • JSON ONLY: a non-JSON body (an SSO login page, a proxy's HTML) is an error, never parsed.
//
// And in CLOUD mode, additionally (the server sits inside a private network there):
//   • https only;
//   • the host must resolve to PUBLIC addresses. Loopback, RFC1918, CGNAT, link-local (including
//     169.254.169.254, the metadata endpoint), unique-local, multicast, reserved and unspecified
//     addresses are refused — for an IP-literal host up front, and for a name AT CONNECT TIME,
//     through the socket's own `lookup`. Checking the address the socket actually dials (rather
//     than resolving once and fetching by name) is what closes DNS rebinding: there is no second
//     resolution for an attacker to answer differently.
//
// LOCAL mode allows http and LAN hosts: an on-prem Jira on the office network is the normal case,
// and the operator is the only caller.
//
// ⚠ NEVER LOG the request options or headers — they carry the token. Errors below carry a CODE
// and never the upstream body.

export const JIRA_TIMEOUT_MS = 10_000;
export const JIRA_MAX_BYTES = 5 * 1024 * 1024;

export type JiraFetchErrorCode =
  | 'bad_url'
  | 'blocked'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  // The provider says THIS ticket exists but the credential may not read it (GitHub Issues: a
  // private or SSO-protected repository). A statement about the ticket — never a workspace backoff.
  | 'no_access'
  | 'http'
  | 'not_json'
  | 'too_large';

export class JiraFetchError extends Error {
  constructor(
    public readonly code: JiraFetchErrorCode,
    public readonly status: number | null = null,
  ) {
    super(`jira request failed: ${code}${status != null ? ` (${status})` : ''}`);
    this.name = 'JiraFetchError';
  }
}

// ---- the address guard ----

const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network", incl. 0.0.0.0 (unspecified)
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT (a provider's internal range)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
}

const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');
}

// An IPv4 address embedded in an IPv6 one (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible,
// `64:ff9b::a.b.c.d` NAT64) — judged as the IPv4 address it reaches.
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1] ?? null;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16);
    const lo = parseInt(hex[2] ?? '0', 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `ip` is an address a CLOUD-mode Jira call must never reach. Non-IP input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return BLOCKED_V4.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = embeddedV4(bare);
    if (v4 != null) return BLOCKED_V4.check(v4, 'ipv4');
    return BLOCKED_V6.check(bare, 'ipv6');
  }
  return true;
}

export interface JiraFetchPolicy {
  /** Cloud: https only + public addresses only. Local: http and LAN allowed. */
  cloud: boolean;
}

/** Parse and vet a URL BEFORE any socket opens. Throws `bad_url` / `blocked`. */
export function checkJiraUrl(raw: string, policy: JiraFetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JiraFetchError('bad_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new JiraFetchError('bad_url');
  if (url.username !== '' || url.password !== '') throw new JiraFetchError('bad_url');
  if (policy.cloud) {
    if (url.protocol !== 'https:') throw new JiraFetchError('blocked');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // An IP-literal host never goes through `lookup`, so it is judged here. (WHATWG URL parsing
    // has already normalised `2130706433` / `0x7f.1` to dotted IPv4.)
    if (isIP(host) !== 0 && isBlockedAddress(host)) throw new JiraFetchError('blocked');
    const lowered = host.toLowerCase();
    if (lowered === 'localhost' || lowered.endsWith('.localhost')) throw new JiraFetchError('blocked');
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
export type LookupFn = (
  hostname: string,
  options: LookupOneOptions | LookupAllOptions,
  callback: LookupCallback,
) => void;

/**
 * A socket `lookup` that refuses to connect to a blocked address. Resolves ALL addresses and
 * refuses if ANY is blocked — a name answering one public and one private address is not a Jira
 * site, it is a rebinding setup. Exported for its test.
 */
export function guardedLookup(resolve: typeof dnsLookup = dnsLookup): LookupFn {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
        const e = new JiraFetchError('blocked') as unknown as NodeJS.ErrnoException;
        return callback(e, '');
      }
      if ((options as LookupAllOptions).all) return callback(null, list);
      const first = list[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  };
}

// ---- the transport (injectable for tests) ----

export interface RawResponse {
  status: number;
  contentType: string;
  body: string;
  /** Response headers, lower-cased names (Linear's rate-limit counters). Absent from a fake. */
  headers?: Record<string, string>;
}

/** A request BODY — the Linear GraphQL POST (tracker/linear/client.ts). Absent = a GET. */
export interface TransportInit {
  method: 'POST';
  body: string;
}

export type JiraTransport = (
  url: URL,
  headers: Record<string, string>,
  opts: { lookup: LookupFn | undefined; timeoutMs: number; maxBytes: number },
  init?: TransportInit,
) => Promise<RawResponse>;

export const nodeTransport: JiraTransport = (url, headers, opts, init) =>
  new Promise<RawResponse>((resolve, reject) => {
    const reqOpts: RequestOptions = {
      method: init?.method ?? 'GET',
      headers: init != null ? { ...headers, 'content-length': String(Buffer.byteLength(init.body)) } : headers,
      ...(opts.lookup ? { lookup: opts.lookup as unknown as RequestOptions['lookup'] } : {}),
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (e: JiraFetchError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(e);
    };
    const req = send(url, reqOpts, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      // Do not read a redirect's body, and never follow its Location.
      if (status >= 300 && status < 400) {
        res.resume();
        return fail(new JiraFetchError('redirect', status));
      }
      const declared = Number(res.headers['content-length'] ?? '');
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.resume();
        return fail(new JiraFetchError('too_large', status));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) return fail(new JiraFetchError('too_large', status));
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
        resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), headers: out });
      });
      res.on('error', () => fail(new JiraFetchError('network')));
    });
    const timer = setTimeout(() => fail(new JiraFetchError('timeout')), opts.timeoutMs);
    req.on('error', (err: unknown) =>
      fail(err instanceof JiraFetchError ? err : new JiraFetchError('network')),
    );
    req.end(init?.body);
  });

/**
 * GET a Jira URL and parse JSON. Throws `JiraFetchError` for every failure; the caller maps the
 * code to a sentence (client.ts `jiraErrorMessage`).
 */
export async function jiraGetJson(
  rawUrl: string,
  headers: Record<string, string>,
  policy: JiraFetchPolicy,
  transport: JiraTransport = nodeTransport,
): Promise<unknown> {
  const url = checkJiraUrl(rawUrl, policy);
  const res = await transport(
    url,
    { accept: 'application/json', 'user-agent': 'Limn', ...headers },
    {
      lookup: policy.cloud ? guardedLookup() : undefined,
      timeoutMs: JIRA_TIMEOUT_MS,
      maxBytes: JIRA_MAX_BYTES,
    },
  );
  if (res.status >= 300 && res.status < 400) throw new JiraFetchError('redirect', res.status);
  if (res.status === 401) throw new JiraFetchError('unauthorized', 401);
  if (res.status === 403) throw new JiraFetchError('forbidden', 403);
  if (res.status === 404) throw new JiraFetchError('not_found', 404);
  if (res.status < 200 || res.status >= 300) throw new JiraFetchError('http', res.status);
  if (!/\bjson\b/i.test(res.contentType)) throw new JiraFetchError('not_json', res.status);
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new JiraFetchError('not_json', res.status);
  }
}
