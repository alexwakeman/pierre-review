// AUTO-POSTING A TICKET REVIEW, over the REAL core client and a FAKE GitHub (nothing reaches GitHub).
// What is pinned:
//   1. Story gaps post ONLY on the owner PR the run names; an item with NO owner is not posted.
//   2. The owner PR must pass the same rules as a PR review: its workspace switched on, the kind on,
//      open (synced and live), not a draft, not a bot's, and 'mine' unless the scope is 'all'.
//   3. Only an AUTOMATIC run posts (a click keeps the Post buttons), and only the ticket's latest.
//   4. NEVER TWICE: a re-raised item (prior_item_id inherits the posting) or one matching an earlier
//      posting by key is not posted again; "Not asked for" entries are carried, never re-posted.
//   5. Failures are recorded (Story check shows them), never retried; the manual route answers
//      AlreadyPosted for an item auto-posting put on GitHub, and the wire says "auto".
//
//   pnpm --filter @pierre-review/backend test ticket-review/auto-post
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AUTO_POST_DEFAULT_KINDS, AUTO_POST_FOOTER, type TicketAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ticket-auto-post.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

vi.mock('../../sync/resync-after-write.js', () => ({ settlePrAfterWrite: async () => ({ visible: true }) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let fp: typeof import('./fingerprint.js');
let ap: typeof import('./auto-post.js');
let settings: typeof import('../claude-review/auto-settings.js');
let claudeAp: typeof import('../claude-review/auto-post.js');
let wsId = 0;
const users: Record<string, number> = {};
const repoIds: number[] = [];
let seq = 0;
let identSeq = 0;

const postFinding = vi.fn();
let live: { state: 'open' | 'closed'; draft: boolean; merged: boolean } | null = null;
const deps = () => ({
  ...claudeAp.defaultAutoPostDeps,
  livePr: vi.fn(async () => ({ headSha: 'unused', ...(live ?? { state: 'open' as const, draft: false, merged: false }) })),
  settle: vi.fn(async () => ({ visible: true })),
});

async function makePr(o: { author: string; draft?: boolean; state?: 'open' | 'merged' | 'closed' }): Promise<number> {
  seq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${seq}`,
      accountId: 1,
      repoId: repoIds[0],
      number: seq,
      title: `pr ${seq}`,
      state: o.state ?? 'open',
      isDraft: o.draft ?? false,
      headSha: `h${seq}`,
      authorId: users[o.author],
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

interface Item {
  ref: string;
  ownerPrId: number | null;
  title: string;
}
async function run(
  ident: string,
  memberIds: number[],
  items: Item[],
  o: { trigger?: 'auto' | 'cascade' | 'manual'; notRequested?: TicketAssessment['notRequested'] } = {},
): Promise<number> {
  const story = { title: 'Export', description: 'd', acceptanceCriteria: '- CSV', source: 'jira' as const, key: 'BMD-7' };
  const liveMembers = await fp.readLiveMembers(ctx, 1, memberIds);
  const h = fp.ticketHash(story);
  const id = await persist.insertQueuedTicketReview(ctx, {
    accountId: 1,
    workspaceId: wsId,
    ident,
    ticketKey: 'BMD-7',
    ticketTitle: 'Export',
    ticket: null,
    originPrId: memberIds[0]!,
    trigger: o.trigger ?? 'auto',
    model: 'm',
  });
  await persist.markTicketReviewRunning(ctx, 1, id, {
    ticket: story,
    ticketHash: h,
    fingerprint: fp.fingerprint(h, liveMembers),
    prCount: memberIds.length,
    members: liveMembers.map((m) => ({ ...m, checkedOut: true })),
  });
  await persist.saveTicketReviewSuccess(ctx, 1, id, {
    alignment: 'partly_aligned',
    summary: null,
    assessment: { alignment: 'partly_aligned', summary: null, criteria: [], missing: [], notRequested: o.notRequested ?? [] },
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    items: items.map((i) => ({ ...i, status: 'not_met' as const, body: 'why', path: null, line: null })),
  });
  return id;
}

const newIdent = (): string => `jira:https://acme.atlassian.net/rest/api/3#BMD-${(identSeq += 1)}`;

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
  for (const login of ['me', 'alice', 'dependabot[bot]']) {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: login.endsWith('[bot]') }).returning().execute();
    users[login] = u.id;
  }
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoIds.push(r.id);
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  persist = await import('./persist.js');
  fp = await import('./fingerprint.js');
  ap = await import('./auto-post.js');
  settings = await import('../claude-review/auto-settings.js');
  claudeAp = await import('../claude-review/auto-post.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    host: { isCloud: false },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: { postFinding },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  postFinding.mockReset();
  let n = 0;
  postFinding.mockImplementation(async () => ({ commentId: `C${(n += 1)}`, postedCommentKind: 'pr_comment' }));
  live = null;
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, {
    autoPost: { enabled: true, scope: 'mine', kinds: { ...AUTO_POST_DEFAULT_KINDS } },
  });
});

describe('where story gaps go', () => {
  it('only on the owner PR; an item with no owner is not posted', async () => {
    const mine = await makePr({ author: 'me' });
    const other = await makePr({ author: 'me' });
    const id = await run(newIdent(), [mine, other], [
      { ref: 'AC1', ownerPrId: other, title: 'CSV export' },
      { ref: 'AC2', ownerPrId: null, title: 'PDF export' },
    ]);
    const out = await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps());
    expect(out).toMatchObject({ kind: 'done', record: { status: 'posted', error: null } });
    expect(postFinding).toHaveBeenCalledTimes(1);
    const call = postFinding.mock.calls[0]![0];
    expect(call.prNumber).toBe((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, other)).execute())[0].number);
    expect(call.finding.footer).toBe(AUTO_POST_FOOTER);
    expect(call.finding.storyLead).toContain('BMD-7 · AC1');
    const r = (await persist.getTicketReviewById(ctx, 1, id))!;
    const ac1 = r.items.find((i) => i.ref === 'AC1')!;
    expect(ac1.posted).toMatchObject({ prId: other, auto: true, carried: false });
    expect(r.items.find((i) => i.ref === 'AC2')!.posted).toBeNull();
    expect(r.autoPost).toMatchObject({ status: 'posted', postedCount: 1 });
  });

  it('every item ownerless ⇒ skipped no_owner, no call', async () => {
    const pr = await makePr({ author: 'me' });
    const id = await run(newIdent(), [pr], [{ ref: 'AC1', ownerPrId: null, title: 'x' }]);
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps())).toEqual({ kind: 'skipped', reason: 'no_owner' });
    expect(postFinding).not.toHaveBeenCalled();
  });

  it('the owner must pass the PR rules: not yours, draft, bot, closed (live) all skip', async () => {
    const theirs = await makePr({ author: 'alice' });
    const draft = await makePr({ author: 'me', draft: true });
    const bot = await makePr({ author: 'dependabot[bot]' });
    for (const owner of [theirs, draft, bot]) {
      const id = await run(newIdent(), [owner], [{ ref: 'AC1', ownerPrId: owner, title: `t${owner}` }]);
      const out = await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps());
      expect(out.kind, `owner ${owner}`).toBe('skipped');
    }
    live = { state: 'closed', draft: false, merged: true };
    const mergedLive = await makePr({ author: 'me' });
    const id = await run(newIdent(), [mergedLive], [{ ref: 'AC1', ownerPrId: mergedLive, title: 'gone' }]);
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps())).toEqual({ kind: 'skipped', reason: 'not_open' });
    expect(postFinding).not.toHaveBeenCalled();
    // 'all' lets someone else's PR through.
    live = null;
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { scope: 'all' } });
    const id2 = await run(newIdent(), [theirs], [{ ref: 'AC1', ownerPrId: theirs, title: 'theirs ok' }]);
    expect((await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id2 }, deps())).kind).toBe('done');
  });

  it('off, the kind off, or a manual run ⇒ nothing', async () => {
    const pr = await makePr({ author: 'me' });
    const manual = await run(newIdent(), [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'a' }], { trigger: 'manual' });
    expect((await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: manual }, deps())).kind).toBe('off');
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { kinds: { storyGaps: false } } });
    const kindOff = await run(newIdent(), [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'b' }]);
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: kindOff }, deps())).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: false } });
    const off = await run(newIdent(), [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'c' }], { trigger: 'cascade' });
    expect((await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: off }, deps())).kind).toBe('off');
    expect((await persist.getTicketReviewById(ctx, 1, off))!.autoPost).toBeNull();
    expect(postFinding).not.toHaveBeenCalled();
  });
});

describe('never twice', () => {
  it('a re-run inherits the posting and posts nothing again; the manual route says AlreadyPosted', async () => {
    const pr = await makePr({ author: 'me' });
    const ident = newIdent();
    const first = await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'CSV export' }]);
    await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: first }, deps());
    expect(postFinding).toHaveBeenCalledTimes(1);
    const second = await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'CSV export' }], { trigger: 'cascade' });
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: second }, deps())).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    expect(postFinding).toHaveBeenCalledTimes(1);
    const r = (await persist.getTicketReviewById(ctx, 1, second))!;
    // (`carried` compares second-resolution timestamps, so it is not asserted within one second.)
    expect(r.items[0]!.posted).toMatchObject({ auto: true, commentId: 'C1' });
    const { postTicketItem } = await import('./post-item.js');
    expect((await postTicketItem(ctx, { accountId: 1, runId: second, itemId: r.items[0]!.id, viewedPrId: pr })).kind).toBe('already_posted');
  });

  it('an item posted two runs back (no link in between) is still not re-posted', async () => {
    const pr = await makePr({ author: 'me' });
    const ident = newIdent();
    const first = await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'CSV export' }]);
    await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: first }, deps());
    // The middle run did not raise it, so the third run's item has no prior link.
    await run(ident, [pr], [], { trigger: 'manual' });
    const third = await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'CSV export' }]);
    expect((await persist.getTicketReviewById(ctx, 1, third))!.items[0]!.priorItemId).toBeNull();
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: third }, deps())).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    expect(postFinding).toHaveBeenCalledTimes(1);
  });

  it('only the latest run posts', async () => {
    const pr = await makePr({ author: 'me' });
    const ident = newIdent();
    const older = await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'x' }]);
    await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'x' }], { trigger: 'manual' });
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: older }, deps())).toEqual({ kind: 'skipped', reason: 'not_latest' });
  });

  it('"Not asked for": off by default; on, posted once and carried afterwards', async () => {
    const pr = await makePr({ author: 'me' });
    const ident = newIdent();
    const nr = [{ title: 'Adds a cache', explanation: 'Not in the story.', prId: pr, path: null, line: null }];
    const a = await run(ident, [pr], [], { notRequested: nr });
    expect(await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: a }, deps())).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { kinds: { notAskedFor: true } } });
    const b = await run(ident, [pr], [], { notRequested: nr });
    expect((await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: b }, deps())).kind).toBe('done');
    expect(postFinding).toHaveBeenCalledTimes(1);
    expect(postFinding.mock.calls[0]![0].finding.storyLead).toBe('BMD-7 · Not asked for: Adds a cache');
    const rb = (await persist.getTicketReviewById(ctx, 1, b))!;
    expect(rb.autoPost?.notRequested).toEqual([{ index: 0, prId: pr, postedAt: expect.any(String), carried: false }]);
    const c = await run(ident, [pr], [], { notRequested: [{ ...nr[0]!, title: '  adds a CACHE ' }] });
    expect((await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: c }, deps())).kind).toBe('skipped');
    expect(postFinding).toHaveBeenCalledTimes(1);
    expect((await persist.getTicketReviewById(ctx, 1, c))!.autoPost?.notRequested).toEqual([
      { index: 0, prId: pr, postedAt: expect.any(String), carried: true },
    ]);
  });
});

describe('failures', () => {
  it('a GitHub error is recorded, the item stays postable, and nothing is retried', async () => {
    postFinding.mockImplementation(async () => {
      throw new Error('GitHub REST POST -> 403: Resource not accessible');
    });
    const pr = await makePr({ author: 'me' });
    const id = await run(newIdent(), [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'x' }]);
    const out = await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps());
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed', error: 'GitHub REST POST -> 403: Resource not accessible' } });
    const r = (await persist.getTicketReviewById(ctx, 1, id))!;
    expect(r.items[0]!.posted).toBeNull();
    expect(r.autoPost).toMatchObject({ status: 'failed', postedCount: 0 });
    expect((await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps())).kind).toBe('already_claimed');
    expect(postFinding).toHaveBeenCalledTimes(1);
  });
});
