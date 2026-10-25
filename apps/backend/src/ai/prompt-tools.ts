// THE PROMPT SEAM FOR TOOL NAMES (docs/CODEX-PLAN.md Phase 3). Limn's prompts name Claude's tools —
// "You may use Read, Glob and Grep", "call submit_review EXACTLY ONCE" — and Codex has other tools:
// Limn's workspace MCP server (`read_file`, `list_files`, `search`; ai/codex/workspace-files.ts),
// `apply_patch` for every edit, and NO result tool at all (its final message IS the answer, checked
// against a strict JSON Schema; ai/result-schemas.ts). This module is the ONE place a prompt asks
// "what is this tool called here?", so each Phase 3 stream ports its prompts the same way.
//
// HOW A PROMPT USES IT. Write the Claude text as it is today and mark each tool reference with
// braces — `{Read}`, `{Glob}`, `{Grep}`, `{Write}`, `{Edit}`, `{MultiEdit}`, `{Bash}`, or a result
// tool such as `{submit_review}` — then pass it through `renderToolRefs(text, provider)`:
//   • CLAUDE: the braces are dropped and NOTHING else changes, so the bytes are exactly today's
//     (pinned by prompt-tools.test.ts; prompt-golden.json pins the prompts themselves). Only a KNOWN
//     name in braces is touched: `{ summary, failures }` and every other brace in a prompt is text.
//   • CODEX: each name becomes Codex's own (`CODEX_TOOL_NAMES`); a result tool becomes "your final
//     JSON answer". A whole "call submit_x …" SENTENCE reads wrong with that swap, so a sentence about
//     submitting goes through `submitSentence(claudeSentence, provider)` instead: Claude's sentence
//     verbatim, else `CODEX_FINAL_ANSWER_SENTENCE`. Anything else that must differ is
//     `either(claude, codex, provider)`.
// ⚠ This changes WORDS only. What a run may touch is decided in code (the path guard, the tool
// lists, the Codex hook and sandbox), never by a prompt.
import type { AgentProviderId } from './provider.js';
import { activeProviderId } from './provider-setting.js';

/** Claude's tool name → the name Codex's model sees for the same job. */
export const CODEX_TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Glob: 'list_files',
  Grep: 'search',
  Write: 'apply_patch',
  Edit: 'apply_patch',
  MultiEdit: 'apply_patch',
  Bash: 'shell',
};

/** What a result tool (`submit_*`, `record_sections`) becomes in a Codex prompt. */
export const CODEX_RESULT_WORDS = 'your final JSON answer';

/** The ONE sentence a Codex prompt says where Claude's says "call submit_x once with …". */
export const CODEX_FINAL_ANSWER_SENTENCE =
  'When you are done, return your answer as your final message: ONE JSON object matching the given schema, and nothing else.';

/** A result tool: `submit_<words>`, `record_sections` or `finish_document` (ai/result-schemas.ts RESULT_TOOL_NAMES). */
const RESULT_TOOL = /^(?:submit_[a-z_]+|record_sections|finish_document)$/;

// `{Name}` where Name is a known tool or a result tool, nothing else. No nesting, no spaces: a brace
// with anything else inside (a JSON shape in prose, a template) is left alone.
const TOOL_REF = /\{(Read|Glob|Grep|Write|Edit|MultiEdit|Bash|submit_[a-z_]+|record_sections|finish_document)\}/g;

/** One tool's name as the provider's model sees it. Claude: unchanged. */
export function toolName(tool: string, provider: AgentProviderId = activeProviderId()): string {
  if (provider === 'claude') return tool;
  if (RESULT_TOOL.test(tool)) return CODEX_RESULT_WORDS;
  return CODEX_TOOL_NAMES[tool] ?? tool;
}

/** A prompt with `{Tool}` references rendered for the provider (see the header). */
export function renderToolRefs(text: string, provider: AgentProviderId = activeProviderId()): string {
  return text.replace(TOOL_REF, (_m, name: string) => toolName(name, provider));
}

/** A whole "call submit_x …" sentence: Claude's verbatim, else the one Codex final-answer sentence. */
export function submitSentence(claudeSentence: string, provider: AgentProviderId = activeProviderId()): string {
  return provider === 'claude' ? claudeSentence : CODEX_FINAL_ANSWER_SENTENCE;
}

/** Provider-specific wording that no rename covers. */
export function either<T>(claude: T, codex: T, provider: AgentProviderId = activeProviderId()): T {
  return provider === 'claude' ? claude : codex;
}

/** The four helpers bound to one provider, for a prompt builder that renders many lines. */
export interface PromptTools {
  provider: AgentProviderId;
  name(tool: string): string;
  render(text: string): string;
  submit(claudeSentence: string): string;
  either<T>(claude: T, codex: T): T;
}

export function promptTools(provider: AgentProviderId = activeProviderId()): PromptTools {
  return {
    provider,
    name: (tool) => toolName(tool, provider),
    render: (text) => renderToolRefs(text, provider),
    submit: (s) => submitSentence(s, provider),
    either: (c, x) => either(c, x, provider),
  };
}

/**
 * The provider's own name, for user-facing copy that says who did (or could not do) the work:
 * "Claude could not answer" vs "Codex could not answer". A Claude sentence stays byte-identical.
 */
export function providerName(provider: AgentProviderId = activeProviderId()): 'Claude' | 'Codex' {
  return provider === 'claude' ? 'Claude' : 'Codex';
}
