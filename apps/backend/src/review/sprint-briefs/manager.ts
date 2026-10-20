import { setSprintPassRunning } from '../../db/sprint-pass-flights.js';
import { SPRINT_BRIEF_MODEL, SPRINT_BRIEF_RUN_CAP, SPRINT_GHOST_DEPTH_MAX, type TrackerProvider } from '@pierre-review/shared';
import { config } from '../../config.js';
import { storeSprintBrief, type SprintBriefInput, type StoredSprintBrief } from '../../db/sprint-briefs.js';
import { expandGhostsAfterBriefs } from '../../tracker/sprint/hooks.js';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import type { AgentContext } from '../agent-context.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { labelCostUsd, type CompleteFn } from '../story-labels/manager.js';
import { briefMaxTokens, SPRINT_BRIEF_SYSTEM, sprintBriefPrompt, sprintBriefUntrusted } from './prompt.js';
import { validateSprintBrief } from './validate.js';

// THE SPRINT BRIEF PASS (docs/CLAUDE-REVIEW.md § Sprint briefs). LOCAL ONLY and agentic: it is started
// by the sprint read's after-read seam, which only `registerAgenticRoutes` sets (cloud: never).
//
//   • WHAT: the graph's NODES with no CURRENT brief (db/sprint-graph.ts `sprintBriefTodo` — the same
//     fold the page draws): the sprint's tickets first, then ghosts by depth. ≤ SPRINT_BRIEF_RUN_CAP
//     per pass.
//   • ROUNDS: a ghost's references come from its brief, so after each round the pass asks the tracker
//     side for the chain's NEXT hop (`expandGhostsAfterBriefs` → ref-status 'missing') and briefs what
//     that stored — at most SPRINT_GHOST_DEPTH_MAX + 1 rounds, stopping as soon as a round neither
//     briefed nor stored anything.
//   • ONE `cheapComplete` PER TICKET (Haiku 5.5, tool-less, connectors isolated), BRIEF_CONCURRENCY at a
//     time, ONE retry on a refused answer. Every call's cost is recorded (`recordAiUsage`, feature
//     'sprint_briefs') and counted against the pass's budget (`config.sprintBriefBudgetUsd`): at the
//     line, no further call STARTS.
//   • ONE PASS PER (account, workspace), claimed SYNCHRONOUSLY. A read landing while a pass runs marks
//     it to run AGAIN once it ends (new text would otherwise wait for the next read).
//   • A failed brief is not stored; the next pass tries again. A missing credential or AI runtime stops
//     the pass at once.

export const BRIEF_CONCURRENCY = 4;

export interface BriefTodo {
  ident: string;
  provider: TrackerProvider;
  input: SprintBriefInput;
}

export interface SprintBriefSeams {
  aiEnabled?: boolean;
  entitled?: (accountId: number) => Promise<boolean>;
  complete?: CompleteFn;
  todo?: (accountId: number, workspaceId: number, cap: number) => Promise<BriefTodo[]>;
  store?: (accountId: number, workspaceId: number, t: BriefTodo, b: StoredSprintBrief) => Promise<void>;
  expand?: (accountId: number, workspaceId: number) => Promise<number>;
  budgetUsd?: number;
}

export interface SprintBriefPassResult {
  state: 'off' | 'no_credential' | 'not_entitled' | 'busy' | 'done' | 'failed';
  briefed: number;
  failed: number;
  costUsd: number;
  rounds: number;
  stoppedBy: 'budget' | 'runtime' | null;
}

const running = new Set<string>();
const again = new Set<string>();
const passes = new Map<string, Promise<SprintBriefPassResult>>();
const keyOf = (a: number, w: number): string => `${a}:${w}`;

/** Test seam. */
export function resetSprintBriefPasses(): void {
  running.clear();
  again.clear();
  passes.clear();
}

/** The pass in flight for this workspace, for tests to await. */
export function sprintBriefPassPromise(accountId: number, workspaceId: number): Promise<SprintBriefPassResult> | undefined {
  return passes.get(keyOf(accountId, workspaceId));
}

// This Sprint is FREE on every tier (it left Pro Reports), so the default answer is "the account
// exists" — the agentic switch (`config.aiEnabled`) and the credential are the gates. The seam stays
// for tests.
async function accountHasReports(accountId: number): Promise<boolean> {
  const { getAccountById } = await import('../../auth/account.js');
  return (await getAccountById(accountId)) != null;
}

const empty = (state: SprintBriefPassResult['state']): SprintBriefPassResult => ({
  state,
  briefed: 0,
  failed: 0,
  costUsd: 0,
  rounds: 0,
  stoppedBy: null,
});

/**
 * Brief this workspace's graph. Returns at once with 'busy' when a pass is running (it re-runs after),
 * otherwise runs the whole pass. Never throws.
 */
export async function runSprintBriefPass(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>,
  accountId: number,
  workspaceId: number,
  seams: SprintBriefSeams = {},
): Promise<SprintBriefPassResult> {
  if (!(seams.aiEnabled ?? config.aiEnabled)) return empty('off');
  const k = keyOf(accountId, workspaceId);
  // ⚠ CLAIMED SYNCHRONOUSLY — no await between the check and the claim.
  if (running.has(k)) {
    again.add(k);
    return empty('busy');
  }
  running.add(k);
  setSprintPassRunning('briefs', accountId, workspaceId, true);
  const p = (async (): Promise<SprintBriefPassResult> => {
    let last: SprintBriefPassResult = empty('done');
    try {
      do {
        again.delete(k);
        last = await onePass(ctx, accountId, workspaceId, seams);
      } while (again.has(k) && last.state === 'done' && last.stoppedBy == null);
      return last;
    } finally {
      running.delete(k);
      again.delete(k);
      passes.delete(k);
      setSprintPassRunning('briefs', accountId, workspaceId, false);
    }
  })();
  passes.set(k, p);
  return p;
}

async function onePass(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>,
  accountId: number,
  workspaceId: number,
  seams: SprintBriefSeams,
): Promise<SprintBriefPassResult> {
  const res = empty('done');
  try {
    if (ctx.llm.detectAuth().status !== 'ok') return { ...res, state: 'no_credential' };
    if (!(await (seams.entitled ?? accountHasReports)(accountId))) return { ...res, state: 'not_entitled' };
  } catch {
    return { ...res, state: 'failed' };
  }
  const budget = seams.budgetUsd ?? config.sprintBriefBudgetUsd;
  const todoOf = seams.todo ?? (async (a: number, w: number, cap: number) => (await import('../../db/sprint-graph.js')).sprintBriefTodo(a, w, cap));
  const store = seams.store ?? ((a, w, t, b) => storeSprintBrief(a, w, t.ident, t.input.textHash, b));
  const expand = seams.expand ?? expandGhostsAfterBriefs;
  const complete: CompleteFn | null = seams.complete ?? null;
  const tried = new Set<string>();
  try {
    const doComplete: CompleteFn = complete ?? (await import('../llm.js')).cheapComplete;
    const one = async (t: BriefTodo): Promise<void> => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (res.costUsd >= budget) return;
          const nonce = pickReviewNonce(sprintBriefUntrusted(t.input));
          const out = await doComplete({
            model: SPRINT_BRIEF_MODEL,
            system: SPRINT_BRIEF_SYSTEM,
            prompt: sprintBriefPrompt(t.input, nonce),
            maxTokens: briefMaxTokens(t.input.criteria.length, t.input.links.length),
          });
          const inputTokens = out.usage?.inputTokens ?? 0;
          const outputTokens = out.usage?.outputTokens ?? 0;
          const costUsd = labelCostUsd(inputTokens, outputTokens);
          res.costUsd += costUsd;
          await ctx
            .recordAiUsage({ accountId, seam: 'summary', feature: 'sprint_briefs', model: SPRINT_BRIEF_MODEL, costUsd, inputTokens, outputTokens })
            .catch((err) => ctx.log.warn({ err }, 'sprint briefs: usage record failed'));
          const v = validateSprintBrief(
            out.text,
            { title: t.input.title, description: t.input.description, criteria: t.input.criteria },
            t.input.criteria.length > 0,
            t.input.links.map((l) => l.key),
          );
          if (v.ok) {
            await store(accountId, workspaceId, t, {
              summary: v.summary,
              oneLiner: v.oneLiner,
              criteria: v.criteria,
              criteriaDerived: t.input.derived,
              references: v.references,
              linkReasons: v.linkReasons,
              costUsd,
              inputTokens,
              outputTokens,
            });
            res.briefed += 1;
            return;
          }
          ctx.log.info({ accountId, reason: v.reason, attempt }, 'sprint briefs: answer refused by validation');
        }
        res.failed += 1;
      } catch (err) {
        res.failed += 1;
        if (err instanceof AiRuntimeMissingError) res.stoppedBy = 'runtime';
        else ctx.log.warn({ accountId, err: String(err).slice(0, 200) }, 'sprint briefs: brief call failed');
      }
    };
    for (let round = 0; round <= SPRINT_GHOST_DEPTH_MAX; round += 1) {
      res.rounds = round + 1;
      const left = SPRINT_BRIEF_RUN_CAP - tried.size;
      const todo = left > 0 ? (await todoOf(accountId, workspaceId, left + tried.size)).filter((t) => !tried.has(t.ident)).slice(0, left) : [];
      for (const t of todo) tried.add(t.ident);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(BRIEF_CONCURRENCY, todo.length) }, async () => {
          while (next < todo.length) {
            if (res.stoppedBy != null) return;
            if (res.costUsd >= budget) {
              res.stoppedBy = 'budget';
              return;
            }
            await one(todo[next++]!);
          }
        }),
      );
      if (res.stoppedBy != null) break;
      // The chain's next hop: the ghosts just briefed may point at tickets nothing stores yet.
      const stored = await expand(accountId, workspaceId);
      if (todo.length === 0 && stored === 0) break;
    }
    return res;
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, err: String(err).slice(0, 200) }, 'sprint briefs: pass threw');
    return { ...res, state: 'failed' };
  }
}
