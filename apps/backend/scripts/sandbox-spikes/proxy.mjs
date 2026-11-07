#!/usr/bin/env node
// SPIKE (not shipped): the egress proxy + credential injector, zero dependencies. Runs as its own
// container from the sandbox image, attached to the session's --internal network AND the default
// bridge, so it is the sandbox's ONLY way out (docs/SANDBOX.md § Spike results, spike 3).
//
//   :3128  forward proxy — CONNECT (HTTPS) and absolute-form HTTP, ALLOW-LIST by host[:port].
//   :8081  Anthropic injector — plain HTTP in, TLS out to api.anthropic.com. A request that carries
//          the PLACEHOLDER credential (`Authorization: Bearer <ph>` or `x-api-key: <ph>`) gets the
//          real one; ANY other credential value is refused (403) and never forwarded.
//   :8082  ChatGPT injector — plain HTTP in, TLS out to chatgpt.com, same rule for the bearer; the
//          real access token is READ PER REQUEST from the read-only auth.json mount, so the host's
//          own refresh (Limn's app-server probe) is picked up with no restart.
//
// The real secrets reach THIS container only (env vars by name, a read-only file), never the
// sandbox. Every request is one JSON log line on stdout: host, port, method, path (injector only),
// status, bytes, allowed, swapped — never a header value.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

const PLACEHOLDER = process.env.LIMN_PLACEHOLDER || 'limn-placeholder';
// Codex sends its stored access token, which it parses as a JWT: the sandbox holds a FAKE JWT.
const CHATGPT_PLACEHOLDER = process.env.LIMN_CHATGPT_PLACEHOLDER || PLACEHOLDER;
const ALLOW = String(process.env.LIMN_ALLOW || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

/** Exact host, `host:port`, or `*.suffix` (which does NOT match the bare suffix). Ports default 443/80. */
export function allowed(host, port) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  for (const rule of ALLOW) {
    const [rh, rp] = rule.split(':');
    if (rp && Number(rp) !== Number(port)) continue;
    if (!rp && Number(port) !== 443 && Number(port) !== 80) continue;
    if (rh.startsWith('*.') ? h.endsWith(rh.slice(1)) : h === rh) return true;
  }
  return false;
}

// ── :3128 forward proxy ────────────────────────────────────────────────────────────────────────
const forward = createServer((req, res) => {
  // Absolute-form HTTP (http://host/path). HTTPS goes through CONNECT below.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const port = Number(url.port || 80);
  if (!allowed(url.hostname, port)) {
    log({ kind: 'forward', method: req.method, host: url.hostname, port, allowed: false });
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by the Limn sandbox proxy: ${url.hostname}\n`);
    return;
  }
  let up = 0, down = 0;
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const p = httpRequest({ host: url.hostname, port, method: req.method, path: url.pathname + url.search, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.on('data', (d) => (down += d.length));
    r.pipe(res);
    r.on('end', () => log({ kind: 'forward', method: req.method, host: url.hostname, port, status: r.statusCode, allowed: true, up, down }));
  });
  p.on('error', () => res.writeHead(502).end());
  req.on('data', (d) => (up += d.length));
  req.pipe(p);
});
forward.on('connect', (req, sock, head) => {
  // A client that resets after a refusal must never take the proxy down with it.
  sock.on('error', () => {});
  const [host, portS] = String(req.url).split(':');
  const port = Number(portS || 443);
  if (!allowed(host, port)) {
    log({ kind: 'connect', host, port, allowed: false });
    sock.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by the Limn sandbox proxy\n');
    return;
  }
  let up = head.length, down = 0;
  const up$ = connect(port, host, () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) up$.write(head);
    sock.pipe(up$);
    up$.pipe(sock);
  });
  sock.on('data', (d) => (up += d.length));
  up$.on('data', (d) => (down += d.length));
  const done = () => log({ kind: 'connect', host, port, allowed: true, up, down });
  up$.once('close', done);
  up$.on('error', () => sock.destroy());
  sock.on('error', () => up$.destroy());
  sock.on('close', () => up$.destroy());
});
forward.listen(3128, '0.0.0.0');

// ── injectors ──────────────────────────────────────────────────────────────────────────────────
function chatgptAccessToken() {
  const f = process.env.LIMN_CHATGPT_AUTH_FILE;
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')).tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

function injector(name, upstreamHost, swap) {
  return createServer((req, res) => {
    const headers = { ...req.headers, host: upstreamHost };
    delete headers['proxy-connection'];
    const result = swap(headers);
    if (result.refuse) {
      log({ kind: 'inject', via: name, method: req.method, path: req.url, status: 403, swapped: null, refused: result.refuse });
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'limn_proxy', message: result.refuse } }));
      return;
    }
    let up = 0, down = 0;
    const p = httpsRequest({ host: upstreamHost, port: 443, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.on('data', (d) => (down += d.length));
      r.pipe(res);
      r.on('end', () =>
        log({ kind: 'inject', via: name, method: req.method, path: String(req.url).split('?')[0], status: r.statusCode, swapped: result.swapped, up, down }),
      );
    });
    p.on('error', (e) => {
      log({ kind: 'inject', via: name, method: req.method, path: req.url, error: e.code || e.message });
      res.writeHead(502).end();
    });
    req.on('data', (d) => (up += d.length));
    req.pipe(p);
  });
}

injector('anthropic', 'api.anthropic.com', (h) => {
  const bearer = typeof h.authorization === 'string' ? h.authorization.replace(/^Bearer\s+/i, '') : null;
  if (bearer != null) {
    if (bearer !== PLACEHOLDER) return { refuse: 'unexpected credential' };
    const real = process.env.LIMN_REAL_ANTHROPIC_OAUTH;
    if (!real) return { refuse: 'no OAuth token on the host' };
    h.authorization = `Bearer ${real}`;
    return { swapped: 'bearer' };
  }
  if (h['x-api-key'] != null) {
    if (h['x-api-key'] !== PLACEHOLDER) return { refuse: 'unexpected credential' };
    const real = process.env.LIMN_REAL_ANTHROPIC_KEY;
    if (!real) return { refuse: 'no API key on the host' };
    h['x-api-key'] = real;
    return { swapped: 'x-api-key' };
  }
  return { swapped: null };
}).listen(8081, '0.0.0.0');

injector('chatgpt', 'chatgpt.com', (h) => {
  const bearer = typeof h.authorization === 'string' ? h.authorization.replace(/^Bearer\s+/i, '') : null;
  if (bearer == null) return { swapped: null };
  if (bearer !== CHATGPT_PLACEHOLDER) return { refuse: 'unexpected credential' };
  const real = chatgptAccessToken();
  if (!real) return { refuse: 'no ChatGPT sign-in on the host' };
  h.authorization = `Bearer ${real}`;
  return { swapped: 'bearer' };
}).listen(8082, '0.0.0.0');

// The proxy is the session's only way out: a stray socket error is logged, never fatal.
process.on('uncaughtException', (e) => log({ kind: 'error', error: e.code || e.message }));
log({ kind: 'ready', allow: ALLOW });
