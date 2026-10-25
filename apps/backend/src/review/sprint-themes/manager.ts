import { setSprintPassRunning } from '../../db/sprint-pass-flights.js';
import { SPRINT_BRIEF_MODEL, SPRINT_THEME_CAPS } from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  areThemesCurrent,
  storedSprintThemes,
  storeSprintThemes,
  type SprintThemeInput,
  type StoredSprintThemes,
} from '../../db/sprint-themes.js';
import type { AgentContext } from '../agent-context.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { cheapUsage } from '../cheap-usage.js';
import { labelCostUsd, type CompleteFn } from '../story-labels/manager.js';
import { SPRINT_THEME_SYSTEM, sprintThemePrompt, sprintThemeUntrusted, themeMaxTokens } from './prompt.js';
import { validateSprintThemes } from './validate.js';

// THE SPRINT THEME PASS (docs/CLAUDE-REVIEW.md § Sprint themes). LOCAL ONLY and agentic: started after
// the brief pass by the sprint read's after-read seam (review/sprint-briefs/index.ts), which only
// `registerAgenticRoutes` sets (cloud: never).
//
//   • ONE `cheapComplete` PER SPRINT (Haiku 5.5, tool-less, connectors isolated) over every sprint
//     ticket's key, title and current brief summary, ONE retry on a refused answer. Cost recorded
//     (`recordAiUsage`, feature 'sprint_themes').
//   • RUNS ONLY WHEN THE INPUT HASH CHANGED (keys + summaries, SPRINT_THEME_VERSION): a sprint read that
//     changed nothing costs nothing. Fewer than SPRINT_THEME_CAPS.minTickets tickets: not themed.
//   • ONE PASS PER (account, workspace), claimed SYNCHRONOUSLY; a second call while one runs is 'busy'
//     (the brief pass that follows the next read calls again).
//   • A failed pass is not stored; the next read tries again. Never throws.

export interface SprintThemeSeams {
  aiEnabled?: boolean;
  entitled?: (accountId: number) => Promise<boolean>;
  complete?: CompleteFn;
  todo?: (accountId: number, workspaceId: number) => Promise<SprintThemeInput | null>;
  isCurrent?: (accountId: number, workspaceId: number, inputHash: string) => Promise<boolean>;
  store?: (accountId: number, workspaceId: number, inputHash: string, v: StoredSprintThemes) => Promise<void>;
}

export interface SprintThemePassResult {
  state: 'off' | 'no_credential' | 'not_entitled' | 'busy' | 'no_tracker' | 'too_few' | 'current' | 'done' | 'failed';
  costUsd: number;
  themes: number;
}

const running = new Set<string>();
const keyOf = (a: number, w: number): string => `${a}:${w}`;

/** Test seam. */
export function resetSprintThemePasses(): void {
  running.clear();
}

// This Sprint is FREE on every tier (it left Pro Reports), so the default answer is "the account
// exists" — the agentic switch (`config.aiEnabled`) and the credential are the gates. The seam stays
// for tests.
async function accountHasReports(accountId: number): Promise<boolean> {
  const { getAccountById } = await import('../../auth/account.js');
  return (await getAccountById(accountId)) != null;
}

/** Theme this workspace's sprint when its input changed. Never throws. */
export async function runSprintThemePass(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>,
  accountId: number,
  workspaceId: number,
  seams: SprintThemeSeams = {},
): Promise<SprintThemePassResult> {
  const res: SprintThemePassResult = { state: 'done', costUsd: 0, themes: 0 };
  if (!(seams.aiEnabled ?? config.aiEnabled)) return { ...res, state: 'off' };
  const k = keyOf(accountId, workspaceId);
  // ⚠ CLAIMED SYNCHRONOUSLY — no await between the check and the claim.
  if (running.has(k)) return { ...res, state: 'busy' };
  running.add(k);
  setSprintPassRunning('themes', accountId, workspaceId, true);
  try {
    if (ctx.llm.detectAuth().status !== 'ok') return { ...res, state: 'no_credential' };
    if (!(await (seams.entitled ?? accountHasReports)(accountId))) return { ...res, state: 'not_entitled' };
    const todo = seams.todo ?? (async (a: number, w: number) => (await import('../../db/sprint-graph.js')).sprintThemeTodo(a, w));
    const input = await todo(accountId, workspaceId);
    if (input == null) return { ...res, state: 'no_tracker' };
    if (input.tickets.length < SPRINT_THEME_CAPS.minTickets) return { ...res, state: 'too_few' };
    const isCurrent = seams.isCurrent ?? (async (a: number, w: number, h: string) => areThemesCurrent(await storedSprintThemes(a, w), h));
    if (await isCurrent(accountId, workspaceId, input.inputHash)) return { ...res, state: 'current' };
    const complete: CompleteFn = seams.complete ?? (await import('../llm.js')).cheapComplete;
    const store = seams.store ?? storeSprintThemes;
    const keys = input.tickets.map((t) => t.key);
    const identOf = new Map(input.tickets.map((t) => [t.key, t.ident]));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = pickReviewNonce(sprintThemeUntrusted(input));
      const out = await complete({
        model: SPRINT_BRIEF_MODEL,
        system: SPRINT_THEME_SYSTEM,
        prompt: sprintThemePrompt(input, nonce),
        maxTokens: themeMaxTokens(input.tickets.length),
      });
      const u = cheapUsage(out, SPRINT_BRIEF_MODEL, labelCostUsd);
      const inputTokens = u.inputTokens ?? 0;
      const outputTokens = u.outputTokens ?? 0;
      const costUsd = u.costUsd;
      res.costUsd += costUsd;
      await ctx
        .recordAiUsage({ accountId, seam: 'summary', feature: 'sprint_themes', ...u })
        .catch((err) => ctx.log.warn({ err }, 'sprint themes: usage record failed'));
      const v = validateSprintThemes(out.text, keys);
      if (v.ok) {
        await store(accountId, workspaceId, input.inputHash, {
          themes: v.themes,
          assignments: v.assignments.map((x) => ({ ident: identOf.get(x.key)!, theme: x.theme })),
          costUsd: res.costUsd,
          inputTokens,
          outputTokens,
        });
        ctx.log.info({ accountId, workspaceId, themes: v.themes.length, costUsd: res.costUsd }, 'sprint themes: stored');
        return { ...res, themes: v.themes.length };
      }
      ctx.log.info({ accountId, reason: v.reason, attempt }, 'sprint themes: answer refused by validation');
    }
    return { ...res, state: 'failed' };
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, err: String(err).slice(0, 200) }, 'sprint themes: pass threw');
    return { ...res, state: 'failed' };
  } finally {
    running.delete(k);
    setSprintPassRunning('themes', accountId, workspaceId, false);
  }
}
