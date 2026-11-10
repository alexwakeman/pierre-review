// Settings → Workspace → Sandbox routes (api/routes/sandbox-settings.ts) on a THROWAWAY sqlite DB.
// Pinned: no row = every default; PUT REPLACES (a field left out goes back to its default); the 400
// carries `validateSandboxSettings`'s sentence; another account's workspace is a 404 on every route;
// the check FINDS the reader's clones through their Claude projects (no folder setting), matches by
// remote and names a clone outside the workspace; the removed `local_folder` / `start_dir` stay dormant;
// the compose files come from Limn's clone cache; the "Always allow" hosts go through the proxy's own
// parser; erasure and export reach the table.
//
// DATABASE_URL is set BEFORE the client is imported, and every value import is dynamic.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/limn-sandbox-settings-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void>) | undefined;
let client: any;
let own = 0;
let foreign = 0;
let scratch = '';
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;

const call = async (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as any } : {}) });
  return { status: res.statusCode, body: res.json() as any };
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  // ⚠ Not `limn-…`: a Claude project under `<tmp>/limn-*` is Limn's own (ai/session-litter.ts) and never looked at.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-settings-')));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude');
  const { runMigrations } = await import('../../db/run-migrations.js');
  client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await client.db.insert(client.schema.accounts).values({ id: 2, githubUserId: 'U_sb_b', githubLogin: 'sb-b', isLocal: false }).execute();
  own = await q.ensureDefaultWorkspace(1);
  foreign = await q.ensureDefaultWorkspace(2);
  const [r1] = await client.db.insert(client.schema.repos).values({ accountId: 1, owner: 'DEFRA', name: 'bng-metric-backend', githubNodeId: 'R_sb1' }).returning().execute();
  const [r2] = await client.db.insert(client.schema.repos).values({ accountId: 1, owner: 'DEFRA', name: 'bng-metric-frontend', githubNodeId: 'R_sb2' }).returning().execute();
  await q.assignReposToWorkspace(own, 1, [r1.id, r2.id]);

  const folder = join(scratch, 'Projects', 'bng');
  for (const [dir, url] of [
    ['bng-metric-backend', 'git@github.com:DEFRA/bng-metric-backend.git'],
    ['cdp-app-config', 'https://github.com/DEFRA/cdp-app-config.git'],
  ] as const) {
    mkdirSync(join(folder, dir, '.git'), { recursive: true });
    writeFileSync(join(folder, dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  }
  // Claude Code ran in the backend clone: that is how Limn finds the reader's clones.
  const key = join(folder, 'bng-metric-backend').replace(/[^a-zA-Z0-9]/g, '-');
  mkdirSync(join(scratch, 'claude', 'projects', key), { recursive: true });
  writeFileSync(join(scratch, 'claude', 'projects', key, 'session.jsonl'), '{}');

  const { sandboxSettingsRoutes } = await import('./sandbox-settings.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(sandboxSettingsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  rmSync(scratch, { recursive: true, force: true });
  if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
});

describe('sandbox settings', () => {
  it('no row is every default', async () => {
    const r = await call('GET', `/api/workspaces/${own}/sandbox`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      workspaceId: own,
      memoryProjects: null,
      userClaudeMd: true,
      userSkills: false,
      globalProxyEnv: false,
      resources: { cpus: null, memoryGb: null, diskGb: null },
      services: [],
      alwaysAllowedHosts: [],
    });
  });

  it('PUT replaces the whole setting', async () => {
    const a = await call('PUT', `/api/workspaces/${own}/sandbox`, { userSkills: true, globalProxyEnv: true, resources: { cpus: 2 } });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ userSkills: true, globalProxyEnv: true, resources: { cpus: 2, memoryGb: null, diskGb: null } });
    const b = await call('PUT', `/api/workspaces/${own}/sandbox`, {});
    expect(b.body).toMatchObject({ userSkills: false, globalProxyEnv: false, resources: { cpus: null } });
  });

  it('keeps a stored local folder and starting folder DORMANT: never on the wire, never written, never cleared', async () => {
    const t = client.schema.sandboxWorkspaceSettings;
    const { eq } = await import('drizzle-orm');
    await client.db.update(t).set({ localFolder: '/Users/old/folder', startDir: '/Users/old/folder/x' }).where(eq(t.workspaceId, own)).execute();
    const r = await call('GET', `/api/workspaces/${own}/sandbox`);
    expect(r.body).not.toHaveProperty('localFolder');
    expect(r.body).not.toHaveProperty('startDir');
    // The schema drops the old fields (Fastify's removeAdditional): a stale client cannot write them.
    const stale = await call('PUT', `/api/workspaces/${own}/sandbox`, { localFolder: '/Users/x', startDir: '/Users/x/y' });
    expect(stale.body).not.toHaveProperty('localFolder');
    expect((await call('PUT', `/api/workspaces/${own}/sandbox`, { userSkills: true })).status).toBe(200);
    const [row] = await client.db.select().from(t).where(eq(t.workspaceId, own)).execute();
    expect([row.localFolder, row.startDir]).toEqual(['/Users/old/folder', '/Users/old/folder/x']);
  });

  it('stores the picked compose files, normalised; PUT without them clears them', async () => {
    const services = [
      { repo: 'DEFRA/bng-metric-backend', file: './compose.yml', egress: ['redis', 'localstack', 'redis'] },
      { repo: 'DEFRA/bng-metric-journey-tests', file: 'compose.yml', egress: [] },
    ];
    const a = await call('PUT', `/api/workspaces/${own}/sandbox`, { services });
    expect(a.status).toBe(200);
    expect((a.body as { services: unknown }).services).toEqual([
      { repo: 'DEFRA/bng-metric-backend', file: 'compose.yml', egress: ['localstack', 'redis'] },
      { repo: 'DEFRA/bng-metric-journey-tests', file: 'compose.yml', egress: [] },
    ]);
    expect(((await call('GET', `/api/workspaces/${own}/sandbox`)).body as { services: unknown[] }).services).toHaveLength(2);
    expect(((await call('PUT', `/api/workspaces/${own}/sandbox`, {})).body as { services: unknown[] }).services).toEqual([]);
    for (const [bad, why] of [
      [{ repo: 'DEFRA/x', file: '../other/compose.yml', egress: [] }, /not a compose file path/],
      [{ repo: 'DEFRA/x', file: '/etc/compose.yml', egress: [] }, /not a compose file path/],
      [{ repo: 'no-owner', file: 'compose.yml', egress: [] }, /owner\/name/],
    ] as const) {
      const r = await call('PUT', `/api/workspaces/${own}/sandbox`, { services: [bad] });
      expect(r.status).toBe(400);
      expect((r.body as { message: string }).message).toMatch(why);
    }
    expect((await call('PUT', `/api/workspaces/${own}/sandbox`, { services: [services[1], services[1]] })).status).toBe(400);
    expect((await call('PUT', `/api/workspaces/${own}/sandbox`, { services: [services[1]] })).status).toBe(200);
  });

  it('refuses a bad value with one sentence, and the shape by schema', async () => {
    const r = await call('PUT', `/api/workspaces/${own}/sandbox`, { memoryProjects: ['relative/path'] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'InvalidSandboxSettings', message: 'Each memory project must be an absolute path.' });
    expect((await call('PUT', `/api/workspaces/${own}/sandbox`, { resources: { cpus: 0 } })).status).toBe(400);
  });

  it("is a 404 for another account's workspace on every route", async () => {
    expect((await call('GET', `/api/workspaces/${foreign}/sandbox`)).status).toBe(404);
    expect((await call('PUT', `/api/workspaces/${foreign}/sandbox`, {})).status).toBe(404);
    expect((await call('POST', `/api/workspaces/${foreign}/sandbox/check`, {})).status).toBe(404);
    expect((await call('GET', `/api/workspaces/${foreign}/sandbox/compose-files`)).status).toBe(404);
    expect((await call('POST', `/api/workspaces/${foreign}/sandbox/allowed-hosts`, { rule: 'example.org' })).status).toBe(404);
    expect((await call('DELETE', `/api/workspaces/${foreign}/sandbox/allowed-hosts`, { rule: 'example.org' })).status).toBe(404);
  });

  it('finds the clones through Claude projects: matched by remote, the rest placed beside, the other workspace named', async () => {
    const folder = join(scratch, 'Projects', 'bng');
    const r = await call('POST', `/api/workspaces/${own}/sandbox/check`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      folder,
      matched: [{ fullName: 'DEFRA/bng-metric-backend', localPath: join(folder, 'bng-metric-backend'), alsoAt: [] }],
      notCloned: [{ fullName: 'DEFRA/bng-metric-frontend', sandboxPath: join(folder, 'bng-metric-frontend') }],
      outside: [{ fullName: 'DEFRA/cdp-app-config', localPath: join(folder, 'cdp-app-config') }],
      memories: [],
      startDir: folder,
    });
    // A stored (dormant) local folder changes nothing.
    expect(r.body).not.toHaveProperty('problem');
  });

  it('lists the compose files of each repository from Limn’s clone cache, and says when there is no copy', async () => {
    const { execFileSync } = await import('node:child_process');
    const { listComposeFiles, isComposeCandidate } = await import('../../sandbox/services/compose-files.js');
    const cache = join(scratch, 'cache');
    const repo = join(cache, 'DEFRA__bng-metric-backend');
    for (const f of ['compose.yml', 'docker-compose.override.yaml', 'docker/compose.dev.yml', '.devcontainer/docker-compose.yml', 'node_modules/x/compose.yml', 'vendor/y/docker-compose.yml', 'src/composer.yml', 'README.md']) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), 'x');
    }
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('add', '-A', '-f');
    g('commit', '-q', '-m', 'c');
    const got = await listComposeFiles(
      [
        { owner: 'DEFRA', name: 'bng-metric-backend' },
        { owner: 'DEFRA', name: 'bng-metric-frontend' },
      ],
      (o, n) => join(cache, `${o}__${n}`),
    );
    expect(got).toEqual([
      { repo: 'DEFRA/bng-metric-backend', copied: true, files: ['compose.yml', 'docker-compose.override.yaml', '.devcontainer/docker-compose.yml', 'docker/compose.dev.yml'] },
      { repo: 'DEFRA/bng-metric-frontend', copied: false, files: [] },
    ]);
    expect(isComposeCandidate('a/b/docker-compose-test.yml')).toBe(true);
    expect(isComposeCandidate('compose.json')).toBe(false);
    const r = await call('GET', `/api/workspaces/${own}/sandbox/compose-files`);
    expect(r.status).toBe(200);
    expect(r.body.repos.map((x: { repo: string }) => x.repo)).toEqual(['DEFRA/bng-metric-backend', 'DEFRA/bng-metric-frontend']);
  });

  it('adds and removes "Always allow" hosts through the proxy parser', async () => {
    const add = await call('POST', `/api/workspaces/${own}/sandbox/allowed-hosts`, { rule: 'Registry.Example.COM' });
    expect(add.body.alwaysAllowedHosts).toEqual(['registry.example.com']);
    const bad = await call('POST', `/api/workspaces/${own}/sandbox/allowed-hosts`, { rule: 'localhost' });
    expect(bad.status).toBe(400);
    const del = await call('DELETE', `/api/workspaces/${own}/sandbox/allowed-hosts`, { rule: 'registry.example.com' });
    expect(del.body.alwaysAllowedHosts).toEqual([]);
  });

  it('reports the runtime in plain words, cached between reads', async () => {
    const { createFakeRuntime } = await import('../../sandbox/runtime/fake.js');
    const { setSandboxRuntimeForTests } = await import('../../sandbox/runtime/index.js');
    const { resetRuntimeStatusCacheForTests } = await import('./sandbox-settings.js');
    const rt = createFakeRuntime();
    rt.setDetection({ kind: 'docker', flavour: 'docker-desktop', serverVersion: '29.0.1', licenceNote: 'Docker Desktop is free only…' });
    setSandboxRuntimeForTests(rt);
    resetRuntimeStatusCacheForTests();
    try {
      const r = await call('GET', '/api/sandbox/runtime');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ available: true, kind: 'docker', label: 'Docker Desktop 29.0.1', licenceNote: 'Docker Desktop is free only…', problem: null, cpus: 8, memoryGb: 16 });
      await call('GET', '/api/sandbox/runtime');
      expect(rt.calls.filter((c) => c.method === 'detect')).toHaveLength(1);

      rt.setDetection({ available: false, daemonReachable: false, flavour: 'unknown', serverVersion: null, cliVersion: '29.0.1', problem: 'Docker is installed but not running. Start it.' });
      resetRuntimeStatusCacheForTests();
      const off = await call('GET', '/api/sandbox/runtime');
      expect(off.body).toMatchObject({ available: false, kind: 'docker', label: 'Docker 29.0.1', problem: 'Docker is installed but not running. Start it.' });

      rt.setDetection({ cli: null });
      resetRuntimeStatusCacheForTests();
      const none = await call('GET', '/api/sandbox/runtime');
      expect(none.body).toMatchObject({ available: false, kind: null, label: null });
    } finally {
      setSandboxRuntimeForTests(null);
      resetRuntimeStatusCacheForTests();
    }
  });

  it('is on the erasure checklist and in the export', async () => {
    const { accountScopedTables } = await import('../../db/erase-account.js');
    expect(accountScopedTables().map((t) => t.name)).toContain('sandboxWorkspaceSettings');
    const { exportAccountData } = await import('../../db/export-account.js');
    const out: any = await exportAccountData(1);
    expect(out.sandboxWorkspaceSettings).toEqual([expect.objectContaining({ workspaceId: own, localFolder: '/Users/old/folder', servicesJson: expect.stringContaining('bng-metric-journey-tests') })]);
  });
});
