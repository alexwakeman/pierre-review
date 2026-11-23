import {
  RELEASE_BLOCKERS_CAPS,
  type ReleaseBlockersPrRef,
  type ReleaseBlockersReport,
  type ReleaseBlockersRepoNote,
  type ReleaseBlockersStep,
  type ReleaseBlockersTicketRef,
} from '@pierre-review/shared';
import { prKey, type ReleaseBlockersInput } from '../../releases/blockers-input.js';

// "EXPLAIN WHAT'S BLOCKING" — THE ANSWER, VALIDATED (release-blockers.test.ts). REFUSE RATHER THAN GUESS:
// the report may cite ONLY tickets and pull requests that are in the input.
//
//   • JSON with a non-empty `headline` (else refused). A headline that names a ticket key or a `#n` that
//     is not in the input, or is over its cap, REFUSES the whole answer (it is the line people act on).
//   • A STEP is dropped (counted in `dropped`) when its text or `unlocks` names a key or `#n` not in the
//     input, when a listed ticket / pull request is not in the input, or when a text is blank or over its
//     cap — never cut, never repaired. Keys and pull requests named in its text join its links.
//   • A REPO NOTE is dropped the same way, and when its repository is not a releasable one.
//   • Control characters stripped, whitespace folded. At most RELEASE_BLOCKERS_CAPS.steps steps kept.

export type ReleaseBlockersAnswer =
  | { ok: true; report: Pick<ReleaseBlockersReport, 'headline' | 'steps' | 'repos' | 'dropped'> }
  | { ok: false; reason: 'not_json' | 'shape' | 'unknown_ref' | 'too_long' };

const C = RELEASE_BLOCKERS_CAPS;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** A tracker key's shape (ABC-12). */
const KEY = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
/** "repository #12" or a bare "#12". */
const PR_IN_TEXT = /(?:([A-Za-z0-9_.-]+)\s+)?#(\d+)\b/g;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const clean = (v: unknown): string | null => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : null);

interface Refs {
  tickets: ReleaseBlockersTicketRef[];
  prs: ReleaseBlockersPrRef[];
}

/** The refs a text names, or null when it names one not in the input. */
function refsIn(text: string, input: ReleaseBlockersInput): Refs | null {
  const out: Refs = { tickets: [], prs: [] };
  for (const m of text.matchAll(KEY)) {
    const t = input.tickets.get(m[0]);
    if (t == null) return null;
    if (!out.tickets.includes(t)) out.tickets.push(t);
  }
  for (const m of text.matchAll(PR_IN_TEXT)) {
    const n = Number(m[2]);
    if (!input.numbers.has(n)) return null;
    const pr = m[1] != null ? input.prs.get(prKey(m[1], n)) : undefined;
    if (pr != null && !out.prs.includes(pr)) out.prs.push(pr);
  }
  return out;
}

const merge = (a: Refs, b: Refs): Refs => ({
  tickets: [...a.tickets, ...b.tickets.filter((t) => !a.tickets.includes(t))],
  prs: [...a.prs, ...b.prs.filter((p) => !a.prs.includes(p))],
});

/** A step's listed tickets / pull requests, or null when one is not in the input. */
function listedRefs(o: Record<string, unknown>, input: ReleaseBlockersInput): Refs | null {
  const out: Refs = { tickets: [], prs: [] };
  const tickets = o.tickets ?? [];
  const prs = o.prs ?? [];
  if (!Array.isArray(tickets) || !Array.isArray(prs)) return null;
  for (const k of tickets) {
    const t = typeof k === 'string' ? input.tickets.get(k.trim()) : undefined;
    if (t == null) return null;
    if (!out.tickets.includes(t)) out.tickets.push(t);
  }
  for (const p of prs) {
    const m = typeof p === 'string' ? /^\s*(.+?)\s*#(\d+)\s*$/.exec(p) : null;
    const pr = m != null ? input.prs.get(prKey(m[1]!, Number(m[2]))) : undefined;
    if (pr == null) return null;
    if (!out.prs.includes(pr)) out.prs.push(pr);
  }
  return out;
}

/** Validate one answer against its input. Pure. */
export function validateReleaseBlockers(raw: string, input: ReleaseBlockersInput): ReleaseBlockersAnswer {
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
  if (o == null) return { ok: false, reason: 'shape' };
  const headline = clean(o.headline);
  if (headline == null || headline === '') return { ok: false, reason: 'shape' };
  if (headline.length > C.headline) return { ok: false, reason: 'too_long' };
  if (refsIn(headline, input) == null) return { ok: false, reason: 'unknown_ref' };
  if ((o.steps != null && !Array.isArray(o.steps)) || (o.repos != null && !Array.isArray(o.repos))) return { ok: false, reason: 'shape' };

  let dropped = 0;
  const steps: ReleaseBlockersStep[] = [];
  for (const s of (o.steps as unknown[] | undefined) ?? []) {
    const r = asRecord(s);
    const text = clean(r?.do);
    const unlocks = r?.unlocks == null ? null : clean(r.unlocks);
    if (r == null || text == null || text === '' || text.length > C.step || (unlocks != null && unlocks.length > C.unlocks)) {
      dropped += 1;
      continue;
    }
    const inText = refsIn(`${text} ${unlocks ?? ''}`, input);
    const listed = listedRefs(r, input);
    if (inText == null || listed == null) {
      dropped += 1;
      continue;
    }
    const refs = merge(listed, inText);
    if (steps.length >= C.steps) continue;
    steps.push({ text, unlocks: unlocks === '' ? null : unlocks, tickets: refs.tickets.slice(0, C.refsPerStep), prs: refs.prs.slice(0, C.refsPerStep) });
  }

  const repos: ReleaseBlockersRepoNote[] = [];
  for (const n of (o.repos as unknown[] | undefined) ?? []) {
    const r = asRecord(n);
    const repoName = clean(r?.repo);
    const text = clean(r?.why);
    if (repoName == null || !input.repoNames.has(repoName) || text == null || text === '' || text.length > C.repoNote || refsIn(text, input) == null) {
      dropped += 1;
      continue;
    }
    if (repos.some((x) => x.repoName === repoName)) continue;
    repos.push({ repoName, text });
  }
  return { ok: true, report: { headline, steps, repos, dropped } };
}
