import { SPRINT_BRIEF_MODEL, SPRINT_CODE_JUDGE_BATCH, SPRINT_CODE_JUDGE_RUN_CAP } from '@pierre-review/shared';
import { config } from '../../config.js';
import { storeSprintCodeJudgement, type SprintCodeJudgeInput, type StoredSprintCodeJudgement } from '../../db/sprint-code-judgements.js';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import type { AgentContext } from '../agent-context.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { cheapUsage } from '../cheap-usage.js';
import { labelCostUsd, type CompleteFn } from '../story-labels/manager.js';
import { codeJudgeMaxTokens, SPRINT_CODE_SYSTEM, sprintCodePrompt, sprintCodeUntrusted, type CodeJudgeTicket } from './prompt.js';
import { validateSprintCode } from './validate.js';

// THE "NEEDS CODE" PASS (docs/CLAUDE-REVIEW.md § Sprint code judgements). LOCAL ONLY and agentic: a step
// of the sprint read's AFTER-READ CHAIN (review/sprint-briefs/index.ts), which only
// `registerAgenticRoutes` sets. Never on a view.
//
//   • WHAT: the sprint tickets the graph fold ASKS about (`sprintCodeAsked`: Not started, no pull
//     request) with no CURRENT judgement (db/sprint-graph.ts `sprintCodeJudgeTodo`), ≤
//     SPRINT_CODE_JUDGE_RUN_CAP per pass. A judgement is current while the ticket's TEXT hash and
//     SPRINT_CODE_JUDGE_VERSION match, so an unchanged sprint costs nothing.
//   • ONE `cheapComplete` PER BATCH of ≤ SPRINT_CODE_JUDGE_BATCH tickets (the brief model, on the ACTIVE
//     provider, tool-less), the batch's missing answers retried ONCE. Every call's cost is recorded
//     (`recordAiUsage`, feature 'sprint_code') with the provider and model that ran; each stored row
//     carries its share.
//   • AUTOMATIC runs ask THE BUDGET GATE first (`automaticRunAllowed`) and are SKIPPED when over; the
//     reader's own Refresh (`manual`) is never refused.
//   • ONE PASS PER (account, workspace), claimed SYNCHRONOUSLY; a second call while one runs is 'busy'
//     (the next read calls again). A missing credential or AI runtime stops the pass. Never throws.

export interface SprintCodeTodo {
  ident: string;
  key: string;
  input: SprintCodeJudgeInput;
}

export interface SprintCodeSeams {
  aiEnabled?: boolean;
  complete?: CompleteFn;
  todo?: (accountId: number, workspaceId: number, cap: number) => Promise<SprintCodeTodo[]>;
  store?: (accountId: number, workspaceId: number, t: SprintCodeTodo, j: StoredSprintCodeJudgement) => Promise<void>;
}

export interface SprintCodePassResult {
  state: 'off' | 'no_credential' | 'over_budget' | 'busy' | 'done' | 'failed';
  judged: number;
  /** Tickets sent and left without an answer. */
  missed: number;
  calls: number;
  costUsd: number;
}

const running = new Set<string>();
const keyOf = (a: number, w: number): string => `${a}:${w}`;

/** Test seam. */
export function resetSprintCodePasses(): void {
  running.clear();
}

const empty = (state: SprintCodePassResult['state']): SprintCodePassResult => ({ state, judged: 0, missed: 0, calls: 0, costUsd: 0 });

/** Judge this workspace's not-started tickets that have no current judgement. Never throws. */
export async function runSprintCodePass(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage' | 'aiBudget'>,
  accountId: number,
  workspaceId: number,
  opts: { manual?: boolean } = {},
  seams: SprintCodeSeams = {},
): Promise<SprintCodePassResult> {
  if (!(seams.aiEnabled ?? config.aiEnabled)) return empty('off');
  const k = keyOf(accountId, workspaceId);
  // ⚠ CLAIMED SYNCHRONOUSLY — no await between the check and the claim.
  if (running.has(k)) return empty('busy');
  running.add(k);
  const res = empty('done');
  try {
    if (ctx.llm.detectAuth('complete').status !== 'ok') return { ...res, state: 'no_credential' };
    if (opts.manual !== true && !(await automaticRunAllowed(ctx, accountId, 'sprint code judgements'))) return { ...res, state: 'over_budget' };
    const todoOf =
      seams.todo ?? (async (a: number, w: number, cap: number) => (await import('../../db/sprint-graph.js')).sprintCodeJudgeTodo(a, w, cap));
    const todo = await todoOf(accountId, workspaceId, SPRINT_CODE_JUDGE_RUN_CAP);
    if (todo.length === 0) return res;
    const store =
      seams.store ?? ((a: number, w: number, t: SprintCodeTodo, j: StoredSprintCodeJudgement) => storeSprintCodeJudgement(a, w, t.ident, t.input.textHash, j));
    const complete: CompleteFn = seams.complete ?? (await import('../llm.js')).cheapComplete;
    for (let i = 0; i < todo.length; i += SPRINT_CODE_JUDGE_BATCH) {
      let left = todo.slice(i, i + SPRINT_CODE_JUDGE_BATCH);
      for (let attempt = 0; attempt < 2 && left.length > 0; attempt += 1) {
        const tickets: CodeJudgeTicket[] = left.map((t) => ({ key: t.key, input: t.input }));
        const nonce = pickReviewNonce(sprintCodeUntrusted(tickets));
        const out = await complete({
          model: SPRINT_BRIEF_MODEL,
          system: SPRINT_CODE_SYSTEM,
          prompt: sprintCodePrompt(tickets, nonce),
          maxTokens: codeJudgeMaxTokens(tickets.length),
        });
        res.calls += 1;
        const u = cheapUsage(out, SPRINT_BRIEF_MODEL, labelCostUsd);
        res.costUsd += u.costUsd;
        await ctx
          .recordAiUsage({ accountId, seam: 'summary', feature: 'sprint_code', ...u })
          .catch((err) => ctx.log.warn({ err }, 'sprint code: usage record failed'));
        const v = validateSprintCode(
          out.text,
          left.map((t) => t.key),
        );
        if (!v.ok) {
          ctx.log.info({ accountId, reason: v.reason, attempt }, 'sprint code: answer refused by validation');
          continue;
        }
        const n = Math.max(1, v.judgements.size);
        for (const t of left) {
          const j = v.judgements.get(t.key);
          if (j == null) continue;
          await store(accountId, workspaceId, t, {
            needsCode: j.needsCode,
            reason: j.reason,
            costUsd: u.costUsd / n,
            inputTokens: Math.round((u.inputTokens ?? 0) / n),
            outputTokens: Math.round((u.outputTokens ?? 0) / n),
            model: u.model,
            provider: u.provider,
          });
          res.judged += 1;
        }
        left = left.filter((t) => !v.judgements.has(t.key));
      }
      res.missed += left.length;
    }
    if (res.judged > 0) ctx.log.info({ accountId, workspaceId, judged: res.judged, costUsd: res.costUsd }, 'sprint code: stored');
    return res;
  } catch (err) {
    if (!(err instanceof AiRuntimeMissingError)) ctx.log.warn({ accountId, workspaceId, err: String(err).slice(0, 200) }, 'sprint code: pass threw');
    return { ...res, state: 'failed' };
  } finally {
    running.delete(k);
  }
}
