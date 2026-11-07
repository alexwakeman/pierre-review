// THE SERVICES CONTROLLER over the FAKE runtime: what `limn-svc` words turn into (normalise in the
// sandbox, police, build, compose on the host, forwards), and what is refused.
import { describe, expect, it } from 'vitest';
import { createFakeRuntime } from '../runtime/fake.js';
import type { ComposeCall } from '../runtime/types.js';
import { parsePs, ServicesController, stackKeyFor, supportsSubpath, type ServiceStackConfig } from './controller.js';
import { serviceStacksFor, validComposePath } from './index.js';
import type { Forward } from './policy.js';

const ROOT = '/Users/limn-test/ws';
const owner = { sessionId: 's1', accountId: 1 };

const backend = {
  services: {
    postgres: { image: 'postgis/postgis:16-3.5', ports: [{ target: 5432, published: '5432', protocol: 'tcp' }] },
    redis: { image: 'redis:7' },
    api: { image: 'acme/api:latest', depends_on: { postgres: { condition: 'service_healthy' } }, ports: [{ target: 3001, published: '3001', protocol: 'tcp' }] },
  },
};
const journey = { services: { postgres: { image: 'postgis/postgis:16-3.4' }, web: { build: { context: `${ROOT}/acme-web`, dockerfile: 'Dockerfile' } } } };

function setup(models: Record<string, unknown> = { 'acme-backend': backend }) {
  const fake = createFakeRuntime();
  for (const [repo, model] of Object.entries(models)) {
    fake.onExec((argv) => argv[0] === '/usr/local/bin/docker-compose' && argv.includes(`${ROOT}/${repo}/compose.yml`), { stdout: JSON.stringify(model) });
  }
  fake.onExec((argv) => argv[0] === 'sh', {});
  const composeCalls: ComposeCall[] = [];
  fake.onCompose((c) => {
    composeCalls.push(c);
    if (c.call.verb === 'ps') return { stdout: Buffer.from('{"Service":"postgres","State":"running","Health":"healthy"}\n{"Service":"api","State":"running","Health":""}\n') };
    if (c.call.verb === 'logs') return { stdout: Buffer.from('api-1 | listening\n') };
    return {};
  });
  const stacks: ServiceStackConfig[] = Object.keys(models).map((repo) => ({ key: repo, repoPath: `${ROOT}/${repo}`, file: 'compose.yml', from: `${repo}/compose.yml`, egress: [] }));
  const forwarded: Forward[][] = [];
  const statuses: string[] = [];
  const c = new ServicesController({
    runtime: fake,
    owner,
    sandbox: 'limn-s1-sandbox',
    network: 'limn-s1-net',
    workspaceRoot: ROOT,
    workspaceVolume: 'limn-s1-vol-work',
    stacks,
    instance: 'test',
    serverVersion: '29.6.2',
    onStatus: (s) => statuses.push(s.stacks.map((x) => `${x.key}:${x.state}`).join(',')),
  });
  c.setForwarder(async (f) => {
    forwarded.push(f);
    return { listening: f.map((x) => x.port), failed: [] };
  });
  return { fake, c, composeCalls, forwarded, statuses };
}

async function call(c: ServicesController, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await c.handle(argv, `${ROOT}/acme-backend`, (s, t) => (s === 'o' ? (out += t) : (err += t)));
  return { code, out, err };
}

describe('limn-svc up / ps / logs / down', () => {
  it('normalises in the sandbox, polices, starts on the host, then forwards localhost', async () => {
    const { fake, c, composeCalls, forwarded, statuses } = setup();
    const r = await call(c, 'up');
    expect(r.code).toBe(0);
    const normalise = fake.calls.find((x) => x.method === 'exec' && (x.args[1] as string[])[0] === '/usr/local/bin/docker-compose');
    expect(normalise?.args[0]).toBe('limn-s1-sandbox');
    const up = composeCalls.find((x) => x.call.verb === 'up')!;
    expect(up.project).toBe('limn-s1-acme-backend');
    expect((up.compose as { networks: unknown }).networks).toEqual({ limn: { external: true, name: 'limn-s1-net' } });
    expect(forwarded.at(-1)).toEqual([{ port: 5432, host: 'postgres', target: 5432 }, { port: 3001, host: 'api', target: 3001 }]);
    expect(r.out).toMatch(/acme-backend is running/);
    expect(r.out).toMatch(/On localhost here: 5432 → postgres:5432, 3001 → api:3001/);
    expect(statuses).toContain('acme-backend:starting');
    expect(c.status().stacks[0]).toMatchObject({ state: 'running', services: ['postgres', 'redis', 'api'] });

    const ps = await call(c, 'ps');
    expect(ps.out).toMatch(/postgres\s+running \(healthy\)/);
    const logs = await call(c, 'logs', 'api', '--tail', '50');
    expect(logs.out).toBe('api-1 | listening\n');
    expect(composeCalls.at(-1)!.call).toEqual({ verb: 'logs', service: 'api', tail: 50 });

    const down = await call(c, 'down');
    expect(down.code).toBe(0);
    expect(composeCalls.at(-1)!.call).toEqual({ verb: 'down' });
    expect(forwarded.at(-1)).toEqual([]);
    expect(c.status().stacks[0]!.state).toBe('stopped');
  });

  it('a named service starts with what it depends on', async () => {
    const { c, composeCalls } = setup();
    expect((await call(c, 'up', 'api')).code).toBe(0);
    expect(composeCalls.find((x) => x.call.verb === 'up')!.call).toEqual({ verb: 'up', services: ['api', 'postgres'] });
  });

  it('a refused file is refused whole, with its reasons, and never reaches compose', async () => {
    const { c, composeCalls } = setup({ 'acme-backend': { services: { db: { image: 'postgres', privileged: true, volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }] } } } });
    const r = await call(c, 'up');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/was refused:\n {2}- `db` asks for privileged mode\.\n {2}- `db` mounts `\/var\/run\/docker\.sock`/);
    expect(composeCalls).toEqual([]);
    expect(c.status().stacks[0]).toMatchObject({ state: 'refused' });
    expect((await call(c, 'check')).out).toMatch(/refused/);
  });

  it('two files with the same service name cannot run together; a bare name must be unique', async () => {
    const { c } = setup({ 'acme-backend': backend, 'acme-journey': journey });
    expect((await call(c, 'up')).err).toMatch(/Name a file: acme-backend, acme-journey/);
    expect((await call(c, 'up', 'postgres')).err).toMatch(/`postgres` is in acme-backend and acme-journey\. Say which: `acme-backend\/postgres`/);
    expect((await call(c, 'up', 'acme-backend')).code).toBe(0);
    expect((await call(c, 'up', 'acme-journey/postgres')).err).toMatch(/Stop acme-backend first .*both have postgres/);
  });

  it('a service with a build section is built from the sandbox first, then started from that image', async () => {
    const { fake, c, composeCalls } = setup({ 'acme-journey': journey });
    const r = await call(c, 'up', 'web');
    expect(r.code).toBe(0);
    const build = fake.calls.find((x) => x.method === 'buildImage')!.args[0] as Record<string, unknown>;
    expect(build).toMatchObject({ tag: 'limn-s1-svc-acme-journey-web:1', from: { container: 'limn-s1-sandbox', dir: `${ROOT}/acme-web` }, dockerfile: 'Dockerfile', network: 'limn-s1-net', proxyUrl: 'http://limn-proxy:3128' });
    const up = composeCalls.find((x) => x.call.verb === 'up')!;
    expect((up.compose as { services: Record<string, { image: string; pull_policy: string }> }).services.web).toMatchObject({ image: 'limn-s1-svc-acme-journey-web:1', pull_policy: 'never' });
    expect(fake.resources().some((x) => x.kind === 'image' && x.name === 'limn-s1-svc-acme-journey-web:1')).toBe(true);
  });

  it('`build <service> <folder>` swaps an image-only service for the agent\'s code; the folder must be inside the workspace', async () => {
    const { fake, c, composeCalls } = setup();
    const b = await call(c, 'build', 'api', '../acme-api', '--target', 'production');
    expect(b.code).toBe(0);
    expect(fake.calls.find((x) => x.method === 'buildImage')!.args[0]).toMatchObject({ from: { dir: `${ROOT}/acme-api` }, dockerfile: 'Dockerfile', target: 'production' });
    expect((await call(c, 'up')).code).toBe(0);
    expect((composeCalls.find((x) => x.call.verb === 'up')!.compose as { services: Record<string, { image: string }> }).services.api!.image).toBe('limn-s1-svc-acme-backend-api:1');
    expect((await call(c, 'build', 'api', '/etc')).err).toMatch(/outside the session's workspace/);
    expect((await call(c, 'build', 'redis')).err).toMatch(/has no build section/);
  });

  it('a failed build is reported with its last lines and nothing starts', async () => {
    const { fake, c, composeCalls } = setup({ 'acme-journey': journey });
    fake.onBuild(() => ({ code: 1, stderr: 'npm ERR! network\nThe command returned a non-zero code: 1', lines: ['Step 1/4 : FROM node:24', 'Step 3/4 : RUN npm ci'] }));
    const r = await call(c, 'up', 'web');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Building web failed at "Step 3\/4 : RUN npm ci"/);
    expect(composeCalls.filter((x) => x.call.verb === 'up')).toEqual([]);
  });

  it('`run` starts a one-off container of a service', async () => {
    const { c, composeCalls } = setup();
    expect((await call(c, 'run', 'api', 'npm', 'run', 'migrate')).code).toBe(0);
    expect(composeCalls.at(-1)!.call).toEqual({ verb: 'run', service: 'api', command: ['npm', 'run', 'migrate'] });
  });

  it('unknown words get the usage; an old Docker is refused in one line', async () => {
    const { c } = setup();
    expect((await call(c, 'frobnicate')).err).toMatch(/unknown command `frobnicate`[\s\S]*limn-svc up/);
    expect((await call(c)).out).toMatch(/limn-svc build <service>/);
    expect(supportsSubpath('25.0.3')).toBe(false);
    expect(supportsSubpath('29.6.2')).toBe(true);
  });

  it('inventory names every service per file (for the seed)', async () => {
    const { c } = setup({ 'acme-backend': backend, 'acme-journey': journey });
    expect(await c.inventory()).toEqual([
      { name: 'postgres', from: 'acme-backend/compose.yml', stack: 'acme-backend' },
      { name: 'redis', from: 'acme-backend/compose.yml', stack: 'acme-backend' },
      { name: 'api', from: 'acme-backend/compose.yml', stack: 'acme-backend' },
      { name: 'postgres', from: 'acme-journey/compose.yml', stack: 'acme-journey' },
      { name: 'web', from: 'acme-journey/compose.yml', stack: 'acme-journey' },
    ]);
  });

  it('stopAll takes every running file down (discard)', async () => {
    const { c, composeCalls } = setup();
    await call(c, 'up');
    await c.stopAll();
    expect(composeCalls.at(-1)!.call).toEqual({ verb: 'down' });
    expect(c.status().stacks[0]!.state).toBe('stopped');
  });
});

describe('picking files', () => {
  it('places each picked file at its repository; a repository not in the session is named and left out', () => {
    const r = serviceStacksFor(
      [
        { repo: 'DEFRA/bng-metric-backend', file: 'compose.yml', egress: [] },
        { repo: 'DEFRA/bng-metric-journey-tests', file: './compose.yml', egress: ['bng-metric-frontend'] },
        { repo: 'DEFRA/elsewhere', file: 'compose.yml', egress: [] },
        { repo: 'DEFRA/bng-metric-backend', file: '../x/compose.yml', egress: [] },
      ],
      [
        { fullName: 'DEFRA/bng-metric-backend', path: '/Users/a/bng/bng-metric-backend' },
        { fullName: 'DEFRA/bng-metric-journey-tests', path: '/Users/a/bng/bng-metric-journey-tests' },
      ],
    );
    expect(r.stacks.map((s) => [s.key, s.repoPath, s.file, s.from])).toEqual([
      ['bng-metric-backend', '/Users/a/bng/bng-metric-backend', 'compose.yml', 'bng-metric-backend/compose.yml'],
      ['bng-metric-journey-tests', '/Users/a/bng/bng-metric-journey-tests', 'compose.yml', 'bng-metric-journey-tests/compose.yml'],
    ]);
    expect(r.notes).toEqual(['DEFRA/elsewhere/compose.yml is not used: the repository is not in this session.', 'DEFRA/bng-metric-backend/../x/compose.yml is not used: not a compose file path.']);
  });

  it('validates paths and keys', () => {
    expect(validComposePath('docker/compose.test.yaml')).toBe(true);
    expect(validComposePath('/etc/compose.yml')).toBe(false);
    expect(validComposePath('compose.json')).toBe(false);
    expect(stackKeyFor('o/My_Repo', new Set())).toBe('my-repo');
    expect(stackKeyFor('o/x', new Set(['x']))).toBe('x-2');
  });

  it('reads both ps shapes', () => {
    expect(parsePs('[{"Service":"b","State":"exited","ExitCode":1},{"Service":"a","State":"running"}]')).toEqual([
      { service: 'a', state: 'running', health: null, exitCode: null },
      { service: 'b', state: 'exited', health: null, exitCode: 1 },
    ]);
  });
});

