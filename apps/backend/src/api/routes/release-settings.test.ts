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
  normaliseReleaseSuffix,
  releaseSettingsConfigured,
  releaseTagName,
  suffixFromTyped,
  suffixTypedPart,
  tagKind,
  validateReleaseSettings,
  validateReleaseSuffix,
} from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-release-settings-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

describe('validateReleaseSuffix — the TYPED part (after the fixed hyphen): a valid git ref fragment, 1–32 characters', () => {
  it.each(['rc', 'hotfix', '.rc1', '_release', 'rc/2', 'r', 'x'.repeat(32)])('accepts %s', (s) => {
    expect(validateReleaseSuffix(s)).toBeNull();
  });
  it.each([
    ['', 'empty'],
    ['-rc', 'a leading hyphen'],
    ['r c', 'spaces'],
    ['rc~', '~'],
    ['rc^', '^'],
    ['rc:', ':'],
    ['rc?', '?'],
    ['rc*', '*'],
    ['rc[', '['],
    ['rc\\', 'backslash'],
    ['r..c', '..'],
    ['r@{c', '@{'],
    ['rc.lock', '.lock'],
    ['rc/', 'trailing /'],
    ['rc.', 'trailing .'],
    ['r//c', '//'],
    ['x'.repeat(33), 'too long'],
  ])('refuses %j (%s) with a sentence', (s) => {
    const problem = validateReleaseSuffix(s);
    expect(problem).toMatch(/\.$/);
  });
  it('a leading hyphen is refused with a sentence saying it is added', () => {
    expect(validateReleaseSuffix('-rc', 'The release suffix')).toBe('The release suffix cannot start with a hyphen. The hyphen is added for you.');
  });
});

describe('the fixed hyphen', () => {
  it('the stored suffix is the hyphen plus what was typed', () => {
    expect(suffixFromTyped('rc')).toBe('-rc');
    expect(suffixFromTyped('')).toBeNull();
    expect(suffixFromTyped('  ')).toBeNull();
    expect(suffixFromTyped('-rc')).toBe('--rc');
    expect(suffixTypedPart('-rc')).toBe('rc');
    expect(suffixTypedPart(null)).toBe('');
  });
  it('normalising puts the hyphen in front only when it is missing (the route and migration 0199)', () => {
    expect(normaliseReleaseSuffix('rc')).toBe('-rc');
    expect(normaliseReleaseSuffix('-rc')).toBe('-rc');
    expect(normaliseReleaseSuffix('')).toBeNull();
    expect(normaliseReleaseSuffix(null)).toBeNull();
  });
  it('a typed leading hyphen ("--rc" stored) is refused', () => {
    expect(validateReleaseSettings({ releaseSuffix: suffixFromTyped('-rc'), hotfixSuffix: null })).toMatch(/cannot start with a hyphen/);
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
  it('acceptance 2: refuses one suffix ending with the other, both ways (on the typed parts)', () => {
    const sentence = 'One suffix cannot end with the other, or a tag could be read as both.';
    expect(validateReleaseSettings({ releaseSuffix: '-rc', hotfixSuffix: '-hotfix-rc' })).toBe(sentence);
    expect(validateReleaseSettings({ releaseSuffix: '-final-hf', hotfixSuffix: '-hf' })).toBe(sentence);
    expect(validateReleaseSettings({ releaseSuffix: '-rc', hotfixSuffix: '-c' })).toBe(sentence);
    expect(validateReleaseSettings({ releaseSuffix: 'rc', hotfixSuffix: 'hotfix' })).toBeNull();
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
      repos: [],
    });
  });

  it('stores both suffixes and reports configured; a suffix sent without the hyphen gets one', async () => {
    const res = await call('PUT', ownWs, { releaseSuffix: 'rc', hotfixSuffix: '-hotfix' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ releaseSuffix: '-rc', hotfixSuffix: '-hotfix', configured: true });
    expect((await call('GET', ownWs)).body.releaseSuffix).toBe('-rc');
  });

  it('migration 0199: a stored suffix without the hyphen reads with one in front', async () => {
    const { workspaces } = client.schema;
    const { eq } = await import('drizzle-orm');
    // The migration's own UPDATE, run again over a row written the old way.
    await client.db.update(workspaces).set({ releaseSuffix: 'rc' }).where(eq(workspaces.id, ownWs)).execute();
    client.rawSqlite?.exec?.(
      "UPDATE `workspaces` SET `release_suffix` = '-' || `release_suffix` WHERE `release_suffix` IS NOT NULL AND trim(`release_suffix`) <> '' AND substr(`release_suffix`, 1, 1) <> '-'",
    );
    expect((await call('GET', ownWs)).body.releaseSuffix).toBe('-rc');
    await client.db.update(workspaces).set({ releaseSuffix: '-rc' }).where(eq(workspaces.id, ownWs)).execute();
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
    // Only a RELEASABLE repo's tags count: unticked, nothing.
    expect((await call('GET', ownWs)).body.hasReleases).toBe(false);
    const tick = await app.inject({ method: 'PUT', url: `/api/workspaces/${ownWs}/release-repos`, payload: { repoIds: [repo.id] } });
    expect(tick.statusCode).toBe(200);
    // Its one tag is a release tag, so Auto releases it from merged pull requests.
    expect(tick.json().repos).toEqual([
      { repoId: repo.id, fullName: 'acme/api', external: false, releasable: true, basis: 'auto', effectiveBasis: 'prs' },
    ]);
    // "Release from" is stored per ticked repo; a bad value is refused by the schema.
    const pick = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ownWs}/release-repos`,
      payload: { repoIds: [repo.id], bases: [{ repoId: repo.id, basis: 'tags' }] },
    });
    expect(pick.json().repos[0]).toMatchObject({ basis: 'tags', effectiveBasis: 'tags' });
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ownWs}/release-repos`,
      payload: { repoIds: [repo.id], bases: [{ repoId: repo.id, basis: 'commits' }] },
    });
    expect(bad.statusCode).toBe(400);
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
    // The history pass walked main to the root: every tag's commit is on it.
    const shas = [...new Set((await client.db.select().from(repoTags).execute()).map((t: any) => t.sha as string))];
    await client.db
      .insert(client.schema.releaseHistoryScans)
      .values({ accountId: 1, repoId, topSha: shas[0]!, deepStartSha: shas[0]!, deepExpectedSha: null, updatedAt: at })
      .execute();
    await client.db
      .insert(client.schema.releaseHistoryCommits)
      .values(shas.map((sha, i) => ({ accountId: 1, repoId, sha, seq: -i, prNumbers: [], committedAt: at })))
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
    // Both are version tags now; the newest qualifies first (nothing older is read).
    expect(after.check.repos[0]).toMatchObject({ status: 'candidate', candidate: { name: 'v1.0.0-rc' } });
    expect(after.check.repos[0].tags.map((t: any) => t.name)).toEqual(['v1.0.0-rc']);
    // Unticked → no check, the setup line (an unticked repo is ignored entirely).
    await app.inject({ method: 'PUT', url: `/api/workspaces/${ownWs}/release-repos`, payload: { repoIds: [] } });
    expect((await get(ownWs)).body).toMatchObject({ configured: true, hasReleasableRepos: false, check: null });
    await app.inject({ method: 'PUT', url: `/api/workspaces/${ownWs}/release-repos`, payload: { repoIds: [repoId] } });
    // Not configured → no check, only the setup line.
    await call('PUT', ownWs, { releaseSuffix: null, hotfixSuffix: null });
    expect((await get(ownWs)).body).toMatchObject({ configured: false, check: null });
  });

  it('PUT …/release-repos refuses a repo outside the workspace, and another account\'s workspace', async () => {
    const bad = await app.inject({ method: 'PUT', url: `/api/workspaces/${ownWs}/release-repos`, payload: { repoIds: [999_999] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'NotAMember' });
    const foreign = await app.inject({ method: 'PUT', url: `/api/workspaces/${foreignWs}/release-repos`, payload: { repoIds: [] } });
    expect(foreign.statusCode).toBe(404);
  });

  it('POST /api/releases/older-tags ("Show 50 more") raises one releasable repo\'s older band; 404 for a repo not released from the workspace', async () => {
    const older = await import('../../releases/older-tags.js');
    older.__resetOlderTagsWanted();
    const repoId = (await client.db.select().from(client.schema.repoTags).execute())[0].repoId as number;
    const post = (body: unknown, ws: number | string = ownWs) => app.inject({ method: 'POST', url: `/api/releases/older-tags?workspace=${ws}`, payload: body as any });
    // The default needs no scan: nothing grows.
    const same = await post({ repoId, wanted: 10 });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toEqual({ workspaceId: ownWs, repoId, wanted: 10 });
    expect((await post({ repoId: 999_999, wanted: 60 })).statusCode).toBe(404);
    expect((await post({ repoId, wanted: 5000 })).statusCode).toBe(400);
    expect((await post({ repoId })).statusCode).toBe(400);
    // An unknown workspace id reads as the Default (never a 404).
    expect((await post({ repoId, wanted: 10 }, 'nope')).json()).toMatchObject({ workspaceId: ownWs });
    expect(older.olderTagsWanted(1, ownWs, repoId)).toBe(10);
    older.raiseOlderTagsWanted(1, ownWs, repoId, 60);
    expect((await post({ repoId, wanted: 10 })).json()).toMatchObject({ wanted: 60 });
    older.__resetOlderTagsWanted();
  });

  it('the start tag is gone: PUT /api/releases/start-tag is not a route (the check finds its own start)', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/releases/start-tag?workspace=${ownWs}`, payload: { repoId: 1, tagName: 'v1.0.0' } });
    expect(res.statusCode).toBe(404);
  });

  it('the new tables are on the erasure checklist', async () => {
    const { accountScopedTables } = await import('../../db/erase-account.js');
    expect(accountScopedTables().map((t) => t.name)).toEqual(
      expect.arrayContaining(['repoTags', 'repoTagRanges', 'releases', 'releaseItems', 'releaseTicketComments', 'workspaceReleaseRepos']),
    );
  });
});
