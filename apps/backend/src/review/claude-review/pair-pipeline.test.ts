// CLAUDE + CODEX, end to end through the review manager over the REAL core client and migrations,
// with a fake prepare and a fake model (no model runs, nothing reaches GitHub). What is pinned:
//   1. SEQUENCING: Claude runs first; Codex starts only once Claude's run has ENDED — and still runs
//      when Claude's failed (without pair input);
//   2. the pair input (Claude's findings) is in the SECOND run's prompt only;
//   3. the code dedupe drops Codex's repeat of a Claude finding and counts it on Codex's row;
//   4. two ordinary rows, each labelled by its own provider, linked as a pair (wire + history);
//   5. one provider signed in ⇒ just that one runs, no pair;
//   6. an AUTO pair (workspace "Claude + Codex"): ONE auto-post call for both halves, and ONE Slack
//      signal, at the pair's end;
//   7. THE CONSOLIDATION runs at the pair's end, BEFORE the auto hooks: the merge pass (a fake
//      completion on the context) when both succeeded — stored, and the latest review reads as ONE —
//      and the code consolidation naming the failed half otherwise.
//
//   pnpm --filter @pierre-review/backend test claude-review/pair-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-pair-pipeline.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;
process.env.LIMN_AI_PROVIDER = 'claude';

// The auto hooks are recorded, never run (auto-post has its own tests: pair-auto-post.test.ts).
const autoPostCalls: Array<Record<string, unknown>> = [];
vi.mock('./auto-post.js', () => ({
  maybeAutoPostReview: async (_ctx: unknown, a: Record<string, unknown>) => {
    autoPostCalls.push(a);
    return { kind: 'off' };
  },
}));
const signals: Array<{ reviewId: number; trigger: string }> = [];
vi.mock('../../platform/event-hooks.js', () => ({
  emitClaudeReviewCompleted: (e: { reviewId: number; trigger: string }) => signals.push(e),
}));
vi.mock('../../sonar/post.js', () => ({ maybeAutoPostSonar: async () => {} }));
vi.mock('../../coding/ai-fix/auto-fix.js', () => ({ maybeStartAutoFix: async () => ({ status: 'not_own' }) }));
vi.mock('../diagrams/trigger.js', () => ({ maybeDrawDiagramsAfterReview: async () => {} }));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));

const HEAD = 'e'.repeat(40);
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n');

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let repoId = 0;
let wsId = 0;
let prSeq = 0;
const signedIn = { claude: true, codex: true };

// Each runReview call, in order; the Claude run can be held open by a gate.
const calls: Array<{ provider: string; prompt: string; startedAt: number }> = [];
const ended: Array<{ provider: string; endedAt: number }> = [];
let clock = 0;
let claudeGate: Promise<void> | null = null;
let claudeFails = false;
const mergeCalls: Array<{ prompt: string; autoPostsSoFar: number }> = [];

const finding = (title: string, line: number) => ({
  path: 'src/a.ts', line, side: 'RIGHT', severity: 'warning', title, body: `${title}.`, suggestion: null, diffHunk: null,
  anchored: true, fileInDiff: true,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    llm: {
      // The merge pass's one-shot (a fake: no model runs). Records when it ran, for the ordering check.
      complete: async (o: { prompt: string }) => {
        mergeCalls.push({ prompt: o.prompt, autoPostsSoFar: autoPostCalls.length });
        return { text: JSON.stringify({ duplicateGroups: [], summary: 'Merged summary.' }) };
      },
      detectAuth: () => ({ status: 'ok' }),
      detectProviderAuth: (p: 'claude' | 'codex') => (signedIn[p] ? { status: 'ok' } : { status: 'none', message: 'no' }),
    },
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF,
        promptDiff: DIFF,
        changedFiles: ['src/a.ts'],
        excludedFiles: [],
        omittedFiles: [],
        fileMetrics: [{ path: 'src/a.ts', additions: 2, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length,
        diffCapped: false,
      }),
      runReview: async (args: RunReviewArgs): Promise<RunReviewResult> => {
        const provider = args.provider ?? 'claude';
        calls.push({ provider, prompt: args.prompt, startedAt: (clock += 1) });
        if (provider === 'claude' && claudeGate) await claudeGate;
        const done = (r: any): RunReviewResult => {
          ended.push({ provider, endedAt: (clock += 1) });
          return r as RunReviewResult;
        };
        if (provider === 'claude' && claudeFails) {
          return done({
            submitted: false, failureReason: 'usage limit', ranOn: { provider, model: args.model }, costUsd: null,
            inputTokens: null, outputTokens: null, numTurns: 1, aborted: false,
          });
        }
        return done({
          submitted: true,
          ranOn: { provider, model: provider === 'codex' ? 'gpt-6.1-sol' : args.model },
          scope: 'diff_only',
          summary: `${provider} summary`,
          verdict: 'COMMENT',
          findings:
            provider === 'claude'
              ? [finding('Null check missing on the user lookup', 10)]
              : [finding('Missing null check on user lookup', 11), finding('Off-by-one in the page count', 30)],
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          numTurns: 1,
          aborted: false,
        });
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  settings = await import('./auto-settings.js');
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  repoId = (
    await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'pair', githubNodeId: 'R_pair' }).returning().execute()
  )[0].id as number;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  calls.length = 0;
  ended.length = 0;
  autoPostCalls.length = 0;
  signals.length = 0;
  claudeGate = null;
  claudeFails = false;
  mergeCalls.length = 0;
  signedIn.claude = true;
  signedIn.codex = true;
});

async function newPr(): Promise<number> {
  prSeq += 1;
  return (
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_pair_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pair ${prSeq}`, state: 'open', isDraft: false,
        openedAt: new Date(), updatedAt: new Date(), headSha: HEAD, files: [{ path: 'src/a.ts', additions: 2, deletions: 0 }],
      })
      .returning()
      .execute()
  )[0].id as number;
}

/** Wait until the PR has no run in flight and `rows` rows exist; answer them oldest first. */
async function settled(prId: number, rows: number): Promise<ClaudeReview[]> {
  for (let i = 0; i < 300; i++) {
    const history = await persist.listClaudeReviewHistory(ctx, prId, 1);
    const status = await manager.getReviewStatus(ctx, 1, prId);
    if (history.length >= rows && status.status !== 'running' && status.status !== 'queued') {
      await new Promise((r) => setTimeout(r, 30));
      const out: ClaudeReview[] = [];
      for (const h of [...history].reverse()) out.push((await persist.getClaudeReviewById(ctx, h.id, 1))!);
      return out;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the pair did not finish');
}

describe('a manual pair', () => {
  it('runs Claude, then Codex only after Claude ended; Codex is shown Claude’s findings; the repeat is dropped', async () => {
    const prId = await newPr();
    let open!: () => void;
    claudeGate = new Promise((r) => (open = r));
    const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5', 'codex', { pair: true });
    expect(started.ok).toBe(true);
    for (let i = 0; i < 300 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    // Claude is running; Codex has not started.
    expect(calls.map((c) => c.provider)).toEqual(['claude']);
    const status = await manager.getReviewStatus(ctx, 1, prId);
    expect(status.pair).toEqual({ role: 'first', provider: 'claude' });
    open();
    const [first, second] = await settled(prId, 2);
    expect(calls.map((c) => c.provider)).toEqual(['claude', 'codex']);
    // Codex started after Claude ENDED.
    expect(calls[1]!.startedAt).toBeGreaterThan(ended[0]!.endedAt);
    // The pair input is on the second run only.
    expect(calls[0]!.prompt).not.toContain('Already raised');
    expect(calls[1]!.prompt).toContain('## Already raised by Claude in this review');
    expect(calls[1]!.prompt).toContain('Null check missing on the user lookup');
    // Two ordinary rows, each its own provider, linked.
    expect(first).toMatchObject({ provider: 'claude', status: 'succeeded', pair: { role: 'first', pairId: first!.id, otherReviewId: second!.id } });
    expect(second).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      status: 'succeeded',
      pair: { role: 'second', pairId: first!.id, otherReviewId: first!.id, dropped: 1 },
    });
    // The code dedupe: Codex's repeat is gone, its new point stays.
    expect(second!.findings.map((f) => f.title)).toEqual(['Off-by-one in the page count']);
    const history = await persist.listClaudeReviewHistory(ctx, prId, 1);
    expect(history.map((h) => h.pair?.role)).toEqual(['second', 'first']);
    // A manual pair reaches no auto hook.
    expect(autoPostCalls).toEqual([]);
    // THE CONSOLIDATION: one merge pass at the pair's end; the latest review reads as ONE.
    expect(mergeCalls).toHaveLength(1);
    const latest = await persist.getLatestClaudeReview(ctx, prId, 1);
    expect(latest).toMatchObject({ id: second!.id, status: 'succeeded', summary: 'Merged summary.', pair: { how: 'pass' } });
    expect(latest!.findings.map((f) => [f.title, f.source])).toEqual([
      ['Null check missing on the user lookup', 'claude'],
      ['Off-by-one in the page count', 'codex'],
    ]);
    expect((await manager.getReviewStatus(ctx, 1, prId)).status).toBe('succeeded');
  });

  it('a failed first half: the second still runs, without pair input', async () => {
    const prId = await newPr();
    claudeFails = true;
    await manager.startReview(ctx, 1, prId, 'claude-opus-5-5', 'claude', { pair: true });
    const [first, second] = await settled(prId, 2);
    expect(first).toMatchObject({ status: 'failed', provider: 'claude' });
    expect(second!.error ?? null).toBeNull();
    expect(second).toMatchObject({ status: 'succeeded', provider: 'codex' });
    expect(calls[1]!.prompt).not.toContain('Already raised');
    expect(second!.findings).toHaveLength(2);
    // One half ⇒ no pass; that half IS the review, the other named.
    expect(mergeCalls).toHaveLength(0);
    const latest = await persist.getLatestClaudeReview(ctx, prId, 1);
    expect(latest).toMatchObject({ status: 'succeeded', summary: 'codex summary', pair: { how: 'single', failedHalf: { provider: 'claude', reason: 'usage limit' } } });
  });

  it('one provider signed in ⇒ that one alone, no pair', async () => {
    const prId = await newPr();
    signedIn.claude = false;
    await manager.startReview(ctx, 1, prId, 'claude-opus-5-5', 'claude', { pair: true });
    const runs = await settled(prId, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ provider: 'codex', status: 'succeeded' });
    expect(runs[0]!.pair ?? null).toBeNull();
    expect(calls.map((c) => c.provider)).toEqual(['codex']);
  });
});

describe('an auto pair', () => {
  it('the workspace setting runs a pair; ONE auto post (both halves) and ONE Slack signal at its end', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoReviewProviders: 'both' });
    expect((await settings.readWorkspaceAutoReview(ctx, 1, wsId))!.autoReviewProviders).toBe('both');
    const prId = await newPr();
    expect(manager.enqueueAutoReview(ctx, 1, prId, wsId)).toBe('queued');
    const [first, second] = await settled(prId, 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(first).toMatchObject({ trigger: 'auto', provider: 'claude', pair: { role: 'first' } });
    expect(second).toMatchObject({ trigger: 'auto', provider: 'codex', pair: { role: 'second' } });
    expect(autoPostCalls).toEqual([{ accountId: 1, prId, reviewId: second!.id, pairFirstReviewId: first!.id }]);
    expect(signals.map((s) => s.reviewId)).toEqual([second!.id]);
    // The merge ran BEFORE the auto post.
    expect(mergeCalls.map((m) => m.autoPostsSoFar)).toEqual([0]);
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoReviewProviders: 'default' });
  });

  it('a failed second half: the first half posts alone', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoReviewProviders: 'both' });
    const prId = await newPr();
    const orig = ctx.review.runReview;
    (ctx.review as any).runReview = async (args: RunReviewArgs) => {
      if (args.provider === 'codex') {
        return { submitted: false, failureReason: 'usage limit', ranOn: { provider: 'codex', model: 'gpt-6.1-sol' }, costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1, aborted: false } as any;
      }
      return orig(args);
    };
    try {
      manager.enqueueAutoReview(ctx, 1, prId, wsId);
      const [first, second] = await settled(prId, 2);
      await new Promise((r) => setTimeout(r, 50));
      expect(second).toMatchObject({ status: 'failed' });
      expect(autoPostCalls).toEqual([{ accountId: 1, prId, reviewId: first!.id }]);
      expect(signals.map((s) => s.reviewId)).toEqual([first!.id]);
    } finally {
      (ctx.review as any).runReview = orig;
      await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoReviewProviders: 'default' });
    }
  });
});
