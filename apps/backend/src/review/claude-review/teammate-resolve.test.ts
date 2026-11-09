// GAP 13 (docs/TEAM-REVIEW.md § 6 Resolving): on the reader's OWN PR, a teammate's posted Limn review
// that found the reader's own Limn finding addressed AT THE CURRENT HEAD resolves its thread, crediting
// the teammate. Throwaway sqlite; GitHub is faked.
//
// What this pins: claim BEFORE the reply; the reply's wording and marker (a Limn reply, so sync stores
// it under the reader's `limn:` bot); never twice; only at the current head; a newer `n` keeps it open;
// the reader's own newer run at that head wins; the setting off, a teammate's PR, a closed PR and a
// teammate's own thread write nothing.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLimnThreadReply, type TeammateReviewRecord } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-teammate-resolve.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let tr: typeof import('./teammate-resolve.js');
let settings: typeof import('./auto-settings.js');
let ap: typeof import('./auto-post.js');
let wsId = 0;
let repoId = 0;
const users: Record<string, number> = {};
let seq = 0;

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const HEAD = 'abcdef1234567890';

const reply = vi.fn(async (_a: number, _node: string, _body: string) => ({ commentId: 'RPL1' as string | null }));
const resolve = vi.fn(async (_a: number, _node: string) => {});
const stamp = vi.fn(async () => {});
const notePrChanged = vi.fn(async () => {});
const settle = vi.fn(async () => ({ visible: true }));
const rdeps = () => ({ reply, resolve, stamp, notePrChanged });
const canWrite = vi.fn(async (_a: number, _o: string, _n: string, _login: string) => true);
const tdeps = () => ({ canWrite });
const pdeps = () => ({ ...ap.defaultAutoPostDeps, settle });

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  await db.update(schema.accounts).set({ githubLogin: 'me' }).execute();
  for (const [login, name, isBot] of [['me', 'Me', false], ['robin', 'Robin Smith', false], ['mallory', 'Mallory', false], ['helper', 'Helper', true]] as const) {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}`, displayName: name, isBot }).returning().execute();
    users[login] = u.id;
  }
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  tr = await import('./teammate-resolve.js');
  settings = await import('./auto-settings.js');
  ap = await import('./auto-post.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    accountIdOf: () => 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  for (const m of [reply, resolve, stamp, notePrChanged, settle, canWrite]) m.mockClear();
  canWrite.mockImplementation(async () => true);
  reply.mockImplementation(async () => ({ commentId: 'RPL1' }));
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { resolveOwnPrs: true } as any });
});

/** A PR with ONE posted inline finding of mine (or `threadBy`'s) and its synced thread (root id `dbId`). */
async function setup(o: { author?: string; state?: 'open' | 'closed'; threadBy?: string; ownKind?: 'teammate' | null } = {}) {
  seq += 1;
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${seq}`, accountId: 1, repoId, number: seq, title: `pr ${seq}`, state: o.state ?? 'open',
      isDraft: false, headSha: HEAD, authorId: users[o.author ?? 'me'], openedAt: new Date(), updatedAt: new Date(),
    })
    .returning()
    .execute();
  const [mine] = await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1, prId: pr.id, headSha: 'OLDHEAD', status: 'succeeded', model: 'claude-opus-5-5', trigger: 'auto',
      finishedAt: new Date('2026-11-01T10:00:00Z'), kind: o.ownKind ?? null,
    })
    .returning()
    .execute();
  const [f] = await db
    .insert(schema.claudeReviewFindings)
    .values({
      reviewId: mine.id, path: 'src/p.ts', line: 10, severity: 'warning', title: 'Null deref', body: 'Null deref — body',
      included: true, postedAt: new Date('2026-11-01T10:01:00Z'), postedCommentKind: 'inline',
    })
    .returning()
    .execute();
  const [th] = await db
    .insert(schema.reviewThreads)
    .values({ prId: pr.id, githubNodeId: `RT_${seq}`, path: 'src/p.ts', isResolved: false, derivedState: 'likely_addressed', createdAt: new Date() })
    .returning()
    .execute();
  const dbId = `7${seq}`;
  await db
    .insert(schema.reviewComments)
    .values({
      prId: pr.id, threadId: th.id, githubNodeId: `RC_${seq}`, databaseId: dbId, authorId: users[o.threadBy ?? 'me'],
      body: `**Warning**\n\nNull deref — body\n\n${MARK}`, createdAt: new Date('2026-11-01T10:01:00Z'),
    })
    .execute();
  return { pr: pr.id, finding: f, thread: th, dbId };
}

async function teammateReview(pr: number, judged: TeammateReviewRecord['judged'], o: { head?: string; at?: string; inferred?: boolean; by?: string } = {}) {
  const teammate: TeammateReviewRecord = {
    githubReviewId: '55', run: 'auto', pair: false, runs: [], limnVersion: '1.0.3', headInferred: o.inferred ?? false, judged,
  };
  await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1, prId: pr, headSha: o.head ?? HEAD, status: 'succeeded', model: '', trigger: 'manual', kind: 'teammate',
      sourceUserId: users[o.by ?? 'robin'], sourceReviewNodeId: `PRR_${pr}_${o.at ?? 'a'}`, teammate,
      postedAt: new Date(o.at ?? '2026-11-02T10:00:00Z'), finishedAt: new Date(o.at ?? '2026-11-02T10:00:00Z'),
    })
    .execute();
}

const rowOf = async (id: number) => {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.id, id)).execute())[0];
};

describe('pure', () => {
  it('the reply credits the teammate and is a Limn reply', () => {
    const body = tr.teammateResolveReplyBody('addressed', HEAD, tr.teammateCheckerName('robin', 'Robin Smith'));
    expect(body.split('\n')[0]).toBe('Addressed in abcdef1 (checked by Robin’s Limn).');
    expect(body).toContain(MARK);
    expect(isLimnThreadReply(body)).toBe(true);
    expect(tr.teammateResolveReplyBody('no_longer_applies', HEAD, 'Robin’s Limn').split('\n')[0]).toBe(
      'No longer applies as of abcdef1 (checked by Robin’s Limn).',
    );
    // A display name cannot carry markup or a mention.
    expect(tr.teammateCheckerName('robin', '@evil <b>x</b>')).toBe('evil’s Limn');
  });

  it('the reply carries the teammate Limn\'s how (`jr=`), made safe', () => {
    expect(tr.teammateResolveReplyBody('addressed', HEAD, 'Robin’s Limn', 'rowSelect reads rowid @bob').split('\n')[0]).toBe(
      'Addressed in abcdef1 (checked by Robin’s Limn): rowSelect reads rowid @\u200bbob',
    );
    const w = { reviewId: 1, login: 'robin', name: null, at: 1, judged: [{ commentId: '1', outcome: 'addressed' as const, reason: 'Fixed the guard' }] };
    expect(tr.teammateResolveWords([w], null).get('1')?.how).toBe('Fixed the guard');
  });

  it('the newest word per comment wins; the reader\'s own newer run wins over both', () => {
    const w = (at: number, outcome: any) => ({ reviewId: at, login: 'robin', name: null, at, judged: [{ commentId: '1', outcome }] });
    expect(tr.teammateResolveWords([w(1, 'addressed')], null).get('1')?.outcome).toBe('addressed');
    expect(tr.teammateResolveWords([w(1, 'addressed'), w(2, 'not_addressed')], null).size).toBe(0);
    expect(tr.teammateResolveWords([w(2, 'no_longer_applies'), w(1, 'still_open')], null).get('1')?.outcome).toBe('no_longer_applies');
    expect(tr.teammateResolveWords([w(5, 'addressed')], 6).size).toBe(0);
  });
});

describe('maybeResolveOnTeammateWord', () => {
  it('claims, replies crediting the teammate, resolves, settles — once', async () => {
    const x = await setup();
    await teammateReview(x.pr, [{ commentId: x.dbId, outcome: 'addressed' }]);
    let seenAtReply: any = 'unset';
    reply.mockImplementation(async () => {
      seenAtReply = (await rowOf(x.finding.id)).autoResolve;
      return { commentId: 'RPL9' };
    });
    const out = await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(out).toEqual({ resolved: [x.finding.id], failed: [], untrusted: [] });
    expect(seenAtReply).toMatchObject({ status: 'resolving', why: 'teammate', checkedBy: 'robin', headSha: HEAD });
    expect(reply).toHaveBeenCalledWith(1, x.thread.githubNodeId, expect.stringContaining('Addressed in abcdef1 (checked by Robin’s Limn).'));
    expect(resolve).toHaveBeenCalledWith(1, x.thread.githubNodeId);
    expect(await rowOf(x.finding.id)).toMatchObject({ autoResolve: { status: 'resolved', replyCommentId: 'RPL9', why: 'teammate' } });
    expect(notePrChanged).toHaveBeenCalledWith(1, [x.pr]);
    expect(settle).toHaveBeenCalledTimes(1);
    await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('a failed reply is recorded and never retried', async () => {
    const x = await setup();
    await teammateReview(x.pr, [{ commentId: x.dbId, outcome: 'no_longer_applies' }]);
    reply.mockImplementation(async () => {
      throw Object.assign(new Error('boom'), { status: 502 });
    });
    expect(await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps())).toEqual({ resolved: [], failed: [x.finding.id], untrusted: [] });
    expect(await rowOf(x.finding.id)).toMatchObject({ autoResolve: { status: 'failed', refused: false } });
    await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(reply).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('writes nothing off the current head, on a legacy (inferred) head, or after a newer "not addressed"', async () => {
    const a = await setup();
    await teammateReview(a.pr, [{ commentId: a.dbId, outcome: 'addressed' }], { head: 'OLDHEAD' });
    const b = await setup();
    await teammateReview(b.pr, [{ commentId: b.dbId, outcome: 'addressed' }], { inferred: true });
    const c = await setup();
    await teammateReview(c.pr, [{ commentId: c.dbId, outcome: 'addressed' }], { at: '2026-11-02T10:00:00Z' });
    await teammateReview(c.pr, [{ commentId: c.dbId, outcome: 'still_open' }], { at: '2026-11-02T11:00:00Z' });
    for (const x of [a, b, c]) await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(reply).not.toHaveBeenCalled();
  });

  it('the reader\'s own newer run at the head wins', async () => {
    const x = await setup();
    await teammateReview(x.pr, [{ commentId: x.dbId, outcome: 'addressed' }]);
    await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId: x.pr, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', trigger: 'manual', finishedAt: new Date('2026-11-03T10:00:00Z') })
      .execute();
    await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(reply).not.toHaveBeenCalled();
  });

  it('writes nothing with the setting off, on a teammate\'s PR, on a closed PR, or on a teammate\'s thread', async () => {
    const off = await setup();
    await teammateReview(off.pr, [{ commentId: off.dbId, outcome: 'addressed' }]);
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { resolveOwnPrs: false } as any });
    await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: off.pr }, pdeps(), rdeps(), tdeps());
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { resolveOwnPrs: true } as any });
    const theirs = await setup({ author: 'robin' });
    await teammateReview(theirs.pr, [{ commentId: theirs.dbId, outcome: 'addressed' }]);
    const closed = await setup({ state: 'closed' });
    await teammateReview(closed.pr, [{ commentId: closed.dbId, outcome: 'addressed' }]);
    // A teammate's imported finding on my PR (kind 'teammate'): never mine to resolve.
    const mate = await setup({ threadBy: 'robin', ownKind: 'teammate' });
    await teammateReview(mate.pr, [{ commentId: mate.dbId, outcome: 'addressed' }]);
    for (const x of [theirs, closed, mate]) await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(reply).not.toHaveBeenCalled();
  });

  it('THE TRUST GATE: a bot or a reviewer without write access never resolves; the word is reported', async () => {
    const x = await setup();
    await teammateReview(x.pr, [{ commentId: x.dbId, outcome: 'addressed' }], { by: 'mallory' });
    canWrite.mockImplementation(async (_a, _o, _n, login) => login !== 'mallory');
    expect(await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps())).toEqual({
      resolved: [], failed: [], untrusted: ['mallory'],
    });
    expect(canWrite).toHaveBeenCalledWith(1, 'acme', 'api', 'mallory');
    const b = await setup();
    await teammateReview(b.pr, [{ commentId: b.dbId, outcome: 'no_longer_applies' }], { by: 'helper' });
    expect(await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: b.pr }, pdeps(), rdeps(), tdeps())).toEqual({
      resolved: [], failed: [], untrusted: ['helper'],
    });
    expect(canWrite).not.toHaveBeenCalledWith(1, 'acme', 'api', 'helper');
    expect(reply).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect((await rowOf(x.finding.id)).autoResolve).toBeNull();
    // A trusted teammate's word on the same PR still resolves.
    await teammateReview(x.pr, [{ commentId: x.dbId, outcome: 'addressed' }], { at: '2026-11-02T12:00:00Z' });
    const out = await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(out).toEqual({ resolved: [x.finding.id], failed: [], untrusted: ['mallory'] });
  });

  it('a failed permission read refuses (the default dep never throws)', async () => {
    const x = await setup();
    await teammateReview(x.pr, [{ commentId: x.dbId, outcome: 'addressed' }]);
    canWrite.mockImplementation(async () => false);
    await tr.maybeResolveOnTeammateWord(ctx, { accountId: 1, prId: x.pr }, pdeps(), rdeps(), tdeps());
    expect(reply).not.toHaveBeenCalled();
  });
});
