// THE FEED'S COMMIT RUNS carry the Limn push summaries whose reviewed head is one of their commits
// (docs/FRONTEND.md § Push summaries), on a THROWAWAY sqlite DB. What is pinned:
//   1. A run holding a summary's head carries it; a run after the last review carries none.
//   2. A replies pass and a failed run are never summaries.
//
//   pnpm --filter @pierre-review/backend test push-summaries-feed
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsolidatedFeedResponse } from '@pierre-review/shared';

const DB_PATH = join(tmpdir(), `pierre-push-summaries-feed-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => void) | undefined;
let response: ConsolidatedFeedResponse;

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
  const { accounts, repos, users, pullRequests, events, commits, claudeReviews } = schema;
  const existing = await db.select().from(accounts).execute();
  const accountId: number =
    existing[0]?.id ??
    (await db.insert(accounts).values({ githubUserId: 'U_v', githubLogin: 'viewer' }).returning().execute())[0].id;
  const [dev] = await db.insert(users).values({ githubLogin: 'dev', githubNodeId: 'U_dev' }).returning().execute();
  const [repo] = await db
    .insert(repos)
    .values({ accountId, owner: 'acme', name: 'push-feed', githubNodeId: 'R_pf' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_pf',
      accountId,
      repoId: repo.id,
      number: 9,
      title: 'Pushes',
      authorId: dev.id,
      state: 'open',
      headSha: 's4',
      openedAt: hAgo(72),
      updatedAt: hAgo(1),
    })
    .returning()
    .execute();
  // Two runs (a > 6h gap splits them): s1+s2 at 30h/29h, s3+s4 at 3h/2h.
  const at: Record<string, number> = { s1: 30, s2: 29, s3: 3, s4: 2 };
  for (const [sha, hours] of Object.entries(at)) {
    const [c] = await db
      .insert(commits)
      .values({ sha, prId: pr.id, authorId: dev.id, committedAt: hAgo(hours) })
      .returning()
      .execute();
    await db
      .insert(events)
      .values({
        accountId,
        repoId: repo.id,
        prId: pr.id,
        actorId: dev.id,
        type: 'commit_pushed',
        occurredAt: hAgo(hours),
        dedupeKey: `cp:${sha}`,
        refTable: 'commits',
        refId: c.id,
      })
      .execute();
  }
  const review = (headSha: string, extra: Record<string, unknown>) => ({
    accountId,
    prId: pr.id,
    headSha,
    status: 'succeeded',
    model: 'claude-opus-5-5',
    trigger: 'auto',
    createdAt: hAgo(20),
    finishedAt: hAgo(20),
    ...extra,
  });
  await db
    .insert(claudeReviews)
    .values([
      review('s2', { pushSummary: 'Adds the reset link.', pushSummaryFromSha: null }),
      // Never summaries: a replies pass and a failed run at the later head.
      review('s4', { kind: 'replies', pushSummary: 'not me' }),
      review('s4', { status: 'failed', pushSummary: 'not me either' }),
    ])
    .execute();

  const scope = await q.resolveWorkspaceScope(accountId, undefined, null);
  response = await q.getConsolidatedFeed(accountId, {
    workspaceId: scope.workspaceId,
    repoIds: scope.repoIds,
    includeAllCommits: true,
  });
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('push summaries on the Feed', () => {
  it('the run holding the reviewed head carries its summary; the later run none', () => {
    const runs = response.items
      .filter((i) => i.kind === 'commit_pushed')
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    expect(runs).toHaveLength(2);
    expect(runs[0]!.commitCount).toBe(2);
    expect(runs[0]!.pushSummaries?.map((s) => [s.toSha, s.fromSha, s.text])).toEqual([
      ['s2', null, 'Adds the reset link.'],
    ]);
    expect(runs[1]!.pushSummaries).toEqual([]);
  });
});
