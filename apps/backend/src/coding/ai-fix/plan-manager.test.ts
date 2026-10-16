// AI Fix PLAN MODE — the manager (manager.ts startPlan / sendPlanMessage / approvePlan): the first
// pass, a steering message re-planning with the whole chat, and "Approve and build" handing the plan
// to the build's prompt. The persistence layer and the PR lookup are mocked; the agent runs are fakes.
//
//   pnpm --filter @pierre-review/backend test plan-manager
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiFixPlan } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { config } from '../../config.js';

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
    saveFixSuccess: vi.fn(async () => {}),
    reconcileOrphanedFixes: vi.fn(async () => 0),
    parseReviewItems: real.parseReviewItems,
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

describe('approvePlan — "Approve and build"', () => {
  it('the SAME row runs the normal build with the approved plan as the agreed brief, on the current head', async () => {
    const { approvePlan } = await import('./manager.js');
    row = readyRow(31);
    const ctx = fakeCtx();
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
