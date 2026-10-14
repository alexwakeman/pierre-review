import { SPRINT_BRIEF_MODEL, type SprintStoryFailure } from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  claimSprintStoryPass,
  isStoryCurrent,
  recordSprintStoryAttempt,
  releaseSprintStoryPass,
  sprintStoryAttempt,
  storedSprintStory,
  storeSprintStory,
  storyBackedOff,
  type SprintStoryAttempt,
  type SprintStoryInput,
  type StoredSprintStory,
} from '../../db/sprint-story.js';
import type { AgentContext } from '../agent-context.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { labelCostUsd, type CompleteFn } from '../story-labels/manager.js';
import { SPRINT_STORY_SYSTEM, STORY_MAX_TOKENS, sprintStoryPrompt, sprintStoryRetryNote, sprintStoryUntrusted } from './prompt.js';
import { validateSprintStory } from './validate.js';

// THE SPRINT STORY PASS (docs/CLAUDE-REVIEW.md § Sprint story). LOCAL ONLY and agentic: started after the
// theme pass by the sprint read's after-read seam (review/sprint-briefs/index.ts), which only
// `registerAgenticRoutes` sets (cloud: never). Never on a view.
//
//   • ONE `cheapComplete` PER SPRINT (Haiku 5.5, tool-less, connectors isolated) over the code-built
//     facts + candidates (db/sprint-story.ts), ONE retry on a refused answer — told WHY the first was
//     refused (`sprintStoryRetryNote`). Cost recorded (`recordAiUsage`, feature 'sprint_story').
//   • RUNS ONLY WHEN THE INPUT HASH CHANGED (everything sent + SPRINT_STORY_VERSION): a sprint read that
//     changed nothing costs nothing.
//   • ⚠ THE BACKOFF: every pass that called Claude RECORDS ITS ATTEMPT on `sprint_reads` (when, the
//     input hash, the failure code or null). A pass that stored nothing for THIS input hash is not run
//     again until the hash moves (new facts, or the next sprint day) — it used to re-bill two refused
//     calls on every read, record nothing, and leave the page on "Writing the sprint story…" for ever.
//   • ONE PASS PER (account, workspace), claimed SYNCHRONOUSLY (db/sprint-story.ts `claimSprintStoryPass`,
//     which the GET reads as 'writing'); a second call while one runs is 'busy'. Never throws.

export interface SprintStorySeams {
  aiEnabled?: boolean;
  entitled?: (accountId: number) => Promise<boolean>;
  complete?: CompleteFn;
  todo?: (accountId: number, workspaceId: number) => Promise<SprintStoryInput | null>;
  isCurrent?: (accountId: number, workspaceId: number, inputHash: string) => Promise<boolean>;
  store?: (accountId: number, workspaceId: number, inputHash: string, v: StoredSprintStory) => Promise<void>;
  attempt?: (accountId: number, workspaceId: number) => Promise<SprintStoryAttempt | null>;
  recordAttempt?: (accountId: number, workspaceId: number, inputHash: string, error: SprintStoryFailure | null) => Promise<void>;
}

export interface SprintStoryPassResult {
  state: 'off' | 'no_credential' | 'not_entitled' | 'busy' | 'no_tracker' | 'too_few' | 'current' | 'backoff' | 'done' | 'failed';
  costUsd: number;
  storylines: number;
  /** Why a 'failed' pass stored nothing. */
  failure?: SprintStoryFailure;
}

/** Test seam. */
export { resetSprintStoryFlight as resetSprintStoryPasses } from '../../db/sprint-story.js';

// This Sprint is FREE on every tier; the agentic switch and the credential are the gates.
async function accountExists(accountId: number): Promise<boolean> {
  const { getAccountById } = await import('../../auth/account.js');
  return (await getAccountById(accountId)) != null;
}

/** Write this workspace's sprint story when its input changed. Never throws. */
export async function runSprintStoryPass(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>,
  accountId: number,
  workspaceId: number,
  seams: SprintStorySeams = {},
): Promise<SprintStoryPassResult> {
  const res: SprintStoryPassResult = { state: 'done', costUsd: 0, storylines: 0 };
  if (!(seams.aiEnabled ?? config.aiEnabled)) return { ...res, state: 'off' };
  // ⚠ CLAIMED SYNCHRONOUSLY — no await between the check and the claim.
  if (!claimSprintStoryPass(accountId, workspaceId)) return { ...res, state: 'busy' };
  let attempted: string | null = null;
  const recordAttempt = seams.recordAttempt ?? ((a: number, w: number, h: string, e: SprintStoryFailure | null) => recordSprintStoryAttempt(a, w, h, e));
  const record = async (hash: string, error: SprintStoryFailure | null): Promise<void> => {
    await recordAttempt(accountId, workspaceId, hash, error).catch((err) => ctx.log.warn({ err: String(err).slice(0, 200) }, 'sprint story: attempt record failed'));
  };
  try {
    if (ctx.llm.detectAuth().status !== 'ok') return { ...res, state: 'no_credential' };
    if (!(await (seams.entitled ?? accountExists)(accountId))) return { ...res, state: 'not_entitled' };
    const todo = seams.todo ?? (async (a: number, w: number) => (await import('../../db/sprint-graph.js')).sprintStoryTodo(a, w));
    const input = await todo(accountId, workspaceId);
    if (input == null) return { ...res, state: 'no_tracker' };
    if (!input.eligible) return { ...res, state: 'too_few' };
    const isCurrent = seams.isCurrent ?? (async (a: number, w: number, h: string) => isStoryCurrent(await storedSprintStory(a, w), h));
    if (await isCurrent(accountId, workspaceId, input.inputHash)) return { ...res, state: 'current' };
    if (storyBackedOff(await (seams.attempt ?? sprintStoryAttempt)(accountId, workspaceId), input.inputHash)) return { ...res, state: 'backoff' };
    const complete: CompleteFn = seams.complete ?? (await import('../llm.js')).cheapComplete;
    const store = seams.store ?? storeSprintStory;
    let inTok = 0;
    let outTok = 0;
    let refused: SprintStoryFailure | null = null;
    attempted = input.inputHash;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = pickReviewNonce(sprintStoryUntrusted(input));
      const out = await complete({
        model: SPRINT_BRIEF_MODEL,
        system: SPRINT_STORY_SYSTEM,
        prompt: sprintStoryPrompt(input, nonce) + (refused != null ? sprintStoryRetryNote(refused) : ''),
        maxTokens: STORY_MAX_TOKENS,
      });
      const inputTokens = out.usage?.inputTokens ?? 0;
      const outputTokens = out.usage?.outputTokens ?? 0;
      inTok += inputTokens;
      outTok += outputTokens;
      const costUsd = labelCostUsd(inputTokens, outputTokens);
      res.costUsd += costUsd;
      await ctx
        .recordAiUsage({ accountId, seam: 'summary', feature: 'sprint_story', model: SPRINT_BRIEF_MODEL, costUsd, inputTokens, outputTokens })
        .catch((err) => ctx.log.warn({ err }, 'sprint story: usage record failed'));
      const v = validateSprintStory(out.text, input);
      if (v.ok) {
        await store(accountId, workspaceId, input.inputHash, {
          headline: v.headline,
          focus: v.focus,
          storylines: v.storylines,
          costUsd: res.costUsd,
          inputTokens: inTok,
          outputTokens: outTok,
        });
        await record(input.inputHash, null);
        ctx.log.info({ accountId, workspaceId, storylines: v.storylines.length, costUsd: res.costUsd }, 'sprint story: stored');
        return { ...res, storylines: v.storylines.length };
      }
      refused = v.reason;
      ctx.log.info({ accountId, workspaceId, reason: v.reason, attempt }, 'sprint story: answer refused by validation');
    }
    await record(input.inputHash, refused ?? 'error');
    return { ...res, state: 'failed', failure: refused ?? 'error' };
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, err: String(err).slice(0, 200) }, 'sprint story: pass threw');
    // A call that failed (network, runtime) is a failed attempt for this input too: backed off alike.
    if (attempted != null) await record(attempted, 'error');
    return { ...res, state: 'failed', failure: 'error' };
  } finally {
    releaseSprintStoryPass(accountId, workspaceId);
  }
}
