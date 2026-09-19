// My Turn's @MENTION type and the scanner behind it, on a THROWAWAY sqlite DB (the
// my-turn-personal.test.ts pattern).
//
// WHAT THIS PINS, and why each one is a real defect rather than a restatement of the code:
//
//   1. THE MATCH IS A WORD BOUNDARY, NOT A SUBSTRING. The SQL half of the derivation is
//      `lower(body) LIKE '%@login%'`, which happily matches "@alexwakeman" when the login is
//      "alex", and "bob@alex.com" for anyone. Deleting the regex confirmation in
//      `deriveMentionedPrs` leaves a scanner that still finds every true mention and quietly
//      claims a pile of false ones — no error, no failing count, just an inbox full of strangers.
//      The table-driven case list is what fails then.
//   2. A MENTION IS A SUMMONS IN A REPO THE VIEWER ONLY READS. That is the entire reason the type
//      exists: "somebody typed your name", not "your patch of ground". Every repo in this fixture
//      is deliberately READ with no merge history.
//   3. THE CARD RUNS ON THE MENTION'S CLOCK. Each row carries the NEWEST qualifying mention's time
//      and author; the card clears when you act after it, and a NEWER mention must restamp the row
//      or you would act once and never be summoned again.
//   4. ONLY A PERSON CAN SUMMON YOU. A bot — including one only GitHub's own type says is a bot —
//      and the viewer themself derive nothing, and a bot echo never becomes a PR's newest mention.
//   5. THE SCAN CONVERGES, in both directions. It re-derives the FULL set and diffs, so an
//      edited-away mention must REMOVE the row — an insert-only writer would make the card a
//      ratchet that only ever widens.
//   6. A RENAMED ACCOUNT NARROWS IMMEDIATELY. The read is login-scoped, so a rename stops the cards
//      before the scanner has re-run; the next tick then re-derives under the new login.
//   7. THE ROW DIES WITH ITS PR. Core schema is mostly cascade-free and the hand-written delete
//      paths are the real cleanup.
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
const HOUR = 60 * MINUTE;
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
  // ── the near-misses ──────────────────────────────────────────────────────────────────────
  // A quote-reply repeats somebody else's words; the quoter did not summon you.
  { key: 'quoted-reply', kind: 'pr_comment', body: '> @alexwakeman said earlier', mentioned: false },
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
let aliceId = 0;
let prefixId = 0;
let botId = 0;
let typedBotId = 0;
let nextNumber = 1;

/** A fresh open PR by alice in the fixture's read-only repo. */
async function insertPr(key: string): Promise<number> {
  const openedAt = new Date(now - MINUTE * (60 - nextNumber));
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_mention_${key}`,
      accountId: 1,
      repoId,
      number: nextNumber++,
      title: `${key} fixture`,
      authorId: aliceId,
      state: 'open',
      isDraft: false,
      openedAt,
      updatedAt: openedAt,
    })
    .returning()
    .execute();
  prIdByKey.set(key, pr.id);
  return pr.id;
}

/** One issue-level PR comment. */
async function insertComment(prId: number, tag: string, authorId: number, body: string, at: number) {
  await db
    .insert(schema.prComments)
    .values({ prId, githubNodeId: `IC_${tag}`, authorId, body, createdAt: new Date(at) })
    .execute();
}

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

  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  prefixId = await insertUser(PREFIX_LOGIN);
  aliceId = await insertUser('alice-dev');
  // Two kinds of automation: one `users.isBot` knows, and one only GitHub's own TYPE says is a bot
  // (google-cla, socket-security… — `is_bot = 0`, `github_type = 'Bot'`). Neither may summon.
  botId = await insertUser('dependabot[bot]', true);
  const [typed] = await db
    .insert(users)
    .values({ githubLogin: 'google-cla', githubNodeId: 'U_google-cla', isBot: false, githubType: 'Bot' })
    .returning()
    .execute();
  typedBotId = typed.id;

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

  for (const c of CASES) {
    const prId = await insertPr(c.key);
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

/** The My Turn mention section, keyed by PR id. */
async function mentionByPr(): Promise<Map<number, any>> {
  const res = await q.getMyTurn(1);
  return new Map<number, any>(res.mentions.map((m: { prId: number }) => [m.prId, m]));
}

async function storedFor(prId: number) {
  return (await mentions.listStoredMentions(1)).find((r: { prId: number }) => r.prId === prId);
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
  it('derives exactly the mentioning PRs across all three body tables, with WHEN and WHO', async () => {
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
    for (const r of rows) {
      // The login is stored canonicalised, so a reader's equality test does not depend on how
      // GitHub spelled it that day.
      expect(r.login).toBe(VIEWER_LOGIN.toLowerCase());
      // THE MENTION CLOCK: when, and by whom. The card clears on an action AFTER this moment.
      expect(r.mentionedAt?.getTime()).toBe(now - DAY);
      expect(r.mentionedByUserId).toBe(aliceId);
    }
  });

  it('turns a mention into a DIRECT My Turn card in a repo the viewer only READS', async () => {
    const byPr = await mentionByPr();
    for (const c of CASES) {
      const prId = prIdByKey.get(c.key)!;
      // ⚠ THE WHOLE POINT. Every repo here is READ with no merge history, so nothing but the
      // mention can have put these here.
      expect(byPr.has(prId), `${c.key} (${c.body})`).toBe(c.mentioned);
    }
    expect(byPr.has(controlPrId)).toBe(false);
    for (const m of byPr.values()) {
      expect(m.relevance).toBe('direct');
      expect(m.personal).toBe(true);
      expect(m.mentionedById).toBe(aliceId);
      // Dated by the MENTION, not by the PR's open time.
      expect(Date.parse(m.since)).toBe(now - DAY);
    }
  });

  it('lists a PR once — a mentioned PR is a mention card, never also a "New PR"', async () => {
    const { setMyTurnSettings } = await import('../auth/account.js');
    await setMyTurnSettings(1, { show: { watched_repo_pr: true } });
    try {
      const res = await q.getMyTurn(1);
      const mentioned = new Set(res.mentions.map((m: { prId: number }) => m.prId));
      const fresh = new Set(res.watchedRepoPrs.map((m: { prId: number }) => m.prId));
      for (const id of mentioned) expect(fresh.has(id)).toBe(false);
      // …and nothing is lost: every fixture PR is in exactly one of the two.
      expect(mentioned.size + fresh.size).toBe(CASES.length + 1);
      // A New PR in a read-only repo is not about you: the mention arm that used to promote it
      // to 'direct' is gone, because a mention is its own type now.
      for (const r of res.watchedRepoPrs) expect(r.relevance).toBe('none');
    } finally {
      await setMyTurnSettings(1, null);
    }
  });

  it('clears the card when you act after the mention — and keeps the stored row', async () => {
    const prId = prIdByKey.get('pr-comment')!;
    expect((await mentionByPr()).has(prId)).toBe(true);
    await insertComment(prId, 'viewer-answer', viewerId, 'on it', now - DAY + HOUR);
    // ⚠ THE BALL RULE, not the scanner: the row still states a true fact (you were mentioned),
    // and the card is gone because you acted after it.
    expect((await mentionByPr()).has(prId)).toBe(false);
    expect(await storedFor(prId)).toBeDefined();
  });

  it('RESTAMPS the row when a newer mention arrives, which brings the card back', async () => {
    const prId = prIdByKey.get('pr-comment')!;
    const at = now - HOUR;
    await insertComment(prId, 'prefix-asks', prefixId, 'thanks — @alexwakeman one more thing?', at);
    const res = await mentions.syncAccountMentions(
      1,
      VIEWER_LOGIN,
      await mentions.deriveMentionedPrs(1, VIEWER_LOGIN),
    );
    // An UPDATE of the kept row — not a delete and re-insert, and not "unchanged".
    expect(res.updated).toBe(1);
    expect(res.added).toBe(0);
    expect(res.removed).toBe(0);
    const row = await storedFor(prId);
    expect(row?.mentionedAt?.getTime()).toBe(at);
    expect(row?.mentionedByUserId).toBe(prefixId);
    // You acted at now − 1d + 1h; the new mention is later, so the ball is yours again.
    const card = (await mentionByPr()).get(prId);
    expect(card?.mentionedById).toBe(prefixId);
    expect(Date.parse(card?.since)).toBe(at);
    // A second pass over unchanged data writes nothing.
    const again = await mentions.syncAccountMentions(
      1,
      VIEWER_LOGIN,
      await mentions.deriveMentionedPrs(1, VIEWER_LOGIN),
    );
    expect(again).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it('lets only a PERSON summon you — never automation of either kind, never yourself', async () => {
    const onlyBot = await insertPr('only-bot');
    await insertComment(onlyBot, 'bot-cc', botId, 'Dependabot will rebase this for @alexwakeman', now - HOUR);
    const onlyTypedBot = await insertPr('only-typed-bot');
    await insertComment(onlyTypedBot, 'cla-cc', typedBotId, '@alexwakeman please sign the CLA', now - HOUR);
    const onlySelf = await insertPr('only-self');
    await insertComment(onlySelf, 'self-cc', viewerId, 'note to @alexwakeman: revisit', now - HOUR);
    // A PERSON'S mention followed by a bot echo: the person's stays the newest mention.
    const echoed = await insertPr('echoed');
    await insertComment(echoed, 'echo-person', aliceId, '@alexwakeman can you look?', now - 3 * HOUR);
    await insertComment(echoed, 'echo-bot', typedBotId, 'cc @alexwakeman (automated)', now - HOUR);

    const derived = await mentions.deriveMentionedPrs(1, VIEWER_LOGIN);
    const byPr = new Map(derived.map((d: { prId: number }) => [d.prId, d]));
    expect(byPr.has(onlyBot)).toBe(false);
    // ⚠ The GLOBAL automation set, not `users.isBot` alone: this account is `is_bot = 0`.
    expect(byPr.has(onlyTypedBot)).toBe(false);
    expect(byPr.has(onlySelf)).toBe(false);
    expect((byPr.get(echoed) as any)?.mentionedById).toBe(aliceId);
    expect((byPr.get(echoed) as any)?.mentionedAt.getTime()).toBe(now - 3 * HOUR);
  });

  it('never lets a QUOTED mention restamp the clock or bring the card back', async () => {
    const quoted = await insertPr('quote-reply-after');
    await insertComment(quoted, 'q-alice', aliceId, '@alexwakeman can you look?', now - 3 * HOUR);
    await insertComment(quoted, 'q-viewer', viewerId, 'looking now', now - 2 * HOUR);
    // After you acted, a person quote-replies the old mention. They did not summon you.
    await insertComment(quoted, 'q-quote', prefixId, '> @alexwakeman can you look?\n\nsame question here', now - HOUR);
    const sync = async () =>
      mentions.syncAccountMentions(1, VIEWER_LOGIN, await mentions.deriveMentionedPrs(1, VIEWER_LOGIN));
    await sync();
    const row = await storedFor(quoted);
    expect(row?.mentionedAt?.getTime()).toBe(now - 3 * HOUR);
    expect(row?.mentionedByUserId).toBe(aliceId);
    expect((await mentionByPr()).has(quoted)).toBe(false);
    // Productive: the same words TYPED by that person are a new mention, and bring the card back.
    await insertComment(quoted, 'q-typed', prefixId, 'still: @alexwakeman can you look?', now - HOUR + MINUTE);
    await sync();
    expect((await storedFor(quoted))?.mentionedByUserId).toBe(prefixId);
    expect((await mentionByPr()).get(quoted)?.mentionedById).toBe(prefixId);
  });

  it('shows NO card for a row the scanner has not stamped yet', async () => {
    const { prMentions } = schema;
    await scan.runMentionScanTick(log);
    const prId = prIdByKey.get('inline')!;
    expect((await mentionByPr()).has(prId)).toBe(true);
    // The state migration 0068 leaves every existing row in until the first tick restamps it.
    await db
      .update(prMentions)
      .set({ mentionedAt: null, mentionedByUserId: null })
      .where(eq(prMentions.prId, prId))
      .execute();
    expect((await mentionByPr()).has(prId)).toBe(false);
    await scan.runMentionScanTick(log);
    expect((await mentionByPr()).has(prId)).toBe(true);
  });

  it('REMOVES a mention that was edited away', async () => {
    const { prComments } = schema;
    const prId = prIdByKey.get('markdown-link')!;
    await db
      .update(prComments)
      .set({ body: 'cc the platform team instead' })
      .where(eq(prComments.prId, prId))
      .execute();

    await scan.runMentionScanTick(log);
    // ⚠ An insert-only writer passes every other case in this file and fails only here: the
    // stored set has to CONVERGE on the derived one, not accumulate it.
    expect(await storedFor(prId)).toBeUndefined();
    expect((await mentionByPr()).has(prId)).toBe(false);
    // Restore, so the ordering of the cases below does not depend on this one.
    await db
      .update(prComments)
      .set({ body: 'see [@alexwakeman](https://github.com/alexwakeman)' })
      .where(eq(prComments.prId, prId))
      .execute();
    await scan.runMentionScanTick(log);
    expect((await mentionByPr()).has(prId)).toBe(true);
  });

  it('narrows IMMEDIATELY when the account login changes, then re-derives', async () => {
    const { accounts } = schema;
    const prId = prIdByKey.get('inline')!;
    expect((await mentionByPr()).has(prId)).toBe(true);

    await db
      .update(accounts)
      .set({ githubLogin: PREFIX_LOGIN })
      .where(eq(accounts.id, 1))
      .execute();
    // ⚠ BEFORE the scanner runs. The read is login-scoped precisely so a rename cannot leave a
    // stale row summoning the new login for as long as a tick.
    const beforeScan = await mentionByPr();
    expect(beforeScan.has(prId)).toBe(false);
    // …and the PR that mentions the NEW login is not a card yet either — nothing widens on a
    // rename until the scan has actually looked.
    expect(beforeScan.has(prIdByKey.get('prefix-login')!)).toBe(false);

    await scan.runMentionScanTick(log);
    const afterScan = await mentionByPr();
    expect(afterScan.has(prIdByKey.get('prefix-login')!)).toBe(true);
    expect(afterScan.has(prId)).toBe(false);
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
