// My Turn's "New PRs" section and its CLOCK, on a THROWAWAY sqlite DB (the
// bot-analytics-verdict.test.ts pattern).
//
// WHAT THIS PINS. The section exists to surface open PRs raised by other people in a repo you
// track. Without a cutoff it is useless on day one: add a repo with 400 open PRs and all 400
// land in My Turn at once. The cutoff used to be `repos.inbox_watch_started_at`, stamped when
// you flipped a per-repo "watch" toggle. That toggle — and the whole second visibility axis it
// sat on — was removed (migration 0046 / pg 0033); a Workspace IS the scope now. The clock moved
// to `repos.createdAt`, i.e. WHEN THE REPO WAS ADDED, which is the same moment for a repo added
// under the old model with watch on by default.
//
// So the behaviour under test is exactly: an open, non-draft PR by a non-bot human other than
// you qualifies iff `openedAt >= repos.createdAt` FOR ITS OWN REPO.
//
// The per-repo half is the part a lax test would miss. A single global cutoff (say, the earliest
// or latest repo) passes a one-repo fixture and is wrong the moment a second repo is added later,
// so repo B is added days after repo A and carries a PR that clears A's cutoff but not its own.
//
// The other three exclusions (you authored it / a bot authored it / it is a draft) are seeded as
// controls: they share the same loop as the cutoff, and without them a fixture where the cutoff
// silently stopped filtering could still look plausible.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-my-turn-new-prs-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let getMyTurn: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write and could turn an intended "exactly at the cutoff" into "just before it".
const now = Math.floor(Date.now() / 1000) * 1000;

// Repo A was added 10 days ago, repo B only 2 days ago.
const ADDED_A = now - 10 * DAY;
const ADDED_B = now - 2 * DAY;

const VIEWER_LOGIN = 'viewer-me';

let repoA = 0;
let repoB = 0;
let viewerId = 0;
let aliceId = 0;
let botId = 0;
const prIdByKey = new Map<string, number>();

// Every seeded PR, with the answer we expect for it. `qualifies` is membership of the "New PRs"
// section — for this fixture that is exactly `getAddedRepoActionablePrIds`, since nothing here
// is review-requested, approved or dismissed, so no other section can claim a row first.
const CASES: {
  key: string;
  repo: () => number;
  author: () => number;
  openedAt: number;
  isDraft?: boolean;
  qualifies: boolean;
  why: string;
}[] = [
  {
    key: 'a-before',
    repo: () => repoA,
    author: () => aliceId,
    openedAt: ADDED_A - DAY,
    qualifies: false,
    why: 'opened before repo A was added — the backlog we refuse to dump',
  },
  {
    key: 'a-exactly-at',
    repo: () => repoA,
    author: () => aliceId,
    openedAt: ADDED_A,
    qualifies: true,
    why: 'opened exactly at the cutoff — the comparison is >=, not >',
  },
  {
    key: 'a-after',
    repo: () => repoA,
    author: () => aliceId,
    openedAt: ADDED_A + DAY,
    qualifies: true,
    why: 'opened after repo A was added',
  },
  {
    key: 'b-between',
    repo: () => repoB,
    author: () => aliceId,
    // Clears repo A's cutoff by eight days; misses repo B's by one. A global cutoff passes it.
    openedAt: ADDED_A + DAY,
    qualifies: false,
    why: "in repo B, and B's own cutoff is what applies — not A's",
  },
  {
    key: 'b-after',
    repo: () => repoB,
    author: () => aliceId,
    openedAt: ADDED_B + HOUR,
    qualifies: true,
    why: 'opened after repo B was added',
  },
  {
    key: 'a-mine',
    repo: () => repoA,
    author: () => viewerId,
    openedAt: ADDED_A + DAY,
    qualifies: false,
    why: 'you authored it — your own PR is not a thing to go and look at',
  },
  {
    key: 'a-bot',
    repo: () => repoA,
    author: () => botId,
    openedAt: ADDED_A + DAY,
    qualifies: false,
    why: 'a bot authored it',
  },
  {
    key: 'a-draft',
    repo: () => repoA,
    author: () => aliceId,
    openedAt: ADDED_A + DAY,
    isDraft: true,
    qualifies: false,
    why: 'still a draft',
  },
];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ({ getMyTurn } = await import('./queries.js'));

  const { accounts, repos, pullRequests, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null and getMyTurn short-circuit to an all-empty response. Give it a login and a
  // matching `users` row so "me" resolves — otherwise every assertion below is vacuous.
  await db
    .update(accounts)
    .set({ githubLogin: VIEWER_LOGIN })
    .where(eq(accounts.id, 1))
    .execute();

  const insertUser = async (login: string, isBot: boolean): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN, false);
  aliceId = await insertUser('alice-dev', false);
  botId = await insertUser('coderabbitai', true);

  const insertRepo = async (name: string, addedAt: number): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name,
        githubNodeId: `R_myturn_${name}`,
        // The clock. Explicit rather than defaulted — the default is "now", which would make
        // every seeded PR fall before the cutoff and the whole fixture assert nothing.
        createdAt: new Date(addedAt),
      })
      .returning()
      .execute();
    return r.id;
  };
  repoA = await insertRepo('api', ADDED_A);
  repoB = await insertRepo('web', ADDED_B);

  let n = 1;
  for (const c of CASES) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_myturn_${c.key}`,
        accountId: 1,
        repoId: c.repo(),
        number: n++,
        title: `${c.key} fixture`,
        state: 'open',
        isDraft: c.isDraft ?? false,
        authorId: c.author(),
        openedAt: new Date(c.openedAt),
        updatedAt: new Date(c.openedAt),
      })
      .returning()
      .execute();
    prIdByKey.set(c.key, pr.id);
  }
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('My Turn "New PRs" keys on repos.createdAt', () => {
  it('admits a PR only when it was opened at or after ITS OWN repo was added', async () => {
    const res = await getMyTurn(1);
    // The wire field keeps its historical name; the concept behind it is "new PRs in your repos".
    const got = new Set<number>(res.watchedRepoPrs.map((p: { prId: number }) => p.prId));

    for (const c of CASES) {
      const id = prIdByKey.get(c.key)!;
      expect(got.has(id), `${c.key} (${c.why})`).toBe(c.qualifies);
    }

    // Exact set, not just per-case membership: an extra row from somewhere else would otherwise
    // slip through every individual assertion above.
    expect(got.size).toBe(CASES.filter((c) => c.qualifies).length);
  });

  it('sorts newest-opened first', async () => {
    const res = await getMyTurn(1);
    const openedAts = res.watchedRepoPrs.map((p: { openedAt: string }) => p.openedAt);
    expect(openedAts).toEqual([...openedAts].sort().reverse());
  });
});
