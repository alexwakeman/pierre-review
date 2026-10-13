import { SPRINT_THEME_CAPS, type SprintTheme } from '@pierre-review/shared';

// THE SPRINT THEMES' ANSWER, VALIDATED (sprint-themes.test.ts). Stored only when the answer is the
// shape; anything else is a FAILED pass — retried once, then again on the next sprint read — never a
// repaired guess.
//
//   • `themes`: strings (or `{name}`), control characters stripped, whitespace folded, a trailing full
//     stop dropped; blank or a repeat (case-insensitive) → `shape`; over SPRINT_THEME_CAPS.nameWords
//     words or nameChars characters → `too_long` (never cut).
//   • `tickets`: `{key, theme}` with `theme` a 1-based number. A key that is not a sprint key is DROPPED
//     (case-insensitive match). A sprint key given twice with two themes → `duplicate`; a sprint key
//     never given → `missing`; a theme number that does not exist → `shape`.
//   • Themes no ticket landed in are dropped; what remains must number minThemes..maxThemes (`count`).

export type ThemeValidationFailure = 'not_json' | 'shape' | 'too_long' | 'count' | 'missing' | 'duplicate';

export type ThemeValidation =
  | { ok: true; themes: SprintTheme[]; assignments: Array<{ key: string; theme: string }> }
  | { ok: false; reason: ThemeValidationFailure };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v: unknown): string =>
  typeof v === 'string'
    ? v
        .replace(CONTROL, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/\.$/, '')
        .trim()
    : '';

/** Parse and validate one completion against the sprint's keys (as sent). */
export function validateSprintThemes(raw: string, keys: readonly string[]): ThemeValidation {
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
  if (o == null || !Array.isArray(o.themes) || !Array.isArray(o.tickets)) return { ok: false, reason: 'shape' };
  const C = SPRINT_THEME_CAPS;
  if (o.themes.length < C.minThemes || o.themes.length > C.maxThemes) return { ok: false, reason: 'count' };
  const names: string[] = [];
  for (const t of o.themes) {
    const name = clean(typeof t === 'string' ? t : asRecord(t)?.name);
    if (name === '') return { ok: false, reason: 'shape' };
    if (name.length > C.nameChars || name.split(' ').length > C.nameWords) return { ok: false, reason: 'too_long' };
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) return { ok: false, reason: 'shape' };
    names.push(name);
  }
  const canon = new Map(keys.map((k) => [k.toUpperCase(), k]));
  const assigned = new Map<string, number>();
  for (const x of o.tickets) {
    const r = asRecord(x);
    if (r == null || typeof r.key !== 'string') return { ok: false, reason: 'shape' };
    const key = canon.get(r.key.trim().toUpperCase());
    if (key == null) continue; // not a sprint key: dropped
    const n = typeof r.theme === 'number' ? r.theme : typeof r.theme === 'string' && /^\d+$/.test(r.theme.trim()) ? Number(r.theme) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > names.length) return { ok: false, reason: 'shape' };
    const prev = assigned.get(key);
    if (prev != null && prev !== n) return { ok: false, reason: 'duplicate' };
    assigned.set(key, n);
  }
  if (keys.some((k) => !assigned.has(k))) return { ok: false, reason: 'missing' };
  const used = new Set(assigned.values());
  const themes = names.filter((_, i) => used.has(i + 1)).map((name) => ({ name }));
  if (themes.length < C.minThemes || themes.length > C.maxThemes) return { ok: false, reason: 'count' };
  return { ok: true, themes, assignments: keys.map((key) => ({ key, theme: names[assigned.get(key)! - 1]! })) };
}
