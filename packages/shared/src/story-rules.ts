import type { StoryIssueId } from './story-issues.js';
import type { StoryDependencyKind, StorySpecGapType } from './story-health.js';

// THE STORY RULES — the CLOSED vocabulary every anchored finding carries (Reports → This sprint: the
// highlights in the ticket text, their hover line and the filters). ONE spelling, read by the
// labeller's validator (review/story-labels), the "Check against code" validator (review/sprint-assess),
// the server's findings fold (db/sprint-findings.ts) and the SPA.
//
// Each rule belongs to exactly ONE story issue (`story-issues.ts`). The labels and hover lines are
// TEMPLATED, never model text: a finding's own detail (the labeller's reason, Claude's sentence) is
// shown beside them as data.
//
//   unclear_done  no_criteria (CODE ONLY — never a model's answer, never quoted), no_expected_result,
//                 vague_term, no_input_or_state, not_observable, bundled
//   blocked       waits_on_ticket, waits_on_decision, waits_on_team, waits_on_external
//   spec_gaps     edge_case, error_handling, business_rule, data, design, non_functional
//
// ⚠ A NEW RULE IS A RUBRIC CHANGE when the labeller may emit it: bump `STORY_RUBRIC_VERSION` with it.

export type StoryUnclearRuleId =
  | 'no_criteria'
  | 'no_expected_result'
  | 'vague_term'
  | 'no_input_or_state'
  | 'not_observable'
  | 'bundled';

export type StoryBlockedRuleId = 'waits_on_ticket' | 'waits_on_decision' | 'waits_on_team' | 'waits_on_external';

export type StoryGapRuleId = 'edge_case' | 'error_handling' | 'business_rule' | 'data' | 'design' | 'non_functional';

export type StoryRuleId = StoryUnclearRuleId | StoryBlockedRuleId | StoryGapRuleId;

export interface StoryRuleMeta {
  id: StoryRuleId;
  issue: StoryIssueId;
  /** Short label: the finding's `brief`, the pill / filter text. */
  label: string;
  /** One line for the highlight's hover. */
  hover: string;
  /** Raised by code only — a model answer naming it is refused. */
  codeOnly: boolean;
}

/** In display order within each issue (issues in STORY_ISSUES order). */
export const STORY_RULES: readonly StoryRuleMeta[] = [
  { id: 'no_criteria', issue: 'unclear_done', label: 'No criteria', hover: 'The ticket has no acceptance criteria.', codeOnly: true },
  { id: 'no_expected_result', issue: 'unclear_done', label: 'No expected result', hover: 'It does not say what should happen.', codeOnly: false },
  { id: 'vague_term', issue: 'unclear_done', label: 'Vague word', hover: 'A word nobody can test, such as “intuitive” or “fast”.', codeOnly: false },
  { id: 'no_input_or_state', issue: 'unclear_done', label: 'No starting point', hover: 'It does not say what input or state to start from.', codeOnly: false },
  { id: 'not_observable', issue: 'unclear_done', label: 'Can’t be seen', hover: 'A tester could not see or measure the result.', codeOnly: false },
  { id: 'bundled', issue: 'unclear_done', label: 'Several outcomes', hover: 'One criterion holds several outcomes. Split it.', codeOnly: false },
  { id: 'waits_on_ticket', issue: 'blocked', label: 'Waits on a ticket', hover: 'Another ticket has to be finished first.', codeOnly: false },
  { id: 'waits_on_decision', issue: 'blocked', label: 'Waits on a decision', hover: 'Someone has to decide or approve something first.', codeOnly: false },
  { id: 'waits_on_team', issue: 'blocked', label: 'Waits on a team', hover: 'Another team or person has to do something first.', codeOnly: false },
  { id: 'waits_on_external', issue: 'blocked', label: 'Waits on outside work', hover: 'Something outside the team has to exist first.', codeOnly: false },
  { id: 'edge_case', issue: 'spec_gaps', label: 'Edge case', hover: 'An unusual case the ticket does not cover.', codeOnly: false },
  { id: 'error_handling', issue: 'spec_gaps', label: 'Error handling', hover: 'It does not say what happens when something fails.', codeOnly: false },
  { id: 'business_rule', issue: 'spec_gaps', label: 'Business rule', hover: 'A rule the developer would have to ask about.', codeOnly: false },
  { id: 'data', issue: 'spec_gaps', label: 'Data', hover: 'Which data, fields or formats is not stated.', codeOnly: false },
  { id: 'design', issue: 'spec_gaps', label: 'Design', hover: 'What it should look like is not stated.', codeOnly: false },
  { id: 'non_functional', issue: 'spec_gaps', label: 'Non-functional', hover: 'Speed, security or accessibility needs are not stated.', codeOnly: false },
];

export const STORY_RULE_IDS: readonly StoryRuleId[] = STORY_RULES.map((r) => r.id);

export const STORY_RULE_BY_ID: Readonly<Record<StoryRuleId, StoryRuleMeta>> = Object.fromEntries(
  STORY_RULES.map((r) => [r.id, r]),
) as Record<StoryRuleId, StoryRuleMeta>;

export function isStoryRuleId(v: unknown): v is StoryRuleId {
  return typeof v === 'string' && (STORY_RULE_IDS as readonly string[]).includes(v);
}

/** The rules of one issue, in display order (code-only ones included). */
export function storyRulesOf(issue: StoryIssueId): StoryRuleId[] {
  return STORY_RULES.filter((r) => r.issue === issue).map((r) => r.id);
}

/** May a MODEL answer name this rule for this issue? (In the vocabulary, of that issue, not code-only.) */
export function isModelStoryRule(rule: unknown, issue: StoryIssueId): rule is StoryRuleId {
  return isStoryRuleId(rule) && STORY_RULE_BY_ID[rule].issue === issue && !STORY_RULE_BY_ID[rule].codeOnly;
}

/** The rules the labeller may give an untestable criterion. */
export const STORY_CRITERION_RULE_IDS: readonly StoryUnclearRuleId[] = storyRulesOf('unclear_done').filter(
  (r) => !STORY_RULE_BY_ID[r].codeOnly,
) as StoryUnclearRuleId[];

/** A labelled spec gap's type → its rule (`rule` is the business rule). */
export const STORY_SPEC_GAP_RULE: Readonly<Record<StorySpecGapType, StoryGapRuleId>> = {
  rule: 'business_rule',
  edge_case: 'edge_case',
  error_handling: 'error_handling',
  design: 'design',
  data: 'data',
  non_functional: 'non_functional',
};

/** A dependency → its blocked rule: a ticket (a key, or kind 'ticket') → waits_on_ticket; a decision →
 *  waits_on_decision; anything else owned by a named team or person → waits_on_team; else
 *  waits_on_external. Pure. */
export function storyBlockerRule(b: { kind: StoryDependencyKind; ticketKey: string | null; owner: string | null }): StoryBlockedRuleId {
  if (b.ticketKey != null || b.kind === 'ticket') return 'waits_on_ticket';
  if (b.kind === 'decision') return 'waits_on_decision';
  if (b.owner != null && b.owner.trim() !== '') return 'waits_on_team';
  return 'waits_on_external';
}

// ── Quotes: the anchor of a finding in the ticket text ───────────────────────────────────────────
//
// A finding's `quote` is an EXACT passage of the ticket (title, description or criteria). A model's
// quote is VERIFIED here before anything shows it: whitespace-normalised (runs of whitespace are one
// space), curly quotes and apostrophes read as straight, case-sensitive first, then case-insensitive.
// The returned quote is the TICKET's own spelling (whitespace collapsed), never the model's. A quote
// that does not verify is null — the finding stays, unanchored — never a guessed position.

/** A model quote's cap (characters, after whitespace normalisation). */
export const STORY_QUOTE_MAX = 120;

export type StoryQuoteWhere = 'title' | 'description' | 'criteria';

export interface StoryQuoteSources {
  title: string;
  description: string;
  /** Criteria text: the numbered items and/or the raw criteria field. Searched in order. */
  criteria: readonly string[];
}

export interface VerifiedStoryQuote {
  /** The passage as the ticket spells it, whitespace collapsed. */
  quote: string;
  where: StoryQuoteWhere;
}

const QUOTE_CHARS: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"' };

/** `s` normalised, with each normalised char's index in `s`. Whitespace runs → one space, trimmed. */
function normaliseWithMap(s: string, lower: boolean): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (text !== '' && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      text += ' ';
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    let c = QUOTE_CHARS[ch] ?? ch;
    if (lower) {
      const l = c.toLowerCase();
      if (l.length === 1) c = l;
    }
    text += c;
    map.push(i);
  }
  return { text, map };
}

/** Whitespace-collapsed, trimmed. */
export function normaliseStoryQuote(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function findIn(source: string, quote: string, lower: boolean): string | null {
  const q = normaliseWithMap(quote, lower).text;
  if (q === '') return null;
  const n = normaliseWithMap(source, lower);
  const at = n.text.indexOf(q);
  if (at < 0) return null;
  const from = n.map[at]!;
  const to = n.map[at + q.length - 1]! + 1;
  return normaliseStoryQuote(source.slice(from, to));
}

/**
 * Verify `quote` against the ticket text. Searches `prefer` first (default criteria, description,
 * title), case-sensitive across every source, then case-insensitive. null when the quote is empty,
 * over `max` characters, or found nowhere. Pure.
 */
export function verifyStoryQuote(
  quote: string | null | undefined,
  sources: StoryQuoteSources,
  opts: { prefer?: readonly StoryQuoteWhere[]; max?: number | null } = {},
): VerifiedStoryQuote | null {
  if (typeof quote !== 'string') return null;
  const q = normaliseStoryQuote(quote);
  const max = opts.max === undefined ? STORY_QUOTE_MAX : opts.max;
  if (q === '' || (max != null && q.length > max)) return null;
  const order = opts.prefer ?? (['criteria', 'description', 'title'] as const);
  const texts = (w: StoryQuoteWhere): readonly string[] =>
    w === 'title' ? [sources.title] : w === 'description' ? [sources.description] : sources.criteria;
  for (const lower of [false, true]) {
    for (const where of order) {
      for (const t of texts(where)) {
        const hit = findIn(t ?? '', q, lower);
        if (hit != null) return { quote: hit, where };
      }
    }
  }
  return null;
}
