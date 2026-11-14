// Settings → Releases (docs/RELEASES.md § Terms and settings; § Acceptance checks 1–3): the shared
// validator, the classifier, and GET / PUT /api/workspaces/:id/release-settings on a THROWAWAY sqlite
// DB (the workspace-flow-settings.test.ts pattern).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load), and
// every value import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  releaseSettingsConfigured,
  releaseTagName,
  tagKind,
  validateReleaseSettings,
  validateReleaseSuffix,
} from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-release-settings-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

describe('validateReleaseSuffix — a valid git ref fragment, 1–32 characters', () => {
  it.each(['-rc', '-hotfix', '.rc1', '_release', '-rc/2', 'r'])('accepts %s', (s) => {
    expect(validateReleaseSuffix(s)).toBeNull();
  });
  it.each([
    ['', 'empty'],
    ['-r c', 'spaces'],
    ['-rc~', '~'],
    ['-rc^', '^'],
    ['-rc:', ':'],
    ['-rc?', '?'],
    ['-rc*', '*'],
    ['-rc[', '['],
    ['-rc\\', 'backslash'],
    ['-r..c', '..'],
    ['-r@{c', '@{'],
    ['-rc.lock', '.lock'],
    ['-rc/', 'trailing /'],
    ['-rc.', 'trailing .'],
    ['-r//c', '//'],
    ['x'.repeat(33), 'too long'],
  ])('refuses %j (%s) with a sentence', (s) => {
    const problem = validateReleaseSuffix(s);
    expect(problem).toMatch(/\.$/);
  });
});

describe('validateReleaseSettings', () => {
  it('lets either suffix be unset (null or empty)', () => {
    expect(validateReleaseSettings({ releaseSuffix: null, hotfixSuffix: null })).toBeNull();
    expect(validateReleaseSettings({ releaseSuffix: '-rc', hotfixSuffix: '' })).toBeNull();
  });
  it('acceptance 2: refuses equal suffixes with a sentence', () => {
    expect(validateReleaseSettings({ releaseSuffix: '-rc', hotfixSuffix: '-rc' })).toBe(
      'The release and hotfix suffixes must be different.',
    );
  });
  it('acceptance 2: refuses one suffix ending with the other, both ways', () => {
    const sentence = 'One suffix cannot end with the other, or a tag could be read as both.';
    expect(validateReleaseSettings({ releaseSuffix: '-rc', hotfixSuffix: '-hotfix-rc' })).toBe(sentence);
    expect(validateReleaseSettings({ releaseSuffix: '-final-hf', hotfixSuffix: '-hf' })).toBe(sentence);
  });
  it('names the field that is wrong', () => {
    expect(validateReleaseSettings({ releaseSuffix: 'a b', hotfixSuffix: '-hf' })).toMatch(/^The release suffix/);
    expect(validateReleaseSettings({ releaseSuffix: '-rc', hotfixSuffix: 'a b' })).toMatch(/^The hotfix suffix/);
  });
});

describe('tagKind', () => {
  const s = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
  it('acceptance 1: classifies nothing until BOTH suffixes are set', () => {
    expect(releaseSettingsConfigured({ releaseSuffix: '-rc', hotfixSuffix: null })).toBe(false);
    expect(tagKind('v1.0.0-rc', { releaseSuffix: '-rc', hotfixSuffix: null })).toBeNull();
  });
  it('reads release, hotfix and version tags by suffix', () => {
    expect(tagKind('v2.4.0-rc', s)).toBe('release');
    expect(tagKind('v2.4.0-rc-hotfix', s)).toBe('hotfix');
    expect(tagKind('v2.4.0', s)).toBe('version');
    expect(tagKind('-rc', s)).toBe('version');
    expect(releaseTagName('v2.4.0', '-rc')).toBe('v2.4.0-rc');
  });
  it('acceptance 3: after the release suffix changes, the old release tags no longer read as releases', () => {
    expect(tagKind('v1.0.0-rc', { releaseSuffix: '-release', hotfixSuffix: '-hotfix' })).toBe('version');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void>) | undefined;
let client: any;
let ownWs = 0;
let foreignWs = 0;

const call = async (method: 'GET' | 'PUT', id: number, body?: unknown) => {
  const res = await app.inject({ method, url: `/api/workspaces/${id}/release-settings`, payload: body as any });
  return { status: res.statusCode, body: res.json() as any };
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await client.db
    .insert(client.schema.accounts)
    .values({ id: 2, githubUserId: 'U_rel_b', githubLogin: 'rel-b', isLocal: false })
    .execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);

  const { releaseRoutes } = await import('./releases.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(releaseRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET / PUT /api/workspaces/:id/release-settings', () => {
  it('acceptance 1: starts with no suffixes and not configured — there is no default', async () => {
    const res = await call('GET', ownWs);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workspaceId: ownWs,
      releaseSuffix: null,
      hotfixSuffix: null,
      configured: false,
      hasReleases: false,
    });
  });

  it('stores both suffixes and reports configured', async () => {
    const res = await call('PUT', ownWs, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ releaseSuffix: '-rc', hotfixSuffix: '-hotfix', configured: true });
    expect((await call('GET', ownWs)).body.releaseSuffix).toBe('-rc');
  });

  it('acceptance 2: refuses equal suffixes with the validator sentence, and stores nothing', async () => {
    const res = await call('PUT', ownWs, { releaseSuffix: '-x', hotfixSuffix: '-x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'InvalidReleaseSettings',
      message: 'The release and hotfix suffixes must be different.',
    });
    expect((await call('GET', ownWs)).body.releaseSuffix).toBe('-rc');
  });

  it('acceptance 3: hasReleases once a stored tag ends in the release suffix (the form warns)', async () => {
    const { repos, repoTags } = client.schema;
    const [repo] = await client.db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_rel_api' })
      .returning()
      .execute();
    const q = await import('../../db/queries.js');
    await q.ensureRepoMemberships(1);
    const now = new Date();
    await client.db
      .insert(repoTags)
      .values({ accountId: 1, repoId: repo.id, name: 'v1.0.0-rc', sha: 'a'.repeat(40), firstSeenAt: now, lastSeenAt: now })
      .execute();
    expect((await call('GET', ownWs)).body.hasReleases).toBe(true);
    // After the suffix changes, the old tag no longer counts.
    const res = await call('PUT', ownWs, { releaseSuffix: '-release', hotfixSuffix: '-hotfix' });
    expect(res.body.hasReleases).toBe(false);
  });

  it('clears a suffix with null or ""', async () => {
    const res = await call('PUT', ownWs, { releaseSuffix: '', hotfixSuffix: null });
    expect(res.body).toMatchObject({ releaseSuffix: null, hotfixSuffix: null, configured: false });
  });

  it("404s another account's workspace on both verbs", async () => {
    expect((await call('GET', foreignWs)).status).toBe(404);
    expect((await call('PUT', foreignWs, { releaseSuffix: '-rc', hotfixSuffix: '-hf' })).status).toBe(404);
  });

  it('400s a body that is not the whole setting', async () => {
    expect((await call('PUT', ownWs, { releaseSuffix: '-rc' })).status).toBe(400);
  });

  it('GET /api/releases: scope falls back to Default (never a 404); acceptance 3: a suffix change drops the old baseline', async () => {
    const { repoTags } = client.schema;
    await call('PUT', ownWs, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' });
    const at = new Date(Date.UTC(2026, 10, 1));
    await client.db
      .update(repoTags)
      .set({ onDefaultBranch: true, committedAt: at, taggedAt: new Date(at.getTime() + 60_000) })
      .execute();
    const repoId = (await client.db.select().from(repoTags).execute())[0].repoId;
    await client.db
      .insert(repoTags)
      .values({ accountId: 1, repoId, name: 'v1.0.0', sha: 'a'.repeat(40), committedAt: at, onDefaultBranch: true, firstSeenAt: at, lastSeenAt: at })
      .execute();
    const get = async (ws: number | string) => {
      const res = await app.inject({ method: 'GET', url: `/api/releases?workspace=${ws}` });
      return { status: res.statusCode, body: res.json() as any };
    };
    const before = await get(ownWs);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ workspaceId: ownWs, configured: true, releaseSuffix: '-rc' });
    expect(before.body.check.repos[0]).toMatchObject({ status: 'nothing_new', baseline: { name: 'v1.0.0-rc' } });
    // Another account's workspace id is not this account's: the Default workspace answers.
    expect((await get(foreignWs)).body.workspaceId).toBe(ownWs);
    await call('PUT', ownWs, { releaseSuffix: '-release', hotfixSuffix: '-hotfix' });
    const after = (await get(ownWs)).body;
    expect(after.check.repos[0].baseline).toBeNull();
    expect(after.check.repos[0].tags.map((t: any) => t.name).sort()).toEqual(['v1.0.0', 'v1.0.0-rc']);
    // Not configured → no check, only the setup line.
    await call('PUT', ownWs, { releaseSuffix: null, hotfixSuffix: null });
    expect((await get(ownWs)).body).toMatchObject({ configured: false, check: null });
  });

  it('the new tables are on the erasure checklist', async () => {
    const { accountScopedTables } = await import('../../db/erase-account.js');
    expect(accountScopedTables().map((t) => t.name)).toEqual(
      expect.arrayContaining(['repoTags', 'repoTagRanges', 'releases', 'releaseItems', 'releaseTicketComments']),
    );
  });
});
