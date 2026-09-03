// The cheap-tier ("Haiku") completion seam. Core-owned so the optional @pierre/pro
// plugin can do a single-shot LLM call (e.g. the per-repo digest) through ctx.llm
// WITHOUT adding its own Anthropic dependency. Non-agentic: one completion, no
// tools, no thinking.
//
// AUTH is CALLER-OWNED (this is deliberate — it keeps each feature's auth discrete):
//   • `opts.apiKey` given → the raw, metered `@anthropic-ai/sdk` with THAT key. The
//     key is passed EXPLICITLY and this seam never reads/writes process.env, so a
//     summary key can never leak into (or force metering on) Claude Review, which
//     resolves auth separately and prefers the ambient subscription.
//   • no `apiKey` → the Claude Agent SDK's `query()` (the SAME runtime Claude Review
//     uses), which resolves a CLAUDE_CODE_OAUTH_TOKEN / ambient logged-in session.
// So the Pro summary passes its own dedicated key (fast, metered) while an OSS/dev
// caller with no key still works via the ambient session.
//
// Both SDK imports are LAZY (inside the function) so merely importing this module
// needs nothing loaded — only an actual caller pays. In OSS mode nothing calls it.

export interface CheapCompleteOpts {
  model?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  // Explicit Anthropic API key → the raw metered path. Omitted → the ambient
  // Claude session (Agent SDK). The seam NEVER falls back to process.env or the
  // Claude Review key on its own — the caller decides its credential.
  apiKey?: string;
  // ⚠ RETIRED, AND KEPT ONLY SO THE ProContext SHAPE DOES NOT MOVE. It used to mean "CORE
  // resolves the local BYO Anthropic key itself and uses it on the raw metered path". That
  // stored key no longer exists — local advanced-AI auth is two rungs now (ambient Claude
  // session, else the environment's ANTHROPIC_API_KEY), and the ambient path below already
  // resolves BOTH through the Agent SDK. So this option resolves to exactly the same thing as
  // omitting it. Do not re-add a resolver behind it; the ladder it named is gone.
  credential?: 'local-review-key';
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

  // An explicit key → the cheap, metered, exact-cost raw path. No key → the ambient session
  // via the Agent SDK, which itself resolves an ambient login or the environment's
  // ANTHROPIC_API_KEY. (No implicit env read here — the SDK owns that half.)
  //
  // ⚠ `opts.credential` IS NO LONGER BRANCHED ON. The stored BYO key it named is retired, so
  // its rung would resolve to nothing; the two-rung ladder IS `agentComplete`.
  if (opts.apiKey) return rawComplete(opts.apiKey, model, opts);
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
