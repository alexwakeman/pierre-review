// The cheap-tier ("Haiku") completion seam: every one-shot model call in Limn — core's (sprint
// briefs/themes, story labels, docs ranking, sprint Ask Claude…) and the platform's through
// ctx.llm (reports, synthesis, work-plan wording, pointers, bot themes, the impact note, the
// advisor's refine, the Slack report). Non-agentic: one completion, no tools.
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
// LIMN_AI_USE_API_KEY=true puts the key first. LIMN_AI_DISABLED=true refuses every call. No caller
// chooses its own credential any more: there is no per-feature key and no "key-only" route.
//
// Both SDKs are LOADED LAZILY through ai/runtime.ts (the one module allowed to import them), so
// merely importing this module needs nothing — only an actual caller pays. On an npm install they
// exist only once the reader has set AI up.

import { claudeExecutableOptions, loadAgentSdk, loadAnthropicSdk } from '../ai/runtime.js';
import { ISOLATED_MCP, ownToolsOnlyHook } from '../ai/agent-isolation.js';
import { agentSdkEnv, resolveAiCredential, type AiCredential } from '../ai/credentials.js';
import { config } from '../config.js';
import { NO_CLAUDE_AUTH_MESSAGE } from './auth.js';

export interface CheapCompleteOpts {
  model?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface CheapCompleteResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const DEFAULT_MODEL = 'claude-haiku-5-5';

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

export async function cheapComplete(
  opts: CheapCompleteOpts,
): Promise<CheapCompleteResult> {
  if (!config.aiEnabled) throw new Error('Claude is switched off here.');
  const model = opts.model ?? DEFAULT_MODEL;
  const credential = resolveAiCredential();
  const route = cheapRoute(credential);
  if (route === 'none') throw new Error(NO_CLAUDE_AUTH_MESSAGE);
  return route === 'api' && credential.route === 'api_key'
    ? rawComplete(credential.apiKey, model, opts)
    : agentComplete(model, opts, credential);
}

/** Which path one cheap completion takes (exported for the test): the login → the Agent SDK. */
export function cheapRoute(credential: AiCredential): 'agent' | 'api' | 'none' {
  if (credential.route === 'login') return 'agent';
  if (credential.route === 'api_key') return 'api';
  return 'none';
}

// ---- raw @anthropic-ai/sdk path (the ANTHROPIC_API_KEY rung) ----------------------------
async function rawComplete(
  apiKey: string,
  model: string,
  opts: CheapCompleteOpts,
): Promise<CheapCompleteResult> {
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
  opts: CheapCompleteOpts,
  credential: AiCredential,
): Promise<CheapCompleteResult> {
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
