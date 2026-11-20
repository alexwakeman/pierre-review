// The Feed's Bots-side filters (`severities` / `botRoles`) on a THROWAWAY sqlite DB.
//
// What is pinned:
//  1. SERVER-SIDE, BEFORE THE PAGE: a narrowed `limit: 1` page is the first MATCHING row, never an
//     empty slice of the wider stream.
//  2. An Ensemble finding's own severity (its lead) WINS over its ML label.
//  3. A row with neither is "unscored" and has a chip of its own.
//  4. ROLE: the stored workspace role beats the login seed.
//  5. Facets: each row's badges are counted with the OTHER row applied, not its own.
//  6. The people side ignores both params and carries no bot facets.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsolidatedFeedResponse, FeedSeverity, ReviewerRole } from '@pierre-review/shared';

// ⚠ EVERY runtime import of a module that reaches db/client.ts must be DYNAMIC, inside beforeAll
// and AFTER the env is set — a static import opens the real database at module load.
const DB_PATH = join(tmpdir(), `pierre-feed-bot-filters-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => void) | undefined;
let feed: (opts: {
  authors?: 'humans' | 'bots';
  severities?: FeedSeverity[] | null;
  botRoles?: ReviewerRole[] | null;
  limit?: number;
}) => Promise<ConsolidatedFeedResponse>;
let setStoredRole: (userId: number, role: ReviewerRole) => Promise<void>;
let rabbitId = 0;
let depId = 0;
let limnId = 0;
let lintId = 0;

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
  const {
    accounts,
    repos,
    users,
    pullRequests,
    events,
    reviewThreads,
    reviewComments,
    prComments,
    mlCommentLabels,
    workspaceReviewers,
  } = schema;

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
  const mkUser = async (login: string, isBot: boolean) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
        .returning()
        .execute()
    )[0];
  const person = await mkUser('alice', false);
  const rabbit = await mkUser('coderabbitai[bot]', true);
  const dep = await mkUser('dependabot[bot]', true);
  const limn = await mkUser('limn:alice', true);
  const lint = await mkUser('in-house-lint[bot]', true);
  const [repo] = await db
    .insert(repos)
    .values({ accountId, owner: 'acme', name: 'feed-bot-filters', githubNodeId: 'R_fbf' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_fbf',
      accountId,
      repoId: repo.id,
      number: 9,
      title: 'Filter the bots',
      authorId: person.id,
      state: 'open',
      openedAt: hAgo(48),
      updatedAt: hAgo(1),
    })
    .returning()
    .execute();
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'T_fbf',
      prId: pr.id,
      path: 'src/a.ts',
      isResolved: false,
      derivedState: 'untouched',
      createdAt: hAgo(10),
    })
    .returning()
    .execute();
  const rc = async (node: string, authorId: number, body: string, hours: number) =>
    (
      await db
        .insert(reviewComments)
        .values({ githubNodeId: node, threadId: thread.id, prId: pr.id, authorId, body, createdAt: hAgo(hours) })
        .returning()
        .execute()
    )[0];
  // CodeRabbit: ML says major.
  const rabbitRc = await rc('RC_rabbit', rabbit.id, 'This leaks a handle.', 6);
  // Ensemble's finding: its lead says Blocker, its ML label says nit — the lead wins.
  const limnRc = await rc(
    'RC_limn',
    limn.id,
    '**Blocker** · `src/a.ts:3`\n\nNull dereference.\n\n<!-- pierre:claude-review-finding -->',
    5,
  );
  // Dependabot's PR comment: no label at all.
  const [depPc] = await db
    .insert(prComments)
    .values({ githubNodeId: 'PC_dep', prId: pr.id, authorId: dep.id, body: 'Bumps x to 2.', createdAt: hAgo(4) })
    .returning()
    .execute();
  // The in-house linter: ML says minor.
  const [lintPc] = await db
    .insert(prComments)
    .values({ githubNodeId: 'PC_lint', prId: pr.id, authorId: lint.id, body: 'Style.', createdAt: hAgo(3) })
    .returning()
    .execute();

  const label = (kind: string, targetId: number, authorUserId: number, severity: string, hours: number) => ({
    accountId,
    repoId: repo.id,
    prId: pr.id,
    targetKind: kind,
    targetId,
    authorUserId,
    severity,
    severityOrd: ['nit', 'minor', 'major', 'critical'].indexOf(severity),
    severityProb: 0.9,
    categories: ['correctness_bug'],
    categoryProbs: {},
    isSummary: false,
    backend: 'test',
    modelVersion: 'test',
    bodyHash: `h-${kind}-${targetId}`,
    targetCreatedAt: hAgo(hours),
  });
  await db
    .insert(mlCommentLabels)
    .values([
      label('review_comment', rabbitRc.id, rabbit.id, 'major', 6),
      label('review_comment', limnRc.id, limn.id, 'nit', 5),
      label('pr_comment', lintPc.id, lint.id, 'minor', 3),
    ])
    .execute();

  const ev = (key: string, actorId: number, type: string, hours: number, refTable: string, refId: number) => ({
    accountId,
    repoId: repo.id,
    prId: pr.id,
    actorId,
    type,
    occurredAt: hAgo(hours),
    dedupeKey: key,
    refTable,
    refId,
  });
  await db
    .insert(events)
    .values([
      ev('rc:rabbit', rabbit.id, 'review_comment', 6, 'review_threads', thread.id),
      ev('rc:limn', limn.id, 'review_comment', 5, 'review_threads', thread.id),
      ev('pc:dep', dep.id, 'pr_comment', 4, 'pr_comments', depPc.id),
      ev('pc:lint', lint.id, 'pr_comment', 3, 'pr_comments', lintPc.id),
    ])
    .execute();

  const scope = await q.resolveWorkspaceScope(accountId, undefined, null);
  feed = ({ authors = 'bots', severities = null, botRoles = null, limit }) =>
    q.getConsolidatedFeed(accountId, {
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      authors,
      severities,
      botRoles,
      ...(limit != null ? { limit } : {}),
    });
  setStoredRole = async (userId, role) => {
    await db
      .insert(workspaceReviewers)
      .values({
        accountId,
        workspaceId: scope.workspaceId,
        authorUserId: userId,
        automated: true,
        role,
        confidence: 'high',
        source: 'manual',
      })
      .onConflictDoUpdate({
        target: [
          workspaceReviewers.accountId,
          workspaceReviewers.workspaceId,
          workspaceReviewers.authorUserId,
        ],
        set: { automated: true, role, source: 'manual' },
      })
      .execute();
  };
  rabbitId = rabbit.id;
  depId = dep.id;
  limnId = limn.id;
  lintId = lint.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const actors = (r: ConsolidatedFeedResponse): (number | null)[] => r.items.map((i) => i.actorId);

describe('the Feed Bots-side filters', () => {
  it('with no narrowing, every bot row shows', async () => {
    const r = await feed({});
    expect(new Set(actors(r))).toEqual(new Set([rabbitId, limnId, depId, lintId]));
  });

  it("an Ensemble finding's own severity beats its ML label; a row with neither is unscored", async () => {
    const r = await feed({});
    expect(r.counts?.bySeverity).toEqual({ major: 1, critical: 1, unscored: 1, minor: 1 });
    expect(actors(await feed({ severities: ['critical'] }))).toEqual([limnId]);
    expect(actors(await feed({ severities: ['nit'] }))).toEqual([]);
    expect(actors(await feed({ severities: ['unscored'] }))).toEqual([depId]);
  });

  it('narrows by bot type, the login seed deciding when no row is stored', async () => {
    const r = await feed({ botRoles: ['dependency'] });
    expect(actors(r)).toEqual([depId]);
    expect(r.counts?.byBotRole?.dependency).toBe(1);
  });

  it('filters BEFORE the page: a one-row page is the first MATCHING row', async () => {
    // The newest bot row is the linter's; a Dependency-only page of one must skip it.
    const r = await feed({ botRoles: ['dependency'], limit: 1 });
    expect(actors(r)).toEqual([depId]);
    expect(r.total).toBe(1);
    // An unknown bot (the in-house linter) defaults to Review until a person says otherwise.
    expect(new Set(actors(await feed({ botRoles: ['review'] })))).toEqual(new Set([rabbitId, limnId, lintId]));
  });

  it("each chip row's badges ignore its own selection and honour the other row's", async () => {
    const r = await feed({ severities: ['critical'], botRoles: ['review'] });
    // byBotRole: severity applied (only the critical finding), role not.
    expect(r.counts?.byBotRole).toEqual({ review: 1 });
    // bySeverity: role applied (review bots only), severity not.
    expect(r.counts?.bySeverity).toEqual({ major: 1, critical: 1, minor: 1 });
  });

  it('a stored role beats the login seed', async () => {
    await setStoredRole(lintId, 'quality_check');
    expect(actors(await feed({ botRoles: ['quality_check'] }))).toEqual([lintId]);
    await setStoredRole(depId, 'housekeeping');
    expect(actors(await feed({ botRoles: ['dependency'] }))).toEqual([]);
  });

  it('the people side ignores both params and carries no bot facets', async () => {
    const r = await feed({ authors: 'humans', severities: ['critical'], botRoles: ['review'] });
    expect(r.counts?.bySeverity).toBeUndefined();
    expect(r.counts?.byBotRole).toBeUndefined();
  });
});
