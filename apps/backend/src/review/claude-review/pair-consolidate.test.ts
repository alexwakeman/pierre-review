// CLAUDE + CODEX AS ONE REVIEW — the consolidation step (pair-consolidate.ts) and the consolidated view
// (pair-view.ts), over the REAL core client and migrations with a FAKE completion (no model runs).
// What is pinned:
//   1. the pass's answer is VALIDATED in code: unknown ids, a finding in two groups, a kept id outside
//      its group, a group of one, no summary, bad JSON ⇒ refused (the fallback);
//   2. code chooses what is kept: a posted finding, else the most severe (never a blocker merged into a
//      nit); a group spanning both providers keeps a 'both' source;
//   3. THE FALLBACKS: the pass throws, answers invalid JSON, or its input is over the cap (no call) ⇒
//      joined in code; no completion on the context ⇒ joined in code, never a live call;
//   4. one half failed ⇒ that half IS the review, with the other named; never started ⇒ named why;
//      both failed ⇒ nothing written;
//   5. the VERDICT is code over the consolidated set (a merged-away finding never counts);
//   6. the VIEW: one review, one id (the latest half), both halves' findings with their source, a
//      merged-away duplicate never read (nor in AI Fix's seed, nor in the Open PRs column);
//   7. the NEXT follow-up of a merged-away finding's provider follows up the KEPT one, never re-raises
//      it as new.
//
//   pnpm --filter @pierre-review/backend test claude-review/pair-consolidate
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ClaudeFindingSeverity } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { CheapCompleteOpts } from '../llm.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-pair-consolidate.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let pc: typeof import('./pair-consolidate.js');
let repoId = 0;
let prSeq = 0;
const usage: any[] = [];

async function makePr(): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PRC_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pr ${prSeq}`, state: 'open', isDraft: false,
      headSha: 'HEAD', openedAt: new Date(), updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

type F = { severity: ClaudeFindingSeverity; title: string; line?: number };

async function half(
  prId: number,
  provider: 'claude' | 'codex',
  findings: F[],
  pair: { role: 'first' } | { role: 'second'; pairId: number },
  o: { verdict?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; fail?: string; head?: string } = {},
): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, o.head ?? 'HEAD', 'claude-opus-5-5' as any, 1, [], 'manual', provider, false, pair);
  if (provider === 'codex') await persist.markReviewRanOn(ctx, id, { provider: 'codex', model: 'gpt-6.1-sol' });
  if (o.fail != null) {
    await persist.markReviewFailed(ctx, id, o.fail);
    return id;
  }
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: `${provider} summary.`,
    verdict: o.verdict ?? 'COMMENT',
    costUsd: provider === 'claude' ? 1.5 : 0,
    inputTokens: 10,
    outputTokens: 5,
    numTurns: 1,
    excludedFiles: [],
    findings: findings.map((f, i) => ({
      path: 'src/a.ts', line: f.line ?? (provider === 'claude' ? 10 : 40) + i, side: 'RIGHT' as const, severity: f.severity,
      title: f.title, body: `${f.title} — body`, suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
    })),
  });
  return id;
}

async function pairOf(a: F[], b: F[], o: { verdicts?: ['COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'] } = {}) {
  const prId = await makePr();
  const first = await half(prId, 'claude', a, { role: 'first' }, { verdict: o.verdicts?.[0] });
  const second = await half(prId, 'codex', b, { role: 'second', pairId: first }, { verdict: o.verdicts?.[1] });
  const ids = async (id: number) => (await persist.getClaudeReviewById(ctx, id, 1))!.findings.map((f) => f.id);
  return { prId, first, second, a: await ids(first), b: await ids(second) };
}

const answer = (groups: Array<{ ids: number[]; keep: number }>, summary = 'One summary.') =>
  JSON.stringify({ duplicateGroups: groups, summary });

const completeWith = (text: string | (() => never)) =>
  vi.fn(async (_o: CheapCompleteOpts) => {
    if (typeof text === 'function') text();
    return { text: text as string, usage: { inputTokens: 100, outputTokens: 50 } };
  });

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'pc', githubNodeId: 'R_pc' }).returning().execute();
  repoId = r.id;
  persist = await import('./persist.js');
  pc = await import('./pair-consolidate.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async (row: any) => {
      usage.push(row);
    },
    accountIdOf: () => 1,
    llm: { detectAuth: () => ({ status: 'ok' }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('the pass answer is validated in code', () => {
  const known = new Set([1, 2, 3, 4]);
  it('accepts a valid answer (and one wrapped in a code fence)', () => {
    expect(pc.parseConsolidation(answer([{ ids: [1, 3], keep: 3 }]), known)).toEqual({
      groups: [{ ids: [1, 3], keep: 3 }],
      summary: 'One summary.',
    });
    expect(pc.parseConsolidation('```json\n' + answer([]) + '\n```', known)).toEqual({ groups: [], summary: 'One summary.' });
  });
  it('refuses unknown ids, overlapping groups, a kept id outside its group, a group of one, no summary, bad JSON', () => {
    expect(pc.parseConsolidation(answer([{ ids: [1, 9], keep: 1 }]), known)).toBeNull();
    expect(pc.parseConsolidation(answer([{ ids: [1, 2], keep: 1 }, { ids: [2, 3], keep: 3 }]), known)).toBeNull();
    expect(pc.parseConsolidation(answer([{ ids: [1, 2], keep: 4 }]), known)).toBeNull();
    expect(pc.parseConsolidation(answer([{ ids: [1], keep: 1 }]), known)).toBeNull();
    expect(pc.parseConsolidation(answer([{ ids: [1, 1], keep: 1 }]), known)).toBeNull();
    expect(pc.parseConsolidation(answer([], ''), known)).toBeNull();
    expect(pc.parseConsolidation(answer([], 'x'.repeat(pc.PAIR_MERGE_SUMMARY_MAX + 1)), known)).toBeNull();
    expect(pc.parseConsolidation('{"duplicateGroups": [', known)).toBeNull();
    expect(pc.parseConsolidation('no json here', known)).toBeNull();
  });
});

describe('what code keeps', () => {
  const f = (id: number, source: 'claude' | 'codex', severity: ClaudeFindingSeverity, posted = false) => ({
    id, source, severity, path: 'a', line: 1, title: 't', body: 'b', posted,
  });
  it('the more severe one, Claude’s on a tie; a group across both providers is "both"', () => {
    const out = pc.applyDuplicateGroups([f(1, 'claude', 'nit'), f(2, 'codex', 'blocker'), f(3, 'claude', 'warning'), f(4, 'codex', 'warning')], [
      { ids: [1, 2], keep: 1 },
      { ids: [3, 4], keep: 4 },
    ]);
    expect(out.mergedFrom).toEqual({ '1': 2, '3': 4 });
    expect(out.sourceOf).toEqual({ '2': 'both', '4': 'both' });
    const tie = pc.applyDuplicateGroups([f(5, 'codex', 'warning'), f(6, 'claude', 'warning'), f(7, 'codex', 'nit')], [{ ids: [5, 6, 7], keep: 7 }]);
    expect(tie.mergedFrom).toEqual({ '5': 6, '7': 6 });
    expect(tie.sourceOf).toEqual({ '6': 'both' });
  });
  it('a posted finding is kept; two posted findings are left alone', () => {
    expect(pc.applyDuplicateGroups([f(1, 'claude', 'blocker', true), f(2, 'codex', 'nit')], [{ ids: [1, 2], keep: 2 }]).mergedFrom).toEqual({ '2': 1 });
    expect(pc.applyDuplicateGroups([f(1, 'claude', 'warning', true), f(2, 'codex', 'warning')], [{ ids: [1, 2], keep: 2 }]).mergedFrom).toEqual({ '2': 1 });
    expect(pc.applyDuplicateGroups([f(1, 'claude', 'nit', true), f(2, 'codex', 'nit', true)], [{ ids: [1, 2], keep: 2 }]).mergedFrom).toEqual({});
  });
  it('a posted warning and an unposted blocker are both left: a blocker is never merged into something milder', () => {
    const out = pc.applyDuplicateGroups([f(1, 'claude', 'warning', true), f(2, 'codex', 'blocker')], [{ ids: [1, 2], keep: 1 }]);
    expect(out.mergedFrom).toEqual({});
    expect(out.sourceOf).toEqual({ '1': 'claude', '2': 'codex' });
  });
  it('the prompt is null over its cap', () => {
    const big = Array.from({ length: 200 }, (_, i) => f(i + 1, 'claude', 'warning'));
    const long = big.map((x) => ({ ...x, body: 'y'.repeat(pc.PAIR_MERGE_BODY_CHARS), title: 'z'.repeat(150) }));
    expect(pc.pairMergePrompt(long, [], 'n0nce')).toBeNull();
    expect(pc.pairMergePrompt(big.slice(0, 2), [{ provider: 'claude', summary: 's', verdict: 'COMMENT' }], 'n0nce')).toContain('---BEGIN FINDING 1 n0nce---');
  });
});

describe('consolidating a pair (DB)', () => {
  it('both succeeded ⇒ the pass: duplicates merged, the summary stored, the verdict in code, usage recorded', async () => {
    const p = await pairOf(
      [{ severity: 'warning', title: 'Null check missing' }, { severity: 'nit', title: 'Rename x' }],
      [{ severity: 'warning', title: 'Missing null guard' }, { severity: 'question', title: 'Why a map?' }],
      { verdicts: ['APPROVE', 'APPROVE'] },
    );
    const complete = completeWith(answer([{ ids: [p.a[0]!, p.b[0]!], keep: p.b[0]! }], 'The lookup can crash on a missing user.'));
    usage.length = 0;
    const rec = await pc.consolidatePair(ctx, { accountId: 1, prId: p.prId, pairId: p.first, secondId: p.second }, { complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0]).toMatchObject({ model: pc.PAIR_MERGE_CLAUDE_MODEL, role: 'standard' });
    expect(rec).toMatchObject({
      how: 'pass',
      summary: 'The lookup can crash on a missing user.',
      mergedFrom: { [String(p.a[0])]: p.b[0] },
      failedHalf: null,
      // Both approved, but a warning is left ⇒ COMMENT (code, never the model).
      verdict: 'COMMENT',
    });
    expect(rec!.sourceOf[String(p.b[0])]).toBe('both');
    expect(usage).toEqual([expect.objectContaining({ feature: pc.PAIR_MERGE_FEATURE, seam: 'summary', prId: p.prId })]);
    // The duplicate stays stored, marked; never read as a finding.
    const row = ((await db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.id, p.a[0])).execute()) as any[])[0];
    expect(row.mergedInto).toBe(p.b[0]);
    expect((await persist.getClaudeReviewById(ctx, p.first, 1))!.findings.map((f) => f.id)).toEqual([p.a[1]]);

    // THE VIEW: one review, the latest half's id, both halves' findings with their source.
    for (const id of [p.first, p.second]) {
      const v = (await persist.getReviewView(ctx, id, 1))!;
      expect(v.id).toBe(p.second);
      expect(v.status).toBe('succeeded');
      expect(v.summary).toBe('The lookup can crash on a missing user.');
      expect(v.verdict).toBe('COMMENT');
      expect(v.findings.map((f) => [f.id, f.source])).toEqual([
        [p.a[1], 'claude'],
        [p.b[0], 'both'],
        [p.b[1], 'codex'],
      ]);
      expect(v.pair).toMatchObject({ pairId: p.first, how: 'pass', failedHalf: null, verdict: 'COMMENT' });
      expect(v.pair!.halves!.map((h) => [h.reviewId, h.provider])).toEqual([
        [p.first, 'claude'],
        [p.second, 'codex'],
      ]);
      expect(v.costUsd).toBe(1.5);
    }
    // The history: counts leave the duplicate out; both rows carry the pair's verdict.
    const hist = await persist.listClaudeReviewHistory(ctx, p.prId, 1);
    expect(hist.map((h) => [h.id, h.findingCount, h.pair?.verdict])).toEqual([
      [p.second, 2, 'COMMENT'],
      [p.first, 1, 'COMMENT'],
    ]);
    // The Open PRs column: one review, both halves' findings, the duplicate left out.
    const [st] = await persist.getLatestReviewStates(ctx, [p.prId], 1);
    expect(st).toMatchObject({ reviewId: p.second, status: 'succeeded', verdict: 'COMMENT' });
    expect(st!.summary!.findings).toMatchObject({ warning: 1, nit: 1, question: 1 });
  });

  it('the AI Fix seed is the consolidated set (a merged-away finding is never sent)', async () => {
    const p = await pairOf([{ severity: 'warning', title: 'Same point' }], [{ severity: 'warning', title: 'Same point again' }, { severity: 'warning', title: 'Other' }]);
    for (const id of [...p.a, ...p.b]) await persist.updateFinding(ctx, id, { included: true });
    await pc.consolidatePair(ctx, { accountId: 1, prId: p.prId, pairId: p.first, secondId: p.second }, {
      complete: completeWith(answer([{ ids: [p.a[0]!, p.b[0]!], keep: p.a[0]! }])),
    });
    const { buildReviewSeed } = await import('../../coding/ai-fix/review-seed.js');
    const view = (await persist.getReviewView(ctx, p.second, 1))!;
    const seed = buildReviewSeed(view, { nonce: () => 'n0nce' });
    const ids = seed.items.filter((i) => i.kind === 'finding').map((i) => i.findingId);
    expect(ids.sort()).toEqual([p.a[0], p.b[1]].sort());
  });

  it('the pass throws, answers invalid JSON, or is over its cap ⇒ joined in code (a failure never fails the pair)', async () => {
    const thrown = await pairOf([{ severity: 'nit', title: 'A' }], [{ severity: 'nit', title: 'B' }]);
    const rec1 = await pc.consolidatePair(ctx, { accountId: 1, prId: thrown.prId, pairId: thrown.first, secondId: thrown.second }, {
      complete: completeWith(() => {
        throw new Error('overloaded');
      }),
    });
    expect(rec1).toMatchObject({ how: 'code', mergedFrom: {}, summary: '**Claude:** claude summary.\n\n**Codex:** codex summary.' });

    const bad = await pairOf([{ severity: 'nit', title: 'A' }], [{ severity: 'nit', title: 'B' }]);
    const rec2 = await pc.consolidatePair(ctx, { accountId: 1, prId: bad.prId, pairId: bad.first, secondId: bad.second }, {
      complete: completeWith(answer([{ ids: [bad.a[0]!, 999999], keep: bad.a[0]! }])),
    });
    expect(rec2).toMatchObject({ how: 'code', mergedFrom: {} });

    const big = await pairOf(
      Array.from({ length: 60 }, (_, i) => ({ severity: 'nit' as const, title: `${'t'.repeat(150)} ${i}`, line: i + 1 })),
      Array.from({ length: 60 }, (_, i) => ({ severity: 'nit' as const, title: `${'u'.repeat(150)} ${i}`, line: i + 1 })),
    );
    await db.update(schema.claudeReviewFindings).set({ body: 'b'.repeat(400) }).execute();
    const complete = completeWith(answer([]));
    const rec3 = await pc.consolidatePair(ctx, { accountId: 1, prId: big.prId, pairId: big.first, secondId: big.second }, { complete });
    expect(complete).not.toHaveBeenCalled();
    expect(rec3).toMatchObject({ how: 'code' });

    // No completion on the context (a test's fake) ⇒ code, never a live call.
    const none = await pairOf([{ severity: 'nit', title: 'A' }], [{ severity: 'nit', title: 'B' }]);
    expect(await pc.consolidatePair(ctx, { accountId: 1, prId: none.prId, pairId: none.first, secondId: none.second })).toMatchObject({ how: 'code' });
  });

  it('a pass that answers after the timeout is joined in code, and its usage is still recorded', async () => {
    const p = await pairOf([{ severity: 'nit', title: 'A' }], [{ severity: 'nit', title: 'B' }]);
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    const complete = vi.fn(async () => {
      await late;
      return { text: answer([]), usage: { inputTokens: 100, outputTokens: 50 } };
    });
    usage.length = 0;
    const rec = await pc.consolidatePair(ctx, { accountId: 1, prId: p.prId, pairId: p.first, secondId: p.second }, { complete: complete as any, timeoutMs: 5 });
    expect(rec).toMatchObject({ how: 'code' });
    expect(usage).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(usage).toEqual([expect.objectContaining({ feature: pc.PAIR_MERGE_FEATURE, prId: p.prId })]));
  });

  it('one half failed ⇒ that half is the review, the other named; never started ⇒ why; both failed ⇒ nothing', async () => {
    const prId = await makePr();
    const first = await half(prId, 'claude', [{ severity: 'blocker', title: 'Race' }], { role: 'first' }, { verdict: 'REQUEST_CHANGES' });
    const second = await half(prId, 'codex', [], { role: 'second', pairId: first }, { fail: 'You have hit your usage limit. Try again later.' });
    const complete = completeWith(answer([]));
    const rec = await pc.consolidatePair(ctx, { accountId: 1, prId, pairId: first, secondId: second }, { complete });
    expect(complete).not.toHaveBeenCalled();
    expect(rec).toMatchObject({
      how: 'single',
      summary: 'claude summary.',
      verdict: 'REQUEST_CHANGES',
      failedHalf: { provider: 'codex', reason: 'You have hit your usage limit' },
    });
    const v = (await persist.getReviewView(ctx, first, 1))!;
    expect(v).toMatchObject({ id: second, status: 'succeeded', summary: 'claude summary.', verdict: 'REQUEST_CHANGES' });
    expect(v.pair!.failedHalf).toEqual({ provider: 'codex', reason: 'You have hit your usage limit' });
    expect(v.findings).toHaveLength(1);
    // The auto-post ran on the first half (the second failed): the view shows THAT record.
    await db
      .update(schema.claudeReviews)
      .set({ autoPost: { status: 'failed', at: '2026-10-28T00:00:00.000Z', reason: null, error: 'The PR changed since this review.', findingIds: [], postedFindingIds: [], githubReviewId: null } })
      .where(eq(schema.claudeReviews.id, first))
      .execute();
    expect((await persist.getReviewView(ctx, second, 1))!.autoPost).toMatchObject({ status: 'failed', error: 'The PR changed since this review.' });

    const prB = await makePr();
    const firstB = await half(prB, 'claude', [{ severity: 'nit', title: 'A' }], { role: 'first' });
    const recB = await pc.consolidatePair(ctx, {
      accountId: 1, prId: prB, pairId: firstB, secondId: null, notStarted: pc.notStartedHalf('codex', 'budget'),
    });
    expect(recB).toMatchObject({ how: 'single', failedHalf: { provider: 'codex', reason: 'the spend budget is used up' } });

    const prC = await makePr();
    const firstC = await half(prC, 'claude', [], { role: 'first' }, { fail: 'boom' });
    const secondC = await half(prC, 'codex', [], { role: 'second', pairId: firstC }, { fail: 'bang' });
    expect(await pc.consolidatePair(ctx, { accountId: 1, prId: prC, pairId: firstC, secondId: secondC })).toBeNull();
    const rows = (await db.select().from(schema.claudeReviews).where(eq(schema.claudeReviews.id, firstC)).execute()) as any[];
    expect(rows[0].pairConsolidation).toBeNull();
    expect((await persist.getReviewView(ctx, secondC, 1))!.status).toBe('failed');
  });

  it('a merged-away blocker never counts in the verdict', async () => {
    const p = await pairOf([{ severity: 'question', title: 'Q' }], [{ severity: 'question', title: 'Q too' }], { verdicts: ['APPROVE', 'APPROVE'] });
    const rec = await pc.consolidatePair(ctx, { accountId: 1, prId: p.prId, pairId: p.first, secondId: p.second }, {
      complete: completeWith(answer([{ ids: [p.a[0]!, p.b[0]!], keep: p.a[0]! }])),
    });
    expect(rec).toMatchObject({ verdict: 'APPROVE', mergedFrom: { [String(p.b[0])]: p.a[0] } });
  });
});

describe('the next follow-up of a merged-away finding', () => {
  it('follows up the KEPT finding (carried into that provider’s chain), never the duplicate', async () => {
    const p = await pairOf([{ severity: 'warning', title: 'Null check missing' }], [{ severity: 'warning', title: 'Missing null guard' }]);
    await pc.consolidatePair(ctx, { accountId: 1, prId: p.prId, pairId: p.first, secondId: p.second }, {
      complete: completeWith(answer([{ ids: [p.a[0]!, p.b[0]!], keep: p.b[0]! }])),
    });
    // The kept finding was posted (the pair's one review).
    await persist.markFindingPosted(ctx, p.b[0]!, 'C1', 'inline');
    // The next head: Claude's follow-up chain.
    const next = await half(p.prId, 'claude', [], { role: 'first' }, { head: 'HEAD2' });
    const prior = await persist.loadPriorReviewForFollowUp(ctx, p.prId, 1, next, new Set(), 'claude');
    expect(prior?.reviewId).toBe(p.first);
    expect(prior!.findings.map((f) => [f.id, f.carried])).toEqual([[p.b[0], true]]);
    expect((prior!.leftOut ?? []).map((l) => l.priorFindingId)).not.toContain(p.a[0]);
    // A PAIR half does not carry it: the kept finding's own provider (the other half) judges it, so
    // the two halves never judge — resolve and dispute — one thread twice.
    const inPair = await persist.loadPriorReviewForFollowUp(ctx, p.prId, 1, next, new Set(), 'claude', true);
    expect(inPair?.reviewId).toBe(p.first);
    expect(inPair!.findings).toEqual([]);
    const codexNext = await persist.loadPriorReviewForFollowUp(ctx, p.prId, 1, next, new Set(), 'codex', true);
    expect(codexNext!.findings.map((f) => [f.id, f.carried])).toEqual([[p.b[0], false]]);
  });

  it('the second half’s code dedupe drops a re-raise of the SAME earlier finding', async () => {
    const { isPairRepeat } = await import('./pair.js');
    expect(isPairRepeat({ path: 'a', line: 1, title: 'x', priorFindingId: 7 }, { path: 'b', line: 90, title: 'y', priorFindingId: 7 })).toBe(true);
    expect(isPairRepeat({ path: 'a', line: 1, title: 'x', priorFindingId: 7 }, { path: 'b', line: 90, title: 'y', priorFindingId: 8 })).toBe(false);
  });
});
