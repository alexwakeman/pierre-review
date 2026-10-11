import {
  SPRINT_CHECKS_DEFAULT,
  STORY_ISSUE_BY_ID,
  STORY_RULE_BY_ID,
  STORY_SPEC_GAPS_MAX,
  STORY_SPEC_GAP_RULE,
  foldStoryIssues,
  storyBlockerPhrase,
  storyBlockerRule,
  storyIssueTypeChecked,
  usableStoryLabel,
  verifyStoryQuote,
  type SprintAssessmentBody,
  type SprintChecks,
  type SprintFinding,
  type StoryBlocker,
  type StoryQuoteSources,
  type StoryQuoteWhere,
  type StoryRuleId,
} from '@pierre-review/shared';
import { sprintCriteriaOf, type SprintChipInput } from './sprint-chips.js';
import { buildStoryIssueInput } from './story-issue-input.js';

// REPORTS → THIS SPRINT — A TICKET'S ANCHORED FINDINGS (pure; sprint-findings.test.ts). Every thing
// wrong with the ticket, each with a rule from the closed vocabulary (shared story-rules.ts) and —
// when it can be — the exact passage of the ticket it is about, so the SPA can highlight it.
//
//   • CODE: "no criteria" (rule no_criteria, never quoted).
//   • BLOCKED: the REAL open blockers (`foldStoryIssues` → `isRealStoryBlocker`), links before text.
//     A text blocker carries the label's quote; a link is quoted only when its KEY appears in the text.
//   • THE CURRENT LABEL: each untestable criterion (its rule + quote; with no quote, the criterion's
//     own sentence when it is found in the text — a known position, not a guess), and the spec gaps
//     (≤ STORY_SPEC_GAPS_MAX, on EVERY stage).
//   • A CURRENT "Check against code" run's findings (`source: 'claude'`, with Claude's suggestion).
//     ⚠ ONE ROW PER THING: a Claude finding about the SAME thing as a code finding — same issue, and
//     quotes that overlap or a ticket key in common (`sameFindingSubject`) — is MERGED into that row:
//     Claude's sentence becomes the detail (with its rule, suggestion, file and quote when it has one),
//     `source: 'claude'`, at the code finding's place. A code finding absorbs at most one.
//
// ⚠ EVERY QUOTE IS RE-VERIFIED here against the text on the wire (title, description, the criteria
// items and field) — the label's quote was verified against the text SENT, which is clipped and
// colour-stripped. A quote that does not hold is null: the finding stays, unanchored. Never a guessed
// position.
// ⚠ The workspace's checks filter findings exactly as they filter chips (`applyStoryIssueChecks`'s
// rule: an unchecked type → none; an issue switched off → none of its findings).

export interface SprintFindingsInput extends SprintChipInput {
  title: string;
}

/** The ticket text a finding may quote, as the wire carries it. */
export function sprintQuoteSources(i: Pick<SprintFindingsInput, 'title' | 'description' | 'acceptanceCriteria' | 'provider'>): StoryQuoteSources {
  const { items } = sprintCriteriaOf(i, i.provider);
  return { title: i.title, description: i.description, criteria: [...items, i.acceptanceCriteria] };
}

const CRITERIA_FIRST: readonly StoryQuoteWhere[] = ['criteria', 'description', 'title'];
const DESCRIPTION_FIRST: readonly StoryQuoteWhere[] = ['description', 'criteria', 'title'];

function anchor(
  quote: string | null | undefined,
  sources: StoryQuoteSources,
  prefer: readonly StoryQuoteWhere[],
  max?: number | null,
): { quote: string | null; where: StoryQuoteWhere | null } {
  const hit = verifyStoryQuote(quote, sources, { prefer, ...(max !== undefined ? { max } : {}) });
  return hit == null ? { quote: null, where: null } : hit;
}

function finding(
  id: string,
  rule: StoryRuleId,
  a: { quote: string | null; where: StoryQuoteWhere | null },
  detail: string,
  extra: Partial<Pick<SprintFinding, 'suggestion' | 'source' | 'ref' | 'blocker'>> = {},
): SprintFinding {
  const meta = STORY_RULE_BY_ID[rule];
  return {
    id,
    issue: meta.issue,
    rule,
    quote: a.quote,
    where: a.where,
    brief: meta.label,
    detail: detail.trim() !== '' ? detail : meta.hover,
    suggestion: extra.suggestion ?? null,
    source: extra.source ?? 'code',
    ref: extra.ref ?? null,
    ...(extra.blocker != null ? { blocker: extra.blocker } : {}),
  };
}

/** A link blocker's anchor: its key, when the key appears in the text. */
function blockerAnchor(b: StoryBlocker, sources: StoryQuoteSources): { quote: string | null; where: StoryQuoteWhere | null } {
  if (b.source === 'text' && b.quote != null) {
    const a = anchor(b.quote, sources, DESCRIPTION_FIRST);
    if (a.quote != null) return a;
  }
  if (b.ticketKey == null) return { quote: null, where: null };
  // The key as a whole token only: "BMD-9" must not anchor inside "BMD-95".
  const esc = b.ticketKey.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i');
  const texts = [sources.description, ...sources.criteria, sources.title];
  return texts.some((t) => whole.test(t)) ? anchor(b.ticketKey, sources, DESCRIPTION_FIRST) : { quote: null, where: null };
}

/** Every anchored finding on one ticket, filtered by the workspace's checks, in STORY_ISSUES order
 *  (code before Claude within an issue). `body` must be the CURRENT assessment's, or null. Pure. */
export function sprintFindingsFor(
  i: SprintFindingsInput,
  checks: SprintChecks = SPRINT_CHECKS_DEFAULT,
  body: SprintAssessmentBody | null = null,
): SprintFinding[] {
  if (!storyIssueTypeChecked(checks, i.issueType ?? null)) return [];
  const sources = sprintQuoteSources(i);
  const { items } = sprintCriteriaOf(i, i.provider);
  const input = buildStoryIssueInput({ criteria: items, label: i.label, links: i.links ?? null, knownTickets: i.knownTickets ?? null });
  const label = usableStoryLabel(input);
  const issues = foldStoryIssues(input);
  const out: SprintFinding[] = [];

  // unclear_done
  if (items.length === 0) {
    out.push(finding('u-none', 'no_criteria', { quote: null, where: null }, ''));
  } else if (label != null) {
    const flagged = issues.find((x) => x.id === 'unclear_done')?.criteria ?? [];
    for (const f of flagged) {
      const c = label.criteria.find((x) => x.n === f.n);
      const rule: StoryRuleId = c?.rule ?? 'not_observable';
      let a = anchor(c?.quote, sources, CRITERIA_FIRST);
      // No usable quote: the criterion's own sentence, when it is in the text (any length).
      if (a.quote == null) a = anchor(items[f.n - 1], sources, CRITERIA_FIRST, null);
      out.push(finding(`u-c${f.n}`, rule, a, f.reason ?? ''));
    }
  }

  // blocked — the real open blockers only.
  const blockers = issues.find((x) => x.id === 'blocked')?.blockers ?? [];
  blockers.forEach((b, n) => {
    out.push(finding(`b-${n}`, storyBlockerRule(b), blockerAnchor(b, sources), storyBlockerPhrase(b), { blocker: b }));
  });

  // spec_gaps — every stage now, ≤ STORY_SPEC_GAPS_MAX.
  (label?.story.gaps ?? []).slice(0, STORY_SPEC_GAPS_MAX).forEach((g, n) => {
    out.push(finding(`g-${n}`, STORY_SPEC_GAP_RULE[g.type], anchor(g.quote, sources, DESCRIPTION_FIRST), g.text));
  });

  // A CURRENT run's findings — merged into the code row about the same thing, else their own row.
  const merged = new Set<number>();
  (body?.findings ?? []).forEach((f, n) => {
    if (STORY_RULE_BY_ID[f.rule]?.issue !== f.issue) return;
    const a = anchor(f.quote, sources, f.where != null ? [f.where, ...CRITERIA_FIRST.filter((w) => w !== f.where)] : CRITERIA_FIRST);
    const claude = finding(`claude-${n}`, f.rule, a, f.text, {
      source: 'claude',
      suggestion: a.quote != null ? f.suggestion : null,
      ref: f.ref,
    });
    const at = out.findIndex((c, i) => !merged.has(i) && c.source === 'code' && sameFindingSubject(c, claude));
    if (at < 0) {
      out.push(claude);
      return;
    }
    merged.add(at);
    const code = out[at]!;
    out[at] = {
      ...claude,
      quote: claude.quote ?? code.quote,
      where: claude.quote != null ? claude.where : code.where,
      ...(code.blocker != null ? { blocker: code.blocker } : {}),
    };
  });

  const kept = out.filter((f) => !checks.off.includes(f.issue));
  const order = (f: SprintFinding): number => STORY_ISSUE_BY_ID[f.issue].order * 2 + (f.source === 'claude' ? 1 : 0);
  return kept.map((f, n) => ({ f, n })).sort((a, b) => order(a.f) - order(b.f) || a.n - b.n).map((x) => x.f);
}

// ── One row per thing ────────────────────────────────────────────────────────────────────────────

const norm = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').trim();

/** The longest run of characters two strings share (both short: quotes are capped). */
function longestCommonRun(a: string, b: string): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

/** Do two quotes point at the same passage? One holds the other, or they share a run of at least 24
 *  characters (or the whole of the shorter one). */
export function quotesOverlap(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  const x = norm(a);
  const y = norm(b);
  if (x === '' || y === '') return false;
  if (x.includes(y) || y.includes(x)) return true;
  const shorter = Math.min(x.length, y.length);
  return longestCommonRun(x.slice(0, 400), y.slice(0, 400)) >= Math.min(24, shorter);
}

const KEY_RE = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9_]{0,19}-\d{1,9}(?![A-Za-z0-9_-])/g;
const keysIn = (...texts: Array<string | null | undefined>): Set<string> =>
  new Set(texts.flatMap((t) => [...(t ?? '').toUpperCase().matchAll(KEY_RE)].map((m) => m[0])));

/** Is a Claude finding about the same thing as a code finding? Same issue, and their quotes overlap or
 *  they name a ticket key in common (a code blocker's key, or keys in its detail / quote). Pure. */
export function sameFindingSubject(code: SprintFinding, claude: SprintFinding): boolean {
  if (code.issue !== claude.issue) return false;
  if (quotesOverlap(code.quote, claude.quote)) return true;
  const codeKeys = keysIn(code.blocker?.ticketKey, code.issue === 'blocked' ? code.detail : null, code.quote);
  if (codeKeys.size === 0) return false;
  for (const k of keysIn(claude.detail, claude.quote)) if (codeKeys.has(k)) return true;
  return false;
}
