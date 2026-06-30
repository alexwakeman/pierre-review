import { getUserAnthropicKey } from './local-settings.js';

// The cheap-tier ("Haiku") completion seam. Core-owned so the optional @pierre/pro
// plugin can do a single-shot LLM call (e.g. the per-repo digest) through ctx.llm
// WITHOUT adding its own Anthropic dependency. Non-agentic: one completion, no
// tools, no thinking.
//
// AUTH (load-bearing): this must accept EVERY credential Claude Review accepts —
// an explicit API key, a CLAUDE_CODE_OAUTH_TOKEN, OR an ambient logged-in Claude
// Code session (see review/auth.ts `detectClaudeAuth`). The raw `@anthropic-ai/sdk`
// only understands an explicit key, so it's used ONLY when a real key is present;
// otherwise we fall back to the Claude Agent SDK's `query()` — the SAME runtime
// Claude Review uses — which resolves the OAuth token / ambient session itself. A
// subscription/ambient user (no env key) is the common local case; using the raw
// SDK there throws "No Claude auth" and the digest silently produces nothing.
//
// Both SDK imports are LAZY (inside the function) so merely importing this module
// needs nothing loaded — only an actual caller pays. In OSS mode nothing calls it.

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

const DEFAULT_MODEL = 'claude-haiku-4-5';

export async function cheapComplete(
  opts: CheapCompleteOpts,
): Promise<CheapCompleteResult> {
  const model = opts.model ?? DEFAULT_MODEL;

  // A real API key (user-supplied local key wins, then ANTHROPIC_API_KEY) takes the
  // cheap, metered, exact-cost raw path.
  const apiKey = getUserAnthropicKey() ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) return rawComplete(apiKey, model, opts);

  // No explicit key → use the Agent SDK, which resolves a CLAUDE_CODE_OAUTH_TOKEN
  // or an ambient logged-in Claude session exactly as Claude Review does.
  return agentComplete(model, opts);
}

// ---- raw @anthropic-ai/sdk path (explicit API key) ----------------------------
async function rawComplete(
  apiKey: string,
  model: string,
  opts: CheapCompleteOpts,
): Promise<CheapCompleteResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 700,
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

// ---- Claude Agent SDK path (OAuth token / ambient session) --------------------
async function agentComplete(
  model: string,
  opts: CheapCompleteOpts,
): Promise<CheapCompleteResult> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // A single-turn, tool-less completion: the system prompt is folded into the user
  // prompt (the SDK's systemPrompt is also passed for models that honour it). No
  // tools, no settings, one turn — just text out.
  const prompt = opts.system
    ? `${opts.system}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  const q = query({
    prompt,
    options: {
      model,
      systemPrompt: opts.system,
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      // Don't load the user's ~/.claude settings / MCP servers for a plain
      // completion (mirrors review/agent.ts).
      settingSources: [],
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
      `Agent SDK completion returned no text${errored ? ` (${errored})` : ''} — check Claude auth (ANTHROPIC_API_KEY, or run \`claude\` to sign in).`,
    );
  }
  return { text: trimmed, usage: { inputTokens, outputTokens } };
}
