// The Feed's people/bots split (`authors`) on a THROWAWAY sqlite DB.
//
// What is pinned, each with a silent failure mode:
//  1. NEVER MIXED. 'humans' (the default) returns no bot row; 'bots' returns no person's row.
//  2. PER ITEM, NOT PER THREAD. A thread a person and a bot both replied on shows on BOTH sides —
//     the person's reply on one, the bot's on the other.
//  3. AN ACTOR-LESS ROW IS A PERSON'S, so it is never lost from both sides at once.
//  4. A MANUAL "this is a human" beats the global bot flag (the hiddenBotUserIds union), so the
//     split agrees with the Timeline's bot hiding.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsolidatedFeedResponse } from '@pierre-review/shared';

// ⚠ EVERY runtime import of a module that reaches db/client.ts must be DYNAMIC, inside beforeAll
// and AFTER the env is set — a static import opens the real database at module load.
const DB_PATH = join(tmpdir(), `pierre-feed-authors-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => void) | undefined;
let feed: (authors?: 'humans' | 'bots') => Promise<ConsolidatedFeedResponse>;
let setJudgement: (automated: boolean) => Promise<void>;
let personId = 0;
let botId = 0;

const T0 = Math.floor(Date.now() / 1000) * 1000;
const hAgo = (hours: number): Date => new Date(T0 - hours * 3_600_000);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  const db: any = client.db;
  const schema: any = client.schema;
  closeDb = client.closeDb;
  const q = await import('./queries.js');
  await runMigrations();
  const { accounts, repos, users, pullRequests, events, workspaceReviewers } = schema;

  const existing = await db.select().from(accounts).execute();
  const accountId: number =
    existing.find((a: any) => a.githubLogin === 'viewer')?.id ??
    (
      await db
        .insert(accounts)
        .values({ githubUserId: 'U_viewer', githubLogin: 'viewer' })
        .returning()
        .execute()
    )[0].id;
  const [person] = await db
    .insert(users)
    .values({ githubLogin: 'alice', githubNodeId: 'U_alice' })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'lintbot', githubNodeId: 'U_lintbot', isBot: true })
    .returning()
    .execute();
  const [repo] = await db
    .insert(repos)
    .values({ accountId, owner: 'acme', name: 'feed-authors', githubNodeId: 'R_fa' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_fa',
      accountId,
      repoId: repo.id,
      number: 7,
      title: 'Split the feed',
      authorId: person.id,
      state: 'open',
      openedAt: hAgo(48),
      updatedAt: hAgo(1),
    })
    .returning()
    .execute();
  const ev = (key: string, actorId: number | null, type: string, hours: number, refId?: number) => ({
    accountId,
    repoId: repo.id,
    prId: pr.id,
    actorId,
    type,
    occurredAt: hAgo(hours),
    dedupeKey: key,
    refTable: refId != null ? 'review_threads' : null,
    refId: refId ?? null,
  });
  await db
    .insert(events)
    .values([
      // One review thread with BOTH a bot and a person on it.
      ev('rc:bot', bot.id, 'review_comment', 6, 900),
      ev('rc:person', person.id, 'review_comment', 5, 900),
      // A bot's PR comment and a person's.
      ev('pc:bot', bot.id, 'pr_comment', 4),
      ev('pc:person', person.id, 'pr_comment', 3),
      // An actor-less row (a deleted GitHub account).
      ev('pc:ghost', null, 'pr_comment', 2),
    ])
    .execute();

  const scope = await q.resolveWorkspaceScope(accountId, undefined, null);
  feed = (authors) =>
    q.getConsolidatedFeed(accountId, {
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      ...(authors ? { authors } : {}),
    });
  // A MANUAL workspace judgement row — what the Feed's "not a bot?" control stores.
  setJudgement = async (automated) => {
    await db
      .insert(workspaceReviewers)
      .values({
        accountId,
        workspaceId: scope.workspaceId,
        authorUserId: bot.id,
        automated,
        confidence: 'high',
        source: 'manual',
      })
      .onConflictDoUpdate({
        target: [
          workspaceReviewers.accountId,
          workspaceReviewers.workspaceId,
          workspaceReviewers.authorUserId,
        ],
        set: { automated, source: 'manual' },
      })
      .execute();
  };
  personId = person.id;
  botId = bot.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const actors = (r: ConsolidatedFeedResponse): (number | null)[] => r.items.map((i) => i.actorId);

describe('the Feed people/bots split', () => {
  it('defaults to people, and never includes a bot row', async () => {
    const r = await feed();
    expect(actors(r)).not.toContain(botId);
    expect(actors(r)).toContain(personId);
    // The actor-less row is a person's.
    expect(actors(r)).toContain(null);
  });

  it("'bots' returns only bot rows", async () => {
    const r = await feed('bots');
    expect(r.items.length).toBeGreaterThan(0);
    expect(actors(r).every((a) => a === botId)).toBe(true);
  });

  it('a thread with both a person and a bot shows on BOTH sides', async () => {
    const onThread = (r: ConsolidatedFeedResponse) => r.items.filter((i) => i.threadId === 900);
    expect(onThread(await feed('humans')).map((i) => i.actorId)).toEqual([personId]);
    expect(onThread(await feed('bots')).map((i) => i.actorId)).toEqual([botId]);
  });

  it('a manual "this is a human" moves the actor to the people side', async () => {
    await setJudgement(false);
    expect(actors(await feed('humans'))).toContain(botId);
    expect((await feed('bots')).items).toEqual([]);
    await setJudgement(true);
    expect(actors(await feed('humans'))).not.toContain(botId);
  });
});
