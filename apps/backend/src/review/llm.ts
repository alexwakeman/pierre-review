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
//
// THE PROVIDER SEAM (ai/provider.ts): the completion itself — the ladder, the request shape, both
// routes — is the ACTIVE PROVIDER's `complete` (Claude's lives in ai/providers/claude.ts, moved there
// unchanged). This module keeps the one switch every caller passes through and the default model.

import { getActiveProvider } from '../ai/provider.js';
import { config } from '../config.js';

// The request shape and the route pick moved with the Claude completion; re-exported under the names
// this module always had.
export { cheapRequestShape, cheapRoute } from '../ai/providers/claude.js';

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

export async function cheapComplete(
  opts: CheapCompleteOpts,
): Promise<CheapCompleteResult> {
  if (!config.aiEnabled) throw new Error('Claude is switched off here.');
  return getActiveProvider().complete({ ...opts, model: opts.model ?? DEFAULT_MODEL, role: 'fast' });
}
