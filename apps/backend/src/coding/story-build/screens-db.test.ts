// THE BUILD REPORT'S SCREENS over the REAL core client (a scratch SQLite): only PNGs the report names under the
// agent's browser folder are copied out, within the caps; a newer report replaces the last; a screenshot is read
// only by its own account; the wire carries the screens and never a byte or a path outside the folder.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-screens`}.storybuild-screens.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let S: typeof import('./screens.js');
let buildId = 0;
const ws: Record<number, number> = {};

const png = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([n, n, n])]);
const DIR = '/home/agent/.limn/browser/';
const files: Record<string, Buffer> = {
  [`${DIR}a-1280.png`]: png(1),
  [`${DIR}a-375.png`]: png(2),
  [`${DIR}same-as-a.png`]: png(1),
  [`${DIR}not-a-png.png`]: Buffer.from('<svg onload=alert(1)>'),
  '/etc/passwd.png': png(3),
};
const reads: string[] = [];
const read = async (p: string): Promise<Buffer | null> => (reads.push(p), files[p] ?? null);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../db/queries.js');
  for (const acct of [1, 2]) {
    await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
    ws[acct] = await ensureDefaultWorkspace(acct);
  }
  ctx = { db, schema, runTransaction: client.runTransaction };
  const P = await import('./persist.js');
  const r = await P.insertStoryBuild(ctx, { accountId: 1, workspaceId: ws[1]!, ident: 'jira:https://acme.atlassian.net#ACME-1', ticketKey: 'ACME-1', ticketTitle: 'Refunds', wantDiagram: false, wantDocs: false, provider: 'claude', model: 'claude-opus-5-5' });
  buildId = r.id;
  S = await import('./screens.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('storeBuildScreens', () => {
  it('copies only PNGs the report names under the browser folder; a path outside it is never read', async () => {
    const r = await S.storeBuildScreens(ctx, {
      accountId: 1,
      buildId,
      read,
      screens: [
        { name: 'Refunds panel', url: 'http://localhost:6006/?path=/story/refunds', shots: [`${DIR}a-1280.png`, `${DIR}a-375.png`, `${DIR}same-as-a.png`], comparedWith: 'the mock-up a-0123456789', verdict: 'matches', note: 'Spacing follows the mock-up.' },
        { name: 'Empty state', shots: [`${DIR}not-a-png.png`, '/etc/passwd.png', `${DIR}missing.png`], verdict: 'no_design', note: 'Built to fit the orders page.' },
      ],
    });
    expect(reads).not.toContain('/etc/passwd.png');
    expect(r.skipped).toBe(3);
    expect(r.screens[0]!.shots.map((s) => s.name)).toEqual(['a-1280.png', 'a-375.png']);
    expect(r.screens[1]!.shots).toEqual([]);
    const rows = await db.select({ sha: schema.storyBuildShots.sha256 }).from(schema.storyBuildShots).execute();
    expect(rows).toHaveLength(2);
    const sha = r.screens[0]!.shots[0]!.sha;
    expect(await S.readBuildShot(ctx, 1, buildId, sha)).toEqual(png(1));
    // Another account, a bad sha: nothing.
    expect(await S.readBuildShot(ctx, 2, buildId, sha)).toBeNull();
    expect(await S.readBuildShot(ctx, 1, buildId, '../x')).toBeNull();
  });

  it('the wire carries the screens (names and shas, never bytes)', async () => {
    const P = await import('./persist.js');
    const row = await P.getStoryBuildRow(ctx, 1, buildId);
    const wire = P.toStoryBuild(row!, [], { repoNames: new Map(), sessionBudgetUsd: 10 });
    expect(wire.screens?.map((s) => [s.name, s.verdict, s.shots.length])).toEqual([
      ['Refunds panel', 'matches', 2],
      ['Empty state', 'no_design', 0],
    ]);
    expect(JSON.stringify(wire)).not.toContain('"png"');
  });

  it('a newer report replaces the last: screenshots it no longer names go', async () => {
    const r = await S.storeBuildScreens(ctx, { accountId: 1, buildId, read, screens: [{ name: 'Refunds panel', shots: [`${DIR}a-375.png`], verdict: 'differs', note: 'The total row wraps on mobile.' }] });
    const rows = await db.select({ sha: schema.storyBuildShots.sha256 }).from(schema.storyBuildShots).execute();
    expect(rows.map((x: { sha: string }) => x.sha)).toEqual([r.screens[0]!.shots[0]!.sha]);
  });

  it('a live shot: the same checks; a later report keeps the live shots it is told to keep', async () => {
    files[`${DIR}live.png`] = png(77);
    expect(await S.storeLiveShot(ctx, { accountId: 1, buildId, path: '/etc/passwd.png', read })).toBeNull();
    expect(await S.storeLiveShot(ctx, { accountId: 1, buildId, path: `${DIR}not-a-png.png`, read })).toBeNull();
    const live = await S.storeLiveShot(ctx, { accountId: 1, buildId, path: `${DIR}live.png`, read });
    expect(live).toMatchObject({ name: 'live.png' });
    await S.storeBuildScreens(ctx, { accountId: 1, buildId, read, keep: [live!.sha], screens: [{ name: 'Refunds panel', shots: [`${DIR}a-375.png`], verdict: 'differs', note: 'Still wraps.' }] });
    expect(await S.readBuildShot(ctx, 1, buildId, live!.sha)).toEqual(png(77));
    // Without `keep`, a report drops it.
    await S.storeBuildScreens(ctx, { accountId: 1, buildId, read, screens: [{ name: 'Refunds panel', shots: [`${DIR}a-375.png`], verdict: 'differs', note: 'Still wraps.' }] });
    expect(await S.readBuildShot(ctx, 1, buildId, live!.sha)).toBeNull();
  });

  it('caps the number of screenshots', async () => {
    const many = Array.from({ length: S.SHOTS_MAX + 5 }, (_, i) => `${DIR}m${i}.png`);
    for (const [i, p] of many.entries()) files[p] = png(10 + i);
    const screens = Array.from({ length: Math.ceil(many.length / 4) }, (_, i) => ({ name: `s${i}`, shots: many.slice(i * 4, i * 4 + 4), verdict: 'matches' as const, note: 'ok' }));
    const r = await S.storeBuildScreens(ctx, { accountId: 1, buildId, read, screens });
    expect(r.screens.flatMap((s) => s.shots)).toHaveLength(S.SHOTS_MAX);
    expect(r.skipped).toBe(5);
  });

  it('the ticket comment: the agent’s words made plain, its verdict said as its own, the pictures inline', () => {
    const screens = [
      { name: 'Refunds [~admin]', url: null, comparedWith: 'the mock-up {color:red}x{color}', verdict: 'differs' as const, note: 'The total wraps.\n!evil.png!', shots: [{ sha: 'a'.repeat(64), name: 'x.png', bytes: 1 }] },
      { name: 'Empty', url: null, comparedWith: null, verdict: 'no_design' as const, note: '', shots: [] },
    ];
    const picked = S.ticketShotsOf(7, screens, 10);
    expect(picked).toEqual([{ sha: 'a'.repeat(64), name: 'ensemble-7-1.png', screen: 0 }]);
    const text = S.screensTicketComment({ ticketKey: 'ACME-1', screens, shots: picked, names: ['ensemble-7-1.png'] });
    expect(text).toContain("h4. Screenshots from Ensemble's build of ACME-1");
    expect(text).toContain('*Refunds admin*: the agent says it differs, compared with the mock-up color:red x color.');
    expect(text).toContain('The total wraps. evil.png');
    expect(text).toContain('!ensemble-7-1.png|thumbnail!');
    expect(text).not.toContain('Empty');
    expect(text.match(/!/g)).toHaveLength(2);
  });

  it('the press: claimed once; a failure before any write releases the claim; after a write it is never retried', async () => {
    // A Jira ticket on this build.
    await db.update(schema.storyBuilds).set({ ident: 'jira:https://acme.atlassian.net#ACME-1', screensTicketJson: null }).execute();
    let posts = 0;
    const refuse = { post: async () => (posts++, { ok: false as const, status: 502, error: 'JiraError', message: 'Jira could not be reached.', wrote: false }), now: () => 0 };
    const r1 = await S.postBuildScreensToTicket(ctx, 1, buildId, refuse);
    expect(r1).toMatchObject({ status: 502 });
    const [after1] = await db.select({ t: schema.storyBuilds.screensTicketJson }).from(schema.storyBuilds).execute();
    expect(after1.t).toBeNull();
    const partly = { post: async () => (posts++, { ok: false as const, status: 502, error: 'JiraError', message: 'Jira stopped.', wrote: true }), now: () => 0 };
    const r2 = await S.postBuildScreensToTicket(ctx, 1, buildId, partly);
    expect(r2).toMatchObject({ status: 502, message: expect.stringContaining('will not try again') });
    expect(await S.postBuildScreensToTicket(ctx, 1, buildId, partly)).toMatchObject({ status: 409, error: 'AlreadyPosted' });
    expect(posts).toBe(2);
    // Another account's build: 404, nothing claimed.
    expect(await S.postBuildScreensToTicket(ctx, 2, buildId, partly)).toMatchObject({ status: 404 });
  });

  it('a good post records it, and the wire says so', async () => {
    await db.update(schema.storyBuilds).set({ screensTicketJson: null }).execute();
    const seen: string[] = [];
    const ok = { post: async (a: any) => (seen.push(a.comment(a.shots.map((s: any) => s.name))), { ok: true as const, attachments: a.shots.length }), now: () => 1_700_000_000_000 };
    const r = await S.postBuildScreensToTicket(ctx, 1, buildId, ok);
    expect(r).toMatchObject({ status: 200, screensTicket: { offered: true, attachments: 10, error: null, posting: false } });
    // The build holds 24 screenshots by now (the cap test): a post carries at most TICKET_SHOTS_MAX (10).
    expect(seen[0]).toContain('|thumbnail!');
  });

  it('the account erasure takes the screenshots', async () => {
    const { eraseAccountData } = await import('../../db/erase-account.js');
    await eraseAccountData(1);
    expect(await db.select().from(schema.storyBuildShots).execute()).toEqual([]);
  });
});
