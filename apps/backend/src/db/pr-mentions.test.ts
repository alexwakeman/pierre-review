// The "@you" MENTION arm of My Turn's personal-relevance flag, on a THROWAWAY sqlite DB (the
// my-turn-personal.test.ts pattern).
//
// WHAT THIS PINS, and why each one is a real defect rather than a restatement of the code:
//
//   1. THE MATCH IS A WORD BOUNDARY, NOT A SUBSTRING. The SQL half of the derivation is
//      `lower(body) LIKE '%@login%'`, which happily matches "@alexwakeman" when the login is
//      "alex", and "bob@alex.com" for anyone. Deleting the regex confirmation in
//      `deriveMentionedPrs` leaves a scanner that still finds every true mention and quietly
//      claims a pile of false ones — no error, no failing count, just a personal inbox full of
//      strangers. The table-driven case list is what fails then.
//   2. A MENTION IS PERSONAL IN A REPO THE VIEWER ONLY READS. That is the entire reason this arm
//      exists: the maintainer arm from phase 1 answers "your patch of ground", this one answers
//      "somebody typed your name". Every repo in this fixture is deliberately READ with no merge
//      history, so a maintainer-only implementation scores ZERO here.
//   3. ABSENCE NEVER WIDENS. Before the scanner has ever run, and for a PR with no mention, the
//      flag must read exactly as it did in phase 1. A control PR carries that.
//   4. THE SCAN CONVERGES, in both directions. It re-derives the FULL set and diffs, so an
//      edited-away mention must REMOVE the row — an insert-only writer would make `personal` a
//      ratchet that only ever widens, which no test that seeds and scans once would notice.
//   5. A RENAMED ACCOUNT NARROWS IMMEDIATELY. The read is login-scoped, so a rename stops
//      claiming those PRs before the scanner has re-run; the next tick then re-derives under the
//      new login.
//   6. THE ROW DIES WITH ITS PR. Core schema is mostly cascade-free and the hand-written delete
//      paths are the real cleanup; a surviving row goes on claiming a deleted PR is personal.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-pr-mentions-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let mentions: any;
let scan: any;
let eq: any;

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;

const VIEWER_LOGIN = 'alexwakeman';
// The trap the boundary rule exists for: a real colleague whose login is a PREFIX of the
// viewer's. Every "@alex …" body in this fixture is a mention of THEM, not of the viewer.
const PREFIX_LOGIN = 'alex';

/** The mention-bearing bodies, one per source table, and the near-misses that must NOT count. */
const CASES = [
  { key: 'pr-comment', kind: 'pr_comment', body: 'cc @alexwakeman — mind taking a look?', mentioned: true },
  { key: 'review-body', kind: 'review', body: 'Handing this to @AlexWakeman (case differs)', mentioned: true },
  { key: 'inline', kind: 'review_comment', body: 'nit: @alexwakeman owns this file', mentioned: true },
  { key: 'markdown-link', kind: 'pr_comment', body: 'see [@alexwakeman](https://github.com/alexwakeman)', mentioned: true },
  { key: 'quoted-reply', kind: 'pr_comment', body: '> @alexwakeman said earlier', mentioned: true },
  // ── the near-misses ──────────────────────────────────────────────────────────────────────
  { key: 'prefix-login', kind: 'pr_comment', body: 'cc @alex about the config', mentioned: false },
  { key: 'longer-login', kind: 'pr_comment', body: 'cc @alexwakemanson about the config', mentioned: false },
  { key: 'hyphen-suffix', kind: 'pr_comment', body: 'cc @alexwakeman-bot ran this', mentioned: false },
  { key: 'email', kind: 'pr_comment', body: 'mail bob@alexwakeman.dev instead', mentioned: false },
  { key: 'path', kind: 'review_comment', body: 'moved to docs/@alexwakeman/notes.md', mentioned: false },
  { key: 'no-at', kind: 'pr_comment', body: 'alexwakeman wrote this originally', mentioned: false },
] as const;

const prIdByKey = new Map<string, number>();
/** The control: a "New PR" in the same read-only repo with no comment text at all. */
let controlPrId = 0;
let repoId = 0;
let viewerId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  mentions = await import('./pr-mentions.js');
  scan = await import('../sync/mention-scan.js');
  ({ eq } = await import('drizzle-orm'));

  const { accounts, repos, pullRequests, prComments, reviewComments, reviewThreads, reviews, users } =
    schema;

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null and getMyTurn short-circuit to an all-empty response — every assertion below
  // would then be vacuously true.
  await db
    .update(accounts)
    .set({ githubLogin: VIEWER_LOGIN })
    .where(eq(accounts.id, 1))
    .execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  await insertUser(PREFIX_LOGIN);
  const aliceId = await insertUser('alice-dev');

  // ⚠ READ, no default-branch merge history, permission KNOWN. The maintainer arm from phase 1
  // scores zero on every PR below, so anything that comes out personal did so via the mention.
  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'read-only-svc',
      githubNodeId: 'R_mentions',
      viewerPermission: 'READ',
      defaultBranch: 'main',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  repoId = repo.id;

  let n = 1;
  const insertPr = async (key: string): Promise<number> => {
    const openedAt = new Date(now - MINUTE * (30 - n));
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_mention_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        authorId: aliceId,
        state: 'open',
        isDraft: false,
        openedAt,
        updatedAt: openedAt,
      })
      .returning()
      .execute();
    return pr.id;
  };

  for (const c of CASES) {
    const prId = await insertPr(c.key);
    prIdByKey.set(c.key, prId);
    const at = new Date(now - DAY);
    if (c.kind === 'pr_comment') {
      await db
        .insert(prComments)
        .values({
          prId,
          githubNodeId: `IC_${c.key}`,
          authorId: aliceId,
          body: c.body,
          createdAt: at,
        })
        .execute();
    } else if (c.kind === 'review') {
      await db
        .insert(reviews)
        .values({
          prId,
          githubNodeId: `RV_${c.key}`,
          authorId: aliceId,
          state: 'commented',
          body: c.body,
          submittedAt: at,
        })
        .execute();
    } else {
      const [thread] = await db
        .insert(reviewThreads)
        .values({
          prId,
          githubNodeId: `RT_${c.key}`,
          path: 'src/index.ts',
          isResolved: false,
          derivedState: 'untouched',
          createdAt: at,
        })
        .returning()
        .execute();
      await db
        .insert(reviewComments)
        .values({
          prId,
          threadId: thread.id,
          githubNodeId: `RC_${c.key}`,
          authorId: aliceId,
          body: c.body,
          createdAt: at,
        })
        .execute();
    }
  }
  controlPrId = await insertPr('control');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

/** The `personal` flag of every "New PRs" row, keyed by PR id. */
async function personalByPr(): Promise<Map<number, boolean>> {
  const res = await q.getMyTurn(1);
  return new Map<number, boolean>(
    res.watchedRepoPrs.map((p: { prId: number; personal?: boolean }) => [p.prId, p.personal]),
  );
}

describe('@mention detection', () => {
  it('matches a whole-word @login and nothing else', () => {
    // The PURE rule, independent of any SQL. The two directions the brief names explicitly:
    // "@alex" must not match "@alexwakeman", and "@alexwakeman" must not match "@alex".
    expect(mentions.mentionsLogin('cc @alexwakeman', 'alexwakeman')).toBe(true);
    expect(mentions.mentionsLogin('cc @alexwakeman', 'alex')).toBe(false);
    expect(mentions.mentionsLogin('cc @alex', 'alexwakeman')).toBe(false);
    expect(mentions.mentionsLogin('cc @ALEXWAKEMAN', 'alexwakeman')).toBe(true);
    expect(mentions.mentionsLogin('bob@alexwakeman.dev', 'alexwakeman')).toBe(false);
    expect(mentions.mentionsLogin('docs/@alexwakeman/x.md', 'alexwakeman')).toBe(false);
    // A login is data, not a pattern: a regex metacharacter in it must be matched literally
    // rather than compiling into a wildcard that matches everything.
    expect(mentions.mentionsLogin('cc @a.b', 'a.b')).toBe(true);
    expect(mentions.mentionsLogin('cc @axb', 'a.b')).toBe(false);
    // An empty login (a local account before `gh api user` has answered) matches nothing.
    expect(mentions.mentionsLogin('cc @alexwakeman', '')).toBe(false);
  });
});

describe('the mention scanner', () => {
  it('derives exactly the mentioning PRs across all three body tables', async () => {
    await scan.runMentionScanTick(log);
    const rows = await mentions.listStoredMentions(1);
    const stored = new Set<number>(rows.map((r: { prId: number }) => r.prId));
    for (const c of CASES) {
      const prId = prIdByKey.get(c.key)!;
      expect(stored.has(prId), `${c.key}: ${c.body}`).toBe(c.mentioned);
    }
    // ⚠ Vacuity guard. If the fixture stopped producing rows at all, every `false` above would
    // still pass and the `true` cases would be the only thing holding the file up.
    expect(stored.size).toBe(CASES.filter((c) => c.mentioned).length);
    expect(stored.has(controlPrId)).toBe(false);
    // The login is stored canonicalised, so a reader's equality test does not depend on how
    // GitHub spelled it that day.
    for (const r of rows) expect(r.login).toBe(VIEWER_LOGIN.toLowerCase());
  });

  it('makes a mentioned PR personal in a repo the viewer only READS', async () => {
    const personal = await personalByPr();
    for (const c of CASES) {
      const prId = prIdByKey.get(c.key)!;
      // ⚠ THE WHOLE POINT. Every repo here is READ with no merge history, so phase 1's
      // maintainer arm answers false for all of these — a true can only have come from a mention.
      expect(personal.get(prId), `${c.key} (${c.body})`).toBe(c.mentioned);
    }
    // ABSENCE NEVER WIDENS: a PR nobody mentioned the viewer on reads exactly as it did before
    // this feature existed.
    expect(personal.get(controlPrId)).toBe(false);
  });

  it('keeps returning every row — the flag is still advisory, not a filter', async () => {
    const res = await q.getMyTurn(1);
    expect(res.watchedRepoPrs.length).toBe(CASES.length + 1);
  });

  it('REMOVES a mention that was edited away', async () => {
    const { prComments } = schema;
    const prId = prIdByKey.get('pr-comment')!;
    await db
      .update(prComments)
      .set({ body: 'cc the platform team instead' })
      .where(eq(prComments.prId, prId))
      .execute();

    await scan.runMentionScanTick(log);
    const stored = new Set<number>(
      (await mentions.listStoredMentions(1)).map((r: { prId: number }) => r.prId),
    );
    // ⚠ An insert-only writer passes every other case in this file and fails only here: the
    // stored set has to CONVERGE on the derived one, not accumulate it.
    expect(stored.has(prId)).toBe(false);
    expect((await personalByPr()).get(prId)).toBe(false);
    // Restore, so the ordering of the cases below does not depend on this one.
    await db
      .update(prComments)
      .set({ body: 'cc @alexwakeman — mind taking a look?' })
      .where(eq(prComments.prId, prId))
      .execute();
    await scan.runMentionScanTick(log);
    expect((await personalByPr()).get(prId)).toBe(true);
  });

  it('narrows IMMEDIATELY when the account login changes, then re-derives', async () => {
    const { accounts } = schema;
    const prId = prIdByKey.get('inline')!;
    expect((await personalByPr()).get(prId)).toBe(true);

    await db
      .update(accounts)
      .set({ githubLogin: PREFIX_LOGIN })
      .where(eq(accounts.id, 1))
      .execute();
    // ⚠ BEFORE the scanner runs. The read is login-scoped precisely so a rename cannot leave a
    // stale row claiming a stranger's PR is personal for as long as a tick.
    const beforeScan = await personalByPr();
    expect(beforeScan.get(prId)).toBe(false);
    // …and the PR that mentions the NEW login is not personal yet either — nothing widens on a
    // rename until the scan has actually looked.
    expect(beforeScan.get(prIdByKey.get('prefix-login')!)).toBe(false);

    await scan.runMentionScanTick(log);
    const afterScan = await personalByPr();
    expect(afterScan.get(prIdByKey.get('prefix-login')!)).toBe(true);
    expect(afterScan.get(prId)).toBe(false);
    // The rows derived under the old login are GONE, not merely ignored.
    const logins = new Set<string>(
      (await mentions.listStoredMentions(1)).map((r: { login: string }) => r.login),
    );
    expect([...logins]).toEqual([PREFIX_LOGIN]);

    await db
      .update(accounts)
      .set({ githubLogin: VIEWER_LOGIN })
      .where(eq(accounts.id, 1))
      .execute();
    await scan.runMentionScanTick(log);
  });

  it('leaves no row behind when the repo is deleted', async () => {
    const { prMentions } = schema;
    expect((await mentions.listStoredMentions(1)).length).toBeGreaterThan(0);
    expect(await q.deleteRepo(repoId, 1)).toBe(true);
    const left = await db
      .select({ id: prMentions.id })
      .from(prMentions)
      .where(eq(prMentions.accountId, 1))
      .execute();
    expect(left.length).toBe(0);
  });
});
