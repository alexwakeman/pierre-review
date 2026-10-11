import {
  STORY_DEPENDENCY_KINDS,
  STORY_LABEL_DEPENDENCIES_MAX,
  STORY_LABEL_TEXT_MAX,
  STORY_SPEC_GAPS_MAX,
  STORY_SPEC_GAP_TYPES,
  canonicalTicketKey,
  type StoryCriterionLabel,
  type StoryDependencyKind,
  type StoryDependencyLabel,
  type StoryLevelLabels,
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

export type LabelValidationFailure = 'not_json' | 'shape' | 'count' | 'order' | 'not_boolean' | 'missing_reason' | 'too_long' | 'too_many';

export type LabelValidation =
  | { ok: true; criteria: StoryCriterionLabel[]; story: StoryLevelLabels }
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

class Refused extends Error {
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

function dependency(v: unknown): StoryDependencyLabel {
  const d = asRecord(v);
  if (d == null) throw new Refused('shape');
  const kind = clean(d.kind) as StoryDependencyKind;
  if (!STORY_DEPENDENCY_KINDS.includes(kind)) throw new Refused('shape');
  const what = text(d.what, STORY_LABEL_TEXT_MAX.what, 'shape');
  const owner = optionalText(d.owner, STORY_LABEL_TEXT_MAX.owner);
  const rawKey = typeof d.ticketKey === 'string' ? clean(d.ticketKey) : '';
  const ticketKey = rawKey !== '' && rawKey.length <= 40 && canonicalTicketKey(rawKey) != null ? rawKey : null;
  return { kind, what, owner, ticketKey };
}

function gap(v: unknown): StorySpecGap {
  const g = asRecord(v);
  if (g == null) throw new Refused('shape');
  const type = clean(g.type) as StorySpecGapType;
  if (!STORY_SPEC_GAP_TYPES.includes(type)) throw new Refused('shape');
  return { type, text: text(g.text, STORY_LABEL_TEXT_MAX.gap, 'shape') };
}

/** Parse and validate one completion against `criteriaCount` numbered criteria. */
export function validateStoryLabels(raw: string, criteriaCount: number): LabelValidation {
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
      criteria.push({ n: i + 1, testable, reason });
    }
    const depsRaw = storyRaw.dependencies;
    const gapsRaw = storyRaw.gaps;
    if (!Array.isArray(depsRaw) || !Array.isArray(gapsRaw)) return { ok: false, reason: 'shape' };
    if (depsRaw.length > STORY_LABEL_DEPENDENCIES_MAX || gapsRaw.length > STORY_SPEC_GAPS_MAX) {
      return { ok: false, reason: 'too_many' };
    }
    // The same dependency listed twice (the agreement test saw one named four times) is kept once.
    const deps = depsRaw.map(dependency).filter(
      (d, i, all) =>
        all.findIndex(
          (x) => x.kind === d.kind && x.what.toLowerCase() === d.what.toLowerCase() && x.ticketKey === d.ticketKey,
        ) === i,
    );
    return { ok: true, criteria, story: { dependencies: deps, gaps: gapsRaw.map(gap) } };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}
