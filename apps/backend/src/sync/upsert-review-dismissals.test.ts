// REVIEW DISMISSALS FROM THE PR TIMELINE (migration 0183; docs/TEAM-REVIEW.md § When Limn takes its
// approval back). Throwaway sqlite; the real persistPr, no GitHub.
//
// What this pins:
//   1. A ReviewDismissedEvent stamps the dismissed review row (when, by whom, GitHub's message) and is
//      ONE `review_dismissed` event, dedupeKey `review_dismissed:<event node id>` — a re-sync adds none.
//   2. Limn's own withdrawal ("Limn withdrew its approval: …") is the poster's Limn bot's action; a
//      person's dismissal stays theirs.
//   3. An absent selection writes nothing and clears nothing.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-upsert-review-dismissals-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let repoId = 0;

const ROBIN = { login: 'robin-dunn', id: 'U_robin', __typename: 'User' };
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' };
const MARKER = '<!-- pierre:claude-review v=1 a=x h=7f8ea893 k=replies d=APPROVE lv=1.0.13 -->';

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_dis_${n}`,
    number: n,
    title: 'Parser fix',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-11-09T10:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-09T17:00:00Z',
    url: `https://github.com/acme/dis/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'fix',
    mergeable: null,
    mergeStateStatus: null,
    author: CAROL,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

const review = (id: string, author: unknown, state: string, body: string, at: string): any => ({
  id,
  fullDatabaseId: id.replace(/\D/g, ''),
  author,
  state,
  body,
  submittedAt: at,
});

const dismissal = (id: string, actor: unknown, reviewId: string, message: string, at: string): any => ({
  __typename: 'ReviewDismissedEvent',
  id,
  createdAt: at,
  dismissalMessage: message,
  actor,
  review: { id: reviewId },
});

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function reviewRow(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.reviews).where(eq(schema.reviews.githubNodeId, nodeId)).execute())[0];
}

async function dismissalEvents(): Promise<any[]> {
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.events).where(eq(schema.events.type, 'review_dismissed')).execute();
}

async function login(id: number | null): Promise<string | null> {
  if (id == null) return null;
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.users).where(eq(schema.users.id, id)).execute())[0]?.githubLogin ?? null;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('./upsert.js');
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'dis', githubNodeId: 'R_dis_1' }).returning().execute();
  repoId = r.id;
  const queries = await import('../db/queries.js');
  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistPr — review dismissals', () => {
  it('PR 221270: Limn’s withdrawal stamps the review and is one event under the Limn bot', async () => {
    const pr = gqlPr(1, {
      reviews: {
        nodes: [review('PRR_5826965513', ROBIN, 'DISMISSED', `Replies checked: the remaining points are settled.\n\n${MARKER}`, '2026-11-09T14:05:09Z')],
      },
      reviewDismissals: {
        nodes: [
          dismissal('RDE_1', ROBIN, 'PRR_5826965513', 'Limn withdrew its approval: 3 warnings found at 951c4aa.', '2026-11-09T16:41:46Z'),
        ],
      },
    } as any);
    await persist(pr);
    await persist(pr); // a re-sync adds nothing
    const row = await reviewRow('PRR_5826965513');
    expect(row.state).toBe('dismissed');
    expect(row.dismissedAt.toISOString()).toBe('2026-11-09T16:41:46.000Z');
    expect(row.dismissalMessage).toBe('Limn withdrew its approval: 3 warnings found at 951c4aa.');
    expect(await login(row.dismissedByUserId)).toBe('limn:robin-dunn');
    const evs = await dismissalEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ dedupeKey: 'review_dismissed:RDE_1', refTable: 'reviews', refId: row.id, actorId: row.dismissedByUserId });
  });

  it('a person’s dismissal stays theirs; an absent selection clears nothing', async () => {
    const reviews = { nodes: [review('PRR_77', ROBIN, 'DISMISSED', `Looks good.\n\n${MARKER}`, '2026-11-09T12:00:00Z')] };
    await persist(
      gqlPr(2, {
        reviews,
        reviewDismissals: { nodes: [dismissal('RDE_2', CAROL, 'PRR_77', 'Stale.', '2026-11-09T13:00:00Z')] },
      } as any),
    );
    const row = await reviewRow('PRR_77');
    expect(await login(row.dismissedByUserId)).toBe('carol-dev');
    await persist(gqlPr(2, { reviews } as any));
    expect((await reviewRow('PRR_77')).dismissalMessage).toBe('Stale.');
    expect((await dismissalEvents()).filter((e) => e.dedupeKey === 'review_dismissed:RDE_2')).toHaveLength(1);
  });
});
