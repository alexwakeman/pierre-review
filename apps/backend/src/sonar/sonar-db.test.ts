// SONARCLOUD over the REAL core client (a scratch SQLite) and a FAKE SonarCloud transport + a FAKE
// GitHub. What is pinned:
//   1. THE TOKEN IS WRITE-ONLY: no settings response, no snapshot and no account export carries it;
//      it is sent to SonarCloud as `Bearer <token>` and nowhere else.
//   2. Settings: per-repo project keys default to `<owner>_<repo>`, an override sticks, a key for a
//      repo outside the workspace is refused, another account's workspace is a 404.
//   3. A refresh stores ONE snapshot per (PR, head); the stored read never calls SonarCloud.
//   4. POSTING ONCE PER (PR, head): two presses at once post once; a re-read of the same head keeps
//      the claim; a GitHub failure is recorded and never retried; a moved head posts nothing; the
//      body carries the hidden marker `isLimnPostedComment` reads.
//
//   DATABASE_URL=<scratch>.db pnpm --filter @pierre-review/backend test sonar/sonar-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JiraTransport } from '../tracker/jira/fetch.js';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-sonar'}.sonar-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let app: FastifyInstance;
let wsA = 0;
let wsB = 0;
let repoA = 0;
let prA = 0;
let prB = 0;
const HEAD = 'a'.repeat(40);
const TOKEN = 'squ_secret_token_value';

const seen: Array<{ path: string; auth: string | undefined }> = [];
let issueTotal = 3;
const transport: JiraTransport = async (url, headers) => {
  seen.push({ path: url.pathname, auth: headers.authorization });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  switch (url.pathname) {
    case '/api/organizations/search':
      return json({ organizations: [{ key: 'acme' }] });
    case '/api/components/show':
      return url.searchParams.get('component') === 'acme_api'
        ? json({ component: { key: 'acme_api' } })
        : { status: 404, contentType: 'application/json', body: '{}' };
    case '/api/qualitygates/project_status':
      return json({ projectStatus: { status: 'ERROR', conditions: [] } });
    case '/api/issues/search':
      return json({
        paging: { total: issueTotal },
        issues: Array.from({ length: issueTotal }, (_, i) => ({
          key: `I${i}`,
          rule: 'ts:S1',
          severity: i === 0 ? 'BLOCKER' : 'MINOR',
          component: 'acme_api:src/a.ts',
          line: i + 1,
          message: `Fix me ${i}`,
          type: 'BUG',
        })),
      });
    case '/api/hotspots/search':
      return json({ paging: { total: 0 }, hotspots: [] });
    case '/api/rules/show':
      return json({ rule: { name: 'Rule', descriptionSections: [{ key: 'how_to_fix', content: '<p>Do X</p>' }] } });
    case '/api/sources/lines':
      return json({ sources: [{ line: 1, code: 'x' }] });
    default:
      return { status: 404, contentType: 'application/json', body: '{}' };
  }
};

const postComment = vi.fn();
let liveHead = HEAD;
const postDeps = {
  livePr: vi.fn(async () => ({ headSha: liveHead, state: 'open', draft: false, merged: false })),
  postComment,
  settle: vi.fn(async () => ({ visible: true })),
};

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../db/queries.js');
  for (const id of [1, 2]) {
    await db.insert(schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const [u] = await db.insert(schema.users).values({ githubLogin: 'me1', githubNodeId: 'U_me1' }).returning().execute();
  const [ra] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_a' }).returning().execute();
  const [rw] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'web', githubNodeId: 'R_w' }).returning().execute();
  const [rb] = await db.insert(schema.repos).values({ accountId: 2, owner: 'acme', name: 'api', githubNodeId: 'R_a' }).returning().execute();
  repoA = ra.id;
  void rw;
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  await q.ensureRepoMemberships(1);
  await q.ensureRepoMemberships(2);
  const pr = async (accountId: number, repoId: number, node: string) =>
    (
      await db
        .insert(schema.pullRequests)
        .values({ githubNodeId: node, accountId, repoId, number: 7, title: 't', state: 'open', isDraft: false, headSha: HEAD, authorId: u.id, openedAt: new Date(), updatedAt: new Date() })
        .returning()
        .execute()
    )[0].id;
  prA = await pr(1, repoA, 'PR_A');
  prB = await pr(2, rb.id, 'PR_B');

  const Fastify = (await import('fastify')).default;
  const { registerSonarRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerSonarRoutes(app, {
    db,
    schema,
    accountIdOf: () => 1,
    log: { info() {}, warn() {}, error() {} } as any,
    isCloud: false,
    transport,
    postDeps,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  postComment.mockReset();
  postComment.mockImplementation(async () => ({ commentId: 'IC1' }));
  liveHead = HEAD;
});

describe('settings', () => {
  it('saves the token write-only and never returns it', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/sonar`, payload: { organization: 'acme', token: TOKEN } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(TOKEN);
    expect(put.json()).toMatchObject({ organization: 'acme', hasToken: true, tokenUnreadable: false });
    const get = await app.inject({ method: 'GET', url: `/api/workspaces/${wsA}/sonar` });
    expect(get.body).not.toContain(TOKEN);
    const repos = get.json().repos;
    expect(repos.map((r: any) => r.projectKey)).toEqual(['acme_api', 'acme_web']);
    // At rest it is never the bare value either (sealed:, or plain: with no key on this machine).
    const [row] = await db.select().from(schema.workspaceSonar).execute();
    expect(row.authToken.startsWith('sealed:v1:') || row.authToken.startsWith('plain:')).toBe(true);
  });

  it('keeps a project-key override, drops one equal to the default, refuses a foreign repo', async () => {
    const webId = (await app.inject({ method: 'GET', url: `/api/workspaces/${wsA}/sonar` })).json().repos[1].repoId;
    const ok = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/sonar`, payload: { projectKeys: { [webId]: 'acme-web-x' } } });
    expect(ok.json().repos[1]).toMatchObject({ projectKey: 'acme-web-x', overridden: true });
    const back = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/sonar`, payload: { projectKeys: { [webId]: 'acme_web' } } });
    expect(back.json().repos[1]).toMatchObject({ projectKey: 'acme_web', overridden: false });
    const bad = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/sonar`, payload: { projectKeys: { 999999: 'x' } } });
    expect(bad.statusCode).toBe(400);
  });

  it("another account's workspace is a 404, both ways", async () => {
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsB}/sonar` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/workspaces/${wsB}/sonar`, payload: { token: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/workspaces/${wsB}/sonar/check` })).statusCode).toBe(404);
  });

  it('tests the connection with the saved token as Bearer', async () => {
    seen.length = 0;
    const res = await app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/sonar/check` });
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json().projects).toEqual([
      expect.objectContaining({ projectKey: 'acme_api', found: true }),
      expect.objectContaining({ projectKey: 'acme_web', found: false }),
    ]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(res.body).not.toContain(TOKEN);
  });
});

describe('snapshots and the one comment', () => {
  it('the stored read calls nothing; a refresh stores one snapshot per head', async () => {
    seen.length = 0;
    const before = await app.inject({ method: 'GET', url: `/api/prs/${prA}/sonar` });
    expect(before.json()).toMatchObject({ configured: true, snapshot: null });
    expect(seen).toHaveLength(0);
    const r = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    expect(r.statusCode).toBe(200);
    const snap = r.json().snapshot;
    expect(snap).toMatchObject({ state: 'ok', headSha: HEAD, totalIssues: 3, projectKey: 'acme_api' });
    expect(snap.issues[0]).toMatchObject({ severity: 'blocker', howToFix: 'Do X' });
    expect(r.body).not.toContain(TOKEN);
    seen.length = 0;
    const after = await app.inject({ method: 'GET', url: `/api/prs/${prA}/sonar` });
    expect(after.json().snapshot.issues).toHaveLength(3);
    expect(seen).toHaveLength(0);
    const rows = await db.select().from(schema.sonarSnapshots).execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("another account's PR is a 404 on every PR route", async () => {
    expect((await app.inject({ method: 'GET', url: `/api/prs/${prB}/sonar` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/prs/${prB}/sonar/refresh`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/prs/${prB}/sonar/post`, payload: { headSha: HEAD } })).statusCode).toBe(404);
  });

  it('posts ONCE per (PR, head), claim before the write, even with two presses at once', async () => {
    let release: () => void = () => {};
    postComment.mockImplementation(
      () => new Promise((res) => (release = () => res({ commentId: 'IC9' }))),
    );
    const a = app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: HEAD } });
    // Let the first request reach the GitHub call, then press again.
    await vi.waitFor(() => expect(postComment).toHaveBeenCalledTimes(1));
    const [{ post }] = await db.select({ post: schema.sonarSnapshots.post }).from(schema.sonarSnapshots).execute();
    expect(post.status).toBe('posting');
    const b = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: HEAD } });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toBe('AlreadyPosted');
    release();
    const done = await a;
    expect(done.statusCode).toBe(200);
    expect(done.json().snapshot.post).toMatchObject({ status: 'posted', commentId: 'IC9', trigger: 'manual', issueCount: 3 });
    expect(postComment).toHaveBeenCalledTimes(1);
    const body = postComment.mock.calls[0]![3] as string;
    expect(body).toContain('<!-- pierre:claude-review-sonar v=1 -->');
    expect(body).toContain('Do X');
    // A manual post carries no "posted automatically" footer.
    expect(body).not.toContain('Posted automatically');
    // A re-read of the same head keeps the claim.
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    const again = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: HEAD } });
    expect(again.statusCode).toBe(409);
    expect(postComment).toHaveBeenCalledTimes(1);
  });

  it('a GitHub failure is recorded and never retried; a moved head posts nothing', async () => {
    const H2 = 'b'.repeat(40);
    await db.update(schema.pullRequests).set({ headSha: H2 }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, prA)).execute();
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    liveHead = 'c'.repeat(40);
    const moved = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H2 } });
    expect(moved.json().error).toBe('HeadMoved');
    expect(postComment).not.toHaveBeenCalled();
    liveHead = H2;
    postComment.mockImplementation(async () => {
      throw new Error('HTTP 403');
    });
    const failed = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H2 } });
    expect(failed.json().snapshot.post).toMatchObject({ status: 'failed', error: 'HTTP 403' });
    const retry = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H2 } });
    expect(retry.statusCode).toBe(409);
    expect(postComment).toHaveBeenCalledTimes(1);
  });

  it('the account export never carries the token', async () => {
    const { exportAccountData } = await import('../db/export-account.js');
    const out = await exportAccountData(1);
    const text = JSON.stringify(out);
    expect(text).not.toContain(TOKEN);
    expect(out?.workspaceSonar).toEqual([expect.objectContaining({ organization: 'acme', hasToken: true })]);
  });

  it('a seed reads the snapshot at the current head only', async () => {
    const { getSonarIssuesForPrHead } = await import('./store.js');
    const ctx = { db, schema };
    expect((await getSonarIssuesForPrHead(ctx, 1, prA)).length).toBe(3);
    expect(await getSonarIssuesForPrHead(ctx, 2, prA)).toEqual([]);
    await db.update(schema.pullRequests).set({ headSha: 'd'.repeat(40) }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, prA)).execute();
    expect(await getSonarIssuesForPrHead(ctx, 1, prA)).toEqual([]);
  });
});

describe('auto-posting after an auto review', () => {
  it('follows the workspace switch and its SonarCloud kind, posts once with the auto footer', async () => {
    const { eq } = await import('drizzle-orm');
    const H3 = 'e'.repeat(40);
    await db.update(schema.pullRequests).set({ headSha: H3 }).where(eq(schema.pullRequests.id, prA)).execute();
    liveHead = H3;
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    const ctx = { db, schema, isPg: false, log: { info() {}, warn() {}, error() {} } } as any;
    const settings = await import('../review/claude-review/auto-settings.js');
    const { maybeAutoPostSonar } = await import('./post.js');
    const run = () => maybeAutoPostSonar(ctx, { accountId: 1, prId: prA, headSha: H3 }, postDeps);

    expect(await run()).toEqual({ kind: 'off' });
    await settings.setWorkspaceAutoReview(ctx, 1, wsA, { autoPost: { enabled: true, scope: 'all', kinds: { sonar: false } } as any });
    expect(await run()).toEqual({ kind: 'off' });
    expect(postComment).not.toHaveBeenCalled();
    await settings.setWorkspaceAutoReview(ctx, 1, wsA, { autoPost: { kinds: { sonar: true } } as any });
    const out = await run();
    expect(out.kind).toBe('done');
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment.mock.calls[0]![3]).toContain('Posted automatically');
    expect((out as any).snapshot.post).toMatchObject({ status: 'posted', trigger: 'auto' });
    expect((await run()).kind).toBe('already_posted');
    expect(postComment).toHaveBeenCalledTimes(1);
  });
});
