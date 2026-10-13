import {
  STORY_DEPENDENCY_KINDS,
  STORY_LABEL_DEPENDENCIES_MAX,
  STORY_LABEL_REFERENCES_MAX,
  STORY_REFERENCE_RELATIONS,
  STORY_LABEL_TEXT_MAX,
  STORY_SPEC_GAPS_MAX,
  STORY_SPEC_GAP_TYPES,
  STORY_CRITERION_RULE_IDS,
  canonicalTicketKey,
  verifyStoryQuote,
  type StoryQuoteSources,
  type StoryQuoteWhere,
  type StoryUnclearRuleId,
  type StoryCriterionLabel,
  type StoryDependencyKind,
  type StoryDependencyLabel,
  type StoryLevelLabels,
  type StoryReferenceRelation,
  type StoryTicketReference,
  type StorySpecGap,
  type StorySpecGapType,
} from '@pierre-review/shared';

// THE LABELLER'S ANSWER, VALIDATED (story-labels.test.ts). A label is stored only when the answer is
// EXACTLY the rubric's shape: JSON, one criterion entry per numbered criterion with `n` = 1, 2, 3 …
// in order, every answer of its type. Anything else is a FAILED label — not stored, retried on the
// next press — never a repaired guess: a dropped or shifted criterion would silently move every
// criterion-weighted percentage, and a cut sentence would be shown to the reader as if it were whole.
//
//   • booleans STRICTLY: `true` / `false`, or the exact strings "true" / "false" (no 0/1, no "yes");
//   • a criterion that is not testable MUST carry a non-empty reason; a testable one stores null;
//   • text over its cap (`STORY_LABEL_TEXT_MAX`) → `too_long` (never cut);
//   • control characters are stripped before any length check;
//   • a `ticketKey` that is not a ticket-key shape is stored as null (the dependency survives).
//   • RUBRIC 3: an untestable criterion MUST name a rule from `STORY_CRITERION_RULE_IDS` (else
//     `bad_rule`); a testable one stores rule and quote null.
//   • EVERY QUOTE IS VERIFIED against the text that was sent (`verifyStoryQuote`: whitespace-
//     normalised, case-sensitive then insensitive) and stored in the TICKET's spelling; one that does
//     not verify, or is over `STORY_QUOTE_MAX`, is stored as null — the answer survives, unanchored.
//     Without `sources` every quote is null (never stored unverified).
//   • RUBRIC 4 — `references` (≤ STORY_LABEL_REFERENCES_MAX, else `too_many`): `relation` STRICTLY from
//     `STORY_REFERENCE_RELATIONS` (else `shape`). An entry whose key is not a ticket-key shape, or (with
//     `sources`) a key the sent text never names, is DROPPED (the label survives) — a reference is a
//     claim about the text. Exact (key, relation) repeats are kept once.
//   • DEPENDENCIES AGREE WITH REFERENCES: a ticket-keyed dependency whose key the references read as
//     anything but `depends_on` is DROPPED; one whose key no reference names gets a `depends_on`
//     reference added from it (the dependency IS that claim). A missing `references` array is `shape`.

export type LabelValidationFailure =
  | 'not_json'
  | 'shape'
  | 'count'
  | 'order'
  | 'not_boolean'
  | 'missing_reason'
  | 'bad_rule'
  | 'too_long'
  | 'too_many';

/** How many quotes the answer gave and how many verified (for the run's log and the sanity check). */
export interface LabelQuoteStats {
  given: number;
  verified: number;
}

export type LabelValidation =
  | { ok: true; criteria: StoryCriterionLabel[]; story: StoryLevelLabels; quotes: LabelQuoteStats }
  | { ok: false; reason: LabelValidationFailure };

function strictBool(v: unknown): boolean | null {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A clean string, '' when absent / not a string / blank. */
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '');

export class Refused extends Error {
  constructor(readonly reason: LabelValidationFailure) {
    super(reason);
  }
}

/** A required string ≤ max: blank → `blank`, over → `too_long`. */
function text(v: unknown, max: number, blank: LabelValidationFailure): string {
  const s = clean(v);
  if (s === '') throw new Refused(blank);
  if (s.length > max) throw new Refused('too_long');
  return s;
}

/** An optional string ≤ max: absent / null / blank → null, over → `too_long`. */
function optionalText(v: unknown, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new Refused('shape');
  const s = clean(v);
  if (s === '') return null;
  if (s.length > max) throw new Refused('too_long');
  return s;
}

/** A quote, verified against `sources` (null when absent, not a string, or not found). */
function quoteOf(
  v: unknown,
  sources: StoryQuoteSources | undefined,
  prefer: readonly StoryQuoteWhere[],
  stats: LabelQuoteStats,
): string | null {
  if (typeof v !== 'string' || clean(v) === '') return null;
  stats.given += 1;
  if (sources == null) return null;
  const hit = verifyStoryQuote(v.replace(CONTROL, ' '), sources, { prefer });
  if (hit == null) return null;
  stats.verified += 1;
  return hit.quote;
}

const CRITERIA_FIRST: readonly StoryQuoteWhere[] = ['criteria', 'description', 'title'];
const DESCRIPTION_FIRST: readonly StoryQuoteWhere[] = ['description', 'criteria', 'title'];

function dependency(v: unknown, sources: StoryQuoteSources | undefined, stats: LabelQuoteStats): StoryDependencyLabel {
  const d = asRecord(v);
  if (d == null) throw new Refused('shape');
  const kind = clean(d.kind) as StoryDependencyKind;
  if (!STORY_DEPENDENCY_KINDS.includes(kind)) throw new Refused('shape');
  const what = text(d.what, STORY_LABEL_TEXT_MAX.what, 'shape');
  const owner = optionalText(d.owner, STORY_LABEL_TEXT_MAX.owner);
  const rawKey = typeof d.ticketKey === 'string' ? clean(d.ticketKey) : '';
  const ticketKey = rawKey !== '' && rawKey.length <= 40 && canonicalTicketKey(rawKey) != null ? rawKey : null;
  return { kind, what, owner, ticketKey, quote: quoteOf(d.quote, sources, DESCRIPTION_FIRST, stats) };
}

/** Does the sent text name this key as a whole token (a bare key, or inside a link)? */
export function textNamesKey(key: string, sources: StoryQuoteSources): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i');
  return [sources.title, sources.description, ...sources.criteria].some((t) => re.test(t));
}

/** One answered reference → the stored one, or null (dropped: not a key, or a key the text never
 *  names). Throws `Refused('shape')` for a relation outside the vocabulary. Shared with the sprint
 *  brief's validator (review/sprint-briefs/validate.ts) — one rule for both. */
export function reference(
  v: unknown,
  sources: StoryQuoteSources | undefined,
  stats: LabelQuoteStats,
): StoryTicketReference | null {
  const r = asRecord(v);
  if (r == null) throw new Refused('shape');
  const relation = clean(r.relation) as StoryReferenceRelation;
  if (!STORY_REFERENCE_RELATIONS.includes(relation)) throw new Refused('shape');
  const owner = optionalText(r.owner, STORY_LABEL_TEXT_MAX.owner);
  const rawKey = typeof r.ticketKey === 'string' ? clean(r.ticketKey) : '';
  const key = rawKey !== '' && rawKey.length <= 140 ? canonicalTicketKey(rawKey) : null;
  if (key == null) return null;
  if (sources != null && !textNamesKey(key, sources)) return null;
  return { ticketKey: key, relation, quote: quoteOf(r.quote, sources, DESCRIPTION_FIRST, stats), owner };
}

function gap(v: unknown, sources: StoryQuoteSources | undefined, stats: LabelQuoteStats): StorySpecGap {
  const g = asRecord(v);
  if (g == null) throw new Refused('shape');
  const type = clean(g.type) as StorySpecGapType;
  if (!STORY_SPEC_GAP_TYPES.includes(type)) throw new Refused('shape');
  return { type, text: text(g.text, STORY_LABEL_TEXT_MAX.gap, 'shape'), quote: quoteOf(g.quote, sources, DESCRIPTION_FIRST, stats) };
}

/** Parse and validate one completion against `criteriaCount` numbered criteria. `sources` = the text
 *  that was SENT (title, description, criteria) — every quote is verified against it. */
export function validateStoryLabels(raw: string, criteriaCount: number, sources?: StoryQuoteSources): LabelValidation {
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
  const storyRaw = asRecord(o?.story);
  if (o == null || !Array.isArray(o.criteria) || storyRaw == null) return { ok: false, reason: 'shape' };
  if (o.criteria.length !== criteriaCount) return { ok: false, reason: 'count' };
  const stats: LabelQuoteStats = { given: 0, verified: 0 };
  try {
    const criteria: StoryCriterionLabel[] = [];
    for (let i = 0; i < o.criteria.length; i += 1) {
      const c = asRecord(o.criteria[i]);
      if (c == null) return { ok: false, reason: 'shape' };
      if (c.n !== i + 1 && c.n !== String(i + 1)) return { ok: false, reason: 'order' };
      const testable = strictBool(c.testable);
      if (testable == null) return { ok: false, reason: 'not_boolean' };
      // A testable criterion's reason is noise: stored null, whatever came back.
      const reason = testable ? null : text(c.reason, STORY_LABEL_TEXT_MAX.reason, 'missing_reason');
      let rule: StoryUnclearRuleId | null = null;
      let quote: string | null = null;
      if (!testable) {
        const r = clean(c.rule);
        if (!(STORY_CRITERION_RULE_IDS as readonly string[]).includes(r)) return { ok: false, reason: 'bad_rule' };
        rule = r as StoryUnclearRuleId;
        quote = quoteOf(c.quote, sources, CRITERIA_FIRST, stats);
      }
      criteria.push({ n: i + 1, testable, reason, rule, quote });
    }
    const depsRaw = storyRaw.dependencies;
    const gapsRaw = storyRaw.gaps;
    const refsRaw = storyRaw.references;
    if (!Array.isArray(depsRaw) || !Array.isArray(gapsRaw) || !Array.isArray(refsRaw)) return { ok: false, reason: 'shape' };
    if (
      depsRaw.length > STORY_LABEL_DEPENDENCIES_MAX ||
      gapsRaw.length > STORY_SPEC_GAPS_MAX ||
      refsRaw.length > STORY_LABEL_REFERENCES_MAX
    ) {
      return { ok: false, reason: 'too_many' };
    }
    const refs = refsRaw
      .map((r) => reference(r, sources, stats))
      .filter((r): r is StoryTicketReference => r != null)
      .filter((r, i, all) => all.findIndex((x) => x.ticketKey.toUpperCase() === r.ticketKey.toUpperCase() && x.relation === r.relation) === i);
    const relationsOf = (key: string): StoryReferenceRelation[] =>
      refs.filter((r) => r.ticketKey.toUpperCase() === key.toUpperCase()).map((r) => r.relation);
    // The same dependency listed twice (the agreement test saw one named four times) is kept once.
    const deps = depsRaw
      .map((d) => dependency(d, sources, stats))
      .filter(
        (d, i, all) =>
          all.findIndex(
            (x) => x.kind === d.kind && x.what.toLowerCase() === d.what.toLowerCase() && x.ticketKey === d.ticketKey,
          ) === i,
      )
      // A ticket the references read as anything but depends_on is not a dependency.
      .filter((d) => {
        if (d.ticketKey == null) return true;
        const rel = relationsOf(d.ticketKey);
        return rel.length === 0 || rel.includes('depends_on');
      });
    // A ticket-keyed dependency no reference names: the dependency IS the depends_on claim.
    for (const d of deps) {
      if (d.ticketKey == null || relationsOf(d.ticketKey).length > 0) continue;
      const key = canonicalTicketKey(d.ticketKey);
      if (key == null || (sources != null && !textNamesKey(key, sources))) continue;
      refs.push({ ticketKey: key, relation: 'depends_on', quote: d.quote ?? null, owner: d.owner });
    }
    return {
      ok: true,
      criteria,
      story: { references: refs, dependencies: deps, gaps: gapsRaw.map((g) => gap(g, sources, stats)) },
      quotes: stats,
    };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}
