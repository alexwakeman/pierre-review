import type { JiraAcCandidate, OpenPointsFieldMode, TicketOpenPoint } from '@pierre-review/shared';

// OPEN POINTS (docs/TRACKERS.md § Open points): the decisions, content or designs that were not final
// when the ticket was written ("Content depends on UCD confirming"). A PR review is told about them so
// the developer can chase them; they never move a verdict.
//
// ONE PURE RULE, run on READ from what the worker already stores (the ticket's text-field candidates
// and its description) — nothing about open points is stored on a ticket row, so a Settings change
// applies at once with nothing to re-derive:
//   1. the open-points FIELD for the issue type: the field chosen in Settings ('field'), or with
//      'auto' the field whose NAME reads "Open points" / "Open questions" (an exact name first);
//   2. when no field gives a point (or the mode is 'none'): an "Open points" SECTION of the
//      description — a heading or label such as "Open points", "Open questions", "Outstanding",
//      "TBC", "To be confirmed".
// Every point carries its source.
//
// ⚠ UNTRUSTED TEXT, LINEAR SCANS: the description is the customer's tracker text. Each line is tested
// on its own by anchored patterns with no nested or overlapping quantifiers, and every input is
// capped before it is scanned.

/** At most this many points per ticket, each at most this many characters. */
export const OPEN_POINTS_MAX = 20;
export const OPEN_POINT_MAX_CHARS = 400;
/** Text longer than this is cut before it is scanned (a description is capped by the reader too). */
const SCAN_MAX_CHARS = 60_000;

// A field NAME that holds open points. Exact first, then one that contains the words.
const EXACT_FIELD_NAME = /^\s*open[\s_-]*(?:points?|questions?|issues?)\s*$/i;
const FIELD_NAME = /\bopen[\s_-]*(?:points?|questions?)\b/i;

// A section LABEL in a description (after the heading marks, bold marks and a trailing colon are
// taken off). One word list, no nesting.
const SECTION_LABEL =
  /^(?:open[\s_-]*(?:points?|questions?|issues?|items?|decisions?)|outstanding(?:[\s_-]*(?:points?|questions?|items?|decisions?|issues?))?|tbc|tbd|to be confirmed|to be decided|unresolved(?:[\s_-]*(?:points?|questions?|issues?))?|pending decisions?)$/i;

// A list item: "- x", "* x", "+ x", "• x", "1. x", "1) x", and a task box "- [ ] x".
const LIST_ITEM = /^\s{0,8}(?:[-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(\S.*)$/;
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
// "Nothing open" written into the field.
const NOTHING = /^(?:none|n\/?a|nil|nothing|-+|no open points?|no open questions?|none at this time|tbc)\.?$/i;

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** Strip a line's heading marks, wrapping bold / italic marks and one trailing colon. Linear. */
function labelOf(line: string): { label: string; rest: string } {
  let s = line.trim();
  // Heading marks.
  let i = 0;
  while (i < s.length && i < 6 && s[i] === '#') i += 1;
  s = s.slice(i).trim();
  // Leading emphasis marks.
  let j = 0;
  while (j < s.length && j < 3 && (s[j] === '*' || s[j] === '_')) j += 1;
  s = s.slice(j);
  // "Label: rest" or "Label**: rest" — the first colon splits label from rest.
  const colon = s.indexOf(':');
  let label = colon >= 0 ? s.slice(0, colon) : s;
  let rest = colon >= 0 ? s.slice(colon + 1) : '';
  label = trimMarks(label);
  rest = trimMarks(rest);
  return { label: label.trim(), rest: rest.trim() };
}

function trimMarks(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === '*' || s[a] === '_' || s[a] === ' ')) a += 1;
  while (b > a && (s[b - 1] === '*' || s[b - 1] === '_' || s[b - 1] === ' ')) b -= 1;
  return s.slice(a, b);
}

/** Does this line open an open-points section? Returns the text after the label ('' when none). */
function sectionStart(line: string): string | null {
  const t = line.trim();
  if (t === '' || t.length > 200 || LIST_ITEM.test(t)) return null;
  const { label, rest } = labelOf(t);
  if (!SECTION_LABEL.test(label)) return null;
  // A bare word in a sentence is not a label: it needs a heading, bold marks, a colon, or to stand alone.
  const marked = HEADING.test(t) || t.startsWith('*') || t.startsWith('_') || t.includes(':');
  if (!marked && rest === '' && t !== label) return null;
  return rest;
}

/** Does this line end a section: another heading, or a short bold / "Label:" line? */
function sectionEnd(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (HEADING.test(t)) return true;
  if (LIST_ITEM.test(t)) return false;
  // A whole-line bold label: "**Notes**" / "__Notes__" / "**Notes:**".
  if ((t.startsWith('**') && t.endsWith('**')) || (t.startsWith('__') && t.endsWith('__'))) return t.length <= 80;
  // "Label:" alone on its line, a few words.
  if (t.endsWith(':') && t.length <= 60 && t.split(/\s+/).length <= 6) return true;
  return false;
}

/**
 * Split a block of text into points: list items (a continuation line joins its item), else one
 * point per paragraph. "None" and the like are dropped. Capped.
 */
export function splitPoints(text: string): string[] {
  const lines = cap(text, SCAN_MAX_CHARS).replace(/\r\n?/g, '\n').split('\n');
  const hasList = lines.some((l) => LIST_ITEM.test(l));
  const out: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    const p = cur.join(' ').replace(/\s+/g, ' ').trim();
    cur = [];
    if (p !== '' && !NOTHING.test(p)) out.push(cap(p, OPEN_POINT_MAX_CHARS));
  };
  let inFence = false;
  for (const raw of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.trim();
    if (hasList) {
      const m = LIST_ITEM.exec(raw);
      if (m) {
        flush();
        cur.push(m[1]!);
      } else if (line === '') {
        flush();
      } else if (cur.length > 0) {
        cur.push(line);
      } else if (!HEADING.test(line)) {
        // Prose before the first item is a point of its own.
        cur.push(line);
        flush();
      }
    } else if (line === '') {
      flush();
    } else if (!HEADING.test(line)) {
      cur.push(line);
    }
    if (out.length >= OPEN_POINTS_MAX) break;
  }
  flush();
  return out.slice(0, OPEN_POINTS_MAX);
}

/** The points under every open-points section of a description ([] when it has none). */
export function descriptionOpenPoints(description: string | null | undefined): string[] {
  if (description == null || description === '') return [];
  const lines = cap(description, SCAN_MAX_CHARS).replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let cur: string[] | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) {
      if (cur) cur.push(line);
      continue;
    }
    const start = sectionStart(line);
    if (start != null) {
      if (cur) blocks.push(cur.join('\n'));
      cur = start !== '' ? [start] : [];
      continue;
    }
    if (cur && sectionEnd(line)) {
      blocks.push(cur.join('\n'));
      cur = null;
      continue;
    }
    if (cur) cur.push(line);
  }
  if (cur) blocks.push(cur.join('\n'));
  const out: string[] = [];
  for (const b of blocks) {
    for (const p of splitPoints(b)) if (!out.includes(p)) out.push(p);
    if (out.length >= OPEN_POINTS_MAX) break;
  }
  return out.slice(0, OPEN_POINTS_MAX);
}

/** The field whose NAME reads as open points, best first (exact name, then contains), or null. */
export function openPointsFieldByName(candidates: readonly JiraAcCandidate[]): JiraAcCandidate | null {
  return candidates.find((c) => EXACT_FIELD_NAME.test(c.name)) ?? candidates.find((c) => FIELD_NAME.test(c.name)) ?? null;
}

/** A workspace's choice for one issue type; absent = 'auto'. */
export interface OpenPointsChoice {
  mode: OpenPointsFieldMode;
  fieldId: string | null;
}

export interface DerivedOpenPoints {
  points: TicketOpenPoint[];
  /** The field the points came from; null when they came from the description (or there are none). */
  field: { id: string; name: string } | null;
}

/** THE ONE RULE: a ticket's open points from its stored candidates and description (see the header). */
export function deriveOpenPoints(
  candidates: readonly JiraAcCandidate[],
  description: string | null | undefined,
  choice: OpenPointsChoice | null | undefined,
): DerivedOpenPoints {
  const mode = choice?.mode ?? 'auto';
  let field: JiraAcCandidate | null = null;
  if (mode === 'field' && choice?.fieldId != null) field = candidates.find((c) => c.id === choice.fieldId) ?? null;
  else if (mode === 'auto') field = openPointsFieldByName(candidates);
  if (field != null) {
    const texts = splitPoints(field.text);
    if (texts.length > 0) {
      return {
        points: texts.map((text) => ({ text, source: 'field', fieldName: field!.name })),
        field: { id: field.id, name: field.name },
      };
    }
  }
  return {
    points: descriptionOpenPoints(description).map((text) => ({ text, source: 'description', fieldName: null })),
    field: null,
  };
}
