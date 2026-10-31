// THE WRITING RULES (2026-10-31): every word a model writes for a person — a review summary, a
// finding, a story check, a brief, a reply, a chat answer, a figure description — follows ONE set of
// rules: ASD-STE100 Simplified Technical English, and brief. They are added ONCE, at the provider seam
// (`ai/provider.ts` `getProvider`), to the system prompt of every agent run and every completion on
// both providers, so no runner can forget them and no prompt carries its own copy.
//
// ⚠ They govern PROSE only. They must never change code, commands, quotes, identifiers or the output
// format a caller asks for (a JSON schema, a tool call), and a caller's own tighter limit wins.
// ⚠ TWO SETS, chosen by the run's kind (`writingStyleFor`). REVIEWS — the AI review and its
// specialists, the CI review, Check threads, the review chat — keep the same technical-writing rules
// but NO length caps, and are told never to cut a finding or a detail to save words: their findings
// feed AI Fix and the CI fix, which need the file, the line, the cause and the change. Everything else
// (story checks, briefs, summaries, chat about docs, every one-shot completion) gets the brief set.
// ⚠ Being appended at the seam, they leave each runner's own prompt text — and so the prompt goldens
// (`review/claude-review/__fixtures__/prompt-golden.json`) — byte-identical.

export const WRITING_RULES = `# Writing rules
These rules apply to all text that a person reads: summaries, findings, explanations, replies, briefs, notes, titles and chat answers. Write in ASD-STE100 Simplified Technical English.
- Be brief. Use the fewest words that state the fact. Do not repeat what the reader can already see.
- Write one idea in each sentence. A sentence has a maximum of 20 words. A description sentence can have 25 words.
- A summary has a maximum of 2 sentences. A finding, a point or an explanation has a maximum of 3 sentences. A paragraph has a maximum of 4 sentences.
- Use a list for steps, and for 3 or more items.
- Use the active voice. Use the simple present, the simple past and the future tense. Write "the function returns null", not "null is being returned".
- Use common words that have one meaning. Use the same word for the same thing each time. Do not use phrasal verbs ("set up", "carry out") or idioms. Use "configure", "do".
- Name the thing: the file, the function, the field, the rule. Keep technical names, code, identifiers, ticket keys and quotes exactly as they are.
- Write the fact and then stop. Do not write a preamble, filler ("Overall", "It is worth noting"), hedges ("it seems", "it appears") or praise, unless you are told to.
- Write "must" for a requirement and "can" for a possibility.
- Do not use contractions or slang.
These rules apply only to prose. They do not change code, commands, quoted text, identifiers, or the output format (a tool call, a JSON object) that you must use. If a different instruction gives a shorter limit, obey the shorter limit.`;

/** The review set: the same technical-writing rules, no length caps, nothing cut. */
export const REVIEW_WRITING_RULES = `# Writing rules
These rules apply to all text that a person reads: summaries, findings, explanations and replies. Write in ASD-STE100 Simplified Technical English.
- Give the full technical content. Do not shorten or leave out a finding, a cause, evidence or a fix to save words. A finding gives what the author, or an agent that fixes the code, needs: the file, the line, what is wrong, why, and the change to make.
- Write one idea in each sentence. A sentence has a maximum of 20 words. A description sentence can have 25 words.
- Use a list for steps, and for 3 or more items.
- Use the active voice. Use the simple present, the simple past and the future tense. Write "the function returns null", not "null is being returned".
- Use common words that have one meaning. Use the same word for the same thing each time. Do not use phrasal verbs ("set up", "carry out") or idioms. Use "configure", "do".
- Name the thing: the file, the function, the field, the rule. Keep technical names, code, identifiers, ticket keys and quotes exactly as they are.
- Do not write a preamble, filler ("Overall", "It is worth noting"), hedges ("it seems", "it appears") or praise, unless you are told to. Say what you could not confirm, once and plainly.
- Write "must" for a requirement and "can" for a possibility.
- Do not use contractions or slang.
These rules apply only to prose. They do not change code, commands, quoted text, identifiers, or the output format (a tool call, a JSON object) that you must use.`;

export type WritingStyle = 'brief' | 'review';

/** The run kinds that are REVIEWS (their findings feed AI Fix and the CI fix): no length caps. */
const REVIEW_KINDS: ReadonlySet<string> = new Set(['review', 'ci_review', 'thread_check', 'review_chat']);

/** Which set a run gets, by its kind. A one-shot completion (no kind) is brief. */
export function writingStyleFor(kind: string | undefined): WritingStyle {
  return kind != null && REVIEW_KINDS.has(kind) ? 'review' : 'brief';
}

/** A system prompt with the writing rules after it (or the rules alone when there was none). */
export function withWritingRules(system: string | undefined, style: WritingStyle = 'brief'): string {
  const rules = style === 'review' ? REVIEW_WRITING_RULES : WRITING_RULES;
  return system != null && system !== '' ? `${system}\n\n${rules}` : rules;
}
