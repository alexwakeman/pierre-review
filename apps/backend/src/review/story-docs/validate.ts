import {
  STORY_DOCS_ACTIONS_MAX,
  STORY_DOCS_ACTIONS_MIN,
  STORY_DOCS_ACTION_MAX,
  STORY_DOCS_CRITERION_TEXT_MAX,
  STORY_DOCS_DERIVED_CRITERIA_MAX,
  STORY_DOCS_ITEM_VERDICTS,
  STORY_DOCS_NOTE_MAX,
  STORY_DOCS_OVERALL_VERDICTS,
  STORY_DOCS_PART_LABEL_MAX,
  STORY_DOCS_REFS_PER_ITEM_MAX,
  STORY_DOCS_STORY_PARTS_MAX,
  STORY_DOCS_SUMMARY_MAX,
  STORY_DOCS_SUMMARY_SENTENCES_MAX,
  STORY_DOCS_SUMMARY_SENTENCES_MIN,
  REVIEW_DOC_QUOTE_MIN_CHARS,
  type StoryDocsAction,
  type StoryDocsAlignmentResult,
  type StoryDocsCriteriaSource,
  type StoryDocsCriterion,
  type StoryDocsCriterionItem,
  type StoryDocsItemVerdict,
  type StoryDocsOverallVerdict,
  type StoryDocsRef,
  type StoryDocsShortlistEntry,
  type StoryDocsStoryPoint,
} from '@pierre-review/shared';
import { validateDocReferences, type LibrarySnapshot } from '../../reference-docs/review-refs.js';

// THE STORY DOCS CHECK'S VALIDATOR — two halves, deliberately different:
//
//   SHAPE (`alignmentShapeProblems`): a missing overall, a verdict outside the shared lists, a summary
//   that is not 2-3 sentences, a criterion number outside the list, an item with no reference at all,
//   too many or too few actions. The submit tool REFUSES these back to the model with every problem
//   listed (≤ MAX_SUBMIT_ATTEMPTS). At STORAGE only an unusable OVERALL (`overallProblems`) fails the
//   run; a malformed item is dropped and counted like an ungrounded one.
//   GROUNDING (`validateAlignment`): every reference goes through the library's own validator
//   (`validateDocReferences`: strict path grammar, a section of a BUILT document, the quote found in
//   it) against a snapshot FILTERED TO THE SHORTLISTED DOCUMENTS. An item left with no checked
//   reference is DROPPED and counted, never refused back — so a quote mismatch cannot loop.
// Outcome: anything survives ⇒ 'checked' (overall kept); nothing ⇒ 'nothing_grounded' (overall null —
// an ungrounded summary is never shown).
//
// Pure apart from the `LibrarySnapshot`, so it is tested without a database.

/* eslint-disable @typescript-eslint/no-explicit-any */

const isObj = (v: unknown): v is Record<string, any> => v != null && typeof v === 'object' && !Array.isArray(v);

/** Control characters stripped, whitespace collapsed, clipped to `max` with an ellipsis. */
export function clipText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Sentences in a summary, by a simple terminal-punctuation split. */
export function sentenceCount(s: string): number {
  return s
    .trim()
    .split(/[.!?](?:\s+|$)/)
    .filter((p) => p.trim() !== '').length;
}

const OVERALL: readonly string[] = STORY_DOCS_OVERALL_VERDICTS;
const ITEM: readonly string[] = STORY_DOCS_ITEM_VERDICTS;

export interface AlignmentContext {
  criteriaSource: StoryDocsCriteriaSource;
  /** The given criteria (ticket review / brief); [] for a derived run. */
  criteria: readonly StoryDocsCriterion[];
}

/** The derived list a payload carries (derived runs only), cleaned. */
export function derivedCriteriaOf(payload: any, ctx: AlignmentContext): StoryDocsCriterion[] {
  if (ctx.criteriaSource !== 'derived' || !Array.isArray(payload?.derivedCriteria)) return [];
  return payload.derivedCriteria
    .map((t: unknown) => clipText(t, STORY_DOCS_CRITERION_TEXT_MAX))
    .filter((t: string) => t !== '')
    .slice(0, STORY_DOCS_DERIVED_CRITERIA_MAX)
    .map((text: string, i: number) => ({ n: i + 1, text }));
}

/** Problems with the WHOLE-STORY verdict — the only ones that make an answer unusable at storage. */
export function overallProblems(payload: unknown): string[] {
  const p: any = isObj(payload) ? payload : {};
  const o = p.overall;
  if (!isObj(o)) return ['`overall` is missing: give its verdict, summary and actions.'];
  const problems: string[] = [];
  if (typeof o.verdict !== 'string' || !OVERALL.includes(o.verdict)) {
    problems.push(`overall.verdict must be one of: ${STORY_DOCS_OVERALL_VERDICTS.join(', ')}.`);
  }
  const summary = clipText(o.summary, 10_000);
  const n = sentenceCount(summary);
  if (summary === '' || n < STORY_DOCS_SUMMARY_SENTENCES_MIN || n > STORY_DOCS_SUMMARY_SENTENCES_MAX) {
    problems.push(`overall.summary has ${n} sentences: write ${STORY_DOCS_SUMMARY_SENTENCES_MIN}-${STORY_DOCS_SUMMARY_SENTENCES_MAX}.`);
  } else if (summary.length > STORY_DOCS_SUMMARY_MAX) {
    problems.push(`overall.summary is ${summary.length} characters: keep it to ${STORY_DOCS_SUMMARY_MAX}.`);
  }
  return problems;
}

const hasRefShape = (refs: unknown): boolean =>
  Array.isArray(refs) && refs.some((r) => isObj(r) && typeof r.link === 'string' && typeof r.quote === 'string');

/** Over its cap ⇒ refused back so the model rewrites it SHORTER; the store never cuts a sentence off. */
const tooLong = (raw: unknown, max: number, where: string): string | null => {
  const n = clipText(raw, 10_000).length;
  return n > max ? `${where} is ${n} characters: rewrite it in ${max} or fewer.` : null;
};

/** Letters and digits — the SAME count `validateDocReferences` drops a quote under. */
const quoteLetters = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** A quote too short to ground is refused back (so the model rewrites it) rather than silently
 *  dropped at grounding along with its whole point. */
const shortQuoteProblem = (refs: unknown, where: string): string | null =>
  Array.isArray(refs) && refs.some((r) => isObj(r) && typeof r.quote === 'string' && quoteLetters(r.quote) < REVIEW_DOC_QUOTE_MIN_CHARS)
    ? `${where} has a quote shorter than ${REVIEW_DOC_QUOTE_MIN_CHARS} letters: copy a longer passage from the section.`
    : null;

/** How many numbered criteria items may name: the given list, or the derived one. */
const criteriaCountOf = (p: any, ctx: AlignmentContext): number =>
  ctx.criteriaSource === 'derived' ? derivedCriteriaOf(p, ctx).length : ctx.criteria.length;

const criterionProblem = (c: any, i: number, count: number, ctx: AlignmentContext): string | null => {
  if (!isObj(c)) return `criteria[${i}] is not an object.`;
  if (typeof c.n !== 'number' || !Number.isInteger(c.n) || c.n < 1 || c.n > count) {
    return count === 0
      ? `criteria[${i}]: there are no numbered criteria${ctx.criteriaSource === 'derived' ? ' (list yours in derivedCriteria first)' : ''}; leave \`criteria\` out.`
      : `criteria[${i}].n must be a criterion number from 1 to ${count}.`;
  }
  if (typeof c.verdict !== 'string' || !ITEM.includes(c.verdict)) return `criteria[${i}].verdict must be one of: ${STORY_DOCS_ITEM_VERDICTS.join(', ')}.`;
  if (clipText(c.note, 10) === '') return `criteria[${i}].note is empty.`;
  const long = tooLong(c.note, STORY_DOCS_NOTE_MAX, `criteria[${i}].note`);
  if (long) return long;
  if (!hasRefShape(c.refs)) return `criteria[${i}] has no reference: every point needs one, or leave the criterion out.`;
  return shortQuoteProblem(c.refs, `criteria[${i}]`);
};

const partProblem = (s: any, i: number): string | null => {
  if (!isObj(s)) return `storyParts[${i}] is not an object.`;
  if (clipText(s.part, 10) === '') return `storyParts[${i}].part is empty.`;
  if (typeof s.verdict !== 'string' || !ITEM.includes(s.verdict)) return `storyParts[${i}].verdict must be one of: ${STORY_DOCS_ITEM_VERDICTS.join(', ')}.`;
  if (clipText(s.note, 10) === '') return `storyParts[${i}].note is empty.`;
  const long = tooLong(s.part, STORY_DOCS_PART_LABEL_MAX, `storyParts[${i}].part`) ?? tooLong(s.note, STORY_DOCS_NOTE_MAX, `storyParts[${i}].note`);
  if (long) return long;
  if (!hasRefShape(s.refs)) return `storyParts[${i}] has no reference: every point needs one.`;
  return shortQuoteProblem(s.refs, `storyParts[${i}]`);
};

const actionProblem = (a: any, i: number): string | null => {
  if (!isObj(a) || clipText(a.text, 10) === '') return `overall.actions[${i}] has no text.`;
  const long = tooLong(a.text, STORY_DOCS_ACTION_MAX, `overall.actions[${i}].text`);
  if (long) return long;
  if (!hasRefShape(a.refs)) return `overall.actions[${i}] has no reference: every point needs one.`;
  return shortQuoteProblem(a.refs, `overall.actions[${i}]`);
};

/**
 * SHAPE problems — each a sentence saying what to fix. [] ⇒ the submit tool accepts. (Grounding is
 * never judged here.)
 */
export function alignmentShapeProblems(payload: unknown, ctx: AlignmentContext): string[] {
  const p: any = isObj(payload) ? payload : {};
  const problems = overallProblems(p);
  const actions = isObj(p.overall) && Array.isArray(p.overall.actions) ? p.overall.actions : [];
  if (isObj(p.overall) && (actions.length < STORY_DOCS_ACTIONS_MIN || actions.length > STORY_DOCS_ACTIONS_MAX)) {
    problems.push(`overall.actions has ${actions.length}: give ${STORY_DOCS_ACTIONS_MIN}-${STORY_DOCS_ACTIONS_MAX} (what to change, or what to keep).`);
  }
  actions.forEach((a: any, i: number) => {
    const x = actionProblem(a, i);
    if (x) problems.push(x);
  });
  if (ctx.criteriaSource === 'derived' && Array.isArray(p.derivedCriteria) && p.derivedCriteria.length > STORY_DOCS_DERIVED_CRITERIA_MAX) {
    problems.push(`derivedCriteria has ${p.derivedCriteria.length}: give at most ${STORY_DOCS_DERIVED_CRITERIA_MAX}.`);
  }
  const count = criteriaCountOf(p, ctx);
  (Array.isArray(p.criteria) ? p.criteria : []).forEach((c: any, i: number) => {
    const x = criterionProblem(c, i, count, ctx);
    if (x) problems.push(x);
  });
  const parts = Array.isArray(p.storyParts) ? p.storyParts : [];
  if (parts.length > STORY_DOCS_STORY_PARTS_MAX) problems.push(`storyParts has ${parts.length}: give at most ${STORY_DOCS_STORY_PARTS_MAX}.`);
  parts.forEach((s: any, i: number) => {
    const x = partProblem(s, i);
    if (x) problems.push(x);
  });
  return problems;
}

/** The library filtered to these documents — the grounding check's whole world. */
export function snapshotForDocs(lib: LibrarySnapshot, slugs: Iterable<string>): LibrarySnapshot {
  const keep = new Set(slugs);
  return {
    workspaceId: lib.workspaceId,
    dir: lib.dir,
    docs: lib.docs.filter((d) => keep.has(d.slug)),
    read: (path) => (keep.has(path.split('/')[0] ?? '') ? lib.read(path) : null),
  };
}

/** One item's refs → checked StoryDocsRefs (≤ STORY_DOCS_REFS_PER_ITEM_MAX) + how many were dropped. */
export function groundRefs(raw: unknown, lib: LibrarySnapshot): { refs: StoryDocsRef[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const mapped = list.map((r) =>
    isObj(r) ? { link: r.link, quote: r.quote, verdict: 'context', note: '' } : r,
  );
  const v = validateDocReferences(mapped, lib);
  const kept = v.references.slice(0, STORY_DOCS_REFS_PER_ITEM_MAX);
  const refs: StoryDocsRef[] = kept.map((r) => ({
    path: r.path,
    workspaceId: lib.workspaceId,
    anchor: r.anchor,
    docSlug: r.docSlug,
    docTitle: r.docTitle,
    sectionTitle: r.sectionTitle,
    quote: r.quote,
  }));
  return { refs, dropped: v.dropped + (v.references.length - kept.length) };
}

export interface AcceptedAlignment {
  result: StoryDocsAlignmentResult;
  /** The criteria the items are numbered against: the given ones, or the derived list. */
  criteria: StoryDocsCriterion[];
}

export type AlignmentValidation = { ok: true; value: AcceptedAlignment } | { ok: false; problems: string[]; message: string };

/**
 * The payload → the result to store. Refuses only on SHAPE problems; grounding DROPS. `lib` is the
 * whole library snapshot — it is filtered here to the shortlisted documents.
 */
export function validateAlignment(
  payload: unknown,
  lib: LibrarySnapshot,
  ctx: AlignmentContext,
  shortlist: readonly StoryDocsShortlistEntry[],
): AlignmentValidation {
  const problems = overallProblems(payload);
  if (problems.length > 0) return { ok: false, problems, message: problems.map((p) => `- ${p}`).join('\n') };
  const p: any = payload;
  const scoped = snapshotForDocs(lib, shortlist.map((s) => s.docSlug));
  const criteriaList = ctx.criteriaSource === 'derived' ? derivedCriteriaOf(p, ctx) : [...ctx.criteria];
  let dropped = 0;

  const count = criteriaList.length;
  const criteria: StoryDocsCriterionItem[] = [];
  const seenN = new Set<number>();
  for (const [i, c] of (Array.isArray(p.criteria) ? p.criteria : []).entries()) {
    // A malformed item (a number outside the list, a bad verdict, no note) is DROPPED here — the tool
    // already refused it once; storage never fails a whole answer over one item.
    if (criterionProblem(c, i, count, ctx) != null || seenN.has(c.n)) {
      dropped += 1;
      continue;
    }
    const g = groundRefs(c.refs, scoped);
    dropped += g.dropped;
    if (g.refs.length === 0) {
      dropped += 1;
      continue;
    }
    seenN.add(c.n);
    criteria.push({ n: c.n, verdict: c.verdict as StoryDocsItemVerdict, note: clipText(c.note, STORY_DOCS_NOTE_MAX), refs: g.refs });
  }
  criteria.sort((a, b) => a.n - b.n);

  const storyParts: StoryDocsStoryPoint[] = [];
  for (const [i, s] of (Array.isArray(p.storyParts) ? p.storyParts : []).entries()) {
    if (partProblem(s, i) != null || storyParts.length >= STORY_DOCS_STORY_PARTS_MAX) {
      dropped += 1;
      continue;
    }
    const g = groundRefs(s.refs, scoped);
    dropped += g.dropped;
    if (g.refs.length === 0) {
      dropped += 1;
      continue;
    }
    storyParts.push({
      part: clipText(s.part, STORY_DOCS_PART_LABEL_MAX),
      verdict: s.verdict as StoryDocsItemVerdict,
      note: clipText(s.note, STORY_DOCS_NOTE_MAX),
      refs: g.refs,
    });
  }

  const actions: StoryDocsAction[] = [];
  for (const [i, a] of (Array.isArray(p.overall.actions) ? (p.overall.actions as any[]) : []).entries()) {
    if (actionProblem(a, i) != null || actions.length >= STORY_DOCS_ACTIONS_MAX) {
      dropped += 1;
      continue;
    }
    const g = groundRefs(a.refs, scoped);
    dropped += g.dropped;
    if (g.refs.length === 0) {
      dropped += 1;
      continue;
    }
    actions.push({ text: clipText(a.text, STORY_DOCS_ACTION_MAX), refs: g.refs });
  }

  const any = criteria.length + storyParts.length + actions.length > 0;
  const result: StoryDocsAlignmentResult = {
    outcome: any ? 'checked' : 'nothing_grounded',
    overall: any
      ? { verdict: p.overall.verdict as StoryDocsOverallVerdict, summary: clipText(p.overall.summary, STORY_DOCS_SUMMARY_MAX), actions }
      : null,
    criteria: any ? criteria : [],
    storyParts: any ? storyParts : [],
    shortlist: [...shortlist],
    dropped,
  };
  return { ok: true, value: { result, criteria: criteriaList } };
}
