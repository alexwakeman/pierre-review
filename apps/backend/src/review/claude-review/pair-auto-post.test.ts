// AUTO-POSTING A CLAUDE + CODEX PAIR, over the REAL core client and a FAKE GitHub (nothing reaches
// GitHub — `ctx.review.postReview` is a recorded stub). What is pinned:
//   1. ONE GitHub review for both halves: one body naming both providers (+ the pair footer), every
//      included finding of both, each comment naming who raised it and carrying its own provider's
//      footer; both runs' findings stamped posted automatically;
//   2. THE CLAIM covers the pair: claimed on the SECOND run's record, the first marked
//      `viaPairReviewId`; a second call posts nothing (never twice), and a failure is recorded and
//      never retried;
//   3. THE VERDICT is computed over the UNION of both runs' findings;
//   4. THE CONSOLIDATION (pair-consolidate.ts) is what posts: its summary, each kept finding's source
//      on the severity lead ("Claude + Codex" for a merged duplicate), and a merged-away duplicate
//      never posted nor counted in the verdict.
//
//   pnpm --filter @pierre-review/backend test claude-review/pair-auto-post
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AUTO_POST_DEFAULT_KINDS, autoPostFooter, PAIR_AUTO_POST_FOOTER, type ClaudeFindingSeverity } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-claude-pair-auto-post.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let ap: typeof import('./auto-post.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let wsId = 0;
let repoId = 0;
const users: Record<string, number> = {};
let prSeq = 0;

const postReview = vi.fn();
const settle = vi.fn(async () => ({ visible: true }));
const deps = () => ({
  ...ap.defaultAutoPostDeps,
  livePr: vi.fn(async () => ({ headSha: 'HEAD', state: 'open' as const, draft: false, merged: false })),
  liveReviews: vi.fn(async () => []),
  accountLogin: vi.fn(async () => 'me'),
  impactLevel: vi.fn(async () => 'low' as const),
  settle,
});

async function makePr(author = 'alice'): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PRP_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pr ${prSeq}`, state: 'open', isDraft: false,
      headSha: 'HEAD', authorId: users[author], openedAt: new Date(), updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

async function half(
  prId: number,
  provider: 'claude' | 'codex',
  findings: Array<{ severity: ClaudeFindingSeverity; title: string; line?: number }>,
  pair: { role: 'first' } | { role: 'second'; pairId: number },
  verdict: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT',
): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'auto', provider, false, pair);
  if (provider === 'codex') await persist.markReviewRanOn(ctx, id, { provider: 'codex', model: 'gpt-6.1-sol' });
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: `${provider} found things.`,
    verdict,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    findings: findings.map((f, i) => ({
      path: 'src/a.ts', line: f.line ?? 10 + i, side: 'RIGHT' as const, severity: f.severity, title: f.title, body: `${f.title} — body`,
      suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
    })),
  });
  return id;
}

async function pairOf(
  prId: number,
  a: Array<{ severity: ClaudeFindingSeverity; title: string }>,
  b: Array<{ severity: ClaudeFindingSeverity; title: string; line?: number }>,
  verdicts: ['COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'] = ['COMMENT', 'COMMENT'],
): Promise<{ first: number; second: number }> {
  const first = await half(prId, 'claude', a, { role: 'first' }, verdicts[0]);
  const second = await half(prId, 'codex', b.map((f, i) => ({ ...f, line: f.line ?? 40 + i })), { role: 'second', pairId: first }, verdicts[1]);
  return { first, second };
}

const recordOf = async (id: number) =>
  ((await db.select({ a: schema.claudeReviews.autoPost }).from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute()) as any[])[0]?.a;

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
  for (const login of ['me', 'alice']) {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false }).returning().execute();
    users[login] = u.id;
  }
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  ap = await import('./auto-post.js');
  persist = await import('./persist.js');
  settings = await import('./auto-settings.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding: vi.fn() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  postReview.mockReset();
  settle.mockClear();
  postReview.mockImplementation(async (a: any) => ({
    postedReviewId: 'R9',
    inlineFindingIds: a.includedFindings.map((f: any) => f.id),
    prComments: [],
    commentCount: a.includedFindings.length,
    prCommentCount: 0,
  }));
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, {
    autoPost: { enabled: true, scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS }, autoVerdict: false } as any,
  });
});

describe('one review for both halves', () => {
  it('posts ONE review: both providers named, every finding of both, each naming who raised it', async () => {
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [{ severity: 'warning', title: 'Null check missing' }], [{ severity: 'blocker', title: 'Race on the cache' }]);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out.kind).toBe('done');
    expect(postReview).toHaveBeenCalledTimes(1);
    const sent = postReview.mock.calls[0]![0];
    // No consolidation stored (an older pair, or the code fallback): each half's lead, named.
    expect(sent.body).toBe(`**Claude:** claude found things.\n\n**Codex:** codex found things.\n\n${PAIR_AUTO_POST_FOOTER}`);
    expect(sent.verdict).toBe('COMMENT');
    // Who raised it rides the ONE severity lead ("**Warning** · Claude"), not a line of its own.
    expect(sent.includedFindings.map((f: any) => [f.severity, f.severityTag, f.storyLead, f.footer])).toEqual([
      ['warning', 'Claude', null, autoPostFooter('Claude')],
      ['blocker', 'Codex', null, autoPostFooter('Codex')],
    ]);
    const { findingCommentBody } = await import('../post-review.js');
    const f0 = sent.includedFindings[0];
    expect(findingCommentBody({ ...f0, editedBody: null }, { tag: f0.severityTag }).split('\n')[0]).toBe('**Warning** · Claude');
    // Claimed on the second; the first rides it.
    const recSecond = await recordOf(second);
    const recFirst = await recordOf(first);
    expect(recSecond).toMatchObject({ status: 'posted', githubReviewId: 'R9' });
    expect(recSecond.postedFindingIds).toHaveLength(2);
    expect(recFirst).toMatchObject({ status: 'posted', githubReviewId: 'R9', viaPairReviewId: second });
    // Each run's findings are stamped, automatically.
    const rows = (await db.select().from(schema.claudeReviewFindings).execute()) as any[];
    for (const id of [first, second]) {
      const mine = rows.filter((f) => f.reviewId === id);
      expect(mine.every((f) => f.postedAt != null && f.postedAuto === true)).toBe(true);
    }
    const wire = await persist.getClaudeReviewById(ctx, first, 1);
    expect(wire?.autoPost?.viaPairReviewId).toBe(second);
  });

  it('NEVER TWICE: a second call (or the first half on its own) posts nothing', async () => {
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [{ severity: 'warning', title: 'A' }], [{ severity: 'warning', title: 'B other' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    const again = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    const alone = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: first }, deps() as any);
    expect(again.kind).toBe('already_claimed');
    expect(alone.kind).toBe('already_claimed');
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('a failure is recorded on both halves and never retried', async () => {
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [{ severity: 'warning', title: 'A' }], [{ severity: 'warning', title: 'B other' }]);
    postReview.mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502 }));
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed', error: 'Bad gateway' } });
    expect(await recordOf(first)).toMatchObject({ status: 'failed', viaPairReviewId: second });
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(postReview).toHaveBeenCalledTimes(1);
  });
});

describe('the consolidated review is what posts', () => {
  it('posts the pass summary; a merged duplicate is never posted and the kept one names both', async () => {
    const prId = await makePr();
    const { first, second } = await pairOf(
      prId,
      [{ severity: 'warning', title: 'Null check missing' }],
      [{ severity: 'blocker', title: 'Missing null guard on input' }, { severity: 'warning', title: 'Slow loop' }],
    );
    const [c1] = (await persist.getClaudeReviewById(ctx, first, 1))!.findings;
    const [x1, x2] = (await persist.getClaudeReviewById(ctx, second, 1))!.findings;
    // The pass said c1 and x1 are the same point; code kept the blocker.
    await persist.savePairConsolidation(ctx, first, [first, second], {
      how: 'pass',
      summary: 'One review of both.\nMore detail.',
      verdict: 'REQUEST_CHANGES',
      sourceOf: { [String(x1!.id)]: 'both', [String(x2!.id)]: 'codex' },
      mergedFrom: { [String(c1!.id)]: x1!.id },
      failedHalf: null,
      at: '2026-10-28T00:00:00.000Z',
    });
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out.kind).toBe('done');
    const sent = postReview.mock.calls[0]![0];
    expect(sent.body).toBe(`One review of both.\n\n${PAIR_AUTO_POST_FOOTER}`);
    expect(sent.includedFindings.map((f: any) => [f.id, f.severityTag])).toEqual([
      [x1!.id, 'Claude + Codex'],
      [x2!.id, 'Codex'],
    ]);
    // The merged-away one is still stored, never posted.
    const row = ((await db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.id, c1!.id)).execute()) as any[])[0];
    expect(row.mergedInto).toBe(x1!.id);
    expect(row.postedAt).toBeNull();
  });

  it('a merged-away blocker is not counted in the verdict', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { autoVerdict: true } as any });
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [{ severity: 'blocker', title: 'Race' }], [{ severity: 'question', title: 'Why?' }], ['APPROVE', 'APPROVE']);
    const [c1] = (await persist.getClaudeReviewById(ctx, first, 1))!.findings;
    const [x1] = (await persist.getClaudeReviewById(ctx, second, 1))!.findings;
    // (A merge the pass could never make — code keeps the most severe — written directly to pin the read.)
    await persist.savePairConsolidation(ctx, first, [first, second], {
      how: 'pass', summary: 'S.', verdict: 'APPROVE', sourceOf: { [String(x1!.id)]: 'both' },
      mergedFrom: { [String(c1!.id)]: x1!.id }, failedHalf: null, at: '',
    });
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    expect(postReview.mock.calls[0]![0].includedFindings.map((f: any) => f.id)).toEqual([x1!.id]);
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { autoVerdict: false } as any });
  });
});

describe('lifting Limn\'s own block after a pair', () => {
  it('a merged-away blocker never holds the block; every half carrying the post is scanned', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { autoVerdict: true } as any });
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [{ severity: 'blocker', title: 'Race on the cache' }], [{ severity: 'blocker', title: 'Unsynchronised cache write' }]);
    const [c1] = (await persist.getClaudeReviewById(ctx, first, 1))!.findings;
    const [x1] = (await persist.getClaudeReviewById(ctx, second, 1))!.findings;
    await persist.savePairConsolidation(ctx, first, [first, second], {
      how: 'pass', summary: 'S.', verdict: 'REQUEST_CHANGES', sourceOf: { [String(x1!.id)]: 'both' },
      mergedFrom: { [String(c1!.id)]: x1!.id }, failedHalf: null, at: '',
    });
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(postReview.mock.calls[0]![0].verdict).toBe('REQUEST_CHANGES');
    expect(await recordOf(first)).toMatchObject({ githubReviewId: 'R9' });
    // The merged-away Claude blocker was never posted — its kept Codex finding was. Nothing unposted.
    expect(await ap.loadUnpostedBlockersOfBlock(ctx, 1, prId, 'R9', [])).toEqual([]);
    // A blocker of the SECOND half that did not reach GitHub is still found (both halves carry R9).
    await db.update(schema.claudeReviewFindings).set({ postedAt: null }).where(eq(schema.claudeReviewFindings.id, x1!.id)).execute();
    expect(await ap.loadUnpostedBlockersOfBlock(ctx, 1, prId, 'R9', [])).toEqual([x1!.id]);
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { autoVerdict: false } as any });
  });
});

describe('the verdict over the union', () => {
  beforeEach(async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { autoVerdict: true } as any });
  });

  it('a blocker in EITHER half ⇒ REQUEST_CHANGES, though the other approved', async () => {
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [], [{ severity: 'blocker', title: 'Race on the cache' }], ['APPROVE', 'COMMENT']);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out).toMatchObject({ kind: 'done', record: { verdict: { wanted: 'REQUEST_CHANGES', submitted: 'REQUEST_CHANGES' } } });
    expect(postReview.mock.calls[0]![0].verdict).toBe('REQUEST_CHANGES');
  });

  it('APPROVE only when BOTH approved and neither left a warning', async () => {
    const prA = await makePr();
    const a = await pairOf(prA, [{ severity: 'question', title: 'Why a map?' }], [], ['APPROVE', 'APPROVE']);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: prA, reviewId: a.second, pairFirstReviewId: a.first }, deps() as any);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');

    const prB = await makePr();
    const b = await pairOf(prB, [], [{ severity: 'warning', title: 'Slow loop' }], ['APPROVE', 'APPROVE']);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: prB, reviewId: b.second, pairFirstReviewId: b.first }, deps() as any);
    expect(postReview.mock.calls[1]![0].verdict).toBe('COMMENT');

    const prC = await makePr();
    const c = await pairOf(prC, [{ severity: 'question', title: 'Why a map?' }], [], ['APPROVE', 'COMMENT']);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: prC, reviewId: c.second, pairFirstReviewId: c.first }, deps() as any);
    expect(postReview.mock.calls[2]![0].verdict).toBe('COMMENT');
  });
});

describe('the routes: Claude + Codex start, Post (one review)', () => {
  const app = async (signedIn: { claude: boolean; codex: boolean }) => {
    const { default: Fastify } = await import('fastify');
    const { registerClaudeReviewRoutes } = await import('./routes.js');
    const a = Fastify({ logger: false });
    const c = {
      ...ctx,
      llm: {
        detectAuth: () => ({ status: 'ok' }),
        detectProviderAuth: (p: 'claude' | 'codex') => (signedIn[p] ? { status: 'ok' } : { status: 'none', message: 'no' }),
      },
    } as any as AgentContext;
    registerClaudeReviewRoutes(a, c);
    return a;
  };

  it('a pair with one provider signed out is refused with one sentence; a non-boolean is a 400', async () => {
    const a = await app({ claude: true, codex: false });
    const r = await a.inject({ method: 'POST', url: '/api/prs/1/claude-review', payload: { pair: true } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'PairUnavailable', message: 'Claude + Codex needs both signed in.' });
    const bad = await a.inject({ method: 'POST', url: '/api/prs/1/claude-review', payload: { pair: 'true' } });
    expect(bad.statusCode).toBe(400);
  });

  it('Post on a pair sends ONE review with both runs’ findings and stamps each run (either half’s id, either path)', async () => {
    const prId = await makePr();
    const { first, second } = await pairOf(prId, [{ severity: 'warning', title: 'Null check missing' }], [{ severity: 'nit', title: 'Rename x' }]);
    await persist.updateReviewDraft(ctx, second, { userBody: 'My summary.' });
    postReview.mockImplementation(async (args: any) => ({
      postedReviewId: 'R77',
      inlineFindingIds: args.includedFindings.map((f: any) => f.id),
      inlineComments: [],
      prComments: [],
      commentCount: args.includedFindings.length,
      prCommentCount: 0,
    }));
    const a = await app({ claude: true, codex: true });
    const r = await a.inject({ method: 'POST', url: `/api/claude-reviews/${first}/post-pair`, payload: { userVerdict: 'COMMENT' } });
    expect(r.statusCode).toBe(200);
    expect(postReview).toHaveBeenCalledTimes(1);
    const sent = postReview.mock.calls[0]![0];
    // The reader's draft — the pair's one review has one draft (on its latest half).
    expect(sent.body).toBe('My summary.');
    expect(sent.includedFindings.map((f: any) => [f.severityTag, f.storyLead])).toEqual([
      ['Claude', null],
      ['Codex', null],
    ]);
    for (const id of [first, second]) {
      const rev = await persist.getClaudeReviewById(ctx, id, 1);
      expect(rev?.postedReviewId).toBe('R77');
      expect(rev?.findings.every((f) => f.postedAt != null)).toBe(true);
    }
  });

  it('a pair still running cannot be posted (409); a merged-away finding cannot be posted alone (409)', async () => {
    const prId = await makePr();
    const first = await half(prId, 'claude', [{ severity: 'warning', title: 'A' }], { role: 'first' });
    const second = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'manual', 'codex', false, { role: 'second', pairId: first });
    const a = await app({ claude: true, codex: true });
    const r = await a.inject({ method: 'POST', url: `/api/claude-reviews/${second}/post`, payload: { userVerdict: 'COMMENT' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('PairIncomplete');

    const prB = await makePr();
    const p = await pairOf(prB, [{ severity: 'warning', title: 'Same point' }], [{ severity: 'warning', title: 'Same point again' }]);
    const [c1] = (await persist.getClaudeReviewById(ctx, p.first, 1))!.findings;
    const [x1] = (await persist.getClaudeReviewById(ctx, p.second, 1))!.findings;
    await persist.savePairConsolidation(ctx, p.first, [p.first, p.second], {
      how: 'pass', summary: 'S.', verdict: 'COMMENT', sourceOf: { [String(x1!.id)]: 'both' },
      mergedFrom: { [String(c1!.id)]: x1!.id }, failedHalf: null, at: '',
    });
    const one = await a.inject({ method: 'POST', url: `/api/claude-findings/${c1!.id}/post`, payload: {} });
    expect(one.statusCode).toBe(409);
    expect(one.json().error).toBe('MergedDuplicate');
  });
});
