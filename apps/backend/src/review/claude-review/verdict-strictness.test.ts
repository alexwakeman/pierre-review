// THE AUTO VERDICT'S TWO RULES AND THE ONE REASON (migration 0145; docs/CLAUDE-REVIEW.md § Auto-posting
// → AUTO VERDICT). Over the REAL core client and a FAKE GitHub (`ctx.review.postReview` is a recorded
// stub — nothing reaches GitHub or a model). What is pinned:
//   1. PAIR STRICTNESS on the PR 190400 shape (Claude APPROVE + Codex COMMENT, no findings): strict ⇒
//      not approved, with Codex's own first sentence as the reason; relaxed ⇒ APPROVE; relaxed with a
//      half that asked for changes ⇒ not approved.
//   2. APPROVE-WITH-LEFTOVERS: 'none' / 'nits' / 'nits_questions' with a nit or a question open, for a
//      single run and a pair; blockers and warnings always hold.
//   3. THE REASON is stored on the run's auto-post verdict record and shown on read — also when
//      auto-posting is off (computed on read, the same rule).
//   4. ON GITHUB: with nothing else to post, ONE short COMMENT review whose body is the reason + the
//      footer (the seam adds the marker), claimed before the write, at most once per (PR, head); with
//      findings, the reason is the body's last line before the footer.
//   5. SETTINGS: both rules round-trip through the one writer and the route, are logged in the
//      settings history, and the route refuses anything else.
//
//   pnpm --filter @pierre-review/backend test claude-review/verdict-strictness
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AUTO_POST_DEFAULT_KINDS,
  autoPostFooter,
  PAIR_AUTO_POST_FOOTER,
  type ClaudeFindingSeverity,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  autoVerdictFor,
  findingsNotApproved,
  leftoverAllowed,
  pairVerdict,
  repliesDissent,
  type VerdictRules,
} from './auto-verdict.js';
import { repliesNotApproved, repliesVerdict } from './replies-pass.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-verdict-strictness.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// The shape of PR 190400's two halves (runs 761 / 762).
const CLAUDE_SUMMARY = 'The fixture update matches the metric change. Nothing else moved.';
const CODEX_SUMMARY =
  'The code change is small, but the binary fixture change cannot be verified from this diff. A deeper worktree review is recommended to inspect the changed GeoPackage records.';
const CODEX_REASON = 'Not approved: Codex didn’t approve. The code change is small, but the binary fixture change cannot be verified from this diff.';

const STRICT: VerdictRules = { pairStrictness: 'strict', approveLeftovers: 'nits_questions' };
const RELAXED: VerdictRules = { pairStrictness: 'relaxed', approveLeftovers: 'nits_questions' };
const f = (severity: ClaudeFindingSeverity) => ({ severity, included: true, story: null });

describe('the rules, pure', () => {
  const runs = (a: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES', b: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES') => [
    { by: 'Claude', verdict: a, summary: CLAUDE_SUMMARY },
    { by: 'Codex', verdict: b, summary: CODEX_SUMMARY },
  ];

  it('pairVerdict: strict needs both; relaxed needs one and nobody asking for changes', () => {
    expect(pairVerdict('APPROVE', 'COMMENT')).toBe('COMMENT');
    expect(pairVerdict('APPROVE', 'COMMENT', 'strict')).toBe('COMMENT');
    expect(pairVerdict('APPROVE', 'COMMENT', 'relaxed')).toBe('APPROVE');
    expect(pairVerdict('COMMENT', 'APPROVE', 'relaxed')).toBe('APPROVE');
    expect(pairVerdict('APPROVE', 'REQUEST_CHANGES', 'relaxed')).toBe('REQUEST_CHANGES');
    expect(pairVerdict('COMMENT', 'COMMENT', 'relaxed')).toBe('COMMENT');
    // A half with no verdict at all is not "asked for nothing".
    expect(pairVerdict('APPROVE', null, 'relaxed')).toBe('COMMENT');
  });

  it('the 190400 shape: strict ⇒ not approved with Codex’s reason; relaxed ⇒ approve', () => {
    expect(autoVerdictFor(pairVerdict('APPROVE', 'COMMENT', 'strict'), [])).toBe('COMMENT');
    expect(findingsNotApproved(runs('APPROVE', 'COMMENT'), [], STRICT)).toEqual({ heldReason: 'pair_strict', text: CODEX_REASON });
    expect(autoVerdictFor(pairVerdict('APPROVE', 'COMMENT', 'relaxed'), [])).toBe('APPROVE');
    expect(findingsNotApproved(runs('APPROVE', 'COMMENT'), [], RELAXED)).toBeNull();
  });

  it('relaxed, but one half asked for changes ⇒ not approved, naming it', () => {
    expect(autoVerdictFor(pairVerdict('APPROVE', 'REQUEST_CHANGES', 'relaxed'), [])).toBe('COMMENT');
    expect(findingsNotApproved(runs('APPROVE', 'REQUEST_CHANGES'), [], RELAXED)).toEqual({
      heldReason: 'model_comment',
      text: 'Not approved: Codex asked for changes. The code change is small, but the binary fixture change cannot be verified from this diff.',
    });
    expect(findingsNotApproved(runs('COMMENT', 'COMMENT'), [], RELAXED)?.text).toBe('Not approved: neither Claude nor Codex approved.');
  });

  it('a single run that did not approve: the model’s own first sentence', () => {
    expect(findingsNotApproved([{ by: 'Claude', verdict: 'COMMENT', summary: '- a list\nLooks risky. More.' }], [], STRICT)).toEqual({
      heldReason: 'model_comment',
      text: 'Not approved: Claude didn’t approve. Looks risky.',
    });
  });

  it('blockers and warnings always hold, whatever the rules', () => {
    const one = [{ by: 'Claude', verdict: 'APPROVE' as const, summary: null }];
    expect(findingsNotApproved(one, [f('warning'), f('warning')], RELAXED)?.text).toBe('Not approved: 2 warnings are still open.');
    expect(findingsNotApproved(one, [f('blocker'), f('warning')], STRICT)?.text).toBe('Not approved: a blocker and a warning are still open.');
    expect(autoVerdictFor('APPROVE', [f('warning')], 'nits_questions')).toBe('COMMENT');
  });

  it('LEFTOVERS: none / nits / nits_questions with a nit or a question open (praise never counts)', () => {
    const one = [{ by: 'Claude', verdict: 'APPROVE' as const, summary: null }];
    const q = [f('question'), f('praise')];
    const n = [f('nit')];
    expect(autoVerdictFor('APPROVE', q, 'nits_questions')).toBe('APPROVE');
    expect(autoVerdictFor('APPROVE', q, 'nits')).toBe('COMMENT');
    expect(autoVerdictFor('APPROVE', n, 'nits')).toBe('APPROVE');
    expect(autoVerdictFor('APPROVE', n, 'none')).toBe('COMMENT');
    expect(autoVerdictFor('APPROVE', [f('praise')], 'none')).toBe('APPROVE');
    expect(findingsNotApproved(one, q, { ...STRICT, approveLeftovers: 'nits' })?.text).toBe('Not approved: a question is still open.');
    expect(findingsNotApproved(one, [...n, ...q], { ...STRICT, approveLeftovers: 'none' })?.text).toBe(
      'Not approved: a nit and a question are still open.',
    );
    expect(findingsNotApproved(one, [...n, ...q], STRICT)).toBeNull();
    expect(leftoverAllowed('warning', 'nits_questions')).toBe(false);
  });

  it('THE REPLIES OUTCOME reads both rules: leftovers and a pair half that raised nothing', () => {
    const items = [{ status: 'reply_accepted' as const, severity: 'warning' as const, title: 'W' }];
    const base = { unjudgedEarlierBlockers: 0, items };
    // A question still open: approved by default, held under 'nits' (and the hold is a HELD approval).
    expect(repliesVerdict({ ...base, open: [{ severity: 'question', title: 'Q' }] })).toBe('APPROVE');
    expect(repliesVerdict({ ...base, open: [{ severity: 'question', title: 'Q' }], leftovers: 'nits' })).toBeNull();
    expect(repliesNotApproved({ ...base, open: [{ severity: 'question', title: 'Q' }], leftovers: 'nits' })).toEqual({
      reason: { heldReason: 'open_findings', text: 'Not approved: a question is still open.' },
      held: true,
    });
    // A warning still open: not an approval, and not a held one (nothing posts for it).
    expect(repliesNotApproved({ ...base, open: [{ severity: 'warning', title: 'W2' }] })).toMatchObject({ held: false });
    // The pair: Codex said COMMENT and raised nothing; Claude's finding was the one replied to.
    const halves = [
      { by: 'Claude', verdict: 'APPROVE' as const, summary: CLAUDE_SUMMARY, raised: 1 },
      { by: 'Codex', verdict: 'COMMENT' as const, summary: CODEX_SUMMARY, raised: 0 },
    ];
    const strict = repliesDissent(halves, 'strict');
    expect(strict).toEqual({ heldReason: 'pair_strict', text: CODEX_REASON });
    expect(repliesVerdict({ ...base, open: [], dissent: strict })).toBeNull();
    expect(repliesNotApproved({ ...base, open: [], dissent: strict })).toEqual({ reason: strict, held: true });
    expect(repliesDissent(halves, 'relaxed')).toBeNull();
    expect(repliesVerdict({ ...base, open: [], dissent: repliesDissent(halves, 'relaxed') })).toBe('APPROVE');
    // Relaxed still holds for a half that asked for changes and raised nothing.
    expect(repliesDissent([halves[0]!, { ...halves[1]!, verdict: 'REQUEST_CHANGES' }], 'relaxed')?.heldReason).toBe('model_comment');
    // A half that raised findings is judged through them (the replies), never through its verdict.
    expect(repliesDissent([halves[0]!, { ...halves[1]!, raised: 2 }], 'strict')).toBeNull();
    expect(repliesDissent([halves[0]!], 'strict')).toBeNull();
  });
});

// ---- over the real DB ----

let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let ap: typeof import('./auto-post.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let na: typeof import('./not-approved.js');
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
  accountUserId: vi.fn(async () => users.me!),
  isAutomation: vi.fn(async () => false),
  impactLevel: vi.fn(async () => 'low' as const),
  settle,
});

async function makePr(author = 'alice'): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PRV_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pr ${prSeq}`, state: 'open', isDraft: false,
      headSha: 'HEAD', authorId: users[author], openedAt: new Date(), updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

type V = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

async function run(
  prId: number,
  provider: 'claude' | 'codex',
  findings: Array<{ severity: ClaudeFindingSeverity; title: string }>,
  verdict: V,
  summary: string,
  pair: { role: 'first' } | { role: 'second'; pairId: number } | null = null,
  trigger: 'auto' | 'manual' = 'auto',
): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], trigger, provider, false, pair);
  if (provider === 'codex') await persist.markReviewRanOn(ctx, id, { provider: 'codex', model: 'gpt-6.1-sol' });
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only', summary, verdict, costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1, excludedFiles: [],
    findings: findings.map((x, i) => ({
      path: 'src/a.ts', line: 10 + i * 20 + (provider === 'codex' ? 300 : 0), side: 'RIGHT' as const, severity: x.severity,
      title: x.title, body: `${x.title} — body`, suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
    })),
  });
  return id;
}

async function the190400(prId: number, trigger: 'auto' | 'manual' = 'auto', codex: V = 'COMMENT') {
  const first = await run(prId, 'claude', [], 'APPROVE', CLAUDE_SUMMARY, { role: 'first' }, trigger);
  const second = await run(prId, 'codex', [], codex, CODEX_SUMMARY, { role: 'second', pairId: first }, trigger);
  return { first, second };
}

const recordOf = async (id: number) =>
  ((await db.select({ a: schema.claudeReviews.autoPost }).from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute()) as any[])[0]?.a;

const setRules = (b: Record<string, unknown>) => settings.setWorkspaceAutoReview(ctx, 1, wsId, b as any);

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
  await db.update(schema.accounts).set({ githubLogin: 'me' }).execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  ap = await import('./auto-post.js');
  persist = await import('./persist.js');
  settings = await import('./auto-settings.js');
  na = await import('./not-approved.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding: vi.fn() },
    llm: {},
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
    postedReviewId: `R${postReview.mock.calls.length}`,
    inlineFindingIds: a.includedFindings.map((x: any) => x.id),
    prComments: [],
    commentCount: a.includedFindings.length,
    prCommentCount: 0,
  }));
  await setRules({
    pairStrictness: 'strict',
    autoPost: { enabled: true, scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS }, autoVerdict: true, approveLeftovers: 'nits_questions' },
  });
});

describe('a Claude + Codex pair, auto-posted', () => {
  it('STRICT on the 190400 shape: not approved, and the reason goes out ONCE as a short COMMENT review', async () => {
    const prId = await makePr();
    const { first, second } = await the190400(prId);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out.kind).toBe('done');
    expect(postReview).toHaveBeenCalledTimes(1);
    const sent = postReview.mock.calls[0]![0];
    expect(sent.verdict).toBe('COMMENT');
    expect(sent.includedFindings).toEqual([]);
    expect(sent.body).toBe(`${CODEX_REASON}\n\n${PAIR_AUTO_POST_FOOTER}`);
    const rec = await recordOf(second);
    expect(rec).toMatchObject({
      status: 'posted',
      reasonPosted: CODEX_REASON,
      reasonOnly: true,
      verdict: { wanted: 'COMMENT', submitted: 'COMMENT', heldReason: 'pair_strict', reasonText: CODEX_REASON },
    });
    expect(await recordOf(first)).toMatchObject({ viaPairReviewId: second, reasonOnly: true });
    // The tab's line, on read.
    const view = await persist.getReviewView(ctx, second, 1);
    expect(await na.notApprovedForView(ctx, 1, view)).toEqual({ heldReason: 'pair_strict', text: CODEX_REASON });

    // ⚠ A later run at the SAME head with the same reason posts nothing more — but still records why.
    const again = await the190400(prId);
    const out2 = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: again.second, pairFirstReviewId: again.first }, deps() as any);
    expect(out2).toMatchObject({ kind: 'skipped', reason: 'nothing_new' });
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(await recordOf(again.second)).toMatchObject({ verdict: { heldReason: 'pair_strict', reasonText: CODEX_REASON } });
    expect((await recordOf(again.second)).reasonPosted).toBeUndefined();
  });

  it('RELAXED on the same shape: APPROVE', async () => {
    await setRules({ pairStrictness: 'relaxed' });
    const prId = await makePr();
    const { first, second } = await the190400(prId);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    expect(await recordOf(second)).toMatchObject({ verdict: { wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null } });
    expect((await recordOf(second)).reasonPosted).toBeUndefined();
  });

  it('RELAXED, but one half asked for changes: not approved, the reason names it', async () => {
    await setRules({ pairStrictness: 'relaxed' });
    const prId = await makePr();
    const { first, second } = await the190400(prId, 'auto', 'REQUEST_CHANGES');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(postReview).toHaveBeenCalledTimes(1);
    const sent = postReview.mock.calls[0]![0];
    expect(sent.verdict).toBe('COMMENT');
    expect(sent.body.startsWith('Not approved: Codex asked for changes.')).toBe(true);
  });

  it('with findings to post, the reason is the body’s LAST line before the footer', async () => {
    const prId = await makePr();
    const first = await run(prId, 'claude', [{ severity: 'warning', title: 'Slow loop' }], 'APPROVE', CLAUDE_SUMMARY, { role: 'first' });
    const second = await run(prId, 'codex', [], 'APPROVE', CODEX_SUMMARY, { role: 'second', pairId: first });
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    const sent = postReview.mock.calls[0]![0];
    expect(sent.includedFindings).toHaveLength(1);
    expect(sent.body.endsWith(`\n\nNot approved: a warning is still open.\n\n${PAIR_AUTO_POST_FOOTER}`)).toBe(true);
    expect(await recordOf(second)).toMatchObject({ reasonPosted: 'Not approved: a warning is still open.' });
    expect((await recordOf(second)).reasonOnly).toBeUndefined();
  });
});

describe('a single run, and the leftovers rule', () => {
  it('a question open under "nits only": not approved, posted with the question', async () => {
    await setRules({ autoPost: { approveLeftovers: 'nits' } });
    const prId = await makePr();
    const id = await run(prId, 'claude', [{ severity: 'question', title: 'Why a map?' }], 'APPROVE', CLAUDE_SUMMARY);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: id }, deps() as any);
    const sent = postReview.mock.calls[0]![0];
    expect(sent.verdict).toBe('COMMENT');
    expect(sent.body).toBe(
      `The fixture update matches the metric change. Nothing else moved.\n\nNot approved: a question is still open.\n\n${autoPostFooter('Claude')}`,
    );
    expect(await recordOf(id)).toMatchObject({ verdict: { heldReason: 'open_findings', reasonText: 'Not approved: a question is still open.' } });
  });

  it('a nit open: approved under "nits", not under "none"', async () => {
    await setRules({ autoPost: { approveLeftovers: 'nits', kinds: { nits: true } } });
    const pa = await makePr();
    const a = await run(pa, 'claude', [{ severity: 'nit', title: 'Rename x' }], 'APPROVE', CLAUDE_SUMMARY);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pa, reviewId: a }, deps() as any);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    await setRules({ autoPost: { approveLeftovers: 'none' } });
    const pb = await makePr();
    const b = await run(pb, 'claude', [{ severity: 'nit', title: 'Rename y' }], 'APPROVE', CLAUDE_SUMMARY);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pb, reviewId: b }, deps() as any);
    expect(postReview.mock.calls[1]![0].verdict).toBe('COMMENT');
    expect(postReview.mock.calls[1]![0].body).toContain('Not approved: a nit is still open.');
    await setRules({ autoPost: { kinds: { nits: false } } });
  });

  it('a gate’s hold is the reason: High impact, posted alone when nothing else is left', async () => {
    const prId = await makePr();
    const id = await run(prId, 'claude', [], 'APPROVE', CLAUDE_SUMMARY);
    await setRules({ autoPost: { approveImpact: { high: false } } });
    const d = { ...deps(), impactLevel: vi.fn(async () => 'high' as const) };
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: id }, d as any);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0]).toMatchObject({ verdict: 'COMMENT', body: `Not approved: High impact.\n\n${autoPostFooter('Claude')}` });
    expect(await recordOf(id)).toMatchObject({ verdict: { wanted: 'APPROVE', heldReason: 'impact', reasonText: 'Not approved: High impact.' } });
    await setRules({ autoPost: { approveImpact: { high: true } } });
  });

  it('with the verdict switched OFF nothing is said and nothing extra posts', async () => {
    await setRules({ autoPost: { autoVerdict: false } });
    const prId = await makePr();
    const { first, second } = await the190400(prId);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'nothing_new' });
    expect(postReview).not.toHaveBeenCalled();
    expect(await na.notApprovedForView(ctx, 1, await persist.getReviewView(ctx, second, 1))).toBeNull();
  });
});

describe('the reason on read', () => {
  it('auto-posting OFF (verdict on): computed by the same rule and shown; nothing posts', async () => {
    await setRules({ autoPost: { enabled: false } });
    const prId = await makePr();
    const { first, second } = await the190400(prId);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: second, pairFirstReviewId: first }, deps() as any);
    expect(out.kind).toBe('off');
    expect(postReview).not.toHaveBeenCalled();
    expect(await na.notApprovedForView(ctx, 1, await persist.getReviewView(ctx, first, 1))).toEqual({
      heldReason: 'pair_strict',
      text: CODEX_REASON,
    });
    await setRules({ pairStrictness: 'relaxed' });
    expect(await na.notApprovedForView(ctx, 1, await persist.getReviewView(ctx, first, 1))).toBeNull();
  });

  it('a MANUAL run shows what the outcome would be: the model’s reason, then "your own pull request"', async () => {
    const mine = await makePr('me');
    const a = await run(mine, 'claude', [], 'APPROVE', CLAUDE_SUMMARY, null, 'manual');
    expect(await na.notApprovedForView(ctx, 1, await persist.getReviewView(ctx, a, 1))).toEqual({
      heldReason: 'own_pr',
      text: 'Not approved: your own pull request.',
    });
    const theirs = await makePr();
    const b = await run(theirs, 'claude', [], 'COMMENT', CODEX_SUMMARY, null, 'manual');
    expect((await na.notApprovedForView(ctx, 1, await persist.getReviewView(ctx, b, 1)))?.text).toBe(
      'Not approved: Claude didn’t approve. The code change is small, but the binary fixture change cannot be verified from this diff.',
    );
  });

  it('the manual pair’s suggested verdict follows the strictness (the consolidation)', async () => {
    const { consolidatePair } = await import('./pair-consolidate.js');
    const prA = await makePr();
    const a = await the190400(prA, 'manual');
    expect((await consolidatePair(ctx, { accountId: 1, prId: prA, pairId: a.first, secondId: a.second }))?.verdict).toBe('COMMENT');
    await setRules({ pairStrictness: 'relaxed' });
    const prB = await makePr();
    const b = await the190400(prB, 'manual');
    expect((await consolidatePair(ctx, { accountId: 1, prId: prB, pairId: b.first, secondId: b.second }))?.verdict).toBe('APPROVE');
  });
});

describe('the settings', () => {
  it('both rules default, round-trip through the one writer, are stored as overrides only and logged', async () => {
    const before = await settings.readWorkspaceAutoReview(ctx, 1, wsId);
    expect(before?.pairStrictness).toBe('strict');
    expect(before?.autoPost.approveLeftovers).toBe('nits_questions');
    const set = await setRules({ pairStrictness: 'relaxed', autoPost: { approveLeftovers: 'none' } });
    expect(set?.pairStrictness).toBe('relaxed');
    expect(set?.autoPost.approveLeftovers).toBe('none');
    const row = ((await db
      .select({ s: schema.workspaces.pairVerdictStrictness, l: schema.workspaces.approveLeftovers })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, wsId))
      .execute()) as any[])[0];
    expect(row).toEqual({ s: 'relaxed', l: 'none' });
    const events = ((await db.select().from(schema.workspaceSettingEvents).execute()) as any[]).map((e) => e.summary);
    expect(events).toContain('Claude + Codex verdict: relaxed (approve if one approves and neither asks for changes)');
    expect(events).toContain('Auto-approve: only with nothing open');
    // Back to the defaults ⇒ NULL again.
    await setRules({ pairStrictness: 'strict', autoPost: { approveLeftovers: 'nits_questions' } });
    const back = ((await db
      .select({ s: schema.workspaces.pairVerdictStrictness, l: schema.workspaces.approveLeftovers })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, wsId))
      .execute()) as any[])[0];
    expect(back).toEqual({ s: null, l: null });
  });

  it('the route: GET carries both, PUT writes them, anything else is a 400', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });
    settings.registerAutoReviewSettingsRoutes(app, ctx);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsId}/auto-review`,
      payload: { pairStrictness: 'relaxed', autoPost: { approveLeftovers: 'nits' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().autoReview).toMatchObject({ pairStrictness: 'relaxed', autoPost: { approveLeftovers: 'nits' } });
    const get = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/auto-review` });
    expect(get.json().autoReview).toMatchObject({ pairStrictness: 'relaxed', autoPost: { approveLeftovers: 'nits' } });
    for (const payload of [{ pairStrictness: 'loose' }, { autoPost: { approveLeftovers: 'all' } }]) {
      expect((await app.inject({ method: 'PUT', url: `/api/workspaces/${wsId}/auto-review`, payload })).statusCode).toBe(400);
    }
    await setRules({ pairStrictness: 'strict', autoPost: { approveLeftovers: 'nits_questions' } });
  });
});
