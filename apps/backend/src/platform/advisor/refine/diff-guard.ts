// Deterministic post-LLM guard — pure, imports NOTHING LLM-shaped. Whatever the refine model
// returned (or whatever a client claims it returned — refined text rides the config-pr body
// and is never trusted), the result may replace the templated block ONLY if:
//   1. it IS exactly one managed block (starts with the start marker, ends with the end
//      marker, no stray markers inside);
//   2. the structured intents header line survives VERBATIM;
//   3. it fits the char budget when one applies (Copilot's 4,000);
//   4. it contains no fenced code block (a reworded instruction never needs one — a fence is
//      the model smuggling structure into prose).
// Any failure ⇒ the templated version is used; the reason is surfaced, never swallowed.
import { INTENTS_HEADER_PREFIX, MARKER_END, MARKER_START } from '../emitters/prose.js';

export function guardRefinedBlock(
  templated: string,
  refined: string,
  opts?: { charBudget?: number },
): { ok: true; content: string } | { ok: false; reason: string } {
  const headerLine = templated
    .split('\n')
    .find((l) => l.trim().startsWith(INTENTS_HEADER_PREFIX));
  if (!headerLine) {
    return { ok: false, reason: 'templated block has no intents header — nothing to refine' };
  }
  const text = refined.trim();
  if (!text.startsWith(MARKER_START) || !text.endsWith(MARKER_END)) {
    return { ok: false, reason: 'refined text dropped the managed markers' };
  }
  if (
    text.indexOf(MARKER_START, MARKER_START.length) !== -1 ||
    text.indexOf(MARKER_END) !== text.length - MARKER_END.length
  ) {
    return { ok: false, reason: 'refined text contains stray managed markers' };
  }
  if (!text.split('\n').some((l) => l.trim() === headerLine.trim())) {
    return { ok: false, reason: 'refined text altered the structured intents header' };
  }
  if (opts?.charBudget != null && text.length > opts.charBudget) {
    return { ok: false, reason: `refined text busts the ${opts.charBudget}-char budget` };
  }
  if (text.includes('```')) {
    return { ok: false, reason: 'refined text introduced a fenced block' };
  }
  return { ok: true, content: text };
}
