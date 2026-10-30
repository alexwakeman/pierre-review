import type { AiEffort, ClaudeReviewModel, StoryBuildProgress } from '@pierre-review/shared';
import { claudeModelChoice, type AgentOutcome, type AgentProviderId, type AgentToolServer, type AgentUsageRecord } from '../../ai/provider.js';
import { promptTools, type PromptTools } from '../../ai/prompt-tools.js';
import { applyClaudeReviewAuth } from '../../review/auth.js';
import { DISPATCH_TOOL_NAMES } from '../../review/claude-review/specialists.js';
import { fallbackCostUsd, ledgerByProvider, liveCostUsd, runProvider } from '../../review/run-provider.js';
import { emptyUsage, type UsageTokens } from '../../review/usage.js';
import { MAX_PLAN_ATTEMPTS, checkStoryPlanSubmission, type RawStoryPlan, type StoryPlanContext } from './plan.js';
import { STORY_PLAN_TOOL_NAME } from './prompts.js';
import { submitStoryPlanShape } from './schema.js';

// THE `story_plan` PASS — the SDK half ("Implement story", docs/STORY-BUILD.md § The plan). Reached ONLY
// through a lazy `await import('./plan-agent.js')` from the manager, so booting never loads the SDK.
//
// READ-ONLY, BY CODE: the allow list carries Read / Glob / Grep and the in-process `submit_story_plan`;
// Bash, EVERY write tool, the web tools and sub-agent dispatch are ALSO denied outright, so a plan pass
// cannot edit a file even if a later change re-adds one to the allow list by mistake (no-shell.test.ts).
// CONFINEMENT: the provider's PreToolUse PATH GUARD with the scratch cwd (REPOS.md) and every candidate
// checkout — plus the docs library when it is usable — as READ-ONLY roots, and NO write root.
//
// `submit_story_plan` is judged IN THE TOOL (plan.ts `checkStoryPlanSubmission`), at most
// MAX_PLAN_ATTEMPTS times; a refusal says WHAT TO FIX. Only an accepted call is kept. A design that is
// still wrong on the last attempt does not cost the plan: the plan is accepted, `designDropped` says so.
//
// ON CODEX (ai/codex/kinds/story-build.ts): the same spec goes to the provider the manager resolved — the
// read roots reach Limn's workspace MCP server, `submit_story_plan` becomes the STRICT final answer
// (ai/result-schemas.ts) handed to the SAME handler (a refusal earns the one `exec resume` retry), the
// tool lists below are Claude's only, and the provider writes the ledger row (`ledgerByProvider`).

/** Codex's answer and its one retry. */
export const CODEX_PLAN_ATTEMPTS = 2;
export const STORY_PLAN_TOOL = `mcp__storyplan__${STORY_PLAN_TOOL_NAME}`;
export const STORY_PLAN_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', STORY_PLAN_TOOL];
export const STORY_PLAN_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  ...DISPATCH_TOOL_NAMES,
];

/** The tool policy. Pure, so the no-shell, no-write, no-dispatch rule is pinned by a test. */
export function storyPlanToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return { allowedTools: [...STORY_PLAN_TOOLS], disallowedTools: [...new Set(STORY_PLAN_DISALLOWED_TOOLS)] };
}

/** The tool's decision, pure: accept (maybe without the design), or answer with what to fix. */
export function judgeStoryPlan(
  payload: unknown,
  attempt: number,
  ctx: StoryPlanContext,
  t: PromptTools = promptTools('claude'),
  maxAttempts: number = MAX_PLAN_ATTEMPTS,
): { accepted: RawStoryPlan; designDropped: boolean } | { reply: string; refusal: string } {
  const raw = (payload ?? {}) as RawStoryPlan;
  const j = checkStoryPlanSubmission(raw, ctx);
  const last = attempt >= maxAttempts;
  if (j.problems.length === 0 && (j.designProblems == null || last)) {
    return { accepted: raw, designDropped: j.designProblems != null };
  }
  const lines = [...j.problems.map((p) => `- ${p}`), ...(j.designProblems != null ? [`Design:\n${j.designProblems}`] : [])];
  const message = lines.join('\n');
  return {
    refusal: [...j.problems, ...(j.designProblems != null ? ['the design has problems'] : [])].join(' '),
    reply: last
      ? `The plan was not recorded:\n${message}\nThat was the last attempt; stop now.`
      : `The plan was not recorded. ${t.either(`Fix every point and call ${STORY_PLAN_TOOL_NAME} again with the whole plan:`, 'Fix every point and answer again with the whole plan:')}\n${message}`,
  };
}

export interface RunStoryPlanAgentArgs {
  accountId: number;
  /** The scratch working directory (holds REPOS.md). */
  cwd: string;
  /** Every candidate checkout, and the library when usable — all READ-ONLY. */
  readRoots: readonly string[];
  systemPrompt: string;
  prompt: string;
  context: StoryPlanContext;
  model: ClaudeReviewModel;
  provider: AgentProviderId;
  /** Settings → AI → Effort (`agenticRunEffort`, decided by the manager once per pass). */
  effort: AiEffort;
  maxBudgetUsd: number;
  maxTurns: number;
  abortController: AbortController;
  onProgress(p: StoryBuildProgress): void;
  usageRecord: AgentUsageRecord;
  /** May the run set process.env for the credential ladder (concurrency 1)? */
  applyAuthEnv: boolean;
}

export interface RunStoryPlanAgentResult {
  plan: RawStoryPlan | null;
  /** The design was asked for but still wrong on the last attempt: the plan was kept without it. */
  designDropped: boolean;
  lastRefusal: string | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  /** The provider's id for the model that ran. */
  model: string;
  /** The provider wrote the ledger row itself (Codex): the manager must not write a second. */
  ledgerByProvider: boolean;
}

export async function runStoryPlanAgent(args: RunStoryPlanAgentArgs): Promise<RunStoryPlanAgentResult> {
  const provider = runProvider(args.provider);
  const choice = claudeModelChoice(args.model);
  const words = promptTools(provider.id);
  const { abortController } = args;
  let outcome: AgentOutcome | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  let accepted: RawStoryPlan | null = null;
  let designDropped = false;
  let lastRefusal: string | null = null;
  let restoreEnv: (() => void) | null = null;
  const activity: string[] = [];
  const telemetry = () => {
    const usage = outcome?.usage ?? liveUsage;
    return {
      costUsd: outcome?.costUsd ?? fallbackCostUsd(provider, args.model, usage),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
      model: provider.resolveModel(choice),
      ledgerByProvider: ledgerByProvider(provider),
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunStoryPlanAgentResult => ({
    plan: null,
    designDropped: false,
    lastRefusal,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    if (provider.id === 'claude') restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shape = await submitStoryPlanShape();
    let attempts = 0;
    // Codex answers at most twice (its answer and the one `exec resume` retry): its second is the last.
    const maxAttempts = provider.id === 'codex' ? CODEX_PLAN_ATTEMPTS : MAX_PLAN_ATTEMPTS;
    const tools: AgentToolServer = {
      server: 'storyplan',
      tools: [
        {
          name: STORY_PLAN_TOOL_NAME,
          description: 'Submit the whole plan. It is checked at once: a refusal lists what to fix.',
          shape,
          handle: async (a) => {
            if (accepted != null) return { text: 'Already recorded.' };
            if (attempts >= maxAttempts) return { text: 'No more attempts. Stop now.', isError: true };
            attempts += 1;
            const j = judgeStoryPlan(a, attempts, args.context, words, maxAttempts);
            if ('accepted' in j) {
              accepted = j.accepted;
              designDropped = j.designDropped;
              return { text: 'Plan recorded.' };
            }
            lastRefusal = j.refusal;
            return { text: j.reply, isError: true };
          },
        },
      ],
    };
    const policy = storyPlanToolPolicy();
    ({ outcome } = await provider.runAgent({
      kind: 'story_plan',
      model: choice,
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard): the scratch cwd, every checkout READ-ONLY, no write.
      cwd: args.cwd,
      roots: [],
      readOnlyRoots: [...args.readRoots],
      writeRoots: [],
      tools,
      budget: { usd: args.maxBudgetUsd, turns: args.maxTurns },
      abortController,
      claude: { allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools, effort: args.effort },
      codex: { effort: args.effort },
      usageRecord: args.usageRecord,
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          for (const line of p.lines) {
            const l = line.trim();
            if (l === '') continue;
            activity.push(l);
            if (activity.length > 25) activity.shift();
          }
          args.onProgress({
            phase: 'planning',
            recentActivity: [...activity],
            usage: { ...liveUsage, estCostUsd: liveCostUsd(provider, args.model, liveUsage) },
          });
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));
    if (abortController.signal.aborted) return fail(undefined, true);
    if (accepted == null) {
      const reason =
        lastRefusal != null
          ? `no usable plan: ${lastRefusal}`
          : outcome && outcome.subtype !== 'success'
            ? `agent stopped (${outcome.subtype}) without submitting`
            : `agent finished without calling ${STORY_PLAN_TOOL_NAME}`;
      return fail(reason, false);
    }
    return { plan: accepted, designDropped, lastRefusal, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    // Codex: a refused answer and its one retry end the run with a THROW; the reason is the last refusal.
    if (provider.id !== 'claude' && lastRefusal != null) return fail(`no usable plan: ${lastRefusal}`, false);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
