// SERVICES ON A REAL DAEMON (slow project; docs/SANDBOX.md § Services). A real sandbox, the real proxy,
// the real relay and `limn-svc` in the image, `docker compose` on the host:
//
//   • a file that breaks the rules (privileged, the Docker socket) is REFUSED with its reasons;
//   • a tiny file with a `build:` section: `limn-svc build` builds from the agent's folder IN the
//     sandbox, its steps run on the session network (no direct route out; the proxy logs them), and a
//     rebuilt image carries the agent's edit; `up` / `ps` / `logs` / `down` work from inside;
//   • the REAL BNG backend file (owner decision D5; spike 4), copied from the local clone with `git
//     archive` (never edited): ALLOWED, started, postgres reached on localhost:5432 from the sandbox,
//     stopped. Skipped when the clone is not there (`LIMN_SANDBOX_BNG_BACKEND` names another).
//
// Skipped without a daemon. Pulls redis/alpine (and, for BNG, its six images unless cached). Every
// resource carries `limn.test=1` and its own `limn.managed` value, and is removed (images included).
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgress, type EgressSession } from '../proxy/egress.js';
import { createDockerRuntime } from '../runtime/docker.js';
import type { FileToCopy, SandboxRuntime } from '../runtime/types.js';
import { startSessionServices, type SessionServices } from './index.js';

const instance = `test-${randomBytes(4).toString('hex')}`;
const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
const rt: SandboxRuntime = createDockerRuntime({ instance, extraLabels: { 'limn.test': '1' } });
const docker = process.env.SANDBOX_CLI || 'docker';
const ROOT = '/Users/limn-test/ws';

const probe = spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
const serverVersion = probe.status === 0 ? probe.stdout.trim() : null;
if (!serverVersion) console.warn(`[services-real] SKIPPED: no container daemon answers (${(probe.stderr || 'no answer').trim().split('\n')[0]})`);
const BNG = process.env.LIMN_SANDBOX_BNG_BACKEND ?? join(homedir(), 'Projects', 'DEFRA', 'bng-fe-be', 'bng-metric-backend');
const haveBng = existsSync(join(BNG, '.git')) || existsSync(join(BNG, 'compose.yml'));
if (serverVersion && !haveBng) console.warn(`[services-real] BNG case SKIPPED: no clone at ${BNG}`);

let sandbox = '';
let egress: EgressSession | null = null;
let services: SessionServices | null = null;
const output: string[] = [];

async function svc(...args: string[]): Promise<{ code: number | null; out: string }> {
  const r = await rt.run(sandbox, ['limn-svc', ...args], { cwd: `${ROOT}/tiny`, timeoutMs: 900_000 });
  return { code: r.code, out: `${String(r.stdout)}${r.stderr}` };
}
async function sh(cmd: string): Promise<{ code: number | null; out: string }> {
  const r = await rt.run(sandbox, ['bash', '-c', cmd], { timeoutMs: 120_000 });
  return { code: r.code, out: `${String(r.stdout)}${r.stderr}`.trim() };
}

/** The BNG backend's compose file and the folder it reads, at its committed HEAD (no edits, no `.env`). */
function bngFiles(): FileToCopy[] {
  const names = execFileSync('git', ['-C', BNG, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'compose.yml', 'compose'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return names.map((n) => ({
    path: `${ROOT}/bng-metric-backend/${n}`,
    content: execFileSync('git', ['-C', BNG, 'show', `HEAD:${n}`]),
    mode: n.endsWith('.sh') ? 0o755 : 0o644,
  }));
}

describe.skipIf(!serverVersion)('services on a real daemon', () => {
  beforeAll(async () => {
    const image = process.env.LIMN_SANDBOX_TEST_IMAGE ?? (await rt.ensureImage()).ref;
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
        mounts: [{ kind: 'volume', name: volume, target: ROOT }],
        resources: { cpus: 2, memoryBytes: 2 * 1024 ** 3, pids: 512, diskBytes: 1024 ** 3 },
        workdir: ROOT,
      })
    ).name;
    const files: FileToCopy[] = [
      { path: `${ROOT}/bad/compose.yml`, content: 'services:\n  db:\n    image: postgres:16\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n' },
      {
        path: `${ROOT}/tiny/compose.yml`,
        content: 'services:\n  cache:\n    image: redis:7-alpine\n    ports: ["6379:6379"]\n  web:\n    build: { context: ./app }\n    depends_on: [cache]\n    ports: ["8080:8080"]\n',
      },
      {
        path: `${ROOT}/tiny/app/Dockerfile`,
        content: [
          'FROM alpine:3.20',
          'COPY message.txt /www/index.html',
          // Steps run on the session network: no direct route out, the proxy answers by name.
          // `getent` asks the libc resolver (what wget/npm use); busybox `nslookup` fails against
          // Docker's embedded DNS in a classic-builder step even when the name resolves.
          // The run's own id in the step makes it uncacheable: a layer left by an earlier run (one
          // killed before its sweep) would otherwise be reused and print nothing.
          `RUN echo probe ${owner.sessionId} >/dev/null; (wget -Y off -q -T 5 -O /dev/null http://registry.npmjs.org/ && echo DIRECT-OK) || echo NO-DIRECT; ((getent hosts limn-proxy || nslookup limn-proxy) >/dev/null 2>&1 && echo PROXY-RESOLVES) || true`,
          'RUN wget -q -T 20 -O /dev/null "http://registry.npmjs.org/" || true',
          // One answer per connection (busybox `nc -l` serves one, then the loop listens again).
          'CMD ["sh", "-c", "cat /www/index.html; while true; do { printf \'HTTP/1.0 200 OK\\\\r\\\\n\\\\r\\\\n\'; cat /www/index.html; } | nc -l -p 8080 >/dev/null; done"]',
        ].join('\n'),
      },
      { path: `${ROOT}/tiny/app/message.txt`, content: 'first build\n' },
      ...(haveBng ? bngFiles() : []),
    ];
    await rt.copyIn(sandbox, files);
    services = await startSessionServices({
      runtime: rt,
      owner,
      sandbox,
      network: net.name,
      workspaceRoot: ROOT,
      workspaceVolume: volume,
      serverVersion,
      instance,
      extraLabels: { 'limn.test': '1' },
      stacks: [
        { key: 'bad', repoPath: `${ROOT}/bad`, file: 'compose.yml', from: 'bad/compose.yml', egress: [] },
        { key: 'tiny', repoPath: `${ROOT}/tiny`, file: 'compose.yml', from: 'tiny/compose.yml', egress: [] },
        ...(haveBng ? [{ key: 'bng-metric-backend', repoPath: `${ROOT}/bng-metric-backend`, file: 'compose.yml', from: 'bng-metric-backend/compose.yml', egress: [] }] : []),
      ],
      onOutput: (l) => output.push(l),
    });
  }, 30 * 60_000);

  afterAll(async () => {
    await services?.close();
    egress?.close();
    await rt.destroy(owner.sessionId);
    const left = await rt.sweep([], { dryRun: true });
    expect(left).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 300_000);

  it('refuses a file that breaks the rules, with its reasons', async () => {
    const r = await svc('check', 'bad');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bad\/compose\.yml: refused\./);
    expect(r.out).toMatch(/`db` asks for privileged mode\./);
    expect(r.out).toMatch(/`db` mounts `\/var\/run\/docker\.sock`, which is outside the session's workspace\./);
    const up = await svc('up', 'bad');
    expect(up.code).toBe(1);
    expect(up.out).toMatch(/was refused/);
    expect(services!.status().stacks.find((s) => s.key === 'bad')!.state).toBe('refused');
  }, 120_000);

  it('builds from the agent\'s folder on the session network, starts, logs, rebuilds with an edit, stops', async () => {
    const up = await svc('up', 'tiny');
    expect(up.out).toMatch(/tiny is running/);
    expect(up.code).toBe(0);
    expect(output.join('\n')).toMatch(/^NO-DIRECT$/m);
    expect(output.join('\n')).toMatch(/^PROXY-RESOLVES$/m);
    expect(output.join('\n')).not.toMatch(/^DIRECT-OK$/m);
    expect(egress!.log.snapshot().some((e) => e.host === 'registry.npmjs.org')).toBe(true);

    const ps = await svc('ps');
    expect(ps.out).toMatch(/web\s+running/);
    expect(ps.out).toMatch(/cache\s+running/);
    expect((await svc('logs', 'web')).out).toMatch(/first build/);
    // Published ports answer on localhost in the sandbox.
    expect((await sh('curl -s -m 5 http://localhost:8080/')).out).toMatch(/first build/);
    expect((await sh('curl -s -m 5 http://web:8080/')).out).toMatch(/first build/);

    // The agent edits its code; the rebuilt image carries the edit.
    await sh(`echo "second build" > ${ROOT}/tiny/app/message.txt`);
    const b = await svc('build', 'web');
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/Built limn-.*-svc-tiny-web:2/);
    expect((await svc('up', 'tiny/web')).code).toBe(0);
    expect((await sh('sleep 1; curl -s -m 5 http://localhost:8080/')).out).toMatch(/second build/);

    const down = await svc('down', 'tiny');
    expect(down.code).toBe(0);
    expect((await sh('curl -s -m 3 http://localhost:8080/ || echo GONE')).out).toMatch(/GONE/);
  }, 900_000);

  it.skipIf(!haveBng)('the real BNG backend file is allowed, comes up, and postgres answers on localhost:5432', async () => {
    const check = await svc('check', 'bng-metric-backend');
    expect(check.out).toMatch(/bng-metric-backend\/compose\.yml: allowed\./);
    expect(check.code).toBe(0);
    const up = await svc('up', 'bng-metric-backend');
    expect(up.out).toMatch(/bng-metric-backend is running/);
    expect(up.code).toBe(0);
    const ps = await svc('ps');
    expect(ps.out).toMatch(/postgres\s+running \(healthy\)/);
    expect(ps.out).toMatch(/localstack\s+running/);
    expect((await sh('pg_isready -h localhost -p 5432 -U dev -d bng_metric_backend')).out).toMatch(/accepting connections/);
    expect((await sh('curl -s -o /dev/null -w "%{http_code}" -m 10 http://localhost:4566/_localstack/health')).out).toBe('200');
    const logs = await svc('logs', 'postgres', '--tail', '20');
    expect(logs.code).toBe(0);
    expect(logs.out).toMatch(/database system is ready to accept connections/);
    const down = await svc('down', 'bng-metric-backend');
    expect(down.code).toBe(0);
  }, 900_000);
});
