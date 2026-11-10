// THE REAL-DOCKER TEST (slow project; docs/SANDBOX.md § Testing). A real daemon, the real image, the
// real proxy: a sandbox on an `--internal` network reaches an ALLOWED host only through the proxy, is
// REFUSED a denied one (logged, attributed to the sandbox container), has no direct route out, gets a
// host after a reader's "Allow for this session", and cannot use a credential Limn did not give it.
//
// Skipped, with the reason printed, when no daemon answers. Needs the internet (registry.npmjs.org and
// example.com). The first run builds the sandbox image (a few minutes) unless LIMN_SANDBOX_TEST_IMAGE
// names one. Every resource carries `limn.test=1` and its own `limn.managed` value, and is removed.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgress, type EgressSession } from '../proxy/egress.js';
import { createDockerRuntime } from './docker.js';
import type { SandboxRuntime } from './types.js';

const instance = `test-${randomBytes(4).toString('hex')}`;
const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
const rt: SandboxRuntime = createDockerRuntime({ instance, extraLabels: { 'limn.test': '1' } });
const docker = process.env.SANDBOX_CLI || 'docker';

const probe = spawnSync(docker, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 20_000 });
const daemon = probe.status === 0 && probe.stdout.trim() === 'linux';
if (!daemon) console.warn(`[docker-real] SKIPPED: no Linux container daemon answers (${docker} info: ${(probe.stderr || probe.error?.message || 'no answer').trim().split('\n')[0]})`);

let image = '';
let sandbox = '';
let egress: EgressSession | null = null;

async function sh(cmd: string): Promise<{ code: number | null; out: string }> {
  const r = await rt.run(sandbox, ['bash', '-c', cmd], { timeoutMs: 60_000 });
  return { code: r.code, out: `${String(r.stdout)}${r.stderr}`.trim() };
}

describe.skipIf(!daemon)('sandbox on a real daemon', () => {
  beforeAll(async () => {
    const override = process.env.LIMN_SANDBOX_TEST_IMAGE;
    image = override ?? (await rt.ensureImage()).ref;
    const net = await rt.createNetwork(owner);
    egress = await startEgress({
      runtime: rt,
      owner,
      workspaceId: 0,
      image,
      network: net.name,
      provider: 'claude',
      store: { list: async () => [], add: async (_a, _w, rule) => ({ ok: true, rule, added: true }) },
      // No real credential in this test: the injector's refusals are what is checked.
      credentialsFor: () => ({ creds: { anthropicOauth: null, anthropicApiKey: null }, problem: null }),
    });
    const volume = await rt.createVolume(owner, 'work');
    sandbox = (
      await rt.startSandbox({
        ...owner,
        image,
        network: net.name,
        env: egress.sandboxEnv,
        mounts: [{ kind: 'volume', name: volume, target: '/Users/limn-test/ws' }],
        resources: { cpus: 1, memoryBytes: 1024 ** 3, pids: 256, diskBytes: 1024 ** 3 },
        workdir: '/Users/limn-test/ws',
      })
    ).name;
  }, 20 * 60_000);

  afterAll(async () => {
    egress?.close();
    await rt.destroy(owner.sessionId);
    const left = await rt.sweep([], { dryRun: true });
    expect(left).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 120_000);

  it('reaches an allowed host through the proxy', async () => {
    const r = await sh('curl -sS -m 30 -o /dev/null -w "%{http_code}" -x "$LIMN_PROXY" https://registry.npmjs.org/');
    expect(r.out).toBe('200');
  }, 60_000);

  it('is refused a denied host, and the refusal is logged against the sandbox', async () => {
    const r = await sh('curl -sS -m 20 -o /dev/null -w "%{http_code}" -x "$LIMN_PROXY" https://example.com/; echo " exit=$?"');
    expect(r.out).not.toMatch(/^200/);
    for (let i = 0; i < 50 && !egress!.log.snapshot().some((e) => e.host === 'example.com'); i++) await new Promise((res) => setTimeout(res, 100));
    const row = egress!.log.snapshot().find((e) => e.host === 'example.com');
    expect(row).toMatchObject({ allowed: false, reason: 'not_listed', port: 443, source: sandbox });
    const ok = egress!.log.snapshot().find((e) => e.host === 'registry.npmjs.org');
    expect(ok).toMatchObject({ allowed: true, source: sandbox });
  }, 60_000);

  it('has no direct route out', async () => {
    const r = await sh('curl -sS -m 10 -o /dev/null -w "%{http_code}" --noproxy "*" https://example.com/; echo " exit=$?"');
    expect(r.out).toMatch(/exit=(6|7|28)/);
  }, 30_000);

  it('gets the host after "Allow for this session"', async () => {
    expect(await egress!.allow('example.com', 'session')).toEqual({ ok: true, rule: 'example.com' });
    const r = await sh('curl -sS -m 30 -o /dev/null -w "%{http_code}" -x "$LIMN_PROXY" https://example.com/');
    expect(r.out).toMatch(/^[23]\d\d$/);
  }, 60_000);

  it('the injector refuses a credential Limn did not give, and holds none of its own here', async () => {
    const foreign = await sh(`curl -sS -m 10 http://limn-proxy:8081/v1/messages -H 'x-api-key: sk-ant-agent-own' -d '{}'`);
    expect(foreign.out).toContain('did not give the sandbox');
    const missing = await sh(`curl -sS -m 10 http://limn-proxy:8081/v1/messages -H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" -d '{}'`);
    expect(missing.out).toContain('missing on the host');
  }, 30_000);

  it('runs hardened: non-root, no capabilities, no new privileges; files go in as the agent', async () => {
    const who = await sh('id -un; grep CapEff /proc/self/status; grep NoNewPrivs /proc/self/status');
    expect(who.out).toMatch(/^agent\nCapEff:\s+0000000000000000\nNoNewPrivs:\s+1$/);
    await rt.copyIn(sandbox, [{ path: '/Users/limn-test/ws/TICKET.md', content: '# Ticket\n' }, { path: '/home/agent/.claude/CLAUDE.md', content: 'x' }]);
    expect(String(await rt.readFile(sandbox, '/Users/limn-test/ws/TICKET.md'))).toBe('# Ticket\n');
    expect(await rt.readFile(sandbox, '/nope')).toBeNull();
    expect((await sh('stat -c %U /Users/limn-test/ws/TICKET.md /Users/limn-test/ws')).out).toBe('agent\nagent');
    const stats = await rt.stats(owner.sessionId);
    expect(stats.map((s) => s.role).sort()).toEqual(['proxy', 'sandbox']);
  }, 60_000);

  // Last: it removes the containers the cases above use.
  it("counts this install's running sandbox, and the 'exit' fallback force-removes its containers", async () => {
    expect(await rt.listSandboxes()).toEqual([{ name: sandbox, sessionId: owner.sessionId }]);
    rt.destroySync!([owner.sessionId]);
    expect(await rt.listSandboxes()).toEqual([]);
    const ps = spawnSync(docker, ['ps', '--all', '--quiet', '--filter', `label=limn.session=${owner.sessionId}`], { encoding: 'utf8' });
    expect(ps.stdout.trim()).toBe('');
  }, 60_000);
});

