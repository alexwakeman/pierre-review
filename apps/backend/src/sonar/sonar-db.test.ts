// SONARCLOUD over the REAL core client (a scratch SQLite) and a FAKE SonarCloud transport + a FAKE
// GitHub. What is pinned:
//   1. THE TOKEN IS WRITE-ONLY: no settings response, no snapshot and no account export carries it;
//      it is sent to SonarCloud as `Bearer <token>` and nowhere else.
//   2. Settings: per-repo project keys default to `<owner>_<repo>`, an override sticks, a key for a
//      repo outside the workspace is refused, another account's workspace is a 404.
//   3. A refresh stores ONE snapshot per (PR, head); the stored read never calls SonarCloud; an
//      analysis of ANOTHER commit never replaces a good read of this head, and is stored as
//      `not_analyzed` (no issues) when there is none.
//   4. POSTING ONCE PER (PR, head): two presses at once post once; a re-read of the same head keeps
//      the claim; a GitHub failure is recorded and never retried; a moved head posts nothing; the
//      body carries the hidden marker `isLimnPostedComment` reads.
//
//   DATABASE_URL=<scratch>.db pnpm --filter @pierre-review/backend test sonar/sonar-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JiraTransport } from '../tracker/jira/fetch.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-sonar`}.sonar-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

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
// The commit SonarCloud says it analysed for PR 7 (`project_pull_requests/list`).
let analysedSha = HEAD;
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
    case '/api/project_pull_requests/list':
      return json({ pullRequests: [{ key: '7', commit: { sha: analysedSha } }] });
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

const postReview = vi.fn();
let liveHead = HEAD;
// The live diff: src/a.ts lines 1-2 are added (I0 and I1 sit on them); line 3 is not in the diff.
let liveDiffText = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -0,0 +1,2 @@', '+x', '+y'].join('\n');
const findLandedReview = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
const postDeps = {
  livePr: vi.fn(async () => ({ headSha: liveHead, state: 'open', draft: false, merged: false })),
  liveDiff: vi.fn(async () => liveDiffText),
  postReview,
  findLandedReview,
  reviewComments: vi.fn(async (_o: string, _n: string, _p: number, reviewId: string) =>
    ((postReview.mock.calls.at(-1)?.[3]?.comments ?? []) as Array<{ path: string; line: number; body: string }>).map((c, i) => ({
      id: Number(reviewId.replace(/\D/g, '') || 0) * 100 + i,
      path: c.path,
      line: c.line,
      side: 'RIGHT' as const,
      body: c.body,
    })),
  ),
  settle: vi.fn(async () => ({ visible: true })),
};
const bodyOf = (call = 0): string => postReview.mock.calls[call]![3].body as string;
const commentsOf = (call = 0): Array<{ path: string; line: number; side: string; body: string }> => postReview.mock.calls[call]![3].comments;

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
    transport,
    postDeps,
    isMergeOfHead: async () => false,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  postReview.mockReset();
  postReview.mockImplementation(async () => ({ reviewId: '501' }));
  findLandedReview.mockReset();
  findLandedReview.mockImplementation(async () => null);
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
    // The read asked SonarCloud which commit it analysed — before and after reading it.
    expect(seen.filter((x) => x.path === '/api/project_pull_requests/list')).toHaveLength(2);
    seen.length = 0;
    const after = await app.inject({ method: 'GET', url: `/api/prs/${prA}/sonar` });
    expect(after.json().snapshot.issues).toHaveLength(3);
    expect(seen).toHaveLength(0);
    const rows = await db.select().from(schema.sonarSnapshots).execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('an analysis of another commit never lands under this head, and never wipes a good read', async () => {
    const { eq } = await import('drizzle-orm');
    analysedSha = 'f'.repeat(40);
    // A forced refresh of HEAD (already read OK): the earlier read stands.
    const kept = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    expect(kept.json().snapshot).toMatchObject({ state: 'ok', headSha: HEAD });
    expect(kept.json().snapshot.issues).toHaveLength(3);
    // A head with no read yet: stored as not analysed, with nothing of the other commit's.
    const H9 = '9'.repeat(40);
    await db.update(schema.pullRequests).set({ headSha: H9 }).where(eq(schema.pullRequests.id, prA)).execute();
    const fresh = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    expect(fresh.json().snapshot).toMatchObject({ state: 'not_analyzed', headSha: H9, issues: [], qualityGate: null });
    expect(fresh.json().snapshot.message).toContain('Its latest analysis is of fffffff.');
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prA)).execute();
    analysedSha = HEAD;
  });

  it("another account's PR is a 404 on every PR route", async () => {
    expect((await app.inject({ method: 'GET', url: `/api/prs/${prB}/sonar` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/prs/${prB}/sonar/refresh`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/prs/${prB}/sonar/post`, payload: { headSha: HEAD } })).statusCode).toBe(404);
  });

  it('posts ONE review ONCE per (PR, head) — threads on diff lines, the rest in the body — claim before the write', async () => {
    let release: () => void = () => {};
    postReview.mockImplementation(
      () => new Promise((res) => (release = () => res({ reviewId: '9' }))),
    );
    const a = app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: HEAD } });
    // Let the first request reach the GitHub call, then press again.
    await vi.waitFor(() => expect(postReview).toHaveBeenCalledTimes(1));
    const [{ post }] = await db.select({ post: schema.sonarSnapshots.post }).from(schema.sonarSnapshots).execute();
    expect(post.status).toBe('posting');
    // The planned threads are on the claim, so a cut-off post still counts them as on GitHub.
    expect(post.inline.map((p: any) => p.key)).toEqual(['I0', 'I1']);
    const b = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: HEAD } });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toBe('AlreadyPosted');
    release();
    const done = await a;
    expect(done.statusCode).toBe(200);
    expect(done.json().snapshot.post).toMatchObject({
      status: 'posted',
      githubReviewId: '9',
      commentId: null,
      trigger: 'manual',
      issueCount: 3,
      summaryCount: 1,
      alreadyCount: 0,
      inline: [
        { key: 'I0', path: 'src/a.ts', line: 1, commentId: '900' },
        { key: 'I1', path: 'src/a.ts', line: 2, commentId: '901' },
      ],
    });
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![3].commitId).toBe(HEAD);
    // I0 + I1 are on changed lines: one thread each, on the RIGHT side, each with the marker.
    expect(commentsOf().map((c) => [c.path, c.line, c.side])).toEqual([
      ['src/a.ts', 1, 'RIGHT'],
      ['src/a.ts', 2, 'RIGHT'],
    ]);
    for (const c of commentsOf()) {
      expect(c.body).toContain('<!-- pierre:claude-review-sonar v=1 -->');
      expect(c.body).toContain('Do X');
    }
    expect(commentsOf()[0]!.body).toContain('Fix me 0');
    // I2 (line 3, outside the diff) is in the body in full; the threaded ones are only counted.
    const body = bodyOf();
    expect(body).toMatch(/<!-- pierre:claude-review-sonar v=1 a=[0-9a-f]{12} -->/);
    expect(body).toContain('2 issues are on the changed lines, as comments there.');
    expect(body).toContain('Fix me 2');
    expect(body).toContain('`src/a.ts:3`');
    expect(body).not.toContain('Fix me 0');
    // A manual post carries no "posted automatically" footer.
    expect(body).not.toContain('Posted automatically');
    // A re-read of the same head keeps the claim.
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    const again = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: HEAD } });
    expect(again.statusCode).toBe(409);
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('a GitHub failure is recorded and never retried; a moved head posts nothing', async () => {
    const H2 = 'b'.repeat(40);
    await db.update(schema.pullRequests).set({ headSha: H2 }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, prA)).execute();
    analysedSha = H2;
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    liveHead = 'c'.repeat(40);
    const moved = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H2 } });
    expect(moved.json().error).toBe('HeadMoved');
    expect(postReview).not.toHaveBeenCalled();
    liveHead = H2;
    postReview.mockImplementation(async () => {
      throw new Error('HTTP 403');
    });
    const failed = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H2 } });
    expect(failed.json().snapshot.post).toMatchObject({ status: 'failed', error: 'HTTP 403' });
    // It looked for the review before calling it a failure.
    expect(findLandedReview).toHaveBeenCalledTimes(1);
    const retry = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H2 } });
    expect(retry.statusCode).toBe(409);
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('a new head never re-threads an issue already threaded on an earlier head (by key)', async () => {
    const { eq } = await import('drizzle-orm');
    // Head H4: I0 and I1 were threaded on HEAD (posted) — and on H2 nothing landed (failed).
    const H4 = '4'.repeat(40);
    await db.update(schema.pullRequests).set({ headSha: H4 }).where(eq(schema.pullRequests.id, prA)).execute();
    analysedSha = H4;
    liveHead = H4;
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    const res = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H4 } });
    expect(res.statusCode).toBe(200);
    expect(commentsOf()).toEqual([]);
    const body = bodyOf();
    expect(body).toContain('Already on GitHub from an earlier commit:');
    expect(body).toContain('`src/a.ts:1`');
    expect(body).toContain('`src/a.ts:2`');
    expect(body).not.toContain('Fix me 0');
    expect(body).toContain('Fix me 2');
    expect(res.json().snapshot.post).toMatchObject({ status: 'posted', alreadyCount: 2, summaryCount: 1, inline: [] });
  });

  it('a POST that errors but landed is adopted, never recorded as failed', async () => {
    const { eq } = await import('drizzle-orm');
    const H5 = '5'.repeat(40);
    await db.update(schema.pullRequests).set({ headSha: H5 }).where(eq(schema.pullRequests.id, prA)).execute();
    analysedSha = H5;
    liveHead = H5;
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    postReview.mockImplementation(async () => {
      throw new Error('HTTP 422: An internal error occurred');
    });
    findLandedReview.mockImplementation(async () => '77');
    const res = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/post`, payload: { headSha: H5 } });
    expect(res.json().snapshot.post).toMatchObject({ status: 'posted', githubReviewId: '77', error: null });
    expect(findLandedReview.mock.calls[0]![3]).toMatchObject({ commitId: H5, body: bodyOf() });
  });

  it('an issue with no line, or a diff that cannot be read, goes to the summary — never a guessed line', async () => {
    const { splitSonarIssues } = await import('./comment.js');
    const { buildAnchorIndex } = await import('../github/diff-anchor.js');
    const issue = (key: string, path: string | null, line: number | null) => ({ key, kind: 'issue', path, line }) as any;
    const index = buildAnchorIndex(liveDiffText);
    const s = splitSonarIssues(
      [issue('A', 'src/a.ts', 1), issue('B', 'src/a.ts', null), issue('C', null, null), issue('D', 'src/a.ts', 9), issue('E', 'src/b.ts', 1), issue('F', 'src/a.ts', 2)],
      index,
      new Set(['F']),
    );
    expect(s.inline.map((i) => i.key)).toEqual(['A']);
    expect(s.summary.map((i) => i.key)).toEqual(['B', 'C', 'D', 'E']);
    expect(s.already.map((i) => i.key)).toEqual(['F']);
    expect(splitSonarIssues([issue('A', 'src/a.ts', 1)], null, new Set()).summary).toHaveLength(1);
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
    analysedSha = H3;
    await app.inject({ method: 'POST', url: `/api/prs/${prA}/sonar/refresh`, payload: {} });
    const ctx = { db, schema, log: { info() {}, warn() {}, error() {} } } as any;
    const settings = await import('../review/claude-review/auto-settings.js');
    const { maybeAutoPostSonar } = await import('./post.js');
    const run = () => maybeAutoPostSonar(ctx, { accountId: 1, prId: prA, headSha: H3 }, postDeps);

    expect(await run()).toEqual({ kind: 'off' });
    await settings.setWorkspaceAutoReview(ctx, 1, wsA, { autoPost: { enabled: true, scope: 'all', kinds: { sonar: false } } as any });
    expect(await run()).toEqual({ kind: 'off' });
    expect(postReview).not.toHaveBeenCalled();
    await settings.setWorkspaceAutoReview(ctx, 1, wsA, { autoPost: { kinds: { sonar: true } } as any });
    const out = await run();
    expect(out.kind).toBe('done');
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(bodyOf()).toContain('Posted automatically');
    expect((out as any).snapshot.post).toMatchObject({ status: 'posted', trigger: 'auto' });
    expect((await run()).kind).toBe('already_posted');
    expect(postReview).toHaveBeenCalledTimes(1);
  });
});
