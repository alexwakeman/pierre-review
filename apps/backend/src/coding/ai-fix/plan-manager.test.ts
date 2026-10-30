// AI Fix PLAN MODE — the manager (manager.ts startPlan / sendPlanMessage / approvePlan): the first
// pass, a steering message re-planning with the whole chat, and "Approve and build" handing the plan
// to the build's prompt. The persistence layer and the PR lookup are mocked; the agent runs are fakes.
//
//   pnpm --filter @pierre-review/backend test plan-manager
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiFixPlan } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { config } from '../../config.js';
import { aiFixes as aiFixesTable } from '../../db/schema.sqlite.js';

const PR = { prId: 0, repoId: 3, owner: 'acme', name: 'app', number: 12, repoFullName: 'acme/app', title: 'Fix auth', body: null };
vi.mock('./pr-context.js', () => ({
  getFixPrContext: vi.fn(async (_c: unknown, _a: number, prId: number) => ({ ...PR, prId })),
}));

const PLAN: AiFixPlan = {
  revision: 1,
  summary: ['Guard the null user'],
  steps: [{ title: 'Null guard', files: ['src/auth.ts'], change: 'Return early when user is null.', refs: [] }],
  notAddressed: [],
  notCovered: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let row: any = null;
const calls = {
  insert: vi.fn(async (..._a: unknown[]) => 101),
  savePlan: vi.fn(async (..._a: unknown[]) => true),
  ended: vi.fn(async (..._a: unknown[]) => {}),
  append: vi.fn(async (..._a: unknown[]) => true),
  approved: vi.fn(async (..._a: unknown[]) => true),
  fixRanOn: vi.fn(async (..._a: unknown[]) => {}),
  planRanOn: vi.fn(async (..._a: unknown[]) => {}),
};
vi.mock('./persist.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./persist.js')>();
  return {
    insertQueuedFix: (...a: unknown[]) => calls.insert(...a),
    getFixById: vi.fn(async () => row),
    savePlanSuccess: (...a: unknown[]) => calls.savePlan(...a),
    markPlanPassEnded: (...a: unknown[]) => calls.ended(...a),
    appendPlanMessage: (...a: unknown[]) => calls.append(...a),
    markPlanApproved: (...a: unknown[]) => calls.approved(...a),
    markPlanDiscarded: vi.fn(async () => true),
    markFixCancelled: vi.fn(async () => {}),
    markFixFailed: vi.fn(async () => {}),
    markFixRunning: vi.fn(async () => {}),
    markFixRanOn: (...a: unknown[]) => calls.fixRanOn(...a),
    markPlanRanOn: (...a: unknown[]) => calls.planRanOn(...a),
    saveFixSuccess: vi.fn(async () => {}),
    reconcileOrphanedFixes: vi.fn(async () => 0),
    parseReviewItems: real.parseReviewItems,
    parseChecks: real.parseChecks,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function fakeCtx(over: { generatePlan?: Any; generateFix?: Any } = {}): AgentContext {
  return {
    log: { warn: vi.fn(), info: vi.fn() },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    github: {
      fetchPrHeadInfo: vi.fn(async () => ({ headSha: 'head2' })),
      fetchPrDiff: vi.fn(async () => ''),
    },
    coding: {
      generatePlan:
        over.generatePlan ??
        vi.fn(async () => ({
          plan: { summary: ['Guard the null user'], steps: [{ title: 'Null guard', change: 'Return early.' }], reply: 'Done as asked.' },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
          costUsd: 0.3,
          numTurns: 4,
          aborted: false,
        })),
      generateFix: over.generateFix ?? vi.fn(() => new Promise(() => {})),
    },
  } as Any as AgentContext;
}

const readyRow = (prId: number, over: Record<string, unknown> = {}) => ({
  id: 500 + prId,
  accountId: 1,
  prId,
  status: 'planned',
  planStatus: 'plan_ready',
  planRevision: 1,
  plan: JSON.stringify(PLAN),
  planSeed: JSON.stringify({ kind: 'plain', text: 'Fix the null user crash' }),
  planTranscript: JSON.stringify([]),
  planCostUsd: 0.5,
  model: 'claude-sonnet-5',
  baseSha: 'head1',
  reviewItems: null,
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(calls)) f.mockClear();
  row = null;
});

describe('startPlan — "Plan first"', () => {
  it('opens a plan row with its frozen seed and runs a READ-ONLY plan pass, never the build', async () => {
    const { startPlan } = await import('./manager.js');
    const ctx = fakeCtx();
    const r = await startPlan(ctx, { accountId: 1, prId: 11, model: 'claude-opus-5-5', seed: 'plain', instruction: 'Fix the null user crash' });
    expect(r).toEqual({ status: 'queued', fixId: 101 });
    expect(calls.insert.mock.calls[0]?.[1]).toMatchObject({
      trigger: 'manual',
      planSeed: { kind: 'plain', text: 'Fix the null user crash' },
    });
    await vi.waitFor(() => expect(calls.savePlan).toHaveBeenCalled());
    const gp = (ctx.coding.generatePlan as Any).mock.calls[0][0];
    expect(gp.systemPrompt).toContain('Your job is to PLAN a code fix');
    expect(gp.prompt).toContain('Fix the null user crash');
    expect(gp.shownRefs).toEqual([]);
    expect(gp.model).toBe('claude-opus-5-5');
    expect(gp.maxBudgetUsd).toBe(config.aiFixBudgetUsd);
    // Default effort (nothing chosen): Opus at medium, sent and stamped on the plan pass.
    expect(gp.effort).toBe('medium');
    expect((calls.planRanOn.mock.calls.at(-1) as Any)[2]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(ctx.coding.generateFix).not.toHaveBeenCalled();
    // Revision 1, and the first pass answers no message.
    const saved = calls.savePlan.mock.calls[0]?.[2] as Any;
    expect(saved.plan.revision).toBe(1);
    expect(saved.reply).toBeNull();
    expect(saved.costUsd).toBe(0.3);
  });

  it('a first pass that hands in no plan ends the row as failed', async () => {
    const { startPlan, subscribeFixStream } = await import('./manager.js');
    const done: string[] = [];
    subscribeFixStream(12, (e) => {
      if (e.type === 'done') done.push(e.status);
    });
    const ctx = fakeCtx({
      generatePlan: vi.fn(async () => ({ plan: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0.1, numTurns: 1, aborted: false })),
    });
    await startPlan(ctx, { accountId: 1, prId: 12, model: 'm', seed: 'plain', instruction: 'x' });
    await vi.waitFor(() => expect(done).toEqual(['failed']));
    expect(calls.ended.mock.calls[0]?.[2]).toMatchObject({ kind: 'failed' });
  });
});

describe('sendPlanMessage — steering re-plans with the whole chat', () => {
  it('appends the message and runs a fresh pass with the seed, the previous plan and the transcript', async () => {
    const { sendPlanMessage } = await import('./manager.js');
    row = readyRow(21, {
      planTranscript: JSON.stringify([
        { role: 'reader', text: 'Keep the public API', revision: 0, at: '' },
        { role: 'claude', text: 'Kept it.', revision: 1, at: '' },
      ]),
    });
    const ctx = fakeCtx();
    const r = await sendPlanMessage(ctx, { accountId: 1, fixId: row.id, text: 'Also add a regression test' });
    expect(r).toEqual({ status: 'queued', fixId: row.id });
    expect(calls.append.mock.calls[0]?.[2]).toMatchObject({ role: 'reader', text: 'Also add a regression test', revision: 1 });
    await vi.waitFor(() => expect(calls.savePlan).toHaveBeenCalled());
    const gp = (ctx.coding.generatePlan as Any).mock.calls[0][0];
    expect(gp.prompt).toContain('Fix the null user crash'); // the frozen seed
    expect(gp.prompt).toContain('PREVIOUS PLAN'); // the previous plan, context only
    expect(gp.prompt).toContain('- Guard the null user');
    expect(gp.prompt).toContain('Keep the public API'); // the whole chat, oldest first
    expect(gp.prompt).toContain('Also add a regression test');
    expect(gp.prompt.indexOf('Keep the public API')).toBeLessThan(gp.prompt.indexOf('Also add a regression test'));
    expect(gp.baseSha).toBe('head1'); // the commit the plan was made at
    expect(gp.maxBudgetUsd).toBeCloseTo(config.aiFixBudgetUsd - 0.5);
    const saved = calls.savePlan.mock.calls[0]?.[2] as Any;
    expect(saved.plan.revision).toBe(2);
    expect(saved.reply).toBe('Done as asked.');
  });

  it('one pass at a time per PR: a second message while a pass runs is refused', async () => {
    const { sendPlanMessage } = await import('./manager.js');
    row = readyRow(22);
    let release: (v: unknown) => void = () => {};
    const ctx = fakeCtx({ generatePlan: vi.fn(() => new Promise((r) => (release = r))) });
    const a = await sendPlanMessage(ctx, { accountId: 1, fixId: row.id, text: 'one' });
    const b = await sendPlanMessage(ctx, { accountId: 1, fixId: row.id, text: 'two' });
    expect(a.status).toBe('queued');
    expect(b.status).toBe('already_running');
    // Let the pass finish so the one global slot is free for the tests below.
    release({ plan: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: null, numTurns: null, aborted: true });
    await vi.waitFor(() => expect(calls.ended).toHaveBeenCalled());
  });

  it('refuses a plan that is not waiting, one at its revision cap, and one out of budget', async () => {
    const { sendPlanMessage } = await import('./manager.js');
    const ctx = fakeCtx();
    row = readyRow(23, { planStatus: 'approved', status: 'queued' });
    expect((await sendPlanMessage(ctx, { accountId: 1, fixId: 1, text: 'x' })).status).toBe('not_ready');
    row = readyRow(23, { planRevision: 12 });
    expect((await sendPlanMessage(ctx, { accountId: 1, fixId: 1, text: 'x' })).status).toBe('revision_cap');
    row = readyRow(23, { planCostUsd: config.aiFixBudgetUsd });
    expect((await sendPlanMessage(ctx, { accountId: 1, fixId: 1, text: 'x' })).status).toBe('budget_spent');
    expect(calls.append).not.toHaveBeenCalled();
  });
});

// The stream's snapshot (getFixStatus) reads the latest row for the PR; a fake db hands back the
// row under test with its PERSISTED status ('planned' while a plan is open).
function withRowDb(ctx: AgentContext, persisted: { id: number; status: string }): AgentContext {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    execute: async () => [persisted],
  };
  return { ...(ctx as Any), db: chain, schema: { aiFixes: aiFixesTable } } as Any as AgentContext;
}

describe('a plan action is live from its first tick', () => {
  it('approve: a snapshot taken while GitHub is asked reads queued, and a bail ends that stream', async () => {
    const { approvePlan, getFixStatus, subscribeFixStream } = await import('./manager.js');
    row = readyRow(41);
    let answer: (v: { headSha: string | null }) => void = () => {};
    const base = fakeCtx();
    (base.github.fetchPrHeadInfo as Any) = vi.fn(() => new Promise((r) => (answer = r)));
    const ctx = withRowDb(base, { id: row.id, status: 'planned' });
    const done: string[] = [];
    subscribeFixStream(41, (e) => {
      if (e.type === 'done') done.push(e.status);
    });
    const p = approvePlan(ctx, { accountId: 1, fixId: row.id });
    await vi.waitFor(() => expect(base.github.fetchPrHeadInfo).toHaveBeenCalled());
    expect((await getFixStatus(ctx, 1, 41)).status).toBe('queued');
    answer({ headSha: null });
    expect((await p).status).toBe('no_head');
    // The stream that read 'queued' is told the row is still the plan.
    expect(done).toEqual(['planned']);
    expect((await getFixStatus(ctx, 1, 41)).status).toBe('planned');
  });

  it('a steering message: a snapshot during the diff fetch reads queued (planning), not the stored plan', async () => {
    const { sendPlanMessage, getFixStatus } = await import('./manager.js');
    row = readyRow(42);
    let answer: (v: string) => void = () => {};
    const base = fakeCtx({
      generatePlan: vi.fn(async () => ({
        plan: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: null,
        numTurns: null,
        aborted: true,
      })),
    });
    (base.github.fetchPrDiff as Any) = vi.fn(() => new Promise((r) => (answer = r)));
    const ctx = withRowDb(base, { id: row.id, status: 'planned' });
    const p = sendPlanMessage(ctx, { accountId: 1, fixId: row.id, text: 'Smaller change please' });
    await vi.waitFor(() => expect(base.github.fetchPrDiff).toHaveBeenCalled());
    const snap = await getFixStatus(ctx, 1, 42);
    expect(snap.status).toBe('queued');
    expect(snap.progress?.phase).toBe('planning');
    answer('');
    expect((await p).status).toBe('queued');
    await vi.waitFor(() => expect(calls.ended).toHaveBeenCalled());
  });
});

describe('a pass that ends early still records what it spent', () => {
  it('a cancelled pass hands its spend to the row (recorded, and counted against the budget)', async () => {
    const { sendPlanMessage } = await import('./manager.js');
    row = readyRow(43);
    const ctx = fakeCtx({
      generatePlan: vi.fn(async () => ({
        plan: null,
        usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0.21,
        numTurns: null,
        aborted: true,
      })),
    });
    await sendPlanMessage(ctx, { accountId: 1, fixId: row.id, text: 'x' });
    await vi.waitFor(() => expect(calls.ended).toHaveBeenCalled());
    expect(calls.ended.mock.calls[0]?.[2]).toEqual({ kind: 'cancelled' });
    expect(calls.ended.mock.calls[0]?.[3]).toMatchObject({ costUsd: 0.21 });
  });

  it('a pass that THROWS passes on the spend the agent attached to the error', async () => {
    const { sendPlanMessage } = await import('./manager.js');
    const { withPartialSpend } = await import('../partial-spend.js');
    row = readyRow(44);
    const ctx = fakeCtx({
      generatePlan: vi.fn(async () => {
        throw withPartialSpend(new Error('SDK fell over'), { usage: { inputTokens: 500, outputTokens: 20 }, costUsd: 0.12 });
      }),
    });
    await sendPlanMessage(ctx, { accountId: 1, fixId: row.id, text: 'x' });
    await vi.waitFor(() => expect(calls.ended).toHaveBeenCalled());
    expect(calls.ended.mock.calls[0]?.[2]).toMatchObject({ kind: 'failed', message: 'SDK fell over' });
    expect(calls.ended.mock.calls[0]?.[3]).toMatchObject({ costUsd: 0.12 });
  });
});

describe('approvePlan — "Approve and build"', () => {
  // (Before the next test: its build never finishes, and holds the one fix slot for the file.)
  it('"Run tests" ticked when the plan started: the build runs the same checks', async () => {
    const { approvePlan } = await import('./manager.js');
    row = readyRow(33, { checks: JSON.stringify({ requested: ['test', 'lint'], ran: false }) });
    const ctx = fakeCtx({ generateFix: vi.fn(async () => { throw new Error('stop here'); }) });
    expect((await approvePlan(ctx, { accountId: 1, fixId: row.id })).status).toBe('queued');
    await vi.waitFor(() => expect(ctx.coding.generateFix).toHaveBeenCalled());
    const gf = (ctx.coding.generateFix as Any).mock.calls.at(-1)[0];
    expect(gf.checks).toEqual(['test', 'lint']);
    expect(gf.systemPrompt).toContain('run_check tool, by NAME only');
    expect(gf.systemPrompt).toContain('You have NO shell here');
  });

  it('a plan without "Run tests" builds without checks, its prompt unchanged', async () => {
    const { approvePlan } = await import('./manager.js');
    row = readyRow(34);
    const ctx = fakeCtx({ generateFix: vi.fn(async () => { throw new Error('stop here'); }) });
    await approvePlan(ctx, { accountId: 1, fixId: row.id });
    await vi.waitFor(() => expect(ctx.coding.generateFix).toHaveBeenCalled());
    const gf = (ctx.coding.generateFix as Any).mock.calls.at(-1)[0];
    expect(gf).not.toHaveProperty('checks');
    expect(gf.systemPrompt).toContain('Nothing is installed, built or tested here');
  });

  it('the SAME row runs the normal build with the approved plan as the agreed brief, on the current head', async () => {
    const { approvePlan } = await import('./manager.js');
    row = readyRow(31);
    const ctx = fakeCtx();
    // The build reads Settings → AI → Effort when it starts.
    const { setStoredAiEffort } = await import('../../ai/effort.js');
    setStoredAiEffort('xhigh');
    const r = await approvePlan(ctx, { accountId: 1, fixId: row.id });
    expect(r).toEqual({ status: 'queued', fixId: row.id });
    const [, id, args] = calls.approved.mock.calls[0] as Any;
    expect(id).toBe(row.id);
    expect(args.baseSha).toBe('head2');
    expect(args.prompt).toContain('The agreed plan.');
    expect(args.prompt).toMatch(/---BEGIN AGREED PLAN [0-9a-f]+---/);
    expect(args.prompt).toContain('1. Null guard (src/auth.ts)');
    await vi.waitFor(() => expect(ctx.coding.generateFix).toHaveBeenCalled());
    const gf = (ctx.coding.generateFix as Any).mock.calls[0][0];
    expect(gf.prompt).toBe(args.prompt);
    expect(gf.systemPrompt).toContain('You have NO shell here');
    expect(gf.baseSha).toBe('head2');
    expect(gf.effort).toBe('xhigh');
    expect((calls.fixRanOn.mock.calls.at(-1) as Any)[2]).toMatchObject({ effort: 'xhigh' });
    setStoredAiEffort(null);
    expect(ctx.coding.generatePlan).not.toHaveBeenCalled();
  });

  it('only a plan that is ready can be approved', async () => {
    const { approvePlan } = await import('./manager.js');
    row = readyRow(32, { planStatus: 'planning' });
    expect((await approvePlan(fakeCtx(), { accountId: 1, fixId: row.id })).status).toBe('not_ready');
    row = null;
    expect((await approvePlan(fakeCtx(), { accountId: 1, fixId: 1 })).status).toBe('not_found');
  });
});
