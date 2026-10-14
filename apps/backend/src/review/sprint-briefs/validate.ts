import {
  SPRINT_BRIEF_CAPS,
  type SprintBriefCriterion,
  type SprintBriefLinkReason,
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
//     repeats kept once. ≤ SPRINT_BRIEF_CAPS.references (else `too_many`). Each carries `why`.
//   • `why` (a reference's or a link's): control characters stripped, whitespace folded; blank, not a
//     string, or over SPRINT_BRIEF_CAPS.why → null. ONE over-long sentence drops only ITSELF — never cut,
//     never a refused brief (the edges and the summary are worth more than one reason).
//   • `links` (optional — absent reads as []; present and not an array → `shape`): one reason per
//     TRACKER LINK the input listed. A key the input did not list is DROPPED (never a new link), a
//     repeat keeps the first, a null `why` is no entry.

export type BriefValidationFailure = 'not_json' | 'shape' | 'count' | 'too_long' | 'too_many';

export type BriefValidation =
  | {
      ok: true;
      summary: string;
      criteria: SprintBriefCriterion[];
      references: SprintBriefReference[];
      linkReasons: SprintBriefLinkReason[];
    }
  | { ok: false; reason: BriefValidationFailure };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '');

/** A `why` sentence, or null (blank, not a string, or over the cap — dropped, never cut). */
export function whyOf(v: unknown): string | null {
  const s = clean(v);
  return s === '' || s.length > SPRINT_BRIEF_CAPS.why ? null : s;
}

/** Parse and validate one completion. `sources` = the text that was SENT; `hadCriteria` = the ticket's
 *  own criteria count was > 0. */
export function validateSprintBrief(
  raw: string,
  sources: StoryQuoteSources,
  hadCriteria: boolean,
  linkKeys: readonly string[] = [],
): BriefValidation {
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
  if (o.links != null && !Array.isArray(o.links)) return { ok: false, reason: 'shape' };
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
      .map((r) => {
        const ref = reference(r, sources, stats);
        return ref == null ? null : { ref, why: whyOf(asRecord(r)?.why) };
      })
      .filter((r): r is { ref: StoryTicketReference; why: string | null } => r != null)
      .filter(
        (r, i, all) =>
          all.findIndex((x) => x.ref.ticketKey.toUpperCase() === r.ref.ticketKey.toUpperCase() && x.ref.relation === r.ref.relation) === i,
      )
      .map(({ ref, why }) => ({ ticketKey: ref.ticketKey, relation: ref.relation, quote: ref.quote, why }));
    return { ok: true, summary, criteria, references: refs, linkReasons: linkReasonsOf(o.links, linkKeys) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason === 'too_long' ? 'too_long' : 'shape' };
    throw e;
  }
}

/** The `links` answer → one reason per LISTED tracker link (keys matched case-insensitively and
 *  returned in the input's spelling); unknown keys and null reasons dropped, repeats keep the first. */
export function linkReasonsOf(raw: unknown, linkKeys: readonly string[]): SprintBriefLinkReason[] {
  if (!Array.isArray(raw)) return [];
  const listed = new Map(linkKeys.map((k) => [k.trim().toUpperCase(), k] as const));
  const out: SprintBriefLinkReason[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const r = asRecord(x);
    if (r == null) continue;
    const k = clean(r.ticketKey).toUpperCase();
    const key = listed.get(k);
    if (key == null || seen.has(k)) continue;
    seen.add(k);
    const why = whyOf(r.why);
    if (why != null) out.push({ ticketKey: key, why });
  }
  return out;
}
