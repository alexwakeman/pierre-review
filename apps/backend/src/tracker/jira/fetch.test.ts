// ── THE ONE JIRA FETCH HELPER: SSRF guard, redirects, size, timeout ────────────────────────────
//
// The Jira base URL is typed by the customer, so every call to it is a server-side request to a
// place they chose. In CLOUD mode the helper must refuse http, loopback, RFC1918, link-local
// (169.254.169.254) and unique-local addresses — for an IP literal up front, and for a NAME at
// connect time through the socket's own lookup. LOCAL mode allows http and LAN (on-prem Jira).
// Both modes refuse redirects, cap the body and time out.
//
// The last block runs REAL sockets against a loopback server — allowed only because it is LOCAL
// mode, which is itself part of what is being pinned.
//
//   ./apps/backend/node_modules/.bin/vitest run --root packages/pro test/jira-fetch.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import {
  JiraFetchError,
  checkJiraUrl,
  guardedLookup,
  isBlockedAddress,
  jiraGetJson,
  nodeTransport,
  type JiraTransport,
} from './fetch.js';

const cloud = { cloud: true };
const local = { cloud: false };

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof JiraFetchError ? e.code : 'other';
  }
};

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::10.0.0.1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['104.192.141.1', '13.52.5.96', '2600:1f18::1', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('checkJiraUrl — before any socket opens', () => {
  it('cloud refuses http, loopback / private / link-local literals and localhost names', () => {
    expect(codeOf(() => checkJiraUrl('http://acme.atlassian.net', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://127.0.0.1/rest', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://169.254.169.254/latest', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://10.1.2.3', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://[::1]:8443', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://[fd00::5]', cloud))).toBe('blocked');
    // WHATWG normalises these to 127.0.0.1 before the check sees them.
    expect(codeOf(() => checkJiraUrl('https://2130706433/', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://0x7f.1/', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://localhost', cloud))).toBe('blocked');
    expect(codeOf(() => checkJiraUrl('https://jira.localhost', cloud))).toBe('blocked');
  });

  it('cloud allows a public https host', () => {
    expect(codeOf(() => checkJiraUrl('https://acme.atlassian.net/rest/api/2/field', cloud))).toBeNull();
  });

  it('local allows http and LAN hosts — an on-prem Jira', () => {
    expect(codeOf(() => checkJiraUrl('http://192.168.1.20:8080/rest/api/2/field', local))).toBeNull();
    expect(codeOf(() => checkJiraUrl('http://jira.lan/rest', local))).toBeNull();
    expect(codeOf(() => checkJiraUrl('http://127.0.0.1:8080', local))).toBeNull();
  });

  it('both modes refuse non-http schemes and userinfo', () => {
    for (const p of [cloud, local]) {
      expect(codeOf(() => checkJiraUrl('file:///etc/passwd', p))).toBe('bad_url');
      expect(codeOf(() => checkJiraUrl('gopher://x', p))).toBe('bad_url');
      expect(codeOf(() => checkJiraUrl('https://user:pw@acme.atlassian.net', p))).toBe('bad_url');
      expect(codeOf(() => checkJiraUrl('not a url', p))).toBe('bad_url');
    }
  });
});

describe('guardedLookup — the check runs on the address the socket dials (no rebinding gap)', () => {
  const fakeResolve =
    (addrs: LookupAddress[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_h: string, _o: unknown, cb: any) => cb(null, addrs)) as never;

  const run = (addrs: LookupAddress[], all = false) =>
    new Promise<{ err: unknown; address: unknown }>((resolve) => {
      guardedLookup(fakeResolve(addrs))('jira.example', { all } as never, (err, address) =>
        resolve({ err, address }),
      );
    });

  it('refuses a name that resolves to a private or link-local address', async () => {
    const r1 = await run([{ address: '10.0.0.8', family: 4 }]);
    expect(r1.err).toBeInstanceOf(JiraFetchError);
    expect((r1.err as JiraFetchError).code).toBe('blocked');
    const r2 = await run([{ address: '169.254.169.254', family: 4 }]);
    expect((r2.err as JiraFetchError).code).toBe('blocked');
  });

  it('refuses when ANY answer is private, even beside a public one', async () => {
    const r = await run([
      { address: '104.192.141.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    expect((r.err as JiraFetchError).code).toBe('blocked');
  });

  it('passes a public answer through, in both callback shapes', async () => {
    const one = await run([{ address: '104.192.141.1', family: 4 }]);
    expect(one.err).toBeNull();
    expect(one.address).toBe('104.192.141.1');
    const all = await run([{ address: '104.192.141.1', family: 4 }], true);
    expect(all.address).toEqual([{ address: '104.192.141.1', family: 4 }]);
  });
});

describe('jiraGetJson wires the guard for cloud and skips it for local', () => {
  it('cloud passes a guarded lookup to the transport; local passes none', async () => {
    const seen: Array<boolean> = [];
    const t: JiraTransport = async (_u, _h, opts) => {
      seen.push(opts.lookup != null);
      return { status: 200, contentType: 'application/json', body: '[]' };
    };
    await jiraGetJson('https://acme.atlassian.net/rest/api/2/field', {}, cloud, t);
    await jiraGetJson('http://jira.lan/rest/api/2/field', {}, local, t);
    expect(seen).toEqual([true, false]);
  });

  it('a blocked cloud URL never reaches the transport', async () => {
    let called = false;
    const t: JiraTransport = async () => {
      called = true;
      return { status: 200, contentType: 'application/json', body: '[]' };
    };
    await expect(jiraGetJson('https://169.254.169.254/', {}, cloud, t)).rejects.toMatchObject({ code: 'blocked' });
    await expect(jiraGetJson('http://acme.atlassian.net/', {}, cloud, t)).rejects.toMatchObject({ code: 'blocked' });
    expect(called).toBe(false);
  });
});

describe('real sockets (LOCAL mode, loopback server)', () => {
  let server: Server;
  let base = '';
  let lastAuthOnRedirectTarget: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/landed' });
        return res.end();
      }
      if (req.url === '/landed') {
        lastAuthOnRedirectTarget = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"landed":true}');
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(`"${'x'.repeat(5000)}"`);
      }
      if (req.url === '/slow') return; // never answers
      if (req.url === '/html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>login</html>');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reads JSON', async () => {
    expect(await jiraGetJson(`${base}/ok`, {}, local)).toEqual({ ok: true });
  });

  it('⚠ REFUSES A REDIRECT and never forwards the Authorization header', async () => {
    lastAuthOnRedirectTarget = undefined;
    await expect(
      jiraGetJson(`${base}/redirect`, { authorization: 'Bearer secret' }, local),
    ).rejects.toMatchObject({ code: 'redirect', status: 302 });
    expect(lastAuthOnRedirectTarget).toBeUndefined();
  });

  it('refuses a non-JSON body', async () => {
    await expect(jiraGetJson(`${base}/html`, {}, local)).rejects.toMatchObject({ code: 'not_json' });
  });

  it('caps the body size', async () => {
    const url = new URL(`${base}/big`);
    await expect(
      nodeTransport(url, {}, { lookup: undefined, timeoutMs: 5000, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('times out', async () => {
    const url = new URL(`${base}/slow`);
    await expect(
      nodeTransport(url, {}, { lookup: undefined, timeoutMs: 100, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('⚠ a NAME that resolves to loopback is refused by the socket lookup itself', async () => {
    // What the guard exists for: a public-looking name whose DNS answer is internal. The refusal
    // must surface as `blocked` through the real http client's error path, not as a network error.
    const port = (server.address() as AddressInfo).port;
    const toLoopback = guardedLookup(((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }])) as never);
    await expect(
      nodeTransport(new URL(`http://jira.example.test:${port}/ok`), {}, {
        lookup: toLoopback,
        timeoutMs: 2000,
        maxBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
  });

  it('⚠ CLOUD refuses the same loopback server (http AND the address)', async () => {
    await expect(jiraGetJson(`${base}/ok`, {}, cloud)).rejects.toMatchObject({ code: 'blocked' });
  });
});
