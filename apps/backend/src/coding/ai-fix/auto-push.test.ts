// PUSH AUTOMATICALLY (coding/ai-fix/auto-push.ts) and the style-bot role read
// (coding/ai-fix/thread-candidates.ts), over the REAL core client and migrations. What this pins:
//   1. ⚠ THE GATE — an AUTO, SUCCEEDED, non-empty, unpushed fix on the reader's OWN PR, in a
//      workspace with auto AI Fix ON and "Push automatically" ON, is pushed with target 'existing'
//      (the Push button's path); every other case pushes nothing and records nothing;
//   2. a failed push is recorded on the row (`error`) and is never retried;
//   3. ⚠ A STYLE BOT IS DECIDED BY THE WORKSPACE'S STORED ROLE FIRST, then the login seed.
//
//   pnpm --filter @pierre-review/backend test ai-fix/auto-push
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../../review/agent-context.js';

const DB_PATH = join(tmpdir(), `pierre-auto-push-${process.pid}.sqlite`);
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let eq: any;
let mod: typeof import('./auto-push.js');
let ctx: AgentContext;
let repoId = 0;
let wsId = 0;
let n = 1;

let own = true;
let pushes: any[] = [];
let pushAnswer: any;
const deps = () => ({
  prAuthorIsAccount: async () => own,
  pushFix: (async (_c: unknown, input: any) => {
    pushes.push(input);
    return pushAnswer;
  }) as any,
});

async function seedFix(over: Record<string, unknown> = {}): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_ap_${n}`,
      accountId: 1,
      repoId,
      number: n++,
      title: 't',
      state: 'open',
      isDraft: false,
      headSha: 'h1',
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  const [row] = await db
    .insert(schema.aiFixes)
    .values({
      accountId: 1,
      repoId,
      prId: pr.id,
      baseSha: 'h1',
      status: 'succeeded',
      model: 'claude-opus-5-5',
      seed: 'review',
      patch: 'diff --git a b',
      trigger: 'auto',
      ...over,
    })
    .returning()
    .execute();
  return row.id;
}

const setWs = (set: Record<string, unknown>) =>
  db.update(schema.workspaces).set(set).where(eq(schema.workspaces.id, wsId)).execute();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  eq = (await import('drizzle-orm')).eq;
  await runMigrations();
  mod = await import('./auto-push.js');
  ctx = {
    db,
    schema,
    isPg: false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoNothing()
    .execute();
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_ap', createdAt: new Date() })
    .returning()
    .execute();
  repoId = repo.id;
  const q = await import('../../db/queries.js');
  wsId = await q.ensureDefaultWorkspace(1);
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: wsId, repoId }).onConflictDoNothing().execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  own = true;
  pushes = [];
  pushAnswer = { ok: true, result: { pushedBranch: 'feature', commitSha: 'c' } };
  await setWs({ autoFixEnabled: true, autoFixSettings: { autoPush: true } });
});

describe('maybeAutoPushFix — the gate', () => {
  it('⚠ an auto fix on my own PR, push on ⇒ pushed onto the existing branch', async () => {
    const fixId = await seedFix();
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId }, deps())).toEqual({ status: 'pushed', branch: 'feature' });
    expect(pushes).toEqual([{ accountId: 1, fixId, target: 'existing' }]);
  });

  it('⚠ "Push automatically" OFF (the default) ⇒ nothing pushed', async () => {
    await setWs({ autoFixSettings: null });
    const fixId = await seedFix();
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId }, deps())).toEqual({ status: 'skipped', reason: 'off' });
    await setWs({ autoFixEnabled: false, autoFixSettings: { autoPush: true } });
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId }, deps())).toEqual({ status: 'skipped', reason: 'off' });
    expect(pushes).toEqual([]);
  });

  it('⚠ someone else’s PR, a manual fix, an empty or already-pushed fix ⇒ nothing pushed', async () => {
    own = false;
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId: await seedFix() }, deps())).toMatchObject({ reason: 'not_own' });
    own = true;
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId: await seedFix({ trigger: 'manual' }) }, deps())).toMatchObject({ reason: 'not_auto' });
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId: await seedFix({ patch: '' }) }, deps())).toMatchObject({ reason: 'not_pushable' });
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId: await seedFix({ pushedAt: new Date() }) }, deps())).toMatchObject({ reason: 'not_pushable' });
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId: await seedFix({ status: 'failed' }) }, deps())).toMatchObject({ reason: 'not_pushable' });
    // Another account's fix id reads as nothing.
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 2, fixId: await seedFix() }, deps())).toMatchObject({ reason: 'not_auto' });
    expect(pushes).toEqual([]);
  });

  it('a failed push is recorded on the row and is not retried', async () => {
    pushAnswer = { ok: false, code: 'HEAD_MOVED', message: 'moved' };
    const fixId = await seedFix();
    expect(await mod.maybeAutoPushFix(ctx, { accountId: 1, fixId }, deps())).toEqual({
      status: 'failed',
      message: 'the branch moved since the fix was made.',
    });
    const [row] = await db.select().from(schema.aiFixes).where(eq(schema.aiFixes.id, fixId)).execute();
    expect(row.error).toBe('Automatic push failed: the branch moved since the fix was made.');
    expect(row.status).toBe('succeeded');
    expect(row.pushedAt).toBeNull();
    expect(pushes.length).toBe(1);
  });
});

describe('loadSeedThreads — who is a style bot', () => {
  it('⚠ the workspace’s stored role beats the login seed, both ways', async () => {
    const { loadSeedThreads } = await import('./thread-candidates.js');
    const user = async (login: string): Promise<number> =>
      (await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}` }).returning().execute())[0].id;
    const linted = await user('house-linter'); // unknown login, stored as a quality check
    const sonar = await user('sonarcloud[bot]'); // seed says quality check, stored as a reviewer
    await user('codecov'); // seed says quality check, no stored row
    await db
      .insert(schema.workspaceReviewers)
      .values([
        { accountId: 1, workspaceId: wsId, authorUserId: linted, automated: true, role: 'quality_check', confidence: 'high', source: 'manual' },
        { accountId: 1, workspaceId: wsId, authorUserId: sonar, automated: true, role: 'review', confidence: 'high', source: 'manual' },
      ])
      .execute();
    const [pr] = await db.select({ id: schema.aiFixes.prId }).from(schema.aiFixes).limit(1).execute();
    const thread = (threadId: number, login: string) => ({
      threadId,
      path: 'a.ts',
      line: 1,
      isOutdated: false,
      derivedState: 'untouched',
      url: null,
      comments: [{ authorLogin: login, authorIsBot: true, createdAt: new Date(), body: 'b' }],
      commitsAfterFirstComment: 0,
      commitsAfterLastComment: 0,
    });
    const withThreads = {
      ...ctx,
      queries: {
        loadReviewThreads: async () => ({
          threads: [thread(1, 'house-linter'), thread(2, 'sonarcloud'), thread(3, 'codecov'), thread(4, 'alice')],
          newestCommentAt: null,
        }),
      },
    } as any as AgentContext;
    const got = await loadSeedThreads(withThreads, 1, pr.id);
    expect(got.map((t) => [t.threadId, t.rootIsStyleBot])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ]);
    // No loader on the context ⇒ no threads, never a throw.
    expect(await loadSeedThreads(ctx, 1, pr.id)).toEqual([]);
  });
});
