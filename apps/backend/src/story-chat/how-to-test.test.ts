// HOW TO TEST AFTER A BUILD over the REAL core client (a scratch SQLite, migrations applied), the story chat
// faked. Pinned: a build's stored work asks the story chat's "How to test" question ONCE (the claim is the
// work's hash); new work asks again; no work, AI off or the spend gate say no question; a failed ask releases
// the claim; the chat id reaches the wire and "seen" is stored; the build work read finds the newest build.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STORY_CHAT_PRESETS } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-story-chat-how-to-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let H: typeof import('./how-to-test.js');
let W: typeof import('./build-work.js');
let ws = 0;
let repoId = 0;
const IDENT = 'jira:https://acme.atlassian.net#ACME-9';
const ctx: any = { log: { warn: () => {}, info: () => {}, error: () => {} } };
const asked: Array<{ ident: string; question: string }> = [];
let allowed = true;
let askFails = false;
let nextChat = 100;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'u1', isLocal: true }).onConflictDoNothing().execute();
  ws = await ensureDefaultWorkspace(1);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R1', owner: 'acme', name: 'api' }).returning().execute();
  repoId = r.id;
  H = await import('./how-to-test.js');
  W = await import('./build-work.js');
  H.setHowToTestDepsForTest({
    aiEnabled: async () => true,
    allowed: async () => allowed,
    ask: async (_c, _a, _w, ident, question) => {
      if (askFails) throw new Error('busy');
      asked.push({ ident, question });
      return { chatId: nextChat++ };
    },
  });
});

afterAll(async () => {
  H.setHowToTestDepsForTest(null);
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  asked.length = 0;
  allowed = true;
  askFails = false;
});

async function newBuild(patch: string | null, status = 'ready'): Promise<{ id: number; repoRowId: number }> {
  // ONE open session per ticket (the partial unique index): close the earlier one first.
  if (status !== 'discarded') await db.update(schema.storyBuilds).set({ status: 'discarded' }).execute();
  const [b] = await db
    .insert(schema.storyBuilds)
    .values({ accountId: 1, workspaceId: ws, ident: IDENT, ticketKey: 'ACME-9', ticketTitle: 'Refunds', status, sessionPhase: 'built' })
    .returning()
    .execute();
  const [r] = await db
    .insert(schema.storyBuildRepos)
    .values({ accountId: 1, buildId: b.id, repoId, ref: 'R1', status: 'ready', baseRef: 'main', baseSha: 'b'.repeat(40), patch })
    .returning()
    .execute();
  return { id: b.id, repoRowId: r.id };
}

const rowOf = async (id: number) => (await db.select().from(schema.storyBuilds).where((await import('drizzle-orm')).eq(schema.storyBuilds.id, id)).execute())[0];

describe('how to test after a build', () => {
  it('asks the ready-made question once per version of the work, and new work asks again', async () => {
    const b = await newBuild('diff --git a/x b/x\n+one\n');
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: b.id })).toBe('asked');
    expect(asked).toEqual([{ ident: IDENT, question: STORY_CHAT_PRESETS.find((p) => p.label === 'How to test')!.question }]);
    const row = await rowOf(b.id);
    expect(row.howToTestChatId).toBe(100);
    expect(row.howToTestSeenAt).toBeNull();
    // The same work: nothing asked.
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: b.id })).toBe('same_work');
    expect(asked).toHaveLength(1);
    // Seen, then new work: asked again and pointed at again.
    expect(await H.markHowToTestSeen(1, b.id)).toBe(true);
    await db.update(schema.storyBuildRepos).set({ patch: 'diff --git a/x b/x\n+two\n' }).where((await import('drizzle-orm')).eq(schema.storyBuildRepos.id, b.repoRowId)).execute();
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: b.id })).toBe('asked');
    const again = await rowOf(b.id);
    expect(again.howToTestChatId).toBe(101);
    expect(again.howToTestSeenAt).toBeNull();
  });

  it('no stored work, the spend gate, or AI off: no question', async () => {
    const empty = await newBuild(null, 'discarded');
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: empty.id })).toBe('not_found');
    const b = await newBuild('diff --git a/y b/y\n+y\n');
    allowed = false;
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: b.id })).toBe('over_budget');
    expect((await rowOf(b.id)).howToTestKey).toBeNull();
    expect(asked).toEqual([]);
    // Another account's build is not found.
    expect(await H.maybeAskHowToTest(ctx, { accountId: 2, buildId: b.id })).toBe('not_found');
    expect(await H.markHowToTestSeen(2, b.id)).toBe(false);
  });

  it('a failed ask releases the claim, so the next stored work asks again', async () => {
    const b = await newBuild('diff --git a/z b/z\n+z\n');
    askFails = true;
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: b.id })).toBe('failed');
    expect((await rowOf(b.id)).howToTestKey).toBeNull();
    askFails = false;
    expect(await H.maybeAskHowToTest(ctx, { accountId: 1, buildId: b.id })).toBe('asked');
  });

  it("the chat reads the NEWEST build's work, with where it is", async () => {
    const b = await newBuild('diff --git a/n b/n\n+n\n');
    const work = await W.storyBuildWorkFor(1, ws, IDENT);
    expect(work).toEqual([{ repo: 'acme/api', label: "the build's work", where: 'not pushed', patch: 'diff --git a/n b/n\n+n\n' }]);
    expect(await W.buildWorkOf(1, b.id)).toEqual(work);
    expect(await W.storyBuildWorkFor(2, ws, IDENT)).toEqual([]);
    expect(W.whereOf({ pushedPrNumber: 7, pushedBranch: 'x', loopBranch: null })).toBe('pushed as PR #7');
    expect(W.whereOf({ pushedPrNumber: null, pushedBranch: null, loopBranch: 'ACME-9' })).toBe('pushed to the branch ACME-9, with no pull request yet');
  });
});
