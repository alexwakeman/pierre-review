// CONTRIBUTION CARDS over the REAL core client and migrations (sqlite 0086). What this pins:
//   1. A card round-trips per (PR, head); re-writing the same head REPLACES it (one row).
//   2. Currency: `readCardsAt` answers only at the asked head — an open PR pushed past its card has
//      none; a merged PR's card at its final head keeps answering.
//   3. The ticket review wire carries each member's card at its CURRENT synced head, null otherwise.
//   4. Another account's PR reads nothing.
//   5. Deleting a PR (the shared prune both delete paths run) deletes its cards.
//
//   pnpm --filter @pierre-review/backend test ticket-review/cards-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ticket-review-cards-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let client: any;
let closeDb: (() => Promise<void> | void) | undefined;
let cards: typeof import('./cards.js');
let persist: typeof import('./persist.js');
let fp: typeof import('./fingerprint.js');
let ctx: AgentContext;
const pr: Record<string, number> = {};

const body = (summary: string) => ({
  summary,
  interfaces: [{ kind: 'endpoint' as const, name: 'GET /x', change: 'added' as const, note: null }],
  criteria: [],
  looseEnds: ['TODO'],
});

async function addPr(tag: string, repoId: number, head: string, state: 'open' | 'merged', accountId = 1): Promise<number> {
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId,
      repoId,
      number: Object.keys(pr).length + 1,
      title: tag,
      state,
      isDraft: false,
      headSha: head,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  pr[tag] = p.id;
  return p.id;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  cards = await import('./cards.js');
  persist = await import('./persist.js');
  fp = await import('./fingerprint.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_b', githubLogin: 'b', isLocal: false }).onConflictDoNothing().execute();
  const [ra] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  const [rb] = await db.insert(schema.repos).values({ accountId: 2, owner: 'other', name: 'x', githubNodeId: 'R_x' }).returning().execute();
  await addPr('open', ra.id, 'h1', 'open');
  await addPr('merged', ra.id, 'm1', 'merged');
  await addPr('foreign', rb.id, 'f1', 'open', 2);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const write = (prId: number, headSha: string, summary: string, source: 'story_check' | 'prepass' = 'prepass') => ({
  prId,
  headSha,
  card: body(summary),
  changedFiles: ['src/a.ts'],
  source,
  model: 'claude-sonnet-5',
  costUsd: source === 'prepass' ? 0.12 : null,
});

describe('contribution card storage', () => {
  it('round-trips per (PR, head) and replaces on the same head', async () => {
    await cards.saveCards(ctx, 1, [write(pr.open!, 'h1', 'first'), write(pr.merged!, 'm1', 'merged one')]);
    await cards.saveCards(ctx, 1, [write(pr.open!, 'h1', 'second', 'story_check')]);
    const rows = await db.select().from(schema.ticketReviewPrCards).execute();
    expect(rows).toHaveLength(2);
    const got = await cards.readCardsAt(ctx, 1, [{ prId: pr.open!, headSha: 'h1' }]);
    expect(got.get(pr.open!)?.card.summary).toBe('second');
    expect(got.get(pr.open!)?.source).toBe('story_check');
    expect(got.get(pr.open!)?.card.changedFiles).toEqual(['src/a.ts']);
    // A write with no head could never be current: skipped.
    await cards.saveCards(ctx, 1, [write(pr.open!, '', 'headless')]);
    expect(await db.select().from(schema.ticketReviewPrCards).execute()).toHaveLength(2);
  });

  it('an open PR pushed past its card has none; a merged card keeps answering', async () => {
    const { eq } = await import('drizzle-orm');
    await db.update(schema.pullRequests).set({ headSha: 'h2' }).where(eq(schema.pullRequests.id, pr.open!)).execute();
    const live = await fp.readLiveMembers(ctx, 1, [pr.open!, pr.merged!]);
    const got = await cards.readCardsAt(ctx, 1, live.map((m) => ({ prId: m.prId, headSha: m.headSha })));
    expect(got.has(pr.open!)).toBe(false);
    expect(got.get(pr.merged!)?.card.summary).toBe('merged one');
  });

  it('the ticket review wire carries the card at the current head only', async () => {
    const id = await persist.insertQueuedTicketReview(ctx, {
      accountId: 1,
      workspaceId: 1,
      ident: 'jira:https://acme.atlassian.net/rest/api/3#BMD-7',
      ticketKey: 'BMD-7',
      ticketTitle: 't',
      ticket: null,
      originPrId: pr.open!,
      trigger: 'manual',
      model: 'm',
    });
    const live = await fp.readLiveMembers(ctx, 1, [pr.open!, pr.merged!]);
    await persist.markTicketReviewRunning(ctx, 1, id, {
      ticket: { title: 't', description: 'd', acceptanceCriteria: '- a' },
      ticketHash: 'h',
      fingerprint: 'f',
      prCount: 2,
      members: live.map((m) => ({ ...m, checkedOut: true })),
    });
    let r = await persist.getTicketReviewById(ctx, 1, id);
    expect(r?.members.find((m) => m.prId === pr.open)?.card).toBeNull();
    const merged = r?.members.find((m) => m.prId === pr.merged)?.card;
    expect(merged).toMatchObject({ headSha: 'm1', source: 'prepass', summary: 'merged one', looseEnds: ['TODO'] });
    expect(merged).not.toHaveProperty('changedFiles');
    await cards.saveCards(ctx, 1, [write(pr.open!, 'h2', 'after the push', 'story_check')]);
    r = await persist.getTicketReviewById(ctx, 1, id);
    expect(r?.members.find((m) => m.prId === pr.open)?.card?.summary).toBe('after the push');
  });

  it("another account's PR reads nothing", async () => {
    await cards.saveCards(ctx, 2, [write(pr.foreign!, 'f1', 'theirs')]);
    expect((await cards.readCardsAt(ctx, 1, [{ prId: pr.foreign!, headSha: 'f1' }])).size).toBe(0);
    expect((await cards.readCardsAt(ctx, 2, [{ prId: pr.foreign!, headSha: 'f1' }])).size).toBe(1);
  });

  it('deleting a PR deletes its cards (the prune both delete paths run)', async () => {
    const { pruneTicketReviewsForPrs } = await import('../../db/ticket-review-prune.js');
    await client.runTransaction((tx: any) => pruneTicketReviewsForPrs(tx, [pr.merged!]));
    const left = (await db.select().from(schema.ticketReviewPrCards).execute()).map((c: any) => c.prId);
    expect(left).not.toContain(pr.merged);
    expect(left).toContain(pr.open);
  });
});
