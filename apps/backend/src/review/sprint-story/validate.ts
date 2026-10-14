import { SPRINT_STORY_CAPS, type SprintStoryline } from '@pierre-review/shared';
import type { SprintStoryInput } from '../../db/sprint-story.js';

// THE SPRINT STORY'S ANSWER, VALIDATED (sprint-story.test.ts). Stored only when the answer is the shape;
// anything else is a FAILED pass — retried once, then again on the next sprint read — never a repaired
// guess.
//
//   • `headline`: one string, cleaned (control characters, whitespace folded), ≤ headlineChars.
//   • `focus` (v4): REQUIRED, one string cleaned alike, ≤ focusChars (missing / empty → `shape`). Its
//     numbers may come from the sprint-wide facts and the AREAS OF WORK block only.
//   • `storylines`: `{id, title, sentence}` (chains and risks only); `id` must be a candidate id
//     (`unknown_id`), each at most once (`duplicate`), at most maxStorylines (`count`), with at least one
//     chain when a chain candidate exists and one risk when a risk candidate exists (`coverage`).
//     KIND and IDENTS come from the candidate — never from the model.
//   • THE NUMBER GATE (the D4 rule, CLAUDE.md): every count is code's, so model text may carry —
//       – no non-ASCII numeral at all (`\p{Nd}\p{No}\p{Nl}` outside 0-9: '٣', '³', 'Ⅻ') → `numeral`;
//       – no ticket-key-shaped token that is not a key handed in → `unknown_key`;
//       – no number that does not appear in the facts it was given → `number`. A storyline may use the
//         sprint-wide facts and ITS OWN candidate; the headline the sprint-wide facts and any candidate.
//     ⚠ ALLOWED NUMBERS COME FROM CODE'S COUNTS ONLY. Tracker-authored names (sprint name, theme / epic
//     names, ticket titles — `input.verbatim`) and the quoted brief reasons are removed before the facts
//     are read for numbers, so "Handle 500 errors" never makes "500 tickets are blocked" pass, and a
//     model-written `why` never launders a figure. The same names are removed from the MODEL's text
//     before the gate, so quoting a title whole ("UTF-8 uploads", "Sprint 15") is not a number or a key.
//       – no SPELLED-OUT count of two or more (`two` … `twenty`, `thirty` … `ninety`, `hundred`,
//         `thousand`, `dozen`; whole words, any case) → `number_word`: every count is DIGITS, so the
//         number gate above can see it. "one" / "a single" stay allowed — "one" is ordinary English
//         ("one of the tickets"). A tracker-authored name quoted whole ("Two-factor login") is removed
//         first, like its digits.

export type StoryValidationFailure =
  | 'not_json'
  | 'shape'
  | 'too_long'
  | 'count'
  | 'unknown_id'
  | 'duplicate'
  | 'coverage'
  | 'numeral'
  | 'number_word'
  | 'unknown_key'
  | 'number';

export type StoryValidation =
  | { ok: true; headline: string; focus: string; storylines: SprintStoryline[] }
  | { ok: false; reason: StoryValidationFailure };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '');
const stripTitle = (s: string): string => s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\.$/, '').trim();

const ANY_NUMERAL = /[\p{Nd}\p{No}\p{Nl}]/gu;
const KEYISH = /\b[A-Za-z][A-Za-z0-9_]*-\d+\b/;
const NUMBER = /\d+(?:\.\d+)?/g;
// A spelled-out count of two or more, as a whole word (a hyphen ends a word: "twenty-one" matches).
const NUMBER_WORD =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?)\b/i;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every handed-in key removed (case-insensitive, whole token). */
function withoutKeys(text: string, keyRe: RegExp | null): string {
  return keyRe == null ? text : text.replace(keyRe, ' ');
}

function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER) ?? []).map((n) => String(Number(n))));
}

/** `text` with each tracker-authored name removed (case-insensitive, literal). Longest first. */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const n of names) out = out.replace(new RegExp(escapeRe(n), 'gi'), ' ');
  return out;
}

/** Candidate / facts text as a source of ALLOWED numbers: names and quoted text ("…") removed. */
function countText(text: string, names: readonly string[]): string {
  return withoutNames(text, names).replace(/"[^"\n]*"/g, ' ');
}

/** The number gate over one piece of model text. Pure (exported for its test). */
export function gateNumbers(text: string, allowed: ReadonlySet<string>, keyRe: RegExp | null): StoryValidationFailure | null {
  for (const ch of text.match(ANY_NUMERAL) ?? []) if (!/[0-9]/.test(ch)) return 'numeral';
  const rest = withoutKeys(text, keyRe);
  if (KEYISH.test(rest)) return 'unknown_key';
  if (NUMBER_WORD.test(rest)) return 'number_word';
  for (const n of numbersIn(rest)) if (!allowed.has(n)) return 'number';
  return null;
}

/** Parse and validate one completion against the input it answered. */
export function validateSprintStory(raw: string, input: SprintStoryInput): StoryValidation {
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
  if (o == null || typeof o.headline !== 'string' || !Array.isArray(o.storylines)) return { ok: false, reason: 'shape' };
  const C = SPRINT_STORY_CAPS;
  const keyRe = input.keys.length > 0 ? new RegExp(`(?<![A-Za-z0-9_])(?:${input.keys.map(escapeRe).join('|')})(?![0-9])`, 'gi') : null;
  const names = input.verbatim ?? [];
  const global = numbersIn(withoutKeys(countText(input.facts, names), keyRe));
  const areaNumbers = new Set([...global, ...numbersIn(withoutKeys(countText(input.areas ?? '', names), keyRe))]);
  const allNumbers = new Set(areaNumbers);
  const byId = new Map<string, { candidate: SprintStoryInput['candidates'][number]; numbers: Set<string> }>();
  for (const c of input.candidates) {
    const own = numbersIn(withoutKeys(countText(c.text, names), keyRe));
    for (const n of own) allNumbers.add(n);
    byId.set(c.id.toUpperCase(), { candidate: c, numbers: new Set([...global, ...own]) });
  }

  const headline = clean(o.headline);
  if (headline === '') return { ok: false, reason: 'shape' };
  if (headline.length > C.headlineChars) return { ok: false, reason: 'too_long' };
  const hg = gateNumbers(withoutNames(headline, names), allNumbers, keyRe);
  if (hg != null) return { ok: false, reason: hg };

  const focus = clean(o.focus);
  if (focus === '') return { ok: false, reason: 'shape' };
  if (focus.length > C.focusChars) return { ok: false, reason: 'too_long' };
  const fg = gateNumbers(withoutNames(focus, names), areaNumbers, keyRe);
  if (fg != null) return { ok: false, reason: fg };

  const min = Math.min(C.minStorylines, input.candidates.length);
  if (o.storylines.length < min || o.storylines.length > C.maxStorylines) return { ok: false, reason: 'count' };
  const seen = new Set<string>();
  const storylines: SprintStoryline[] = [];
  for (const x of o.storylines) {
    const r = asRecord(x);
    if (r == null || typeof r.id !== 'string') return { ok: false, reason: 'shape' };
    const id = r.id.trim().replace(/^\[|\]$/g, '').toUpperCase();
    const hit = byId.get(id);
    if (hit == null) return { ok: false, reason: 'unknown_id' };
    if (seen.has(id)) return { ok: false, reason: 'duplicate' };
    seen.add(id);
    const title = stripTitle(clean(r.title));
    const sentence = clean(r.sentence);
    if (title === '' || sentence === '') return { ok: false, reason: 'shape' };
    if (title.length > C.titleChars || title.split(' ').length > C.titleWords || sentence.length > C.sentenceChars) return { ok: false, reason: 'too_long' };
    for (const t of [title, sentence]) {
      const g = gateNumbers(withoutNames(t, names), hit.numbers, keyRe);
      if (g != null) return { ok: false, reason: g };
    }
    storylines.push({ kind: hit.candidate.kind, title, sentence, idents: [...hit.candidate.idents] });
  }
  // COVERAGE: a chain when any chain candidate exists, a risk when any risk candidate exists.
  for (const kind of ['chain', 'risk'] as const) {
    if (input.candidates.some((c) => c.kind === kind) && !storylines.some((l) => l.kind === kind)) return { ok: false, reason: 'coverage' };
  }
  return { ok: true, headline, focus, storylines };
}
