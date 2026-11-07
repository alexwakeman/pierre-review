// limn-svcd — the services RELAY inside the sandbox (docs/SANDBOX.md § Services). Limn starts it with
// `docker exec -i` and talks to it over its STDIN/STDOUT, one JSON object per line. Nothing listens on
// the network for Limn: the host never accepts a connection from a sandbox.
//
//   limn-svc  ──unix socket──►  limn-svcd  ──stdout──►  Limn (host): police, build, docker compose
//             ◄────────────────            ◄──stdin────
//
// It also runs the LOCALHOST FORWARDS Limn gives it: tests that hard-code `localhost:5432` reach
// `postgres:5432` (compose's published ports are dropped; spike 4 rule 3).
//
// Host → relay: {t:'out', id, stream:'o'|'e', data} · {t:'exit', id, code} · {t:'forward', ports:[{port, host, target}]}
// Relay → host: {t:'ready', socket} · {t:'req', id, argv, cwd} · {t:'gone', id} · {t:'forwards', listening, failed}
//
// The relay trusts nothing it is sent by a client: it passes argv on as data; Limn checks it.
'use strict';
const fs = require('node:fs');
const net = require('node:net');

const SOCKET = process.env.LIMN_SVC_SOCKET || '/tmp/limn-svc.sock';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CLIENTS = 8;
const MAX_FORWARDS = 256;

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

let nextId = 1;
const clients = new Map();

try {
  fs.unlinkSync(SOCKET);
} catch {
  /* not there */
}

const server = net.createServer((sock) => {
  if (clients.size >= MAX_CLIENTS) {
    sock.end(JSON.stringify({ e: 'limn-svc: too many requests at once. Try again.\n' }) + '\n' + JSON.stringify({ x: 3 }) + '\n');
    return;
  }
  let buf = '';
  let id = null;
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    if (id !== null) return;
    buf += chunk;
    if (buf.length > MAX_REQUEST_BYTES) {
      sock.end(JSON.stringify({ e: 'limn-svc: the request is too long.\n' }) + '\n' + JSON.stringify({ x: 2 }) + '\n');
      return;
    }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    let req;
    try {
      req = JSON.parse(buf.slice(0, nl));
    } catch {
      sock.end(JSON.stringify({ e: 'limn-svc: unreadable request.\n' }) + '\n' + JSON.stringify({ x: 2 }) + '\n');
      return;
    }
    const argv = Array.isArray(req.argv) ? req.argv.filter((a) => typeof a === 'string') : [];
    id = nextId++;
    clients.set(id, sock);
    send({ t: 'req', id, argv, cwd: typeof req.cwd === 'string' ? req.cwd : '' });
  });
  const gone = () => {
    if (id !== null && clients.delete(id)) send({ t: 'gone', id });
  };
  sock.on('close', gone);
  sock.on('error', gone);
});
server.on('error', (e) => {
  process.stderr.write(`limn-svcd: ${e.message}\n`);
  process.exit(1);
});
server.listen(SOCKET, () => {
  try {
    fs.chmodSync(SOCKET, 0o600);
  } catch {
    /* best effort: the sandbox has one user */
  }
  send({ t: 'ready', socket: SOCKET });
});

// ── Localhost forwards ──────────────────────────────────────────────────────────────────────────
const forwards = new Map(); // port → { key, servers: net.Server[] }

function listenOn(port, address, host, target) {
  return new Promise((resolve) => {
    const s = net.createServer((client) => {
      const upstream = net.connect(target, host);
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
    });
    s.once('error', (e) => resolve({ server: null, error: e.code || e.message }));
    s.listen(port, address, () => resolve({ server: s, error: null }));
  });
}

async function setForwards(list) {
  const wanted = new Map();
  for (const f of Array.isArray(list) ? list.slice(0, MAX_FORWARDS) : []) {
    const port = Number(f && f.port);
    const target = Number(f && f.target);
    const host = f && typeof f.host === 'string' ? f.host : '';
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(target) || target < 1 || target > 65535) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(host)) continue;
    if (!wanted.has(port)) wanted.set(port, { host, target, key: `${host}:${target}` });
  }
  for (const [port, f] of forwards) {
    const w = wanted.get(port);
    if (!w || w.key !== f.key) {
      for (const s of f.servers) s.close();
      forwards.delete(port);
    }
  }
  const listening = [];
  const failed = [];
  for (const [port, w] of wanted) {
    if (forwards.has(port)) {
      listening.push(port);
      continue;
    }
    const v4 = await listenOn(port, '127.0.0.1', w.host, w.target);
    if (!v4.server) {
      failed.push({ port, reason: v4.error });
      continue;
    }
    const servers = [v4.server];
    // `localhost` may resolve to ::1 first; listen there too when the sandbox has IPv6 loopback.
    const v6 = await listenOn(port, '::1', w.host, w.target);
    if (v6.server) servers.push(v6.server);
    forwards.set(port, { key: w.key, servers });
    listening.push(port);
  }
  send({ t: 'forwards', listening, failed });
}

// ── Limn's messages ─────────────────────────────────────────────────────────────────────────────
let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inBuf += chunk;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i);
    inBuf = inBuf.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.t === 'forward') {
      void setForwards(m.ports);
      continue;
    }
    const sock = clients.get(m.id);
    if (!sock) continue;
    if (m.t === 'out' && typeof m.data === 'string') {
      sock.write(JSON.stringify(m.stream === 'e' ? { e: m.data } : { o: m.data }) + '\n');
    } else if (m.t === 'exit') {
      clients.delete(m.id);
      sock.end(JSON.stringify({ x: Number.isInteger(m.code) ? m.code : 1 }) + '\n');
    }
  }
});
// Limn went away: nothing can answer any more.
process.stdin.on('end', () => {
  for (const sock of clients.values()) sock.end(JSON.stringify({ e: 'limn-svc: Limn stopped answering.\n' }) + '\n' + JSON.stringify({ x: 3 }) + '\n');
  server.close();
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    /* gone */
  }
  process.exit(0);
});
