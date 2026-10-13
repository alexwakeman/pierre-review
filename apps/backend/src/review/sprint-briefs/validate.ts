import {
  SPRINT_BRIEF_CAPS,
  type SprintBriefCriterion,
  type SprintBriefReference,
  type StoryQuoteSources,
  type StoryTicketReference,
} from '@pierre-review/shared';
import { reference, Refused } from '../story-labels/validate.js';

// THE SPRINT BRIEF'S ANSWER, VALIDATED (validate.test.ts). A brief is stored only when the answer is the
// shape: JSON, a non-empty summary, a criteria array and a references array. Anything else is a FAILED
// brief — not stored, retried once in the same pass and again on the next pass — never a repaired guess.
//
//   • `summary`: control characters stripped, whitespace folded; blank → `shape`; over the cap →
//     `too_long` (never cut: a cut sentence would be shown as if it were whole).
//   • `criteria`: ≤ SPRINT_BRIEF_CAPS.criteria (else `too_many`); each a string or `{text}`; a blank one is
//     dropped, one over the cap is `too_long`; RENUMBERED 1..k in the order given (the model's `n` is
//     ignored). A ticket that HAS criteria must get ≥ 1 back (else `count`).
//   • `references`: rubric 4's rule, the SAME function as the story labels (`reference`): relation from
//     the vocabulary (else `shape`), a key that is not a key or that the text never names is DROPPED,
//     every quote VERIFIED against the sent text (null when it does not hold). Exact (key, relation)
//     repeats kept once. ≤ SPRINT_BRIEF_CAPS.references (else `too_many`).

export type BriefValidationFailure = 'not_json' | 'shape' | 'count' | 'too_long' | 'too_many';

export type BriefValidation =
  | { ok: true; summary: string; criteria: SprintBriefCriterion[]; references: SprintBriefReference[] }
  | { ok: false; reason: BriefValidationFailure };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '');

/** Parse and validate one completion. `sources` = the text that was SENT; `hadCriteria` = the ticket's
 *  own criteria count was > 0. */
export function validateSprintBrief(raw: string, sources: StoryQuoteSources, hadCriteria: boolean): BriefValidation {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, reason: 'not_json' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(a, b + 1));
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const o = asRecord(parsed);
  if (o == null || !Array.isArray(o.criteria) || !Array.isArray(o.references)) return { ok: false, reason: 'shape' };
  const summary = clean(o.summary);
  if (summary === '') return { ok: false, reason: 'shape' };
  if (summary.length > SPRINT_BRIEF_CAPS.summary) return { ok: false, reason: 'too_long' };
  if (o.criteria.length > SPRINT_BRIEF_CAPS.criteria || o.references.length > SPRINT_BRIEF_CAPS.references) {
    return { ok: false, reason: 'too_many' };
  }
  const criteria: SprintBriefCriterion[] = [];
  for (const c of o.criteria) {
    const text = clean(typeof c === 'string' ? c : asRecord(c)?.text);
    if (text === '') continue;
    if (text.length > SPRINT_BRIEF_CAPS.criterion) return { ok: false, reason: 'too_long' };
    criteria.push({ n: criteria.length + 1, text });
  }
  if (hadCriteria && criteria.length === 0) return { ok: false, reason: 'count' };
  const stats = { given: 0, verified: 0 };
  try {
    const refs = o.references
      .map((r) => reference(r, sources, stats))
      .filter((r): r is StoryTicketReference => r != null)
      .filter((r, i, all) => all.findIndex((x) => x.ticketKey.toUpperCase() === r.ticketKey.toUpperCase() && x.relation === r.relation) === i)
      .map((r) => ({ ticketKey: r.ticketKey, relation: r.relation, quote: r.quote }));
    return { ok: true, summary, criteria, references: refs };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason === 'too_long' ? 'too_long' : 'shape' };
    throw e;
  }
}
