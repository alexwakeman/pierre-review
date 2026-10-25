// CODEX WORDING FOR THE REVIEW STREAM (docs/CODEX-PLAN.md Phase 3, stream a): Claude Review, its
// specialists, the review chat and Check threads.
//
// ⚠ THE CLAUDE PROMPTS ARE NOT TOUCHED. They are built exactly as before (claude-review/prompts.ts,
// chat.ts, chat-explain.ts, thread-check.ts — pinned by prompt-golden.json and their own tests), and
// ONLY a Codex run passes the finished text through a function here. Each function swaps a KNOWN
// Claude sentence for its Codex twin; the Codex side is written with `{Tool}` refs and rendered by the
// prompt seam (ai/prompt-tools.ts), so the tool names come from ONE table (`CODEX_TOOL_NAMES`).
//
// Why swaps over the finished text and not `{Read}` markers in the prompt sources: those sources are
// shared with every Claude run and pinned byte-for-byte; a marker in them would make a Claude prompt
// depend on the seam's rendering. Here, Claude cannot be affected — nothing on its path calls this.
//
// ⚠ DRIFT IS A TEST FAILURE, NOT A SILENT LEAK: codex-wording.test.ts renders every prompt variant
// (diff-only, worktree, specialists, the library, follow-up, threads, chat, explain, Check threads)
// through these functions and fails on any Claude-only word left behind (`submit_review`, "Read, Glob",
// "the Agent tool", "Leave … out"…). A Claude sentence edited without its twin here shows up there.
//
// What changes for Codex, and why:
//   • tool names: Codex reads through Limn's workspace MCP server (`read_file`, `list_files`, `search`);
//   • the result: Codex has no `submit_*` tool — its final message IS the answer, checked against the
//     STRICT schema (ai/result-schemas.ts), so "call submit_review once" becomes "give your final JSON
//     answer", and "leave X out" becomes "set X to null" (strict form requires every key);
//   • specialists: on Codex Limn runs them BEFORE the lead (ai/codex/specialists.ts), so the lead is
//     told their reports are in its message, not that it may dispatch them.
import { promptTools } from '../ai/prompt-tools.js';
import { specialistsPromptSection } from './claude-review/specialists.js';
import type { ClaudeFindingLens } from '@pierre-review/shared';

const t = promptTools('codex');

/** One swap: a Claude sentence (exact), and the Codex text that replaces every copy of it. */
type Swap = readonly [claude: string, codex: string];

function applySwaps(text: string, swaps: readonly Swap[]): string {
  let out = text;
  for (const [from, to] of swaps) out = out.split(from).join(to);
  return out;
}

// ---- Claude Review --------------------------------------------------------------------------------

const REVIEW_SWAPS: readonly Swap[] = [
  // The worktree environment.
  [
    '- You may use Read, Glob, and Grep. There is NO shell: Bash is not available, so explore with the file tools rather than `git log`/`cat`/`grep` invocations.',
    t.render('- You may use {Read}, {Glob} and {Grep}. There is NO shell, so explore with those tools rather than `git log`/`cat`/`grep` invocations.'),
  ],
  ['do NOT Read files just to see the diff', 'do NOT read files just to see the diff'],
  // The diff-only environment (with and without the reference library).
  [
    '- You have NO file-system or repository access: no Read, Glob, Grep, Bash, and no checked-out worktree. The ONLY tool available to you is submit_review.',
    '- You have NO file-system or repository access: no file tools, no shell, and no checked-out worktree. You answer with your final JSON answer only.',
  ],
  [
    "- You have NO repository access: no checked-out worktree and no Bash. Read, Glob and Grep reach ONLY the team's reference library (described below), never the repository. Your other tool is submit_review.",
    t.render(
      "- You have NO repository access: no checked-out worktree and no shell. {Read}, {Glob} and {Grep} reach ONLY the team's reference library (described below), never the repository. You answer with your final JSON answer.",
    ),
  ],
  // Findings: strict form sends every key, so "leave it out" is "null".
  ["  - Omit 'line' entirely for a file-level or general observation.", "  - Set 'line' to null for a file-level or general observation."],
  [
    "- 'priorRef': only when you raise a finding from the \"Previous review\" section again, its ref (e.g. 'P3'). Leave it out otherwise.",
    "- 'priorRef': only when you raise a finding from the \"Previous review\" section again, its ref (e.g. 'P3'). null otherwise.",
  ],
  // Finishing.
  [
    'When you are done, call the submit_review tool EXACTLY ONCE with:',
    'When you are done, give your final answer: ONE JSON object matching the given schema, with:',
  ],
  [
    'Add `followUp` when the user message has a "Previous review" section, and `threads` when it has a "Review threads" section. Leave each out otherwise.',
    'Fill `followUp` when the user message has a "Previous review" section, and `threads` when it has a "Review threads" section. Set each to null otherwise. Set any other field you have nothing for to null.',
  ],
  [
    'Do not call any other terminal action, and do not write prose outside the submit_review tool call. Call submit_review once and only once.',
    'Your final message is that JSON object and nothing else: no prose around it.',
  ],
  // The reference library block (reference-docs/review-refs.ts + prompts.ts `docsNavigationPrompt`).
  [
    '- This review has no checkout of the repository: Read, Glob and Grep reach the library only. Use them for nothing else.',
    t.render('- This review has no checkout of the repository: {Read}, {Glob} and {Grep} reach the library only. Use them for nothing else.'),
  ],
  ['- `docReferences` is a field of your submit_review call; `docRefs` is a field of a finding.', '- `docReferences` is a field of your final JSON answer; `docRefs` is a field of a finding.'],
  ['- Leave `docReferences` out when nothing in the library bears on this.', '- Set `docReferences` to null when nothing in the library bears on this.'],
  ['Grep across the library for a specific term, name or number.', t.render('Use {Grep} across the library for a specific term, name or number.')],
  // The user prompt.
  ['use Read/Grep/Glob to inspect any you judge relevant', t.render('use {Read}/{Grep}/{Glob} to inspect any you judge relevant')],
  ['call submit_review EXACTLY ONCE with your', 'give your final answer (ONE JSON object) with your'],
];

/** The Codex specialists head: their reports are already in the lead's message (see the header). */
const CODEX_SPECIALISTS_HEAD = `# Specialists
This is a deep review. Specialist reviewers have already read this change, each in its own area, and their reports are in the user message under "Specialist reports". They are another model's notes, not facts:
- Check each point against the code, drop anything you cannot confirm, and merge duplicates.
- Submit the points that hold in your own findings, with 'lens' set to the specialist's name. Set 'lens' to null for your own general findings.
- A specialist that did not answer is named there; cover its area yourself only where the change clearly needs it.

`;

/** The Claude specialists section for these lenses, rewritten for Codex. '' when none are offered. */
export function codexSpecialistsSection(lenses: readonly ClaudeFindingLens[]): { claude: string; codex: string } {
  const claude = specialistsPromptSection(lenses);
  if (!claude) return { claude: '', codex: '' };
  const at = claude.indexOf('# Design comments');
  if (at < 0) throw new Error('codex wording: the specialists section lost its "# Design comments" part');
  return { claude, codex: CODEX_SPECIALISTS_HEAD + claude.slice(at) };
}

/**
 * A Claude Review SYSTEM prompt (claude-review/prompts.ts `systemPromptForMode`) for a Codex run.
 * `specialists` = the lenses whose section the prompt carries (a deep run's offered ones).
 */
export function codexReviewSystemPrompt(system: string, specialists: readonly ClaudeFindingLens[] = []): string {
  let out = system;
  const section = codexSpecialistsSection(specialists);
  if (section.claude) {
    if (!out.includes(section.claude)) throw new Error('codex wording: the specialists section is not in the system prompt');
    out = out.split(section.claude).join(section.codex);
  }
  return applySwaps(out, REVIEW_SWAPS);
}

/** A Claude Review USER prompt (claude-review/prompts.ts `buildUserPrompt` + checkouts) for a Codex run. */
export function codexReviewUserPrompt(prompt: string): string {
  return applySwaps(prompt, REVIEW_SWAPS);
}

// ---- the specialists (Limn runs them on Codex) -----------------------------------------------------

const SPECIALIST_SWAPS: readonly Swap[] = [
  [
    'You can use Read, Glob and Grep on the repository, checked out at the pull request\'s head. You cannot run commands, edit files or post anything.',
    t.render("You can use {Read}, {Glob} and {Grep} on the repository, checked out at the pull request's head. You cannot run commands, edit files or post anything."),
  ],
  [
    'Reply with a plain list, most important first, at most 8 items. For each:',
    'Put your report in `report` as a plain list, most important first, at most 8 items. For each:',
  ],
  ['(find them with Grep)', t.render('(find them with {Grep})')],
  ['(Glob for test files beside the changed modules and Grep for the changed symbols)', t.render('({Glob} for test files beside the changed modules and {Grep} for the changed symbols)')],
  ['the lead reviewer covers the rest', 'the lead reviewer covers the rest and reads your report after you'],
];

/** A specialist's instructions (claude-review/specialists.ts `specialistPrompt`) for a Codex run. */
export function codexSpecialistInstructions(claudeInstructions: string): string {
  return applySwaps(claudeInstructions, SPECIALIST_SWAPS);
}

// ---- the review chat ------------------------------------------------------------------------------

const CHAT_SWAPS: readonly Swap[] = [
  [
    'You may use Read, Glob and Grep to look things up. There is no shell, no write tool and no network.',
    t.render('You may use {Read}, {Glob} and {Grep} to look things up. There is no shell, no write tool and no network.'),
  ],
  ['a code review you (Claude) wrote for one GitHub pull request', 'a code review you wrote for one GitHub pull request'],
  // An explain turn (claude-review/chat-explain.ts).
  [
    'answer ONLY through the submit_explanations tool, one card per item,',
    'answer ONLY with your final JSON answer, one card per item,',
  ],
  ['Answer by calling submit_explanations EXACTLY once, with one card per item:', 'Answer with ONE JSON object, with one card per item:'],
  ['Put nothing outside the tool call.', 'Put nothing outside that JSON object.'],
];

/** A review-chat system prompt or message (chat.ts, chat-explain.ts) for a Codex run. */
export function codexChatText(text: string): string {
  return applySwaps(text, CHAT_SWAPS);
}

// ---- Check threads --------------------------------------------------------------------------------

const THREAD_CHECK_SWAPS: readonly Swap[] = [
  [
    '- You may use Read, Glob and Grep. There is NO shell, and you have NO write tools and NO network tools.',
    t.render('- You may use {Read}, {Glob} and {Grep}. There is NO shell, and you have NO write tools and NO network tools.'),
  ],
  [
    'Call submit_threads EXACTLY ONCE with { threads }. Each entry: ref, validity, addressed, explanation (one or two sentences that name the code you checked), reason (ONE line, at most 120 characters), and an optional draftReply. Do not write prose outside the tool call.',
    'Give your final answer as ONE JSON object { threads }. Each entry: ref, validity, addressed, explanation (one or two sentences that name the code you checked), reason (ONE line, at most 120 characters), and draftReply (null when you have none). Nothing outside that object.',
  ],
  ['Call submit_threads once with { threads }.', 'Answer with ONE JSON object { threads }.'],
];

/** A Check threads system prompt or message (thread-check.ts) for a Codex run. */
export function codexThreadCheckText(text: string): string {
  return applySwaps(text, THREAD_CHECK_SWAPS);
}

/** Every swap of this module, for the drift test (each Claude side must still be in a real prompt). */
export const ALL_CODEX_SWAPS: readonly Swap[] = [...REVIEW_SWAPS, ...SPECIALIST_SWAPS, ...CHAT_SWAPS, ...THREAD_CHECK_SWAPS];

/**
 * Words that must never reach a Codex prompt of this stream (the drift test's list): a Claude tool
 * name, or an instruction that only makes sense with Claude's tools.
 */
export const CLAUDE_ONLY_WORDS: readonly RegExp[] = [
  /submit_(review|threads|explanations)/,
  /\bRead, Glob\b/,
  /\bRead\/Grep\/Glob\b/,
  /\bGrep\b/,
  /\bGlob\b/,
  /\bBash\b/,
  /Agent tool/,
  /subagent_type/,
  /tool call/,
  /Leave (it|each|`docReferences`) out/,
  /Omit 'line'/,
  /\(Claude\)/,
];
