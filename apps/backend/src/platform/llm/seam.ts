import type { ProContext } from '../contract.js';

// The cheap-tier completion seam for the plugin. It calls the HOST llm seam
// (ctx.llm.complete → review/llm.ts cheapComplete), so the plugin adds NO new
// Anthropic dependency at runtime — the host owns the SDK wiring. A future
// OpenAI-compatible client implements the same `LlmClient` interface.
//
// AUTH — none chosen here. Every call takes the host's ONE credential ladder (ai/credentials.ts):
// the reader's Claude Code login first, else ANTHROPIC_API_KEY from the environment
// (LIMN_AI_USE_API_KEY=true puts the key first). There is no per-feature key.
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens: number }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    // Who answered. 'codex' ⇒ `costUsd` is Codex's OWN figure (0 on a ChatGPT login), never a Claude
    // price, and `model` is the Codex model: a ledger row must spread both (provider + model).
    provider?: 'claude' | 'codex';
    /** The answering model when the provider named it (Codex); absent ⇒ the caller's own model. */
    model?: string;
  }>;
}

// The plugin's ONE cheap model. The host seam (review/llm.ts) defaults to the same id, gives it
// effort 'low' and pads its cap for thinking; every plugin caller that names a model names this.
export const HAIKU_MODEL = 'claude-haiku-5-5';

// Its list price is TIERED BY PROMPT LENGTH: $0.10 / 1M input and $0.50 / 1M output for a prompt up
// to 100,000 input tokens, $0.50 / $2.50 above it (the whole request moves tier, output included).
const HAIKU_INPUT_USD_PER_TOKEN = 0.1 / 1_000_000;
const HAIKU_OUTPUT_USD_PER_TOKEN = 0.5 / 1_000_000;
const HAIKU_LONG_PROMPT = {
  aboveInputTokens: 100_000,
  inputUsdPerToken: 0.5 / 1_000_000,
  outputUsdPerToken: 2.5 / 1_000_000,
} as const;

/** The USD cost of one Haiku call, tier included. Exported so every plugin caller prices alike. */
export function haikuCostUsd(inputTokens: number, outputTokens: number): number {
  return priceTokens(inputTokens, outputTokens);
}

type HostResult = Awaited<ReturnType<ProContext['llm']['complete']>>;

/**
 * The host's answer → the client's. A CODEX answer keeps Codex's own US$ (0 on a ChatGPT login), its
 * model and its provider — never a Claude price; a Claude answer is priced at the caller's rates.
 */
function fromHost(
  res: HostResult,
  claudeCostUsd: (inputTokens: number, outputTokens: number) => number,
): Awaited<ReturnType<LlmClient['complete']>> {
  const inputTokens = res.usage?.inputTokens ?? 0;
  const outputTokens = res.usage?.outputTokens ?? 0;
  if (res.provider === 'codex') {
    return {
      text: res.text,
      inputTokens,
      outputTokens,
      costUsd: res.costUsd ?? 0,
      provider: 'codex',
      ...(res.model ? { model: res.model } : {}),
    };
  }
  return { text: res.text, inputTokens, outputTokens, costUsd: claudeCostUsd(inputTokens, outputTokens), provider: 'claude' };
}

export function makeHaikuClient(ctx: ProContext): LlmClient {
  return {
    async complete(req) {
      const res = await ctx.llm.complete({
        model: undefined, // the host seam's default, HAIKU_MODEL (review/llm.ts)
        system: req.system,
        prompt: req.user,
        maxTokens: req.maxTokens,
      });
      return fromHost(res, haikuCostUsd);
    },
  };
}

/** One rate card: per-token input/output, with an optional long-prompt tier that moves BOTH legs. */
function priceTokens(inputTokens: number, outputTokens: number): number {
  const rates = inputTokens > HAIKU_LONG_PROMPT.aboveInputTokens
    ? HAIKU_LONG_PROMPT
    : { inputUsdPerToken: HAIKU_INPUT_USD_PER_TOKEN, outputUsdPerToken: HAIKU_OUTPUT_USD_PER_TOKEN };
  return inputTokens * rates.inputUsdPerToken + outputTokens * rates.outputUsdPerToken;
}

// (The period report's model choice, pricing table and `makeReportClient` were REMOVED 2026-11-08
// with the AI write-up: Reports is code only.)
