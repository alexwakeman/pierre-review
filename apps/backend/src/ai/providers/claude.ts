// THE CLAUDE PROVIDER (ai/provider.ts; docs/CODEX-PLAN.md § 3.1) — the Agent SDK code every runner
// used to carry, MOVED here behind `runAgent` / `complete`, not rewritten. With the AI runtime
// (ai/runtime.ts), this is the ONLY module that calls the Agent SDK's `query` or loads the
// Anthropic SDK (pinned by provider-seam.test.ts).
//
// What `runAgent` puts on EVERY run, exactly as each call site did:
//   • `permissionMode: 'bypassPermissions'`, `settingSources: []` (no host .claude settings,
//     CLAUDE.md or skills), `ISOLATED_MCP` (no claude.ai connectors), the LIMN_CLAUDE_PATH
//     executable and the credential ladder's environment (`agentAuthOptions()`);
//   • ⚠ THE PATH GUARD as the FIRST PreToolUse hook — `createPathGuard(cwd, roots, {readOnlyRoots})`
//     — then `ownToolsOnlyHook(<the run's own server>)`, then the run's extra hooks (the specialist
//     cap, the docs build's sections-write guard). Under bypassPermissions a PreToolUse deny is the
//     only thing that confines an absolute path, and the prompt is attacker-authored;
//   • `additionalDirectories` = roots + read-only roots, only when there are any (the SDK adds one
//     `--add-dir` per entry, so an empty list and no list run the same CLI);
//   • the result tools as ONE in-process MCP server (`createSdkMcpServer`, version 1.0.0), each
//     handler's reply as one text block (+ `isError` only when the handler set it).
// The SDK module comes from `loadAgentSdk()`, whose `query` is TAPPED (ai/runtime.ts `tapQuery`), so
// every message still reaches the spend budget's observer.
import { loadAgentSdk, loadAnthropicSdk, claudeExecutableOptions, getAiRuntimeStatus } from '../runtime.js';
import { agentAuthOptions, agentSdkEnv, resolveAiCredential, type AiCredential } from '../credentials.js';
import { ISOLATED_MCP, ownToolsOnlyHook } from '../agent-isolation.js';
import { config } from '../../config.js';
import { NO_CLAUDE_AUTH_MESSAGE } from '../../review/auth.js';
import { sdkModelOptions } from '../../review/model-options.js';
import { createPathGuard, pathGuardHook } from '../../review/path-guard.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../../review/usage.js';
import type {
  AgentMessage,
  AgentOutcome,
  AgentProvider,
  AgentResultMessage,
  AgentRunResult,
  AgentRunSpec,
  CompleteRequest,
  CompleteResult,
  ModelChoice,
  ModelRole,
  ProviderStatus,
} from '../provider.js';
import { AI_MODEL_FOR_ROLE } from '@pierre-review/shared';
import { foldRateLimitEvent, parseUsageProbe } from './claude-usage.js';
import { assistantText, describeFixBlocks, describeReviewBlocks } from './claude-activity.js';

/**
 * Claude's model per role — the shared table's (packages/shared `AI_MODEL_FOR_ROLE`, which the SPA's
 * labels read too). A call site that must keep an exact id passes it (`ModelChoice.id`).
 */
export const CLAUDE_MODEL_FOR_ROLE: Readonly<Record<ModelRole, string>> = AI_MODEL_FOR_ROLE.claude;

function resolveModel(choice: ModelChoice): string {
  return choice.id ?? CLAUDE_MODEL_FOR_ROLE[choice.role];
}

// ---- runAgent ---------------------------------------------------------------------------------

async function runAgent(spec: AgentRunSpec): Promise<AgentRunResult> {
  const model = resolveModel(spec.model);
  // From the AI runtime (ai/runtime.ts) — downloaded on first use for an npm install. A missing
  // runtime throws here, into the caller's catch, as it always did.
  const { createSdkMcpServer, query, tool } = await loadAgentSdk();
  const mcpServers = spec.tools
    ? {
        [spec.tools.server]: createSdkMcpServer({
          name: spec.tools.server,
          version: '1.0.0',
          tools: spec.tools.tools.map((t) =>
            tool(t.name, t.description, t.shape as Parameters<typeof tool>[2], async (a: unknown) => {
              const reply = await t.handle(a);
              return {
                content: [{ type: 'text' as const, text: reply.text }],
                ...(reply.isError !== undefined ? { isError: reply.isError } : {}),
              };
            }),
          ),
        }),
      }
    : undefined;
  const guard = createPathGuard(spec.cwd, spec.roots, { readOnlyRoots: spec.readOnlyRoots });
  const extraDirs = [...spec.roots, ...spec.readOnlyRoots];
  const c = spec.claude;

  const q = query({
    prompt: spec.prompt,
    options: {
      model,
      ...sdkModelOptions(model, spec.effort, spec.claude.effort),
      ...(spec.system !== undefined ? { systemPrompt: spec.system } : {}),
      cwd: spec.cwd,
      ...(extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
      permissionMode: 'bypassPermissions',
      // `tools` is the BASE SET the model can see at all ([] = no built-in tools); allowedTools only
      // skips prompts. Sent only by the runs that narrow it.
      ...(c.builtinTools ? { tools: c.builtinTools } : {}),
      allowedTools: c.allowedTools,
      disallowedTools: c.disallowedTools,
      maxTurns: spec.budget.turns,
      ...(c.agents ? { agents: c.agents as never } : {}),
      // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: PreToolUse hooks run before the tool and
      // their deny holds under bypassPermissions (canUseTool would never be asked). Every hook
      // must allow a call for it to run.
      hooks: {
        PreToolUse: [
          pathGuardHook(guard),
          ownToolsOnlyHook(spec.tools ? [spec.tools.server] : []),
          ...(c.extraPreToolUse ?? []),
        ] as never,
      },
      maxBudgetUsd: spec.budget.usd,
      // Don't inherit the host's .claude settings / CLAUDE.md / skills.
      settingSources: [],
      ...ISOLATED_MCP,
      ...(mcpServers ? { mcpServers } : {}),
      abortController: spec.abortController,
      // LIMN_CLAUDE_PATH → the user's own `claude` instead of the SDK's bundled binary.
      ...claudeExecutableOptions(),
      ...agentAuthOptions(),
    },
  });

  // THE NEUTRAL STREAM (ai/provider.ts header), derived HERE from each SDK message exactly as every
  // runner used to derive it: per assistant message, the per-request usage map (de-duplicated, a
  // usage shape that throws is skipped), the activity lines and the text → ONE `step`; the result
  // message → the `outcome`. The raw message goes to `spec.claude.onMessage` (the escape hatch) FIRST.
  const usageByRequest = new Map<string, UsageTokens>();
  // Dispatch tool_use id → specialist name, so a specialist's own steps are labelled as its. Kept for
  // the whole run only for Claude Review (the one run with specialists, as review/agent.ts did).
  const specialistByToolUse = new Map<string, string>();
  const describe = (message: unknown): string[] =>
    spec.activity === 'fix'
      ? describeFixBlocks(message)
      : describeReviewBlocks(message, spec.kind === 'review' ? specialistByToolUse : new Map());
  let outcome: AgentOutcome | null = null;
  for await (const message of q) {
    spec.claude.onMessage?.(message as AgentMessage);
    if (message.type === 'assistant') {
      try {
        recordUsage(usageByRequest, message);
      } catch {
        /* usage shape varies — never let it break the run */
      }
      let lines: string[] = [];
      try {
        lines = describe(message);
      } catch {
        /* never let progress derivation break the run */
      }
      spec.onProgress?.({ kind: 'step', lines, text: assistantText(message), usage: sumUsageMap(usageByRequest) });
    } else if (message.type === 'result') {
      outcome = outcomeOf(message as AgentResultMessage);
      spec.onProgress?.({ kind: 'outcome', outcome });
    }
  }
  return { outcome };
}

/** Claude's result message → the neutral outcome. Exported for the test. */
export function outcomeOf(result: AgentResultMessage): AgentOutcome {
  const r = result as AgentResultMessage & { result?: unknown };
  return {
    subtype: String(r.subtype),
    text: r.subtype === 'success' && typeof r.result === 'string' ? r.result : null,
    costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
    numTurns: typeof r.num_turns === 'number' ? r.num_turns : null,
    usage: sumModelUsage(r),
  };
}

// ---- complete (the cheap one-shot seam; review/llm.ts `cheapComplete` calls it) -----------------
//
// ⚠ THE DEFAULT MODEL THINKS UNLESS TOLD OTHERWISE. Its adaptive thinking is on by default and its
// thinking tokens count toward `max_tokens`, so a small cap tuned for the previous Haiku could stop
// after a thinking block with no text at all. Every call to it therefore goes out at effort 'low'
// (it may skip thinking entirely on a simple prompt) with THINKING_HEADROOM added to the cap. It
// also 400s on a non-default temperature/top_p/top_k and on an assistant prefill: send neither.
//
// ⚠ ONE CREDENTIAL LADDER (ai/credentials.ts), the same one every agent run uses:
//   1. the reader's Claude Code login (default) → the Claude Agent SDK's `query()`, one tool-less
//      turn, with ANTHROPIC_API_KEY hidden from it so the login pays rather than a meter;
//   2. else ANTHROPIC_API_KEY from the environment → the Anthropic API directly (`@anthropic-ai/sdk`).

// Models given the low-effort, headroom-padded shape above. A caller passing another model id (a
// stored per-account override, say) gets the plain request it always got.
const ADAPTIVE_CHEAP_MODELS: ReadonlySet<string> = new Set(['claude-haiku-5-5']);
const THINKING_HEADROOM = 1024;

/** The model-dependent request shape for one cheap completion (exported for the test). */
export function cheapRequestShape(
  model: string,
  maxTokens: number,
): { maxTokens: number; effort?: 'low' } {
  return ADAPTIVE_CHEAP_MODELS.has(model)
    ? { maxTokens: maxTokens + THINKING_HEADROOM, effort: 'low' }
    : { maxTokens };
}

/** Which path one cheap completion takes (exported for the test): the login → the Agent SDK. */
export function cheapRoute(credential: AiCredential): 'agent' | 'api' | 'none' {
  if (credential.route === 'login') return 'agent';
  if (credential.route === 'api_key') return 'api';
  return 'none';
}

async function complete(req: CompleteRequest): Promise<CompleteResult> {
  const model = req.model ?? CLAUDE_MODEL_FOR_ROLE[req.role ?? 'fast'];
  const credential = resolveAiCredential();
  const route = cheapRoute(credential);
  if (route === 'none') throw new Error(NO_CLAUDE_AUTH_MESSAGE);
  return route === 'api' && credential.route === 'api_key'
    ? rawComplete(credential.apiKey, model, req)
    : agentComplete(model, req, credential);
}

// ---- raw @anthropic-ai/sdk path (the ANTHROPIC_API_KEY rung) ----------------------------
async function rawComplete(
  apiKey: string,
  model: string,
  opts: CompleteRequest,
): Promise<CompleteResult> {
  const { default: Anthropic } = await loadAnthropicSdk();
  const client = new Anthropic({ apiKey });
  const shape = cheapRequestShape(model, opts.maxTokens ?? 700);
  const resp = await client.messages.create({
    model,
    max_tokens: shape.maxTokens,
    ...(shape.effort ? { output_config: { effort: shape.effort } } : {}),
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
  });
  const blocks: unknown = resp.content;
  const text = (Array.isArray(blocks) ? blocks : [])
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown };
      return block?.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .join('');
  return {
    text: text.trim(),
    usage: {
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
    },
  };
}

// ---- Claude Agent SDK path (the Claude Code login) --------------------
async function agentComplete(
  model: string,
  opts: CompleteRequest,
  credential: AiCredential,
): Promise<CompleteResult> {
  const { query } = await loadAgentSdk();

  // A single-turn, tool-less completion: the system prompt is folded into the user
  // prompt (the SDK's systemPrompt is also passed for models that honour it). No
  // tools, no settings, one turn — just text out.
  const prompt = opts.system
    ? `${opts.system}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  const shape = cheapRequestShape(model, opts.maxTokens ?? 700);
  const q = query({
    prompt,
    options: {
      model,
      ...(shape.effort ? { effort: shape.effort } : {}),
      systemPrompt: opts.system,
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      // Don't load the user's ~/.claude settings / MCP servers for a plain
      // completion (mirrors review/agent.ts).
      settingSources: [],
      // No tools at all: the account's claude.ai connectors must not reach a plain completion.
      ...ISOLATED_MCP,
      hooks: { PreToolUse: [ownToolsOnlyHook([])] },
      ...claudeExecutableOptions(),
      // The login pays: any ANTHROPIC_API_KEY is hidden from this run (ai/credentials.ts).
      env: agentSdkEnv(process.env, credential),
    },
  });

  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let errored: string | null = null;

  for await (const message of q as AsyncIterable<Record<string, unknown>>) {
    const type = message.type;
    if (type === 'assistant') {
      const inner = (message.message ?? {}) as {
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
      for (const b of inner.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
      }
    } else if (type === 'result') {
      const usage = (message.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
      };
      inputTokens = usage.input_tokens ?? inputTokens;
      outputTokens = usage.output_tokens ?? outputTokens;
      const subtype = String(message.subtype ?? '');
      if (subtype && subtype !== 'success' && !text) {
        errored = subtype;
      }
    }
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      `Agent SDK completion returned no text${errored ? ` (${errored})` : ''} — check your Claude Code login (run \`claude\` to sign in) or set ANTHROPIC_API_KEY.`,
    );
  }
  return { text: trimmed, usage: { inputTokens, outputTokens } };
}

// ---- detect ----------------------------------------------------------------------------------

async function detect(): Promise<ProviderStatus> {
  if (!config.aiEnabled) {
    return { id: 'claude', available: false, route: 'none', message: 'Claude is switched off here.' };
  }
  const route = resolveAiCredential().route;
  const runtime = getAiRuntimeStatus();
  if (runtime.runtime !== 'ready') {
    return { id: 'claude', available: false, route, message: runtime.runtimeMessage ?? 'AI is not set up yet: limn ai install' };
  }
  if (route === 'none') return { id: 'claude', available: false, route, message: NO_CLAUDE_AUTH_MESSAGE };
  return { id: 'claude', available: true, route, message: null };
}

// ---- the usage probe (moved from ai/budget.ts) ---------------------------------------------------

const PROBE_TIMEOUT_MS = 20_000;

/** Ask the Agent SDK's experimental usage method. Spawns the CLI with an empty input stream (no model
 *  call), asks, closes. Throws on anything unexpected; the caller swallows. */
async function sdkUsageProbe(): Promise<unknown> {
  const sdk = await loadAgentSdk();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  // An input stream that never yields a turn: the CLI starts, answers control requests, and spends
  // nothing.
  async function* noTurns(): AsyncGenerator<never> {
    await held;
  }
  const q = sdk.query({
    prompt: noTurns(),
    options: {
      allowedTools: [],
      settingSources: [],
      ...ISOLATED_MCP,
      ...claudeExecutableOptions(),
      ...agentAuthOptions(),
    },
  });
  try {
    const method = (q as unknown as Record<string, unknown>)
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof method !== 'function') throw new Error('usage method not available');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (method as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('usage probe timed out')), PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    release();
    try {
      (q as unknown as { close?: () => void }).close?.();
    } catch {
      /* already gone */
    }
  }
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  resolveModel,
  runAgent,
  complete,
  detect,
  credentialRoute: () => resolveAiCredential().route,
  usage: {
    readingFromMessage: (message, nowMs) => foldRateLimitEvent(null, message, nowMs),
    probe: sdkUsageProbe,
    readingFromProbe: parseUsageProbe,
    probeReady: () => getAiRuntimeStatus().runtime === 'ready',
  },
};
