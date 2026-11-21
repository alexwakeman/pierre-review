// THE BROWSER ON A REAL DAEMON (slow project; docs/SANDBOX.md § The browser). A plain Node container stands in
// for the sandbox (its `agent` user, an internal network, the shipped `ensemble-browser` and relay program
// copied in); the Docker runtime starts the PINNED browser with the real argv (shared network namespace,
// non-root, read-only); the agent's verbs run INSIDE the sandbox: `start` over the relay, then `shot` and
// `console` over the DevTools protocol against a page the sandbox serves on its own localhost.
//
// Skipped without a daemon. Pulls `node:22-bookworm-slim` and the pinned browser image if missing.
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDockerRuntime } from '../runtime/docker.js';
import { resourceName } from '../runtime/labels.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { SessionBrowser } from './index.js';

const docker = process.env.SANDBOX_CLI || 'docker';
const probe = spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
const haveDaemon = probe.status === 0 && probe.stdout.trim() !== '';
if (!haveDaemon) console.warn('[browser-real] SKIPPED: no container daemon answers');

const IMAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sandbox-image');
const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
const rt: SandboxRuntime = createDockerRuntime({ instance: 'browser-test', extraLabels: { 'limn.test': '1' } });
const sandbox = resourceName(owner.sessionId, 'sandbox');
const network = `limn-${owner.sessionId}-net`;
const notices: string[] = [];
// The paths `ensemble-browser shot` handed to Ensemble (live screenshots).
const noted: string[] = [];
let browser: SessionBrowser | null = null;

const PAGE = `require('http').createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<html><body style="background:#eef"><h1>Refunds</h1><p>' + q.headers.host + '</p><script>console.error("missing amount")</script></body></html>'); }).listen(5173, '127.0.0.1')`;

describe.skipIf(!haveDaemon)('the browser in a real sandbox', () => {
  beforeAll(async () => {
    execFileSync(docker, ['network', 'create', '--internal', '--label', 'limn.test=1', network], { stdio: 'ignore', timeout: 60_000 });
    execFileSync(docker, ['run', '-d', '--name', sandbox, '--label', 'limn.test=1', '--network', network, 'node:22-bookworm-slim', 'sleep', 'infinity'], { stdio: 'ignore', timeout: 300_000 });
    execFileSync(docker, ['exec', '-u', 'root', sandbox, 'useradd', '-m', '-s', '/bin/sh', 'agent'], { stdio: 'ignore', timeout: 60_000 });
    await rt.copyIn(
      sandbox,
      [
        { path: '/usr/local/bin/ensemble-browser', content: readFileSync(join(IMAGE_DIR, 'ensemble-browser')), mode: 0o755 },
        { path: '/usr/local/lib/limn/limn-svcd.cjs', content: readFileSync(join(IMAGE_DIR, 'limn-svcd.cjs')) },
      ],
      { user: 'root' },
    );
    // The agent's dev server, on the SANDBOX's loopback only.
    spawnSync(docker, ['exec', '-d', '-u', 'agent', sandbox, 'node', '-e', PAGE], { timeout: 30_000 });
    browser = new SessionBrowser({ runtime: rt, owner, sandbox, proxyUrl: null, notice: (t) => void notices.push(t), onShots: async (p) => void noted.push(...p) });
    await browser.startRelay();
  }, 600_000);

  afterAll(async () => {
    browser?.close();
    await rt.destroy(owner.sessionId).catch(() => {});
    spawnSync(docker, ['rm', '-f', sandbox, resourceName(owner.sessionId, 'browser')], { stdio: 'ignore', timeout: 60_000 });
    spawnSync(docker, ['network', 'rm', network], { stdio: 'ignore', timeout: 60_000 });
  });

  const sh = async (cmd: string) => {
    const r = await rt.run(sandbox, ['sh', '-c', cmd], { timeoutMs: 600_000 });
    return { code: r.code, out: `${String(r.stdout)}${r.stderr}` };
  };

  it('start over the relay; the browser is non-root, read-only, in the sandbox’s network', async () => {
    expect((await sh('ensemble-browser status')).out).toContain('No browser is running');
    const started = await sh('ensemble-browser start');
    expect(started.code).toBe(0);
    expect(started.out).toContain('The browser is running.');
    expect(notices).toEqual(['The agent started a browser.']);
    const inspect = JSON.parse(execFileSync(docker, ['inspect', resourceName(owner.sessionId, 'browser')], { encoding: 'utf8' }))[0];
    expect(inspect.Config.User).toBe('65534:65534');
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.NetworkMode).toBe(`container:${inspect.HostConfig.NetworkMode.split(':')[1]}`);
    expect(inspect.HostConfig.CapDrop).toEqual(['ALL']);
    expect(inspect.Config.Labels['limn.role']).toBe('browser');
  }, 600_000);

  it('shot: a PNG per width of the page the sandbox serves on localhost; console: its error', async () => {
    const shot = await sh('ensemble-browser shot http://localhost:5173/refunds --width 1280,375 --height 400');
    expect(shot.code).toBe(0);
    const files = shot.out.trim().split('\n');
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\/home\/agent\/\.limn\/browser\/\d{8}-\d{6}-localhost-5173-refunds-1280\.png$/);
    const png = await rt.readFile(sandbox, files[0]!);
    expect([...png!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The shot told Ensemble its files, over the relay (live screenshots).
    expect(noted).toEqual(files);
    const con = await sh('ensemble-browser console http://localhost:5173/ --wait 300');
    expect(con.out).toContain('console.error: missing amount');
  }, 120_000);

  it('the session’s destroy removes the browser with the rest', async () => {
    await rt.destroy(owner.sessionId);
    const left = spawnSync(docker, ['ps', '-a', '--filter', `label=limn.session=${owner.sessionId}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim();
    expect(left).toBe('');
  }, 120_000);
});
