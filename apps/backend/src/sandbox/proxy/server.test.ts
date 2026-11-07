// THE EGRESS PROXY, in process (docs/SANDBOX.md § The egress proxy). Real sockets on 127.0.0.1, with the
// test-only loopback switch so a local "upstream" can stand in for the internet; every refusal path is
// checked with an upstream that COUNTS its connections, so "a denied request never connects" is proven,
// not assumed.
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyAddress, createProxy, matchRule, normaliseHost, parseRule, parseRules, splitAuthority, type ProxyLogRow, type RunningProxy } from './server.js';

describe('allow-list matcher', () => {
  const rules = parseRules(['registry.npmjs.org', '*.example.com', 'api.internal:8443', 'any.port:*', '203.0.113.7', 'bücher.example']);

  it('exact host, default ports 80 and 443 only', () => {
    expect(matchRule(rules, 'registry.npmjs.org', 443)?.text).toBe('registry.npmjs.org');
    expect(matchRule(rules, 'REGISTRY.npmjs.org.', 80)?.text).toBe('registry.npmjs.org');
    expect(matchRule(rules, 'registry.npmjs.org', 22)).toBeNull();
    expect(matchRule(rules, 'evil-registry.npmjs.org', 443)).toBeNull();
  });

  it('a suffix rule matches subdomains, never the bare suffix', () => {
    expect(matchRule(rules, 'a.b.example.com', 443)?.text).toBe('*.example.com');
    expect(matchRule(rules, 'example.com', 443)).toBeNull();
    expect(matchRule(rules, 'notexample.com', 443)).toBeNull();
  });

  it('an explicit port, or any port', () => {
    expect(matchRule(rules, 'api.internal', 8443)?.text).toBe('api.internal:8443');
    expect(matchRule(rules, 'api.internal', 443)).toBeNull();
    expect(matchRule(rules, 'any.port', 5432)?.text).toBe('any.port:*');
  });

  it('IDN hosts match in either spelling', () => {
    expect(normaliseHost('Bücher.Example')).toBe('xn--bcher-kva.example');
    expect(matchRule(rules, 'xn--bcher-kva.example', 443)?.text).toBe('xn--bcher-kva.example');
    expect(matchRule(rules, 'bücher.example', 443)?.text).toBe('xn--bcher-kva.example');
  });

  it('an IP literal is refused unless listed exactly; a suffix rule never matches an IP', () => {
    expect(matchRule(rules, '203.0.113.7', 443)?.text).toBe('203.0.113.7');
    expect(matchRule(rules, '203.0.113.8', 443)).toBeNull();
    expect(matchRule(parseRules(['*.0.113.7']), '1.0.113.7', 443)).toBeNull();
  });

  it('refuses rules that would open too much, and junk', () => {
    expect(parseRule('*.com')).toBeNull();
    expect(parseRule('*.1.2.3.4')).toBeNull();
    expect(parseRule('host:99999')).toBeNull();
    expect(parseRule('has space')).toBeNull();
    expect(parseRule('-bad-.com')).toBeNull();
    expect(parseRule('*')?.any).toBe(true);
    expect(parseRule('[2001:db8::1]:443')?.text).toBe('[2001:db8::1]:443');
  });

  it('classifies addresses', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('169.254.169.254')).toBe('link_local');
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('172.20.0.2')).toBe('private');
    expect(classifyAddress('192.168.65.254')).toBe('private');
    expect(classifyAddress('100.64.0.1')).toBe('private');
    expect(classifyAddress('0.0.0.0')).toBe('unspecified');
    expect(classifyAddress('224.0.0.1')).toBe('multicast');
    expect(classifyAddress('104.18.1.1')).toBe('public');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('fd00::1')).toBe('private');
    expect(classifyAddress('fe80::1')).toBe('link_local');
    expect(classifyAddress('2606:4700::1')).toBe('public');
    // Every spelling, and the IPv6 forms that carry an IPv4 address elsewhere.
    expect(classifyAddress('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(classifyAddress('::ffff:7f00:1')).toBe('loopback');
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('link_local');
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
    expect(classifyAddress('FD00::1')).toBe('private');
    expect(classifyAddress('64:ff9b::7f00:1')).toBe('reserved');
    expect(classifyAddress('2002:7f00:1::1')).toBe('reserved');
    expect(classifyAddress('::127.0.0.1')).toBe('reserved');
    expect(classifyAddress('fec0::1')).toBe('reserved');
    expect(classifyAddress('::ffff:8.8.8.8')).toBe('public');
    expect(classifyAddress('not-an-ip')).toBe('reserved');
  });

  it('splits CONNECT authorities', () => {
    expect(splitAuthority('example.com:443', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(splitAuthority('[::1]:8443', 443)).toEqual({ host: '::1', port: 8443 });
    expect(splitAuthority('example.com', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(splitAuthority('example.com:0', 443)).toBeNull();
  });
});

// ── the server ─────────────────────────────────────────────────────────────────────────────────

interface Upstream {
  port: number;
  connections: number;
  lastHeaders: http.IncomingHttpHeaders | null;
  close(): Promise<void>;
}

async function upstream(): Promise<Upstream> {
  const u: Upstream = { port: 0, connections: 0, lastHeaders: null, close: async () => undefined };
  const server = http.createServer((req, res) => {
    u.lastHeaders = req.headers;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello ${req.method} ${req.url} ${body.length}`));
  });
  server.on('connection', () => (u.connections += 1));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  u.port = (server.address() as net.AddressInfo).port;
  u.close = () => new Promise((r) => server.close(() => r()));
  return u;
}

const TOKEN = 'control-token-0123456789abcdef';
const running: RunningProxy[] = [];
const upstreams: Upstream[] = [];

afterEach(async () => {
  for (const p of running.splice(0)) await p.stop();
  for (const u of upstreams.splice(0)) await u.close();
});

async function start(opts: { rules?: string[]; up?: Upstream; lookup?: (h: string) => Promise<string[]>; loopback?: boolean } = {}) {
  const rows: ProxyLogRow[] = [];
  const proxy = await createProxy({
    forwardPort: 0,
    anthropicPort: 0,
    chatgptPort: 0,
    controlPort: 0,
    listenHost: '127.0.0.1',
    controlHost: '127.0.0.1',
    controlToken: TOKEN,
    rules: opts.rules ?? [],
    placeholders: { anthropic: 'ph-anthropic', chatgpt: 'ph-chatgpt' },
    upstreams: opts.up
      ? { anthropic: { protocol: 'http:', host: '127.0.0.1', port: opts.up.port }, chatgpt: { protocol: 'http:', host: '127.0.0.1', port: opts.up.port } }
      : {},
    unsafeAllowLoopback: opts.loopback ?? true,
    ...(opts.lookup ? { lookup: opts.lookup } : { lookup: async () => ['127.0.0.1'] }),
    log: (r) => rows.push(r),
  }).start();
  running.push(proxy);
  return { proxy, rows };
}

/** Raw CONNECT; resolves with the status line and the socket. */
function connectThrough(proxyPort: number, authority: string): Promise<{ status: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let buf = '';
    s.on('data', function onData(d) {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        s.off('data', onData);
        resolve({ status: buf.split('\r\n')[0] ?? '', socket: s });
      }
    });
    s.on('error', reject);
  });
}

function request(port: number, opts: http.RequestOptions & { body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const waitFor = async (pred: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('forward proxy', () => {
  it('tunnels CONNECT to a listed host and logs bytes, never headers', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy, rows } = await start({ rules: [`allowed.test:${up.port}`] });
    const { status, socket } = await connectThrough(proxy.ports.forward, `allowed.test:${up.port}`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    const reply = await new Promise<string>((resolve) => {
      let b = '';
      socket.on('data', (d) => (b += d.toString()));
      socket.on('end', () => resolve(b));
      socket.write('GET /x HTTP/1.1\r\nHost: allowed.test\r\nAuthorization: Bearer secret-value\r\nConnection: close\r\n\r\n');
    });
    expect(reply).toContain('hello GET /x');
    await waitFor(() => rows.some((r) => r.kind === 'connect'));
    const row = rows.find((r) => r.kind === 'connect')!;
    expect(row).toMatchObject({ kind: 'connect', host: 'allowed.test', port: up.port, method: 'CONNECT', allowed: true, status: 200, from: '127.0.0.1' });
    expect(row.up).toBeGreaterThan(0);
    expect(row.down).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('secret-value');
  });

  it('refuses an unlisted host with 403 and NEVER connects upstream', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy, rows } = await start({ rules: ['other.test'] });
    const { status, socket } = await connectThrough(proxy.ports.forward, `denied.test:${up.port}`);
    socket.destroy();
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(up.connections).toBe(0);
    expect(rows.find((r) => r.kind === 'connect')).toMatchObject({ host: 'denied.test', allowed: false, reason: 'not_listed', status: 403 });
  });

  it('survives a client that resets right after a refusal (spike 3)', async () => {
    const { proxy } = await start({ rules: [] });
    for (let i = 0; i < 5; i++) {
      const s = net.connect(proxy.ports.forward, '127.0.0.1', () => {
        s.write('CONNECT nope.test:443 HTTP/1.1\r\n\r\n');
        s.resetAndDestroy();
      });
      s.on('error', () => undefined);
    }
    await new Promise((r) => setTimeout(r, 50));
    const up = await upstream();
    upstreams.push(up);
    proxy.setRules([`ok.test:${up.port}`]);
    const { status, socket } = await connectThrough(proxy.ports.forward, `ok.test:${up.port}`);
    socket.destroy();
    expect(status).toContain('200');
  });

  it('refuses loopback, link-local and DNS-rebound private answers', async () => {
    const up = await upstream();
    upstreams.push(up);
    // Loopback is refused for real (no test switch) even when the name is listed.
    const strict = await start({ rules: [`*.rebind.test:*`, `exact.lan:*`, '169.254.169.254:80'], loopback: false, lookup: async (h) => (h === 'exact.lan' ? ['10.0.0.5'] : h.startsWith('lo') ? ['127.0.0.1'] : ['192.168.1.20']) });
    const lo = await connectThrough(strict.proxy.ports.forward, `lo.rebind.test:${up.port}`);
    lo.socket.destroy();
    expect(lo.status).toContain('403');
    const priv = await connectThrough(strict.proxy.ports.forward, `lan.rebind.test:443`);
    priv.socket.destroy();
    expect(priv.status).toContain('403');
    const meta = await request(strict.proxy.ports.forward, { method: 'GET', path: 'http://169.254.169.254/latest/meta-data/', headers: { host: '169.254.169.254' } });
    expect(meta.status).toBe(403);
    const reasons = strict.rows.filter((r) => r.allowed === false).map((r) => r.reason);
    expect(reasons).toEqual(['blocked_address', 'private_address', 'blocked_address']);
    expect(up.connections).toBe(0);
  });

  it('forwards absolute-form HTTP to a listed host and refuses origin-form', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy, rows } = await start({ rules: [`plain.test:${up.port}`] });
    const ok = await request(proxy.ports.forward, { method: 'POST', path: `http://plain.test:${up.port}/p?q=1`, headers: { host: `plain.test:${up.port}` }, body: 'abc' });
    expect(ok).toEqual({ status: 200, body: 'hello POST /p?q=1 3' });
    // A Host header that names another site is replaced by the vetted authority (CDN fronting).
    const fronted = await request(proxy.ports.forward, { method: 'GET', path: `http://plain.test:${up.port}/`, headers: { host: 'not-listed.example' } });
    expect(fronted.status).toBe(200);
    expect(up.lastHeaders?.host).toBe(`plain.test:${up.port}`);
    const denied = await request(proxy.ports.forward, { method: 'GET', path: `http://other.test:${up.port}/`, headers: { host: 'other.test' } });
    expect(denied.status).toBe(403);
    const direct = await request(proxy.ports.forward, { method: 'GET', path: '/', headers: { host: 'x' } });
    expect(direct.status).toBe(400);
    expect(up.connections).toBeLessThanOrEqual(2);
    await waitFor(() => rows.filter((r) => r.kind === 'http').length >= 4);
    expect(rows.filter((r) => r.kind === 'http').map((r) => [r.allowed, r.status])).toEqual([[true, 200], [true, 200], [false, 403], [false, 400]]);
  });
});

describe('credential injectors', () => {
  it('swaps the placeholder bearer for the host token, refuses any other credential, and logs no value', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy, rows } = await start({ up });
    proxy.setCredentials({ anthropicOauth: 'REAL-OAUTH-TOKEN' });

    const ok = await request(proxy.ports.anthropic, { method: 'POST', path: '/v1/messages?beta=true', headers: { authorization: 'Bearer ph-anthropic' }, body: '{}' });
    expect(ok.status).toBe(200);
    expect(up.lastHeaders?.authorization).toBe('Bearer REAL-OAUTH-TOKEN');

    const before = up.connections;
    const foreign = await request(proxy.ports.anthropic, { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'sk-ant-agent-own' }, body: '{}' });
    expect(foreign.status).toBe(403);
    expect(up.connections).toBe(before);

    await waitFor(() => rows.filter((r) => r.kind === 'inject').length >= 2);
    const inject = rows.filter((r) => r.kind === 'inject');
    expect(inject[0]).toMatchObject({ via: 'anthropic', path: '/v1/messages', swapped: 'bearer', allowed: true, status: 200 });
    expect(inject[1]).toMatchObject({ allowed: false, reason: 'unexpected_credential' });
    const text = JSON.stringify(rows);
    for (const secret of ['REAL-OAUTH-TOKEN', 'ph-anthropic', 'sk-ant-agent-own', 'beta=true']) expect(text).not.toContain(secret);
  });

  it('swaps an API-key placeholder, and says so when the host has no credential', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy } = await start({ up });
    const missing = await request(proxy.ports.anthropic, { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'ph-anthropic' } });
    expect(missing.status).toBe(403);
    expect(missing.body).toContain('missing on the host');
    proxy.setCredentials({ anthropicApiKey: 'REAL-KEY' });
    await request(proxy.ports.anthropic, { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'ph-anthropic' } });
    expect(up.lastHeaders?.['x-api-key']).toBe('REAL-KEY');
  });

  it('the ChatGPT injector swaps only its own placeholder', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy } = await start({ up });
    proxy.setCredentials({ chatgptAccess: 'REAL-CHATGPT' });
    await request(proxy.ports.chatgpt, { method: 'GET', path: '/backend-api/codex/models', headers: { authorization: 'Bearer ph-chatgpt' } });
    expect(up.lastHeaders?.authorization).toBe('Bearer REAL-CHATGPT');
    expect(up.lastHeaders?.host).toBe(`127.0.0.1:${up.port}`);
    const wrong = await request(proxy.ports.chatgpt, { method: 'GET', path: '/x', headers: { authorization: 'Bearer ph-anthropic' } });
    expect(wrong.status).toBe(403);
  });
});

describe('control port', () => {
  it('needs the token, then sets rules and credentials', async () => {
    const up = await upstream();
    upstreams.push(up);
    const { proxy, rows } = await start({ up });
    const post = (path: string, body: unknown, token = TOKEN) =>
      request(proxy.ports.control, { method: 'POST', path, headers: { 'content-type': 'application/json', 'x-limn-control': token }, body: JSON.stringify(body) });
    expect((await post('/rules', { rules: ['x.test'] }, 'wrong')).status).toBe(403);
    expect(await post('/rules', { rules: [`late.test:${up.port}`, 'junk rule'] })).toEqual({ status: 200, body: '{"ok":true,"rules":1}' });
    const { status, socket } = await connectThrough(proxy.ports.forward, `late.test:${up.port}`);
    socket.destroy();
    expect(status).toContain('200');
    expect((await post('/credentials', { anthropicOauth: 'FROM-CONTROL' })).status).toBe(200);
    await request(proxy.ports.anthropic, { method: 'POST', path: '/v1/messages', headers: { authorization: 'Bearer ph-anthropic' } });
    expect(up.lastHeaders?.authorization).toBe('Bearer FROM-CONTROL');
    expect(JSON.stringify(rows)).not.toContain('FROM-CONTROL');
    expect(rows.filter((r) => r.kind === 'control').map((r) => r.action)).toEqual(['rules', 'credentials']);
  });
});
