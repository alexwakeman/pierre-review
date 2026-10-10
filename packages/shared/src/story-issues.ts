import type { StoryCriterionLabel, StoryLevelLabels } from './story-health.js';

// THE FOUR STORY ISSUES — the ONE vocabulary for "what is wrong with this ticket" across Reports →
// This sprint (chips, bullets, checks, the code assessment), Story health (the refinement panel) and
// the story report (its points carry an issue id). docs/CLAUDE-REVIEW.md § Story issues.
//
// FOLDED IN CODE from inputs that already exist — never a new model call, never a relabel:
//   • the numbered criteria (`extractCriteria`, the ONE extractor), and
//   • the six stored Haiku labels (`story_labels`, `STORY_RUBRIC_VERSION` unchanged): per criterion
//     testable / bundled / dependsOnOtherWork, per story outOfScopeStated / dependencyNamed /
//     nonCodeWork.
//
//   unclear_done    no criteria, OR any criterion not testable.
//   too_big         more than STORY_TOO_BIG_CRITERIA criteria, OR any criterion bundled, OR nonCodeWork.
//   waits_on_work   any criterion dependsOnOtherWork.
//   scope_unstated  outOfScopeStated is false.
//
// ⚠ A LABEL HALF NEEDS A CURRENT LABEL — the caller hands in only the label whose text hash equals
// today's (`storyLabelInput`), and a label that judged a different NUMBER of criteria than today's list
// is ignored here (criterion n must point at the text it judged). With no usable label, only what code
// knows is raised: "no criteria" and "more than 8 criteria". Unknown is never "fine": `storyIssueStates`
// says `null` for an issue it cannot decide, and Story health leaves that story out of that series.
//
// ⚠ EVERY SENTENCE HERE IS TEMPLATED — the chip detail and the one-line bullet. Never model text. (The
// code assessment may REPLACE a bullet with its own sentence; that is labelled as Claude's on screen.)

/** A ticket with more criteria than this is "Too big" on count alone. */
export const STORY_TOO_BIG_CRITERIA = 8;

export type StoryIssueId = 'unclear_done' | 'too_big' | 'waits_on_work' | 'scope_unstated';

export interface StoryIssueMeta {
  id: StoryIssueId;
  /** Chip / heading text, plain English. */
  label: string;
  /** Display order (chips, bullets, series, Copy all). */
  order: number;
  /** The issue AVOIDED, for a strength ("What we do well"): naming the problem there reads as one. */
  avoided: string;
}

/** In display order. */
export const STORY_ISSUES: readonly StoryIssueMeta[] = [
  { id: 'unclear_done', label: 'Unclear when done', order: 0, avoided: 'Clear when done' },
  { id: 'too_big', label: 'Too big', order: 1, avoided: 'Right-sized' },
  { id: 'waits_on_work', label: 'Waits on other work', order: 2, avoided: 'Nothing to wait on' },
  { id: 'scope_unstated', label: 'Scope not stated', order: 3, avoided: 'Scope stated' },
];

export const STORY_ISSUE_IDS: readonly StoryIssueId[] = STORY_ISSUES.map((m) => m.id);

export const STORY_ISSUE_BY_ID: Readonly<Record<StoryIssueId, StoryIssueMeta>> = Object.fromEntries(
  STORY_ISSUES.map((m) => [m.id, m]),
) as Record<StoryIssueId, StoryIssueMeta>;

export function isStoryIssueId(v: unknown): v is StoryIssueId {
  return typeof v === 'string' && (STORY_ISSUE_IDS as readonly string[]).includes(v);
}

/** Why an issue was raised — data the templates read (and tests pin). */
export type StoryIssueReason =
  | 'no_criteria' // unclear_done
  | 'untestable' // unclear_done
  | 'many_criteria' // too_big
  | 'bundled' // too_big
  | 'non_code_work' // too_big
  | 'depends' // waits_on_work, the dependency is named in the ticket
  | 'depends_unnamed' // waits_on_work, the ticket does not name it
  | 'no_out_of_scope' // scope_unstated
  | 'claude'; // any issue: raised by a CURRENT "Check against code" run that code did not raise

export interface StoryIssue {
  id: StoryIssueId;
  /** 1-based criterion numbers behind it, ascending (untestable / bundled / waiting). [] when the
   *  issue is story-level (no criteria, many criteria, non-code work, no out of scope). */
  criteria: number[];
  /** The ticket's criteria count today. */
  total: number;
  /** In the order above; at least one. */
  reasons: StoryIssueReason[];
}

/** The stored label shape (`story_labels.criteria_json` + `story_json`). */
export interface StoryIssueLabel {
  criteria: StoryCriterionLabel[];
  story: StoryLevelLabels;
}

export interface StoryIssueInput {
  /** The ticket's numbered criteria (`extractCriteria`), in order. */
  criteria: readonly string[];
  /** The CURRENT label only; null when there is none (pending, off, or no criteria). */
  label: StoryIssueLabel | null;
}

/** The label if it may be used: present, and judged exactly today's number of criteria. */
export function usableStoryLabel(input: StoryIssueInput): StoryIssueLabel | null {
  const l = input.label;
  if (l == null || input.criteria.length === 0) return null;
  return l.criteria.length === input.criteria.length ? l : null;
}

const numbers = (l: StoryIssueLabel, pick: (c: StoryCriterionLabel) => boolean, total: number): number[] =>
  [...new Set(l.criteria.filter((c) => pick(c) && c.n >= 1 && c.n <= total).map((c) => c.n))].sort((a, b) => a - b);

/** Every issue present on one ticket, in STORY_ISSUES order. Pure. */
export function foldStoryIssues(input: StoryIssueInput): StoryIssue[] {
  const total = input.criteria.length;
  const label = usableStoryLabel(input);
  const out: StoryIssue[] = [];

  // unclear_done
  if (total === 0) out.push({ id: 'unclear_done', criteria: [], total, reasons: ['no_criteria'] });
  else if (label != null) {
    const untestable = numbers(label, (c) => !c.testable, total);
    if (untestable.length > 0) out.push({ id: 'unclear_done', criteria: untestable, total, reasons: ['untestable'] });
  }

  // too_big — the count half is code; the rest needs the label.
  {
    const reasons: StoryIssueReason[] = [];
    let crit: number[] = [];
    if (total > STORY_TOO_BIG_CRITERIA) reasons.push('many_criteria');
    if (label != null) {
      crit = numbers(label, (c) => c.bundled, total);
      if (crit.length > 0) reasons.push('bundled');
      if (label.story.nonCodeWork) reasons.push('non_code_work');
    }
    if (reasons.length > 0) out.push({ id: 'too_big', criteria: crit, total, reasons });
  }

  if (label != null) {
    const waiting = numbers(label, (c) => c.dependsOnOtherWork, total);
    if (waiting.length > 0) {
      out.push({
        id: 'waits_on_work',
        criteria: waiting,
        total,
        reasons: [label.story.dependencyNamed ? 'depends' : 'depends_unnamed'],
      });
    }
    if (!label.story.outOfScopeStated) out.push({ id: 'scope_unstated', criteria: [], total, reasons: ['no_out_of_scope'] });
  }
  return out;
}

/** Per issue: true = present, false = known absent, null = cannot tell (no usable label). Story
 *  health's per-story input. Pure; agrees with `foldStoryIssues` by construction. */
export function storyIssueStates(input: StoryIssueInput): Record<StoryIssueId, boolean | null> {
  const present = new Set(foldStoryIssues(input).map((i) => i.id));
  const labelled = usableStoryLabel(input) != null;
  const state = (id: StoryIssueId): boolean | null => (present.has(id) ? true : labelled ? false : null);
  return {
    unclear_done: state('unclear_done'),
    too_big: state('too_big'),
    waits_on_work: state('waits_on_work'),
    scope_unstated: state('scope_unstated'),
  };
}

/** THE MEASUREMENT RULE for rates over many stories (Story health's refinement series, the story
 *  report's whole-window rates): ONE POPULATION — the stories with a usable label. Every issue, both
 *  halves, is answered for a labelled story and for no other, so a rate's numerator and denominator
 *  always come from the same stories. ⚠ "No criteria" is NOT folded into "Unclear when done" here: a
 *  no-criteria story can never be labelled, so counting it would mix a code-counted numerator into a
 *  label-covered denominator and the rate would move with label coverage, not with the tickets. It is
 *  counted on its own, by code, over every known ticket (`noCriteria` / `noCriteriaFound`). null =
 *  leave this story out of this issue's rate. Pure. */
export function storyIssueMeasure(input: StoryIssueInput): Record<StoryIssueId, boolean | null> {
  if (usableStoryLabel(input) != null) return storyIssueStates(input);
  return { unclear_done: null, too_big: null, waits_on_work: null, scope_unstated: null };
}

// ── Checks (per-workspace, Reports → This sprint) ────────────────────────────────────────────────

/** Which issues a workspace raises. OVERRIDES ONLY: `off` switches an issue off; `issueTypes` limits
 *  the WHOLE tab's issues to tickets of those types (case-insensitive; [] = every type). A ticket of
 *  another type is still listed, with no issues. A ticket with no issue type is always checked. */
export interface StoryIssueChecks {
  off: StoryIssueId[];
  issueTypes: string[];
}

export const STORY_ISSUE_CHECKS_DEFAULT: StoryIssueChecks = { off: [], issueTypes: [] };
export const STORY_ISSUE_CHECK_TYPES_MAX = 40;
export const STORY_ISSUE_CHECK_TYPE_MAX_CHARS = 80;

/** Is a ticket of this type checked at all? THE ONE type predicate. */
export function storyIssueTypeChecked(checks: StoryIssueChecks, issueType: string | null): boolean {
  if (checks.issueTypes.length === 0 || issueType == null || issueType.trim() === '') return true;
  const t = issueType.trim().toLowerCase();
  return checks.issueTypes.some((x) => x.trim().toLowerCase() === t);
}

/** The issues this workspace raises on a ticket of this type. THE ONE filter (server and SPA). */
export function applyStoryIssueChecks<T extends { id: StoryIssueId }>(
  issues: readonly T[],
  checks: StoryIssueChecks,
  issueType: string | null,
): T[] {
  if (!storyIssueTypeChecked(checks, issueType)) return [];
  return issues.filter((i) => !checks.off.includes(i.id));
}

// ── Templates (never model text) ─────────────────────────────────────────────────────────────────

/** "criterion 3" · "criteria 2 and 5" · "criteria 2, 4 and 5" · "6 criteria" past three. */
export function criteriaPhrase(ns: readonly number[]): string {
  if (ns.length === 1) return `criterion ${ns[0]}`;
  if (ns.length <= 3) return `criteria ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
  return `${ns.length} criteria`;
}

const capitalise = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

/** The chip's suffix after the label ("3 of 25 criteria", "25 criteria", "no criteria"), or null. */
export function storyIssueDetail(issue: StoryIssue): string | null {
  if (issue.reasons.length === 1 && issue.reasons[0] === 'claude') return null;
  switch (issue.id) {
    case 'unclear_done':
      return issue.reasons.includes('no_criteria') ? 'no criteria' : `${issue.criteria.length} of ${issue.total} criteria`;
    case 'too_big':
      if (issue.reasons.includes('many_criteria')) return `${issue.total} criteria`;
      if (issue.criteria.length > 0) return `${issue.criteria.length} of ${issue.total} criteria`;
      return null;
    case 'waits_on_work':
      return `${issue.criteria.length} of ${issue.total} criteria`;
    case 'scope_unstated':
      return null;
  }
}

/** "Unclear when done · 3 of 25 criteria" — the whole chip text. */
export function storyIssueChipText(issue: StoryIssue): string {
  const d = storyIssueDetail(issue);
  return d == null ? STORY_ISSUE_BY_ID[issue.id].label : `${STORY_ISSUE_BY_ID[issue.id].label} · ${d}`;
}

/** THE ONE templated bullet per issue: one sentence saying what to do. */
export function storyIssueBullet(issue: StoryIssue): string {
  const of = ` (of ${issue.total})`;
  switch (issue.id) {
    case 'unclear_done':
      if (issue.reasons.includes('no_criteria')) {
        return 'Add acceptance criteria: outcomes a tester could check, one per line.';
      }
      return `Rewrite ${criteriaPhrase(issue.criteria)}${of} as outcomes someone could check: the input, the action and the result.`;
    case 'too_big': {
      const many = issue.reasons.includes('many_criteria');
      const bundled = issue.reasons.includes('bundled');
      const nonCode = issue.reasons.includes('non_code_work');
      if (!many && !bundled && nonCode) {
        return 'Move the work that is not code (sign-off, docs, config) into its own task.';
      }
      const parts: string[] = [];
      if (many) parts.push(`it has ${issue.total} criteria`);
      if (bundled) {
        const n = issue.criteria;
        parts.push(`${criteriaPhrase(n)} ${n.length === 1 ? 'holds' : 'hold'} more than one outcome`);
      }
      if (nonCode) parts.push('part of the work is not code');
      const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
      return `Split this story: ${joined}.`;
    }
    case 'waits_on_work': {
      const subject = capitalise(criteriaPhrase(issue.criteria));
      const verb = issue.criteria.length === 1 ? 'waits' : 'wait';
      return issue.reasons.includes('depends_unnamed')
        ? `${subject}${of} ${verb} on other work: name it and link its ticket.`
        : `${subject}${of} ${verb} on other work: say what happens if it is late.`;
    }
    case 'scope_unstated':
      return 'Add an “Out of scope” line saying what this story will not do.';
  }
}
