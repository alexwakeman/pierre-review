import type { StoryCriterionLabel, StoryLevelLabels } from '@pierre-review/shared';

// THE LABELLER'S ANSWER, VALIDATED (validate.test.ts). A label is stored only when the answer is
// EXACTLY the rubric's shape: JSON, one criterion entry per numbered criterion with `n` = 1, 2, 3 …
// in order, and every answer a boolean. Anything else is a FAILED label — not stored, retried on the
// next press — never a repaired guess: a dropped or shifted criterion would silently move every
// criterion-weighted percentage. Booleans are coerced STRICTLY: `true` / `false`, or the exact
// strings "true" / "false"; nothing else (no 0/1, no "yes").

export type LabelValidation =
  | { ok: true; criteria: StoryCriterionLabel[]; story: StoryLevelLabels }
  | { ok: false; reason: 'not_json' | 'shape' | 'count' | 'order' | 'not_boolean' };

function strictBool(v: unknown): boolean | null {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Parse and validate one completion against `criteriaCount` numbered criteria. */
export function validateStoryLabels(text: string, criteriaCount: number): LabelValidation {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, reason: 'not_json' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const o = asRecord(raw);
  const storyRaw = asRecord(o?.story);
  if (o == null || !Array.isArray(o.criteria) || storyRaw == null) return { ok: false, reason: 'shape' };
  if (o.criteria.length !== criteriaCount) return { ok: false, reason: 'count' };
  const criteria: StoryCriterionLabel[] = [];
  for (let i = 0; i < o.criteria.length; i += 1) {
    const c = asRecord(o.criteria[i]);
    if (c == null) return { ok: false, reason: 'shape' };
    if (c.n !== i + 1 && c.n !== String(i + 1)) return { ok: false, reason: 'order' };
    const testable = strictBool(c.testable);
    const bundled = strictBool(c.bundled);
    const dependsOnOtherWork = strictBool(c.dependsOnOtherWork);
    if (testable == null || bundled == null || dependsOnOtherWork == null) return { ok: false, reason: 'not_boolean' };
    criteria.push({ n: i + 1, testable, bundled, dependsOnOtherWork });
  }
  const outOfScopeStated = strictBool(storyRaw.outOfScopeStated);
  const dependencyNamed = strictBool(storyRaw.dependencyNamed);
  const nonCodeWork = strictBool(storyRaw.nonCodeWork);
  if (outOfScopeStated == null || dependencyNamed == null || nonCodeWork == null) {
    return { ok: false, reason: 'not_boolean' };
  }
  return { ok: true, criteria, story: { outOfScopeStated, dependencyNamed, nonCodeWork } };
}
