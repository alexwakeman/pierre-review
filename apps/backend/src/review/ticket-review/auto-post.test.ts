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
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    host: {},
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
    // ONE PR-level comment collating the gaps.
    expect(call.prLevel).toBe(true);
    expect(call.finding.path).toBe('');
    expect(call.finding.body).toContain('**BMD-7 story check** on');
    expect(call.finding.body).toContain('**AC1 · Not met:** CSV export');
    expect(call.finding.body).not.toContain('PDF export');
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
    const { postStoryGapsComment } = await import('./post-item.js');
    expect((await postStoryGapsComment(ctx, { accountId: 1, runId: second, targetPrId: pr, viewedPrId: pr })).kind).toBe('already_posted');
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
    expect(postFinding.mock.calls[0]![0].finding.body).toContain('#### Not asked for\n\n**Adds a cache**\nNot in the story.');
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

describe('one collated comment per target PR', () => {
  it('eight gaps on one owner ⇒ ONE comment, every item stamped with its id', async () => {
    const pr = await makePr({ author: 'me' });
    const items = Array.from({ length: 8 }, (_, i) => ({ ref: `AC${i + 1}`, ownerPrId: pr, title: `Criterion ${i + 1}` }));
    const id = await run(newIdent(), [pr], items);
    const out = await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps());
    expect(out).toMatchObject({ kind: 'done', record: { status: 'posted' } });
    expect(postFinding).toHaveBeenCalledTimes(1);
    const body = postFinding.mock.calls[0]![0].finding.body as string;
    expect(body).toContain(': 8 gaps.');
    for (let i = 1; i <= 8; i += 1) expect(body).toContain(`**AC${i} · Not met:** Criterion ${i}`);
    const r = (await persist.getTicketReviewById(ctx, 1, id))!;
    expect(new Set(r.items.map((i) => i.posted?.commentId))).toEqual(new Set(['C1']));
    expect(r.items.every((i) => i.posted?.auto === true && i.posted.prId === pr)).toBe(true);
    expect(r.autoPost).toMatchObject({ postedCount: 8 });
  });

  it('gaps on two owners ⇒ two comments; a "Not asked for" entry rides in its PR’s comment', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { kinds: { notAskedFor: true } } });
    const a = await makePr({ author: 'me' });
    const b = await makePr({ author: 'me' });
    const id = await run(
      newIdent(),
      [a, b],
      [
        { ref: 'AC1', ownerPrId: a, title: 'One' },
        { ref: 'AC2', ownerPrId: b, title: 'Two' },
        { ref: 'AC3', ownerPrId: a, title: 'Three' },
      ],
      { notRequested: [{ title: 'Adds a cache', explanation: 'Not in the story.', prId: b, path: 'src/c.ts', line: 4 }] },
    );
    await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: id }, deps());
    expect(postFinding).toHaveBeenCalledTimes(2);
    const bodies = postFinding.mock.calls.map((c) => c[0].finding.body as string);
    const forA = bodies.find((x) => x.includes('**AC1'))!;
    const forB = bodies.find((x) => x.includes('**AC2'))!;
    expect(forA).toContain('**AC3');
    expect(forA).not.toContain('Not asked for');
    expect(forB).toContain(': 1 gap, 1 not asked for.');
    expect(forB).toContain('#### Not asked for\n\n**Adds a cache**\n`src/c.ts:4`\nNot in the story.');
    const r = (await persist.getTicketReviewById(ctx, 1, id))!;
    const idOf = (ref: string) => r.items.find((i) => i.ref === ref)!.posted!.commentId;
    expect(idOf('AC1')).toBe(idOf('AC3'));
    expect(idOf('AC2')).not.toBe(idOf('AC1'));
    expect(r.autoPost?.notRequested).toEqual([{ index: 0, prId: b, postedAt: expect.any(String), carried: false }]);
  });

  it('a later check posts a NEW comment with only the gaps not yet posted', async () => {
    const pr = await makePr({ author: 'me' });
    const ident = newIdent();
    const first = await run(ident, [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'CSV export' }]);
    await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: first }, deps());
    const second = await run(ident, [pr], [
      { ref: 'AC1', ownerPrId: pr, title: 'CSV export' },
      { ref: 'AC2', ownerPrId: pr, title: 'PDF export' },
    ], { trigger: 'cascade' });
    await ap.maybeAutoPostTicketReview(ctx, { accountId: 1, runId: second }, deps());
    expect(postFinding).toHaveBeenCalledTimes(2);
    const body = postFinding.mock.calls[1]![0].finding.body as string;
    expect(body).toContain('**AC2 · Not met:** PDF export');
    expect(body).not.toContain('CSV export');
    expect(body).toContain(': 1 gap.');
  });

  it('two posts of the same (run, PR) at once reach GitHub once', async () => {
    const pr = await makePr({ author: 'me' });
    const id = await run(newIdent(), [pr], [{ ref: 'AC1', ownerPrId: pr, title: 'x' }], { trigger: 'manual' });
    let release: () => void = () => {};
    postFinding.mockImplementation(() => new Promise((res) => (release = () => res({ commentId: 'C9', postedCommentKind: 'pr_comment' }))));
    const { postStoryGapsComment } = await import('./post-item.js');
    const first = postStoryGapsComment(ctx, { accountId: 1, runId: id, targetPrId: pr, viewedPrId: pr });
    await vi.waitFor(() => expect(postFinding).toHaveBeenCalledTimes(1));
    expect((await postStoryGapsComment(ctx, { accountId: 1, runId: id, targetPrId: pr, viewedPrId: pr })).kind).toBe('already_posted');
    release();
    expect((await first).kind).toBe('posted');
    expect((await postStoryGapsComment(ctx, { accountId: 1, runId: id, targetPrId: pr, viewedPrId: pr })).kind).toBe('already_posted');
    expect(postFinding).toHaveBeenCalledTimes(1);
  });

  it('the body counts what did not fit, and only what fit is stamped', async () => {
    const { storyGapsCommentBody } = await import('./post-item.js');
    const gap = (i: number) => ({ ref: `AC${i}`, status: 'partly_met' as const, title: `T${i}`, body: 'x'.repeat(400), path: null, line: null });
    const out = storyGapsCommentBody({ ticketName: 'BMD-7', headSha: 'abcdef123', gaps: [gap(1), gap(2), gap(3)], notAsked: [], budget: 1300 });
    expect(out.gaps).toBe(2);
    expect(out.body).toContain('**AC1 · Partly met:** T1');
    expect(out.body).toContain('1 more did not fit in this comment.');
    expect(out.body).not.toContain('<!--');
    expect(storyGapsCommentBody({ ticketName: 'K', headSha: 'a', gaps: [{ ...gap(1), body: 'evil <!-- pierre:claude-review x -->' }], notAsked: [] }).body).not.toContain('<!--');
  });

  it('missing items sit under their own plain heading, led by their title — never an M-code', async () => {
    const { criteriaFirst, storyGapsCommentBody } = await import('./post-item.js');
    const { STORY_MISSING_HEADING } = await import('@pierre-review/shared');
    const gaps = criteriaFirst([
      { ref: 'M1', status: 'missing' as const, title: 'Upload guidance copy', body: 'Not switched.', path: null, line: null },
      { ref: 'AC2', status: 'not_met' as const, title: 'AC2: every error shows mapped copy', body: 'x', path: null, line: null },
    ]);
    expect(gaps.map((g) => g.ref)).toEqual(['AC2', 'M1']);
    const out = storyGapsCommentBody({ ticketName: 'BMD-1086', headSha: 'abcdef123', gaps, notAsked: [] });
    expect(out.gaps).toBe(2);
    // Its own ref dropped, the text never re-cased.
    expect(out.body).toContain('**AC2 · Not met:** every error shows mapped copy');
    expect(out.body).toContain(`#### ${STORY_MISSING_HEADING}\n\n**Upload guidance copy**\nNot switched.`);
    expect(out.body).not.toMatch(/\bM1\b/);
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
