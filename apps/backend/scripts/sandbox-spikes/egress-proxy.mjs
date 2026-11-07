#!/usr/bin/env node
// Spike 4 (docs/SANDBOX.md § Spike results): Limn's allow-list egress proxy, zero dependencies.
// The seed of WP3 (`apps/backend/src/sandbox/proxy/`). Not shipped.
//
// It runs in a container that sits on the session's `--internal` network AND the default bridge,
// so it is the only way out. It speaks:
//   - CONNECT host:port   (HTTPS and anything else tunnelled; the TLS stays end to end)
//   - absolute-form HTTP  (`GET http://host/path`, plain HTTP through a proxy)
// Every request is one JSON line on stdout:
//   {"t":…,"kind":"connect"|"http","host":…,"port":…,"method":…,"allowed":bool,"status":…,
//    "up":bytes,"down":bytes,"ms":…,"error"?:…}
// A denied request NEVER opens an upstream socket.
//
// Env:
//   PROXY_PORT   listen port (default 3128)
//   PROXY_ALLOW  comma list: `host`, `*.suffix`, optionally `:port` (`host:8443`, `*.x.com:*`).
//                No port given = 80 and 443 only. `*` alone = allow everything (record mode).
//                IP literals are refused unless listed exactly.

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PROXY_PORT ?? 3128);
const RULES = parseRules(process.env.PROXY_ALLOW ?? '');

export function parseRules(text) {
  return text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      if (entry === '*') return { any: true };
      // `[v6]:port` is not supported in the spike; v6 literals are refused anyway.
      const m = /^(.*?)(?::(\d+|\*))?$/.exec(entry);
      const host = m?.[1] ?? entry;
      const port = m?.[2] ?? null;
      return { host, port };
    });
}

export function isIpLiteral(host) {
  return net.isIP(host.replace(/^\[|\]$/g, '')) !== 0;
}

export function allowed(rules, rawHost, port) {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  for (const r of rules) {
    if (r.any) return true;
    const portOk = r.port === '*' || (r.port === null ? port === 80 || port === 443 : Number(r.port) === port);
    if (!portOk) continue;
    if (r.host.startsWith('*.')) {
      if (isIpLiteral(host)) continue; // a suffix rule never matches an IP
      const suffix = r.host.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (r.host === host) {
      return true;
    }
  }
  return false;
}

function log(row) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n');
}

function splitHostPort(authority, defaultPort) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(authority);
  return { host: m?.[1] ?? authority, port: Number(m?.[2] ?? defaultPort) };
}

function startServer() {
  const server = http.createServer((req, res) => {
    // Absolute-form plain HTTP only. Origin-form means someone talked to the proxy directly.
    let url;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Limn proxy: absolute URL required\n');
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || 80);
    const started = Date.now();
    if (url.protocol !== 'http:' || !allowed(RULES, host, port)) {
      log({ kind: 'http', from: req.socket.remoteAddress, host, port, method: req.method, allowed: false, status: 403, up: 0, down: 0, ms: 0 });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`Limn proxy: ${host} is not on the allow-list\n`);
      req.resume();
      return;
    }
    let up = 0;
    let down = 0;
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request(
      { host, port, method: req.method, path: url.pathname + url.search, headers },
      (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.on('data', (c) => (down += c.length));
        ures.pipe(res);
        ures.on('end', () =>
          log({ kind: 'http', from: req.socket.remoteAddress, host, port, method: req.method, allowed: true, status: ures.statusCode, up, down, ms: Date.now() - started }),
        );
      },
    );
    upstream.on('error', (e) => {
      log({ kind: 'http', host, port, method: req.method, allowed: true, status: 502, up, down, ms: Date.now() - started, error: e.message });
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.on('data', (c) => (up += c.length));
    req.pipe(upstream);
  });

  server.on('connect', (req, client, head) => {
    const { host, port } = splitHostPort(req.url ?? '', 443);
    const started = Date.now();
    const from = client.remoteAddress; // read now: it is gone once the socket closes
    if (!allowed(RULES, host, port)) {
      log({ kind: 'connect', from, host, port, method: 'CONNECT', allowed: false, status: 403, up: 0, down: 0, ms: 0 });
      client.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nLimn proxy: not on the allow-list\n');
      return;
    }
    let up = head.length;
    let down = 0;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      log({ kind: 'connect', from, host, port, method: 'CONNECT', allowed: true, status: error ? 502 : 200, up, down, ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    const upstream = net.connect(port, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('data', (c) => (down += c.length));
    client.on('data', (c) => (up += c.length));
    upstream.on('error', (e) => {
      finish(e.message);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
    upstream.on('close', () => {
      finish();
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
  });

  server.listen(PORT, '0.0.0.0', () => log({ kind: 'listening', port: PORT, rules: RULES.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
