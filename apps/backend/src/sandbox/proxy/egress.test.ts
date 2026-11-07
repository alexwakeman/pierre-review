// ONE SESSION'S EGRESS over the FAKE runtime: what the proxy container is started with (no secret in
// its env or argv), how credentials and Allow clicks reach it (control port over exec STDIN), and how
// its log becomes Network rows.
import { describe, expect, it } from 'vitest';
import { createFakeRuntime, type FakeRuntime } from '../runtime/fake.js';
import { startEgress, type AllowedHostStore } from './egress.js';

const owner = { sessionId: 's1', accountId: 1 };

function memoryStore(initial: string[] = []): AllowedHostStore & { rows: string[] } {
  const rows = [...initial];
  return {
    rows,
    list: async () => [...rows],
    add: async (_a, _w, rule) => {
      const added = !rows.includes(rule);
      if (added) rows.push(rule);
      return { ok: true, rule, added };
    },
  };
}

function setup(fake: FakeRuntime) {
  const control: { path: string; body: Record<string, unknown> }[] = [];
  fake.onExec((argv) => argv[0] === 'node' && argv[1] === '-e', async (ctx) => {
    for await (const l of ctx.stdin) control.push(JSON.parse(l));
    ctx.stdout('{"ok":true}');
    return 0;
  });
  // The proxy prints `ready` once listening.
  const realFollow = fake.followLogs.bind(fake);
  fake.followLogs = (c, o) => {
    const h = realFollow(c, o);
    setTimeout(() => fake.emitLog(c, '{"t":"x","kind":"ready","count":11}'), 5);
    return h;
  };
  return control;
}

describe('startEgress', () => {
  it('starts the proxy with non-secret config only, then pushes the credential over the control port', async () => {
    const fake = createFakeRuntime();
    const control = setup(fake);
    const store = memoryStore(['nexus.corp.example']);
    const egress = await startEgress({
      runtime: fake,
      owner,
      workspaceId: 7,
      image: 'img',
      network: 'limn-s1-net',
      provider: 'claude',
      store,
      credentialsFor: () => ({ creds: { anthropicOauth: 'REAL-SECRET', anthropicApiKey: null }, problem: null }),
    });
    const started = fake.calls.find((c) => c.method === 'startProxy')!.args[0] as { env: Record<string, string>; alias: string; network: string };
    expect(started.alias).toBe('limn-proxy');
    expect(started.network).toBe('limn-s1-net');
    // Nowhere but an exec's STDIN: not the proxy's env, not any argv.
    const outsideStdin = fake.calls.map((c) => (c.method === 'exec' ? [c.args[0], c.args[1]] : c.args));
    expect(JSON.stringify(outsideStdin)).not.toContain('REAL-SECRET');
    const cfg = JSON.parse(started.env.LIMN_PROXY_CONFIG!);
    expect(cfg.rules).toContain('registry.npmjs.org');
    expect(cfg.rules).toContain('nexus.corp.example');
    expect(cfg.controlToken).toMatch(/^[0-9a-f]{48}$/);
    // The secret travelled on stdin to the control port, nowhere else.
    expect(control).toEqual([{ path: '/credentials', body: { anthropicOauth: 'REAL-SECRET', anthropicApiKey: null } }]);
    // The sandbox gets the placeholder the proxy expects, and no global proxy variables.
    expect(egress.sandboxEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(cfg.placeholders.anthropic);
    expect(egress.sandboxEnv.ANTHROPIC_BASE_URL).toBe('http://limn-proxy:8081');
    expect(egress.sandboxEnv.HTTPS_PROXY).toBeUndefined();
    expect(egress.credentialMode).toBe('injected');
    expect(egress.credentialProblem).toBeNull();
    egress.close();
  });

  it('applies Allow for this session (memory) and Always allow (stored), each as a reader click', async () => {
    const fake = createFakeRuntime();
    const control = setup(fake);
    const store = memoryStore();
    const egress = await startEgress({
      runtime: fake, owner, workspaceId: 7, image: 'img', network: 'n', provider: 'claude', store,
      credentialsFor: () => ({ creds: {}, problem: 'Sign in to Claude Code on this computer first.' }),
    });
    expect(egress.credentialProblem).toMatch(/Sign in/);
    expect(await egress.allow('Example.org', 'session')).toEqual({ ok: true, rule: 'example.org' });
    expect(store.rows).toEqual([]);
    expect(await egress.allow('pkgs.example.net:8443', 'workspace')).toEqual({ ok: true, rule: 'pkgs.example.net:8443' });
    expect(store.rows).toEqual(['pkgs.example.net:8443']);
    expect(await egress.allow('*', 'session')).toMatchObject({ ok: false });
    const pushes = control.filter((c) => c.path === '/rules').map((c) => c.body.rules as string[]);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual(expect.arrayContaining(['example.org', 'pkgs.example.net:8443', 'registry.npmjs.org']));
    expect(egress.rules()).toEqual(pushes[1]);
    egress.close();
  });

  it('turns proxy log lines into Network rows named by container', async () => {
    const fake = createFakeRuntime();
    setup(fake);
    fake.networkMembers = async () => new Map([['172.30.0.3', 'limn-s1-sandbox']]);
    const seen: string[] = [];
    const egress = await startEgress({
      runtime: fake, owner, workspaceId: 7, image: 'img', network: 'n', provider: 'claude', store: memoryStore(),
      credentialsFor: () => ({ creds: {}, problem: null }),
      onNetwork: (e) => seen.push(`${e.source} ${e.host} ${e.allowed}`),
    });
    fake.emitLog(egress.proxy, JSON.stringify({ t: 'x', kind: 'connect', from: '172.30.0.3', host: 'example.com', port: 443, allowed: false, reason: 'not_listed', status: 403 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['limn-s1-sandbox example.com false']);
    expect(egress.log.snapshot()[0]).toMatchObject({ host: 'example.com', reason: 'not_listed', count: 1 });
    egress.close();
  });

  it('fails plainly when the proxy never says ready', async () => {
    const fake = createFakeRuntime();
    await expect(
      startEgress({ runtime: fake, owner, workspaceId: 7, image: 'img', network: 'n', provider: 'claude', store: memoryStore(), readyTimeoutMs: 50, credentialsFor: () => ({ creds: {}, problem: null }) }),
    ).rejects.toThrow('The egress proxy did not start.');
  });
});
