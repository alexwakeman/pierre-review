import { RELEASE_BLOCKERS_CAPS, RELEASE_BLOCKERS_ID_IN_TEXT, type ReleaseBlockersReport, type ReleaseBlockersRef, type ReleaseBlockersRepoNote, type ReleaseBlockersStep } from '@pierre-review/shared';
import type { ReleaseBlockersInput } from '../../releases/blockers-input.js';

// "EXPLAIN WHAT'S BLOCKING" — THE ANSWER, VALIDATED BY ID (release-blockers.test.ts). REFUSE RATHER THAN
// GUESS, one point at a time — never the whole answer:
//
//   • NOT JSON, or not the shape ({headline, steps[], repos[]}) → `not_json` / `shape`: the route retries
//     ONCE. That is the ONLY retry.
//   • A text (the headline, a step, a repository note) is DROPPED (counted in `dropped`) when it cites an id
//     the input does not define, writes a bare ticket key or `#n` that is not in the input, is blank, or is
//     over its cap — never cut, never repaired. A dropped headline is null; the steps and notes stay.
//   • `{T3, P7}` is read as `{T3}, {P7}`. `refs` = exactly the ids the kept texts cite.
//   • A repository note must name a repository whose ladder has stops (each named once).
//   • Control characters stripped, whitespace folded. At most RELEASE_BLOCKERS_CAPS.steps / .repos kept.
//   • Nothing kept at all → `empty` (the route stores nothing and says so; no retry).

export type ReleaseBlockersAnswer =
  | { ok: true; report: Pick<ReleaseBlockersReport, 'headline' | 'steps' | 'repos' | 'refs' | 'dropped'> }
  | { ok: false; reason: 'not_json' | 'shape' | 'empty'; dropped: number };

const C = RELEASE_BLOCKERS_CAPS;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** A tracker key's shape (ABC-12). */
const KEY = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
/** A bare `#12`. */
const NUMBER = /#(\d+)\b/g;
/** `{T3, P7}` — a list of ids in one pair of braces. */
const ID_LIST = /\{\s*([TPR]\d{1,4}(?:\s*,\s*[TPR]\d{1,4})+)\s*\}/g;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const clean = (v: unknown): string | null =>
  typeof v === 'string'
    ? v
        .replace(CONTROL, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(ID_LIST, (_m, list: string) => list.split(/\s*,\s*/).map((x) => `{${x}}`).join(', '))
    : null;

/** The ids a text cites, or null when it cites one the input does not define or a bare unknown key / `#n`. */
function citedIds(text: string, input: ReleaseBlockersInput): string[] | null {
  const ids: string[] = [];
  for (const m of text.matchAll(RELEASE_BLOCKERS_ID_IN_TEXT)) {
    if (!input.refs.has(m[1]!)) return null;
    if (!ids.includes(m[1]!)) ids.push(m[1]!);
  }
  // Outside the braces: a key or a number must still be one the input gives. A GitHub Issues key
  // ("acme/web#12") is matched whole first, so its `#12` is not read as a number.
  let rest = text.replace(RELEASE_BLOCKERS_ID_IN_TEXT, ' ');
  for (const k of input.keys) if (k.includes('#') && rest.includes(k)) rest = rest.split(k).join(' ');
  for (const m of rest.matchAll(KEY)) if (!input.keys.has(m[0])) return null;
  for (const m of rest.matchAll(NUMBER)) if (!input.numbers.has(Number(m[1]))) return null;
  return ids;
}

/** Validate one answer against its input. Pure. */
export function validateReleaseBlockers(raw: string, input: ReleaseBlockersInput): ReleaseBlockersAnswer {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, reason: 'not_json', dropped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(a, b + 1));
  } catch {
    return { ok: false, reason: 'not_json', dropped: 0 };
  }
  const o = asRecord(parsed);
  if (o == null || (o.headline != null && typeof o.headline !== 'string') || (o.steps != null && !Array.isArray(o.steps)) || (o.repos != null && !Array.isArray(o.repos))) {
    return { ok: false, reason: 'shape', dropped: 0 };
  }

  let dropped = 0;
  /** A kept text, or null (counted) when it must go. */
  const keep = (v: unknown, cap: number): string | null => {
    const text = clean(v);
    if (text == null || text === '') {
      if (v != null) dropped += 1;
      return null;
    }
    if (text.length > cap || citedIds(text, input) == null) {
      dropped += 1;
      return null;
    }
    return text;
  };

  const headline = keep(o.headline, C.headline);
  const steps: ReleaseBlockersStep[] = [];
  for (const s of (o.steps as unknown[] | undefined) ?? []) {
    // A step is a string; `{do: "…"}` (the old shape) is read too.
    const v = typeof s === 'string' ? s : (asRecord(s)?.do ?? null);
    if (v == null) {
      dropped += 1;
      continue;
    }
    const text = keep(v, C.step);
    if (text != null && steps.length < C.steps) steps.push({ text });
  }
  const repos: ReleaseBlockersRepoNote[] = [];
  for (const n of (o.repos as unknown[] | undefined) ?? []) {
    const r = asRecord(n);
    const repoName = clean(r?.repo);
    if (repoName == null || !input.blockedRepoNames.has(repoName) || repos.some((x) => x.repoName === repoName)) {
      dropped += 1;
      continue;
    }
    const text = keep(r?.why, C.repoNote);
    if (text != null && repos.length < C.repos) repos.push({ repoName, text });
  }
  if (headline == null && steps.length === 0 && repos.length === 0) return { ok: false, reason: 'empty', dropped };

  // Exactly the ids the kept texts cite.
  const refs: Record<string, ReleaseBlockersRef> = {};
  const keptText = [headline ?? '', ...steps.map((s) => s.text), ...repos.map((r) => r.text)].join(' ');
  for (const m of keptText.matchAll(RELEASE_BLOCKERS_ID_IN_TEXT)) {
    const ref = input.refs.get(m[1]!);
    if (ref != null) refs[m[1]!] = ref;
  }
  return { ok: true, report: { headline, steps, repos, refs, dropped } };
}
