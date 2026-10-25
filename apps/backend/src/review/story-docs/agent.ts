import { STORY_DOCS_ALIGNMENT_MODEL, type ClaudeReviewModel } from '@pierre-review/shared';
import {
  claudeModelChoice,
  type AgentOutcome,
  type AgentProviderId,
  type AgentToolServer,
  type AgentUsageRecord,
} from '../../ai/provider.js';
import { promptTools, type PromptTools } from '../../ai/prompt-tools.js';
import { fallbackCostUsd, ledgerByProvider, runProvider } from '../run-provider.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { emptyUsage, type UsageTokens } from '../usage.js';
import { STORY_DOCS_TOOL_NAME } from './prompts.js';
export { storyDocsRoots } from './prompts.js';
import { submitAlignmentShape } from './schema.js';
import { alignmentShapeProblems, type AlignmentContext } from './validate.js';

// THE STORY DOCS READ — the SDK half (a copy of diagrams/agent.ts). Reached ONLY through a lazy
// `await import('./agent.js')` from the manager, so booting the server never loads the SDK.
//
// TOOLS: Read, Glob, Grep and the in-process `submit_alignment`; Bash, every write tool, the web tools
// and sub-agent dispatch are DENIED. CONFINEMENT: the PreToolUse PATH GUARD, with the SHORTLISTED
// DOCUMENTS' FOLDERS as its only READ-ONLY roots (`storyDocsRoots`) — never the library folder itself,
// so INDEX.md and every other document are unreachable. The working directory is an empty scratch dir.
//
// `submit_alignment` refuses SHAPE problems only (validate.ts `alignmentShapeProblems`), at most
// MAX_SUBMIT_ATTEMPTS times. Grounding is NOT judged here: a quote that does not check out is dropped at
// storage and the model is simply told "Recorded." — so a mismatch cannot loop.

// ON CODEX (ai/codex/kinds/tickets.ts): the SAME spec goes to the provider the manager resolved — the
// read roots are these, `submit_*` becomes the strict final answer handed to the SAME handler, the
// tool lists below are Claude's only, and the provider writes the ledger row (`ledgerByProvider`).

export const STORY_DOCS_TOOL = `mcp__storydocs__${STORY_DOCS_TOOL_NAME}`;
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', STORY_DOCS_TOOL];
export const MAX_SUBMIT_ATTEMPTS = 3;

/** The tool policy. Pure, so the no-shell, no-write, no-dispatch rule is pinned by a test. */
export function storyDocsToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

/** The tool's decision, pure: accept, or answer with what to fix (shape only). */
export function judgeSubmission(
  payload: unknown,
  attempt: number,
  ctx: AlignmentContext,
  t: PromptTools = promptTools('claude'),
): { accepted: unknown } | { reply: string; refusal: string } {
  const problems = alignmentShapeProblems(payload, ctx);
  if (problems.length === 0) return { accepted: payload };
  const message = problems.map((p) => `- ${p}`).join('\n');
  return {
    refusal: problems.join(' '),
    reply:
      attempt >= MAX_SUBMIT_ATTEMPTS
        ? `Refused:\n${message}\nThat was the last attempt; stop now.`
        : `Refused:\n${message}\n${t.either(`Fix every point and call ${STORY_DOCS_TOOL_NAME} again with the whole answer.`, 'Fix every point and answer again with the whole answer.')}`,
  };
}

export interface RunStoryDocsAgentArgs {
  cwd: string;
  roots: readonly string[];
  systemPrompt: string;
  prompt: string;
  alignment: AlignmentContext;
  applyAuthEnv: boolean;
  abortController: AbortController;
  model?: ClaudeReviewModel;
  // The provider the manager resolved (and worded the prompts for). Absent ⇒ the active one.
  provider?: AgentProviderId;
  // Who the ledger row bills. A provider that records its own usage (Codex) writes it from this; on
  // Claude it is unused and the manager records the run as it always has.
  usageRecord?: AgentUsageRecord;
}

export interface RunStoryDocsAgentResult {
  payload: unknown | null;
  lastRefusal: string | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  // The model the run was on (the provider's id for it) and whether the PROVIDER wrote the ledger row.
  // Absent (a stand-in runner in a test) ⇒ the requested model, and the manager's ledger.
  model?: string;
  ledgerByProvider?: boolean;
}

export async function runStoryDocsAgent(args: RunStoryDocsAgentArgs): Promise<RunStoryDocsAgentResult> {
  const model = args.model ?? (STORY_DOCS_ALIGNMENT_MODEL as ClaudeReviewModel);
  const { abortController } = args;
  const provider = runProvider(args.provider);
  const choice = claudeModelChoice(model);
  const words: PromptTools = promptTools(provider.id);
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  let accepted: unknown | null = null;
  let lastRefusal: string | null = null;
  const telemetry = (): Pick<
    RunStoryDocsAgentResult,
    'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns' | 'model' | 'ledgerByProvider'
  > => {
    const usage = outcome?.usage ?? liveUsage;
    return {
      costUsd: outcome?.costUsd ?? fallbackCostUsd(provider, model, usage),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
      model: provider.resolveModel(choice),
      ledgerByProvider: ledgerByProvider(provider),
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunStoryDocsAgentResult => ({
    payload: null,
    lastRefusal,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    if (provider.id === 'claude') restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shape = await submitAlignmentShape();
    let attempts = 0;
    const tools: AgentToolServer = {
      server: 'storydocs',
      tools: [
        {
          name: STORY_DOCS_TOOL_NAME,
          description: 'Submit the whole check of the story against the docs. Its shape is checked at once: a refusal lists what to fix.',
          shape,
          handle: async (a) => {
            if (accepted != null) return { text: 'Already recorded.' };
            if (attempts >= MAX_SUBMIT_ATTEMPTS) {
              return { text: 'No more attempts. Stop now.', isError: true };
            }
            attempts += 1;
            const j = judgeSubmission(a, attempts, args.alignment, words);
            if ('accepted' in j) {
              accepted = j.accepted;
              return { text: 'Recorded.' };
            }
            lastRefusal = j.refusal;
            return { text: j.reply, isError: true };
          },
        },
      ],
    };
    // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: a PreToolUse deny holds under bypassPermissions.
    const policy = storyDocsToolPolicy();
    ({ outcome } = await provider.runAgent({
      kind: 'story_docs',
      model: choice,
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard): the scratch cwd, and the shortlisted
      // documents READ-ONLY.
      cwd: args.cwd,
      roots: [],
      readOnlyRoots: [...args.roots],
      writeRoots: [],
      tools,
      budget: { usd: config.storyDocsBudgetUsd, turns: config.storyDocsMaxTurns },
      abortController,
      claude: { allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools },
      ...(args.usageRecord ? { usageRecord: args.usageRecord } : {}),
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));

    if (accepted == null) {
      const reason =
        lastRefusal != null
          ? `no usable answer: ${lastRefusal}`
          : outcome && outcome.subtype !== 'success'
            ? `agent stopped (${outcome.subtype}) without submitting`
            : `agent finished without calling ${STORY_DOCS_TOOL_NAME}`;
      return fail(reason, false);
    }
    return { payload: accepted, lastRefusal, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    // Codex: a refused answer and its one retry end the run with a THROW (ai/providers/codex.ts), where
    // Claude's run ends normally after its refusals. The reason is the same either way: the last refusal.
    if (provider.id !== 'claude' && lastRefusal != null) return fail(`no usable answer: ${lastRefusal}`, false);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
