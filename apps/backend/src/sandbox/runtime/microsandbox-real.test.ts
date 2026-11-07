// THE REAL-MICROSANDBOX TEST (slow project; docs/SANDBOX.md § microsandbox). The same checks as
// docker-real.test.ts on a real microVM: the sandbox reaches an ALLOWED host only through Limn's host
// proxy (over vsock), is REFUSED a denied one (logged), has no network of its own, gets a host after
// "Allow for this session", cannot use a credential Limn did not give it, runs as the non-root agent,
// and its private disk is the agent's.
//
// ⚠ NEVER RUN YET: no machine this was written on can run microsandbox. It SKIPS, saying why, unless
// `msb doctor` passes (an Apple Silicon Mac, or Linux with /dev/kvm). CI runs it on a Linux runner
// only when /dev/kvm exists (.github/workflows/microsandbox.yml). Needs the internet and the sandbox
// image (pulled, or built with Docker and loaded) unless LIMN_SANDBOX_TEST_IMAGE names an msb image.
// Every VM carries `limn.test=1` and its own `limn.managed` value, and is removed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgress, type EgressSession } from '../proxy/egress.js';
import { createMicrosandboxRuntime } from './microsandbox.js';
import type { RuntimeDetection, SandboxRuntime } from './types.js';

const instance = `test-${randomBytes(4).toString('hex')}`;
const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
const socketRoot = mkdtempSync(join('/tmp', 'limn-msb-real-'));
const rt: SandboxRuntime = createMicrosandboxRuntime({ instance, extraLabels: { 'limn.test': '1' }, socketRoot });

let detected: RuntimeDetection | null = null;
try {
  detected = await rt.detect();
} catch (e) {
  detected = null;
  console.warn(`[microsandbox-real] SKIPPED: detection threw (${e instanceof Error ? e.message : String(e)})`);
}
const ready = detected?.available === true;
if (!ready) rmSync(socketRoot, { recursive: true, force: true });
// The KVM CI job sets this: there, a skip would hide a broken setup, so it fails instead.
if (!ready && process.env.LIMN_MSB_REQUIRED === '1') throw new Error(`microsandbox is required here but not ready: ${detected?.problem ?? 'detection failed'}`);
if (detected && !ready) console.warn(`[microsandbox-real] SKIPPED: ${detected.problem ?? 'microsandbox is not available here.'}`);

let sandbox = '';
let egress: EgressSession | null = null;
const WS = '/Users/limn-test/ws';

async function sh(cmd: string): Promise<{ code: number | null; out: string }> {
  const r = await rt.run(sandbox, ['bash', '-c', cmd], { timeoutMs: 60_000 });
  return { code: r.code, out: `${String(r.stdout)}${r.stderr}`.trim() };
}

describe.skipIf(!ready)('sandbox on real microsandbox', () => {
  beforeAll(async () => {
    const image = process.env.LIMN_SANDBOX_TEST_IMAGE ?? (await rt.ensureImage({ onProgress: (p) => console.log(`[image] ${p.line}`) })).ref;
    const net = await rt.createNetwork(owner);
    egress = await startEgress({
      runtime: rt,
      owner,
      workspaceId: 0,
      image,
      network: net.name,
      provider: 'claude',
      store: { list: async () => [], add: async (_a, _w, rule) => ({ ok: true, rule, added: true }) },
      credentialsFor: () => ({ creds: { anthropicOauth: null, anthropicApiKey: null }, problem: null }),
    });
    const volume = await rt.createVolume(owner, 'work');
    sandbox = (
      await rt.startSandbox({
        ...owner,
        image,
        network: net.name,
        env: egress.sandboxEnv,
        mounts: [{ kind: 'volume', name: volume, target: WS }],
        resources: { cpus: 1, memoryBytes: 1024 ** 3, pids: 256, diskBytes: 2 * 1024 ** 3 },
        workdir: WS,
      })
    ).name;
  }, 20 * 60_000);

  afterAll(async () => {
    egress?.close();
    await rt.destroy(owner.sessionId);
    const left = await rt.sweep([], { dryRun: true });
    rmSync(socketRoot, { recursive: true, force: true });
    expect(left.containers).toEqual([]);
  }, 180_000);

  it('reaches an allowed host through the host proxy', async () => {
    const r = await sh('curl -sS -m 30 -o /dev/null -w "%{http_code}" -x "$LIMN_PROXY" https://registry.npmjs.org/');
    expect(r.out).toBe('200');
  }, 60_000);

  it('is refused a denied host, and the refusal is logged', async () => {
    const r = await sh('curl -sS -m 20 -o /dev/null -w "%{http_code}" -x "$LIMN_PROXY" https://example.com/; echo " exit=$?"');
    expect(r.out).not.toMatch(/^200/);
    for (let i = 0; i < 50 && !egress!.log.snapshot().some((e) => e.host === 'example.com'); i++) await new Promise((res) => setTimeout(res, 100));
    expect(egress!.log.snapshot().find((e) => e.host === 'example.com')).toMatchObject({ allowed: false, reason: 'not_listed', port: 443 });
  }, 60_000);

  it('has no network of its own', async () => {
    const r = await sh('curl -sS -m 10 -o /dev/null -w "%{http_code}" --noproxy "*" https://example.com/; echo " exit=$?"');
    expect(r.out).toMatch(/exit=(6|7|28)/);
    const ip = await sh('curl -sS -m 10 -o /dev/null --noproxy "*" http://1.1.1.1/; echo " exit=$?"');
    expect(ip.out).toMatch(/exit=(7|28)/);
  }, 40_000);

  it('gets the host after "Allow for this session"', async () => {
    expect(await egress!.allow('example.com', 'session')).toEqual({ ok: true, rule: 'example.com' });
    const r = await sh('curl -sS -m 30 -o /dev/null -w "%{http_code}" -x "$LIMN_PROXY" https://example.com/');
    expect(r.out).toMatch(/^[23]\d\d$/);
  }, 60_000);

  it('the injector refuses a credential Limn did not give', async () => {
    const foreign = await sh(`curl -sS -m 10 http://limn-proxy:8081/v1/messages -H 'x-api-key: sk-ant-agent-own' -d '{}'`);
    expect(foreign.out).toContain('did not give the sandbox');
  }, 30_000);

  it('runs as the agent; the private disk and copied files are the agent’s', async () => {
    expect((await sh('id -un')).out).toBe('agent');
    await rt.copyIn(sandbox, [{ path: `${WS}/TICKET.md`, content: '# Ticket\n' }]);
    expect(String(await rt.readFile(sandbox, `${WS}/TICKET.md`))).toBe('# Ticket\n');
    expect((await sh(`stat -c %U ${WS}/TICKET.md ${WS}`)).out).toBe('agent\nagent');
    const stats = await rt.stats(owner.sessionId);
    expect(stats.map((s) => s.role)).toContain('sandbox');
  }, 60_000);
});
