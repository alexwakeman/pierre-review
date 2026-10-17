import { SPRINT_PATHS_CAPS, SPRINT_PATH_RISKS, type SprintPathRisk } from '@pierre-review/shared';
import type { SprintPathsInput, StoredPathsJson } from '../../db/sprint-paths.js';

// THE SPRINT BUILDER'S ANSWER, VALIDATED (sprint-paths.test.ts) — inside `submit_paths` (a refusal is
// answered with EVERY problem and what to do about it) and once more before storing. Never repaired
// beyond folding whitespace: an answer that breaks a rule is refused.
//
//   • `paths` ≤ maxPaths, `callouts` ≤ maxCallouts (an absent `callouts` is []).
//   • Every ticket is a key the INPUT listed (sprint ticket or outside ticket), matched case-blind and
//     stored as the input spells it; no key twice in one list; no empty list; ≤ pathTickets /
//     calloutTickets.
//   • `title` 1–titleChars, `advice` 1–adviceChars, `risk` high | medium | low.
//   • ⚠ THE DIGIT GATE (the D4 rule, CLAUDE.md): titles and advice match `/^[^\p{Nd}\p{No}\p{Nl}]*$/u`
//     — no ASCII digit and no other Unicode numeral either ('٣', '³', 'Ⅻ'). Every number on the page is
//     code's; spelled-out counts stay a prompt-only rule.
//   • PLAIN TEXT: no Markdown or HTML characters (`* _ # < > [ ] | ~ and the backtick) and no link.
//   • Paths are re-ordered high → medium → low, the model's order kept within one level.

export const NO_NUMERALS = /^[^\p{Nd}\p{No}\p{Nl}]*$/u;
const MARKUP = /[`*_#<>[\]|~]|https?:\/\/|www\./i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '');
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export type SprintPathsValidation = { ok: true; value: StoredPathsJson } | { ok: false; problems: string[]; message: string };

const RISK_RANK: Record<SprintPathRisk, number> = { high: 0, medium: 1, low: 2 };

/** Validate one `submit_paths` payload against the input it answers. Pure. */
export function validateSprintPaths(raw: unknown, input: Pick<SprintPathsInput, 'keys'>): SprintPathsValidation {
  const C = SPRINT_PATHS_CAPS;
  const problems: string[] = [];
  const o = asRecord(raw);
  if (o == null) return refuse(['The answer must be an object with "paths" and "callouts".']);
  const canon = new Map(input.keys.map((k) => [k.toUpperCase(), k]));
  const text = (where: string, field: string, v: unknown, max: number): string => {
    const s = clean(v);
    if (s === '') problems.push(`${where}: "${field}" is missing or empty.`);
    else if (s.length > max) problems.push(`${where}: "${field}" is ${s.length} characters; keep it to ${max}.`);
    if (s !== '' && !NO_NUMERALS.test(s)) {
      problems.push(`${where}: "${field}" contains a digit or numeral. Remove every number and ticket key from it; put tickets in "tickets" only.`);
    }
    if (s !== '' && MARKUP.test(s)) problems.push(`${where}: "${field}" must be plain text: no Markdown, HTML or links.`);
    return s;
  };
  const tickets = (where: string, v: unknown, max: number): string[] => {
    if (!Array.isArray(v) || v.length === 0) {
      problems.push(`${where}: "tickets" must list at least one ticket key.`);
      return [];
    }
    if (v.length > max) problems.push(`${where}: lists ${v.length} tickets; keep it to ${max}.`);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of v) {
      const raw = typeof t === 'string' ? t.trim() : '';
      const key = canon.get(raw.toUpperCase());
      if (key == null) {
        problems.push(`${where}: "${raw === '' ? String(t) : raw}" is not a ticket key in the map. Use only keys the map lists.`);
        continue;
      }
      if (seen.has(key)) {
        problems.push(`${where}: ${key} is listed twice.`);
        continue;
      }
      seen.add(key);
      out.push(key);
    }
    return out;
  };

  const pathsRaw = o.paths;
  if (!Array.isArray(pathsRaw)) problems.push('"paths" must be a list (it may be empty).');
  const calloutsRaw = o.callouts == null ? [] : o.callouts;
  if (!Array.isArray(calloutsRaw)) problems.push('"callouts" must be a list (it may be empty).');
  const pathList = Array.isArray(pathsRaw) ? pathsRaw : [];
  const calloutList = Array.isArray(calloutsRaw) ? calloutsRaw : [];
  if (pathList.length > C.maxPaths) problems.push(`There are ${pathList.length} paths; send at most ${C.maxPaths}, the riskiest.`);
  if (calloutList.length > C.maxCallouts) problems.push(`There are ${calloutList.length} call-outs; send at most ${C.maxCallouts}.`);

  const paths: StoredPathsJson['paths'] = [];
  pathList.slice(0, C.maxPaths).forEach((p, i) => {
    const where = `Path ${i + 1}`;
    const r = asRecord(p);
    if (r == null) {
      problems.push(`${where} must be an object with title, tickets, advice and risk.`);
      return;
    }
    const title = text(where, 'title', r.title, C.titleChars);
    const advice = text(where, 'advice', r.advice, C.adviceChars);
    const risk = typeof r.risk === 'string' ? r.risk.trim().toLowerCase() : '';
    if (!SPRINT_PATH_RISKS.includes(risk as SprintPathRisk)) problems.push(`${where}: "risk" must be "high", "medium" or "low".`);
    const ts = tickets(where, r.tickets, C.pathTickets);
    paths.push({ title, tickets: ts, advice, risk: risk as SprintPathRisk });
  });
  const callouts: StoredPathsJson['callouts'] = [];
  calloutList.slice(0, C.maxCallouts).forEach((c, i) => {
    const where = `Call-out ${i + 1}`;
    const r = asRecord(c);
    if (r == null) {
      problems.push(`${where} must be an object with title and tickets.`);
      return;
    }
    const title = text(where, 'title', r.title, C.titleChars);
    callouts.push({ title, tickets: tickets(where, r.tickets, C.calloutTickets) });
  });
  if (problems.length > 0) return refuse(problems);
  const ranked = paths.map((p, i) => ({ p, i })).sort((a, b) => RISK_RANK[a.p.risk] - RISK_RANK[b.p.risk] || a.i - b.i).map((x) => x.p);
  return { ok: true, value: { paths: ranked, callouts } };
}

function refuse(problems: string[]): SprintPathsValidation {
  return { ok: false, problems, message: problems.map((p) => `- ${p}`).join('\n') };
}
