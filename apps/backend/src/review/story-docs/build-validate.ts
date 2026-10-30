import {
  REVIEW_DOC_QUOTE_MIN_CHARS,
  STORY_BUILD_DOCS_ITEM_KINDS,
  STORY_BUILD_DOCS_ITEMS_MAX,
  STORY_BUILD_DOCS_NOTE_MAX,
  STORY_BUILD_DOCS_REFS_MAX,
  STORY_BUILD_DOCS_SUGGESTION_MAX,
  STORY_DOCS_SUMMARY_MAX,
  STORY_DOCS_SUMMARY_SENTENCES_MAX,
  STORY_DOCS_SUMMARY_SENTENCES_MIN,
  type StoryBuildDocs,
  type StoryBuildDocsItem,
  type StoryBuildDocsItemKind,
  type StoryDocsShortlistEntry,
} from '@pierre-review/shared';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import { clipText, groundRefs, sentenceCount, snapshotForDocs } from './validate.js';

// THE BUILD MODE'S VALIDATOR ("Implement story" → docs consideration; docs/STORY-BUILD.md). The same two
// halves as the story check's (validate.ts), deliberately different:
//
//   SHAPE (`buildDocsShapeProblems`): the summary's sentences, a kind outside the three, an `about` the
//   message did not list, a note too long, a suggestion on a kind that is not 'suggestion' (or none on
//   one that is), an item with no reference, a quote too short. The submit tool REFUSES these back with
//   every problem listed. At STORAGE only an unusable SUMMARY fails the run; a malformed item is dropped.
//   GROUNDING (`validateBuildDocs`): every reference through the library's own validator, against a
//   snapshot FILTERED TO THE SHORTLISTED DOCUMENTS. An item left with no checked reference is DROPPED,
//   never refused back. Nothing survives (and something was said) ⇒ `nothingGrounded`, summary hidden.
//
// THE PRECEDENCE RULE (the story is the spec) lives in the prompt (build-prompts.ts); the validator holds
// the parts a machine can check: a 'superseded' or 'grounded' item never carries a suggestion, so no item
// can propose a change to the story.

/* eslint-disable @typescript-eslint/no-explicit-any */

const isObj = (v: unknown): v is Record<string, any> => v != null && typeof v === 'object' && !Array.isArray(v);
const KINDS: readonly string[] = STORY_BUILD_DOCS_ITEM_KINDS;

export interface BuildDocsContext {
  /** Every `about` the message listed, canonical: `story`, `AC1`…, `M1`…, `R1:step 1`…. */
  abouts: readonly string[];
}

/** An `about` as written → its canonical form ('ac2' → 'AC2', 'R1: Step 3' → 'R1:step 3'); null when
 *  it is not one of the listed values. */
export function canonicalAbout(raw: unknown, ctx: BuildDocsContext): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  let c: string;
  if (/^story$/i.test(t)) c = 'story';
  else {
    const step = /^(R\d+)\s*[:,-]?\s*step\s*#?\s*(\d+)$/i.exec(t);
    c = step ? `${step[1]!.toUpperCase()}:step ${Number(step[2])}` : t.toUpperCase();
  }
  return ctx.abouts.includes(c) ? c : null;
}

const hasRefShape = (refs: unknown): boolean =>
  Array.isArray(refs) && refs.some((r) => isObj(r) && typeof r.link === 'string' && typeof r.quote === 'string');

const quoteLetters = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

const tooLong = (raw: unknown, max: number, where: string): string | null => {
  const n = clipText(raw, 10_000).length;
  return n > max ? `${where} is ${n} characters: rewrite it in ${max} or fewer.` : null;
};

/** Problems with the summary — the only ones that make an answer unusable at storage. */
export function buildDocsSummaryProblems(payload: unknown): string[] {
  const p: any = isObj(payload) ? payload : {};
  const summary = clipText(p.summary, 10_000);
  const n = sentenceCount(summary);
  if (summary === '' || n < STORY_DOCS_SUMMARY_SENTENCES_MIN || n > STORY_DOCS_SUMMARY_SENTENCES_MAX) {
    return [`summary has ${n} sentences: write ${STORY_DOCS_SUMMARY_SENTENCES_MIN}-${STORY_DOCS_SUMMARY_SENTENCES_MAX}.`];
  }
  if (summary.length > STORY_DOCS_SUMMARY_MAX) return [`summary is ${summary.length} characters: keep it to ${STORY_DOCS_SUMMARY_MAX}.`];
  return [];
}

const hasText = (v: unknown): boolean => clipText(v, 10) !== '';

/** One item's shape problem, or null. */
export function buildDocsItemProblem(it: any, i: number, ctx: BuildDocsContext): string | null {
  const at = `items[${i}]`;
  if (!isObj(it)) return `${at} is not an object.`;
  if (typeof it.kind !== 'string' || !KINDS.includes(it.kind)) return `${at}.kind must be one of: ${STORY_BUILD_DOCS_ITEM_KINDS.join(', ')}.`;
  if (canonicalAbout(it.about, ctx) == null) {
    return `${at}.about must be one of the values the message lists (${ctx.abouts.slice(0, 8).join(', ')}${ctx.abouts.length > 8 ? ', …' : ''}).`;
  }
  if (!hasText(it.note)) return `${at}.note is empty.`;
  const long = tooLong(it.note, STORY_BUILD_DOCS_NOTE_MAX, `${at}.note`);
  if (long) return long;
  if (it.kind === 'suggestion') {
    if (!hasText(it.suggestion)) return `${at} is a suggestion with no \`suggestion\`: say what to add to the work.`;
    const longS = tooLong(it.suggestion, STORY_BUILD_DOCS_SUGGESTION_MAX, `${at}.suggestion`);
    if (longS) return longS;
  } else if (hasText(it.suggestion)) {
    // ⚠ THE PRECEDENCE RULE, machine-held: only a suggestion proposes work. A superseded point is never a
    // fix to the story, and a grounded one needs none.
    return `${at} is '${it.kind}': leave \`suggestion\` out. Only a 'suggestion' item proposes work; the story is never changed to match the docs.`;
  }
  if (!hasRefShape(it.refs)) return `${at} has no reference: every point needs one.`;
  if (Array.isArray(it.refs) && it.refs.some((r: any) => isObj(r) && typeof r.quote === 'string' && quoteLetters(r.quote) < REVIEW_DOC_QUOTE_MIN_CHARS)) {
    return `${at} has a quote shorter than ${REVIEW_DOC_QUOTE_MIN_CHARS} letters: copy a longer passage from the section.`;
  }
  return null;
}

/** SHAPE problems, each a sentence saying what to fix. [] ⇒ the submit tool accepts. */
export function buildDocsShapeProblems(payload: unknown, ctx: BuildDocsContext): string[] {
  const p: any = isObj(payload) ? payload : {};
  const problems = buildDocsSummaryProblems(p);
  if (!Array.isArray(p.items)) {
    problems.push('`items` is missing: give the points (an empty list when the docs say nothing about the plan).');
    return problems;
  }
  if (p.items.length > STORY_BUILD_DOCS_ITEMS_MAX) problems.push(`items has ${p.items.length}: give at most ${STORY_BUILD_DOCS_ITEMS_MAX}, the ones that matter most.`);
  p.items.forEach((it: any, i: number) => {
    const x = buildDocsItemProblem(it, i, ctx);
    if (x) problems.push(x);
  });
  return problems;
}

export interface BuildDocsValidationValue {
  docs: StoryBuildDocs;
  /** Items (and references beyond the cap) dropped for a bad shape or no checked reference. */
  dropped: number;
}

export type BuildDocsValidation = { ok: true; value: BuildDocsValidationValue } | { ok: false; problems: string[] };

/**
 * The payload → the `StoryBuildDocs` to store. Refuses only on the SUMMARY; items are dropped for shape
 * or grounding. Ids `D1`… are given to the SURVIVORS in the model's order (the decisions map keys on them,
 * so a new run starts its decisions afresh). `lib` is the whole library — filtered here to the shortlist.
 */
export function validateBuildDocs(
  payload: unknown,
  lib: LibrarySnapshot,
  ctx: BuildDocsContext,
  shortlist: readonly Pick<StoryDocsShortlistEntry, 'docSlug'>[],
  planRevision: number,
): BuildDocsValidation {
  const problems = buildDocsSummaryProblems(payload);
  if (problems.length > 0) return { ok: false, problems };
  const p: any = payload;
  const scoped = snapshotForDocs(lib, shortlist.map((s) => s.docSlug));
  const raw: any[] = Array.isArray(p.items) ? p.items : [];
  const items: StoryBuildDocsItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const [i, it] of raw.entries()) {
    if (buildDocsItemProblem(it, i, ctx) != null || items.length >= STORY_BUILD_DOCS_ITEMS_MAX) {
      dropped += 1;
      continue;
    }
    const kind = it.kind as StoryBuildDocsItemKind;
    const about = canonicalAbout(it.about, ctx)!;
    const note = clipText(it.note, STORY_BUILD_DOCS_NOTE_MAX);
    const key = `${kind}\u0000${about}\u0000${note.toLowerCase()}`;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    const g = groundRefs(it.refs, scoped);
    const refs = g.refs.slice(0, STORY_BUILD_DOCS_REFS_MAX);
    dropped += g.dropped + (g.refs.length - refs.length);
    if (refs.length === 0) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    items.push({
      id: `D${items.length + 1}`,
      kind,
      about,
      note,
      suggestion: kind === 'suggestion' ? clipText(it.suggestion, STORY_BUILD_DOCS_SUGGESTION_MAX) : null,
      refs,
    });
  }
  const nothingGrounded = raw.length > 0 && items.length === 0;
  return {
    ok: true,
    value: {
      // An ungrounded summary is never shown.
      docs: { summary: nothingGrounded ? '' : clipText(p.summary, STORY_DOCS_SUMMARY_MAX), items, nothingGrounded, planRevision },
      dropped,
    },
  };
}
