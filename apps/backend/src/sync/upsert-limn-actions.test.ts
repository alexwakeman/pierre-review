// LIMN'S ACTIONS ARE BOTS (docs/CLAUDE-REVIEW.md § Limn's actions are bots). Throwaway sqlite; the
// real ledger writer, the real persistPr and the real re-attribution, no GitHub.
//
// What this pins:
//   1. The resolver (pure): the marker, the reply-wrapper rule, the `Limn-Run:` trailer, the ledger.
//   2. `limnWrite` records a Limn write (claimed → done with GitHub's ids, or failed) and never a
//      reader's.
//   3. Sync with `config.limnAttributeAll` OFF changes nothing it did not change before (a marked
//      review stays the person's) but keeps the review id of every comment and links the ledger.
//   4. Sync with it ON stores every Limn row under the poster's bot with the person beside it: a
//      summary review, a reply wrapper, an unmarked ledger comment, a trailer commit, a ledger commit,
//      a merge Limn landed, a PR Limn opened. A person's rows stay theirs. Event actors follow.
//   5. `reattributeLimnRows` reaches the same state from rows stored with the flag off, and a second
//      run writes nothing.
//   6. The reader's own `limn:` bot reads as the reader's post (`isLimnPostedComment`), and the bot
//      sits in the `limn` lane.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-upsert-limn-actions-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let config: any;
let upsert: typeof import('./upsert.js');
let limnBots: typeof import('../db/limn-bots.js');
let ledger: typeof import('../db/limn-actions.js');
let writeOrigin: typeof import('../github/write-origin.js');
let repoId = 0;

const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' };
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' };
const FINDING_MARK = '<!-- pierre:claude-review-finding v=1 -->';
const SUMMARY = 'Two warnings.\n\n<!-- pierre:claude-review v=1 a=abc123 -->';
const STORY_CHECK = 'Story check: two gaps.\n\n<!-- pierre:claude-review-ticket v=1 -->';
const FINDING = `**Warning**\n\nThis can throw.\n\n${FINDING_MARK}`;

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_la_${n}`,
    number: n,
    title: 'Change',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-10-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-10-02T00:00:00Z',
    url: `https://github.com/acme/la/pull/${n}`,
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

const review = (id: string, dbId: string, author: any, body: string, state = 'COMMENTED', at = '2026-10-02T10:00:00Z'): any => ({
  id,
  fullDatabaseId: dbId,
  state,
  body,
  submittedAt: at,
  author,
});
const rcomment = (id: string, dbId: string, author: any, body: string, reviewDbId: string, at: string): any => ({
  id,
  fullDatabaseId: dbId,
  body,
  createdAt: at,
  diffHunk: null,
  author,
  pullRequestReview: { fullDatabaseId: reviewDbId },
});
const thread = (id: string, comments: any[]): any => ({
  id,
  isResolved: false,
  isOutdated: false,
  isCollapsed: false,
  path: 'src/x.ts',
  line: 3,
  resolvedBy: null,
  comments: { nodes: comments },
});
const commit = (oid: string, message: string, author: any = ALICE): any => ({
  commit: {
    oid,
    committedDate: '2026-10-02T09:00:00Z',
    message,
    messageHeadline: message.split('\n')[0],
    author: { user: { login: author.login, id: author.id } },
    committer: { user: { login: author.login, id: author.id } },
  },
});

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}
async function q(table: string, where: Record<string, unknown>): Promise<any> {
  const { and, eq } = await import('drizzle-orm');
  const t = schema[table];
  return (
    await db
      .select()
      .from(t)
      .where(and(...Object.entries(where).map(([k, v]) => eq(t[k], v))))
      .execute()
  )[0];
}
async function userId(login: string): Promise<number> {
  return (await q('users', { githubLogin: login })).id;
}

/** The PR used by the attribution cases: every kind of Limn row, and a person's of each. */
function busyPr(n: number): GqlPullRequest {
  return gqlPr(n, {
    author: ALICE,
    state: 'MERGED',
    mergedAt: '2026-10-03T00:00:00Z',
    mergedBy: ALICE,
    reviews: {
      nodes: [
        review(`RV_${n}_sum`, `${n}01`, ALICE, SUMMARY, 'APPROVED'),
        review(`RV_${n}_wrap`, `${n}02`, ALICE, ''),
        review(`RV_${n}_mine`, `${n}03`, ALICE, ''),
        review(`RV_${n}_carol`, `${n}04`, CAROL, 'Looks fine.', 'APPROVED'),
      ],
    } as any,
    reviewThreads: {
      nodes: [
        // A Limn finding in the summary review; Limn's reply in a wrapper; Alice's own typed reply.
        thread(`T_${n}_1`, [
          rcomment(`C_${n}_1`, `${n}11`, ALICE, FINDING, `${n}01`, '2026-10-02T10:00:00Z'),
          rcomment(`C_${n}_2`, `${n}12`, CAROL, 'Why?', `${n}04`, '2026-10-02T11:00:00Z'),
          rcomment(`C_${n}_3`, `${n}13`, ALICE, `Because.\n\n${FINDING_MARK}`, `${n}02`, '2026-10-02T12:00:00Z'),
          rcomment(`C_${n}_4`, `${n}14`, ALICE, 'I typed this one myself.', `${n}03`, '2026-10-02T13:00:00Z'),
        ]),
      ],
    } as any,
    comments: {
      nodes: [
        { id: `PC_${n}_story`, fullDatabaseId: `${n}21`, body: STORY_CHECK, createdAt: '2026-10-02T14:00:00Z', author: ALICE },
        // Unmarked: Limn's only through the ledger ("@dependabot rebase").
        { id: `PC_${n}_rebase`, fullDatabaseId: `${n}22`, body: '@dependabot rebase', createdAt: '2026-10-02T15:00:00Z', author: ALICE },
        { id: `PC_${n}_mine`, fullDatabaseId: `${n}23`, body: 'Shipping it.', createdAt: '2026-10-02T16:00:00Z', author: ALICE },
      ],
    } as any,
    commits: {
      nodes: [
        commit(`aaa${n}000000000000000000000000000000000001`.slice(0, 40), 'Fix the thing\n\nLimn-Run: ai-fix/9\n'),
        commit(`bbb${n}000000000000000000000000000000000002`.slice(0, 40), 'Merge main into fix'),
        commit(`ccc${n}000000000000000000000000000000000003`.slice(0, 40), 'My own commit'),
      ],
    } as any,
  });
}

async function seedLedger(n: number, prId: number | null): Promise<void> {
  const alice = await userId('alice-dev');
  const base = { accountId: 1, repoId, prId, origin: 'auto' as const, onBehalfUserId: alice };
  await ledger.recordLimnAction({ ...base, kind: 'pr_comment' }, { githubDatabaseId: `${n}22` });
  await ledger.recordLimnAction({ ...base, kind: 'push', claimKey: `sha:bbb${n}` }, { commitSha: `bbb${n}000000000000000000000000000000000002`.slice(0, 40) });
  await ledger.recordLimnAction({ ...base, kind: 'merge' }, {});
  await ledger.recordLimnAction({ ...base, prId: null, kind: 'open_pr' }, { prNumber: n, githubNodeId: `PR_la_${n}` });
}

async function expectAttributed(n: number): Promise<void> {
  const alice = await userId('alice-dev');
  const carol = await userId('carol-dev');
  const bot = await userId('limn:alice-dev');
  // Reviews: the summary and the wrapper are Limn's; Alice's empty review around her own reply and
  // Carol's review stay with their people.
  expect(await q('reviews', { githubNodeId: `RV_${n}_sum` })).toMatchObject({ authorId: bot, limnPostedByUserId: alice });
  expect(await q('reviews', { githubNodeId: `RV_${n}_wrap` })).toMatchObject({ authorId: bot, limnPostedByUserId: alice });
  expect(await q('reviews', { githubNodeId: `RV_${n}_mine` })).toMatchObject({ authorId: alice, limnPostedByUserId: null });
  expect(await q('reviews', { githubNodeId: `RV_${n}_carol` })).toMatchObject({ authorId: carol, limnPostedByUserId: null });
  // Comments: a marked story check and a ledger-only rebase request are Limn's; a typed one is not.
  expect(await q('prComments', { githubNodeId: `PC_${n}_story` })).toMatchObject({ authorId: bot, limnPostedByUserId: alice });
  expect(await q('prComments', { githubNodeId: `PC_${n}_rebase` })).toMatchObject({ authorId: bot, limnPostedByUserId: alice });
  expect(await q('prComments', { githubNodeId: `PC_${n}_mine` })).toMatchObject({ authorId: alice, limnPostedByUserId: null });
  // Commits: the trailer and the ledger sha are Limn's; Alice's own commit is hers.
  const sha = (p: string, k: string): string => `${p}${n}00000000000000000000000000000000000${k}`.slice(0, 40);
  expect((await q('commits', { sha: `aaa${n}000000000000000000000000000000000001`.slice(0, 40) })).authorId).toBe(bot);
  expect(await q('commits', { sha: `bbb${n}000000000000000000000000000000000002`.slice(0, 40) })).toMatchObject({ authorId: bot, limnPushedByUserId: alice });
  expect(await q('commits', { sha: `ccc${n}000000000000000000000000000000000003`.slice(0, 40) })).toMatchObject({ authorId: alice, limnPushedByUserId: null });
  void sha;
  // The PR: opened and merged by Limn for Alice.
  const pr = await q('pullRequests', { githubNodeId: `PR_la_${n}` });
  expect(pr).toMatchObject({ authorId: bot, limnOpenedForUserId: alice, mergedById: bot, limnMergedForUserId: alice });
  // Events follow the rows.
  expect((await q('events', { dedupeKey: `review_submitted:RV_${n}_sum` })).actorId).toBe(bot);
  expect((await q('events', { dedupeKey: `pr_comment:PC_${n}_rebase` })).actorId).toBe(bot);
  expect((await q('events', { dedupeKey: `pr_opened:PR_la_${n}` })).actorId).toBe(bot);
  // The PERSON behind each row reads back through trueAuthorId.
  const { eq } = await import('drizzle-orm');
  const person = await db
    .select({ id: limnBots.trueAuthorId(schema.pullRequests), merger: limnBots.trueMergerId(schema.pullRequests) })
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, pr.id))
    .execute();
  expect(person[0]).toEqual({ id: alice, merger: alice });
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  config = (await import('../config.js')).config;
  upsert = await import('./upsert.js');
  limnBots = await import('../db/limn-bots.js');
  ledger = await import('../db/limn-actions.js');
  writeOrigin = await import('../github/write-origin.js');
  const { eq } = await import('drizzle-orm');
  await db.update(schema.accounts).set({ githubLogin: 'alice-dev' }).where(eq(schema.accounts.id, 1)).execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'la', githubNodeId: 'R_la_1' }).returning().execute();
  repoId = r.id;
  const queries = await import('../db/queries.js');
  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
  // Alice and Carol exist as users (a first walk would create them anyway).
  await persist(gqlPr(900, { author: ALICE }));
  await persist(gqlPr(901, { author: CAROL }));
});

afterAll(() => {
  if (config) config.limnAttributeAll = false;
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the resolver (pure)', () => {
  it('reads the marker, the wrapper rule, the trailer and the ledger', async () => {
    const { commentIsLimn, reviewIsLimn, commitIsLimn, prLimnRoles } = limnBots;
    // Narrow (finding era): a story check is not a finding; wide: any marker; the ledger; never a quote.
    expect(commentIsLimn({ body: STORY_CHECK }, 'pr_comment', { wide: false })).toBe(false);
    expect(commentIsLimn({ body: STORY_CHECK }, 'pr_comment', { wide: true })).toBe(true);
    const quoted = STORY_CHECK.split('\n').map((l) => `> ${l}`).join('\n');
    expect(commentIsLimn({ body: `${quoted}\n\nNo.` }, 'pr_comment', { wide: true })).toBe(false);
    expect(commentIsLimn({ body: '@dependabot rebase', databaseId: 7 }, 'pr_comment', { wide: true, ledger: { commentIds: new Set(['7']) } })).toBe(true);
    expect(commentIsLimn({ body: '@dependabot rebase', databaseId: 7 }, 'pr_comment', { wide: false, ledger: { commentIds: new Set(['7']) } })).toBe(false);
    // Reviews: marker; an EMPTY COMMENTED review is Limn's only when every comment in it is.
    expect(reviewIsLimn({ databaseId: '1', body: SUMMARY, state: 'approved' }, {})).toBe(true);
    const cs = new Map([['2', [true, true]], ['3', [true, false]]]);
    expect(reviewIsLimn({ databaseId: '2', body: '', state: 'commented' }, { commentsLimn: cs })).toBe(true);
    expect(reviewIsLimn({ databaseId: '3', body: '', state: 'commented' }, { commentsLimn: cs })).toBe(false);
    expect(reviewIsLimn({ databaseId: '4', body: '', state: 'commented' }, { commentsLimn: cs })).toBe(false);
    expect(reviewIsLimn({ databaseId: '2', body: '', state: 'approved' }, { commentsLimn: cs })).toBe(false);
    expect(reviewIsLimn({ databaseId: '9', body: 'LGTM', state: 'approved' }, { ledger: { reviewIds: new Set(['9']) } })).toBe(true);
    // Commits: the trailer on a line of its own, or the ledger's sha.
    expect(commitIsLimn({ sha: 'A1', message: 'x\n\nLimn-Run: ai-fix/3' }, {})).toBe(true);
    expect(commitIsLimn({ sha: 'A1', message: 'mentions Limn-Run: inline' }, {})).toBe(false);
    expect(commitIsLimn({ sha: 'A1', message: 'x' }, { ledger: { commitShas: new Set(['a1']) } })).toBe(true);
    // The PR: only when GitHub names the same person the ledger does.
    expect(prLimnRoles({ authorId: 5, mergedById: 5 }, { mergedFor: 5, openedFor: 5 })).toEqual({ openedFor: 5, mergedFor: 5 });
    expect(prLimnRoles({ authorId: 6, mergedById: 7 }, { mergedFor: 5, openedFor: 5 })).toEqual({ openedFor: null, mergedFor: null });
  });

  it('adds the trailer once', async () => {
    const { withLimnRunTrailer, hasLimnRunTrailer, limnRunTrailer } = await import('@pierre-review/shared');
    const once = withLimnRunTrailer('Fix it', 'ai-fix/12');
    expect(once).toBe('Fix it\n\nLimn-Run: ai-fix/12\n');
    expect(withLimnRunTrailer(once, 'ai-fix/12')).toBe(once);
    expect(hasLimnRunTrailer(once)).toBe(true);
    expect(limnRunTrailer('conflict/a b')).toBe('Limn-Run: conflict/a-b');
  });
});

describe('limnWrite — the ledger records Limn, never the reader', () => {
  it('claims, then settles done with GitHub ids; failed on a throw or a refusal; nothing for the reader', async () => {
    const alice = await userId('alice-dev');
    const origin = { limn: 'auto' as const, accountId: 1, repoId, prId: null, onBehalfUserId: alice, source: { table: 'ai_fixes', id: 3 } };
    const out = await writeOrigin.limnWrite(origin, 'pr_comment', { prNumber: 77 }, async () => ({ id: 555 }), (r) => ({ githubDatabaseId: r.id }));
    expect(out).toEqual({ id: 555 });
    expect(await q('limnActions', { githubDatabaseId: '555' })).toMatchObject({
      status: 'done',
      kind: 'pr_comment',
      origin: 'auto',
      prNumber: 77,
      onBehalfUserId: alice,
      sourceTable: 'ai_fixes',
      sourceId: 3,
    });
    await expect(
      writeOrigin.limnWrite({ ...origin, claimKey: 'boom' }, 'merge', {}, async () => {
        throw new Error('GitHub said no');
      }, () => ({})),
    ).rejects.toThrow('GitHub said no');
    expect(await q('limnActions', { claimKey: 'boom' })).toMatchObject({ status: 'failed', detail: 'GitHub said no' });
    await writeOrigin.limnWrite({ ...origin, claimKey: 'refused' }, 'merge', {}, async () => ({ ok: false }), () => ({ failed: 'not mergeable' }));
    expect(await q('limnActions', { claimKey: 'refused' })).toMatchObject({ status: 'failed', detail: 'not mergeable' });
    const before = (await db.select().from(schema.limnActions).execute()).length;
    await writeOrigin.limnWrite('reader', 'merge', {}, async () => ({}), () => ({}));
    await writeOrigin.recordLimnPush('reader', ['abcdef1']);
    expect((await db.select().from(schema.limnActions).execute()).length).toBe(before);
    await writeOrigin.recordLimnPush(origin, ['ABCDEF1234', 'not a sha']);
    expect(await q('limnActions', { commitSha: 'abcdef1234' })).toMatchObject({ kind: 'push', status: 'done' });
  });
});

describe('persistPr — every Limn row is the bot\'s', () => {
  it('flag OFF: a marked review stays the person\'s; the review id and the ledger link are kept', async () => {
    config.limnAttributeAll = false;
    await seedLedger(10, null);
    await persist(busyPr(10));
    const alice = await userId('alice-dev');
    expect(await q('reviews', { githubNodeId: 'RV_10_sum' })).toMatchObject({ authorId: alice, limnPostedByUserId: null });
    expect((await q('pullRequests', { githubNodeId: 'PR_la_10' })).authorId).toBe(alice);
    expect((await q('reviewComments', { githubNodeId: 'C_10_3' })).reviewDatabaseId).toBe('1002');
    // The finding rule still holds with the flag off.
    expect((await q('reviewComments', { githubNodeId: 'C_10_1' })).limnPostedByUserId).toBe(alice);
    // The open_pr row now names the stored PR.
    const pr = await q('pullRequests', { githubNodeId: 'PR_la_10' });
    expect((await q('limnActions', { kind: 'open_pr', prNumber: 10 })).prId).toBe(pr.id);
  });

  it('flag ON: reviews, wrappers, comments, commits, the merge and the opening move to the bot', async () => {
    config.limnAttributeAll = true;
    const pr = await q('pullRequests', { githubNodeId: 'PR_la_10' });
    // The ledger's merge row names the PR once it is stored.
    const { and, eq, isNull } = await import('drizzle-orm');
    // (In the app the origin names the PR when it is stored; the seed wrote them before it was.)
    await db.update(schema.limnActions).set({ prId: pr.id }).where(and(eq(schema.limnActions.repoId, repoId), isNull(schema.limnActions.prId))).execute();
    await persist(busyPr(10));
    await expectAttributed(10);
    // A second walk is idempotent.
    await persist(busyPr(10));
    await expectAttributed(10);
    config.limnAttributeAll = false;
  });
});

describe('reattributeLimnRows — the history, by the same rule', () => {
  it('reaches the sync state from rows stored with the flag off, and a second run writes nothing', async () => {
    config.limnAttributeAll = false;
    // A stored commit message is what lets the history read the trailer (lean storage keeps none:
    // there only the ledger's shas are recognised).
    const lean = config.persistBodies;
    config.persistBodies = true;
    await persist(busyPr(20));
    config.persistBodies = lean;
    const pr = await q('pullRequests', { githubNodeId: 'PR_la_20' });
    await seedLedger(20, pr.id);
    const first = await limnBots.reattributeLimnRows(1, { prIds: [pr.id] });
    expect(first.reviews).toBe(2);
    expect(first.commits).toBe(2);
    expect(first.prs).toBe(1);
    expect(first.comments).toBeGreaterThanOrEqual(2);
    await expectAttributed(20);
    const second = await limnBots.reattributeLimnRows(1, { prIds: [pr.id] });
    expect(second).toMatchObject({ reviews: 0, commits: 0, prs: 0, comments: 0 });
  });
});

describe('the reader\'s own bot', () => {
  it('reads as the reader\'s post, and sits in the limn lane', async () => {
    const { isLimnPostedComment } = await import('../db/review-threads-for-review.js');
    const c = { body: `x\n\n${FINDING_MARK}`, databaseId: null };
    expect(isLimnPostedComment({ ...c, authorLogin: 'limn:alice-dev' }, undefined, 'alice-dev')).toBe(true);
    expect(isLimnPostedComment({ ...c, authorLogin: 'limn:carol-dev' }, undefined, 'alice-dev')).toBe(false);
    const { resolveActorLanes } = await import('../db/actor-lanes.js');
    const { resolveWorkspaceScope } = await import('../db/queries.js');
    const scope = await resolveWorkspaceScope(1, null);
    const lanes = await resolveActorLanes(1, scope as any);
    const bot = await userId('limn:alice-dev');
    expect(lanes.laneOf(bot)).toBe('limn');
    expect(lanes.laneOf(await userId('alice-dev'))).toBe('human');
  });
});
