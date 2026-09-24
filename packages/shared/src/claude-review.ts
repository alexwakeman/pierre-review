// Claude Review: the ONE spelling of the user-story caps, the acceptance-criteria split, the
// ticket validator, and the status vocabularies + templated sentences.
//
// ⚠ READ BY BOTH HALVES. The plugin's generate route validates with `checkClaudeReviewTicket`
// (400 on failure, never a silent truncation) and stores the split it returns; the SPA runs the
// SAME function to show the counter, the item count and the message before a request is sent.
// Shared is vendored into the release (build-release.mjs), so this is real runtime code on both
// sides — never retype a cap or the split rule as a literal anywhere else.
//
// The follow-up / criteria SENTENCES are TEMPLATED from server-validated statuses (a code-derived
// figure). Claude's own explanations are shown separately, as Claude's text — CLAUDE.md's rule
// that a model-derived and a code-derived figure are labelled apart.
import type {
  ClaudeFollowUpStatus,
  ClaudeReviewTicket,
  ClaudeReviewTicketInput,
  ClaudeTicketAlignment,
  ClaudeTicketAssessment,
  ClaudeTicketCriterionStatus,
} from './types.js';

// ---- caps ----

export const CLAUDE_REVIEW_TICKET_LIMITS = {
  titleChars: 300,
  descriptionChars: 8000,
  acceptanceCriteriaChars: 4000,
  acceptanceCriteriaItems: 30,
} as const;

// ---- the acceptance-criteria split ----

// A leading marker, each part REQUIRING whitespace (or the end of the line) after it, so `e.g.`
// and `1.5 s` are not markers:
//   1. a bullet (`-` `*` `+` `•` `‣` `◦` `▪` `–` `—`), a number (`1.` `2)` `(3)`), a Roman
//      numeral from i to xxxix in ONE case (`II.` `iv)` — a valid numeral only, so a word like
//      `mix.` is not one) or a single letter (`a)` `B.`);
//   2. then an optional task-list checkbox (`[ ]` `[x]`);
//   3. then an optional acceptance-criterion LABEL the person typed (`AC2:` `AC-3.` `AC 4)`
//      `**AC5:**`). ⚠ The label is STRIPPED on purpose: the server numbers criteria AC1..n by
//      position and the model reports by that ref, so a pasted `AC3:` left inside the text of the
//      criterion fenced as AC1 is a second, competing number — and a verdict can land on the wrong
//      row. The person's own text is kept verbatim in `acceptanceCriteria`.
const BULLET = String.raw`[-*+•‣◦▪–—]`;
const NUMBER = String.raw`\(?\d{1,3}[.)]`;
const ROMAN_UPPER = String.raw`(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})`;
const ROMAN_LOWER = String.raw`(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})`;
const LETTER_OR_ROMAN = String.raw`\(?(?:${ROMAN_UPPER}|${ROMAN_LOWER}|[A-Za-z])[.)]`;
const CHECKBOX = String.raw`\[[ xX]\]`;
const AC_LABEL = String.raw`\*{0,2}[Aa][Cc][-\s#]?\d{1,3}\*{0,2}\s*[:.)\-–—]\*{0,2}`;
const CRITERION_MARKER = new RegExp(
  String.raw`^\s*(?:(?:${BULLET}|${NUMBER}|${LETTER_OR_ROMAN})(?:\s+|$))?(?:${CHECKBOX}(?:\s+|$))?(?:${AC_LABEL}(?:\s+|$))?`,
);

// Section headings, which are never criteria: a Markdown heading, a wholly bold line, and (by
// position, see below) a plain line ending in a colon.
const MD_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const WHOLLY_EMPHASISED = /^\s*(\*\*|__)(?:(?!\1).)+\1\s*:?\s*$/;
const ENDS_WITH_COLON = /:\s*$/;

// Gherkin: `Scenario:` opens a scenario; `Given` opens one or continues a bare `Scenario:` header;
// `When` / `Then` / `And` / `But` continue a scenario. ONE scenario is ONE criterion.
const GHERKIN_HEADER = /^(?:Scenario(?: Outline)?|Background)\s*:/i;
const GHERKIN_GIVEN = /^Given\b/i;
const GHERKIN_STEP = /^(?:When|Then|And|But)\b/i;

type GherkinState = 'none' | 'header' | 'steps';

const gherkinStateOf = (text: string): GherkinState =>
  GHERKIN_HEADER.test(text) ? 'header' : GHERKIN_GIVEN.test(text) ? 'steps' : 'none';

/**
 * Split pasted acceptance criteria into items, deterministically:
 *   1. split on line breaks and drop blank lines;
 *   2. drop SECTION HEADINGS (Markdown `#` headings and wholly bold lines anywhere; a plain line
 *      ending in `:` when it comes before the first marker, or — once markers have started — when
 *      the next line is a marker or there is none; with no markers at all, only LEADING `:` lines).
 *      A text made of nothing but headings keeps them, so a one-line criterion is never lost;
 *   3. if ANY line starts with a bullet / number / Roman numeral / letter / checkbox / `AC1:`
 *      marker, each marker line starts an item (marker stripped), a plain line joins the previous
 *      item with one space, and a plain line before the first marker is its own item;
 *   4. otherwise every line is one item;
 *   5. in either mode, a Gherkin scenario is one item: a `When` / `Then` / `And` / `But` line
 *      joins a preceding `Given` or `Scenario:` item, and `Given` joins a bare `Scenario:` header.
 * Items are trimmed and empties dropped. null / blank ⇒ [].
 */
export function splitAcceptanceCriteria(text: string | null | undefined): string[] {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const parsed = lines.map((line) => {
    const m = CRITERION_MARKER.exec(line);
    const prefix = m ? m[0] : '';
    const isMarker = prefix.trim().length > 0;
    return { line, isMarker, rest: (isMarker ? line.slice(prefix.length) : line).trim() };
  });
  const anyMarker = parsed.some((p) => p.isMarker);
  const firstMarker = parsed.findIndex((p) => p.isMarker);

  const heading: boolean[] = [];
  let leading = true;
  parsed.forEach((p, i) => {
    let h = false;
    if (!p.isMarker) {
      if (MD_HEADING.test(p.line) || WHOLLY_EMPHASISED.test(p.line)) {
        h = true;
      } else if (ENDS_WITH_COLON.test(p.line)) {
        const next = parsed[i + 1];
        h = anyMarker ? i < firstMarker || next === undefined || next.isMarker : leading;
      }
    }
    if (!h) leading = false;
    heading.push(h);
  });
  const dropHeadings = heading.some((h) => !h);

  const items: string[] = [];
  const chain: GherkinState[] = [];
  const push = (t: string): void => {
    items.push(t);
    chain.push(gherkinStateOf(t));
  };
  const joinLast = (t: string, state?: GherkinState): void => {
    const last = items.length - 1;
    items[last] = `${items[last] ?? ''} ${t}`.trim();
    if (state) chain[last] = state;
  };
  let seenMarker = false;
  parsed.forEach((p, i) => {
    if (dropHeadings && heading[i]) return;
    if (p.isMarker) seenMarker = true;
    const t = p.rest;
    const lastState = chain[chain.length - 1];
    if (t && GHERKIN_STEP.test(t) && (lastState === 'header' || lastState === 'steps')) {
      joinLast(t, 'steps');
    } else if (t && GHERKIN_GIVEN.test(t) && lastState === 'header') {
      joinLast(t, 'steps');
    } else if (p.isMarker) {
      push(t);
    } else if (anyMarker && seenMarker && items.length > 0) {
      joinLast(t);
    } else {
      push(t);
    }
  });
  return items.filter((s) => s.length > 0);
}

// ---- the ticket validator ----

export type ClaudeReviewTicketField = 'title' | 'description' | 'acceptanceCriteria';

export type ClaudeReviewTicketCheck =
  | { ok: true; ticket: ClaudeReviewTicket | null }
  | { ok: false; field: ClaudeReviewTicketField; message: string };

const FIELD_LABEL: Record<ClaudeReviewTicketField, string> = {
  title: 'Title',
  description: 'Description',
  acceptanceCriteria: 'Acceptance criteria',
};

// C0 controls other than tab / newline / carriage return, plus DEL. Postgres jsonb cannot hold
// `\u0000`, and none of these belongs in a user story.
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// A lone surrogate half (in `u` mode a PAIRED surrogate is one code point and does not match).
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Normalise and validate the optional user story. Each field is trimmed; blank becomes null; all
 * blank ⇒ `ticket: null`. Over a cap ⇒ `ok:false` with the field and a plain message. It NEVER
 * truncates. The stored `criteria` is exactly `splitAcceptanceCriteria(acceptanceCriteria)`.
 */
export function checkClaudeReviewTicket(
  raw: ClaudeReviewTicketInput | null | undefined,
): ClaudeReviewTicketCheck {
  const L = CLAUDE_REVIEW_TICKET_LIMITS;
  const caps: Record<ClaudeReviewTicketField, number> = {
    title: L.titleChars,
    description: L.descriptionChars,
    acceptanceCriteria: L.acceptanceCriteriaChars,
  };
  const out: Record<ClaudeReviewTicketField, string | null> = {
    title: null,
    description: null,
    acceptanceCriteria: null,
  };
  for (const field of ['title', 'description', 'acceptanceCriteria'] as const) {
    const value = raw?.[field];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const label = FIELD_LABEL[field];
    if (CONTROL_CHAR.test(trimmed)) {
      return { ok: false, field, message: `${label} contains a control character that can't be stored.` };
    }
    if (LONE_SURROGATE.test(trimmed)) {
      return { ok: false, field, message: `${label} contains a broken character that can't be stored.` };
    }
    if (trimmed.length > caps[field]) {
      return {
        ok: false,
        field,
        message: `${label} is ${trimmed.length} characters; the limit is ${caps[field]}.`,
      };
    }
    out[field] = trimmed;
  }
  const criteria = splitAcceptanceCriteria(out.acceptanceCriteria);
  if (criteria.length > L.acceptanceCriteriaItems) {
    return {
      ok: false,
      field: 'acceptanceCriteria',
      message: `Acceptance criteria has ${criteria.length} items; the limit is ${L.acceptanceCriteriaItems}.`,
    };
  }
  if (out.title == null && out.description == null && out.acceptanceCriteria == null) {
    return { ok: true, ticket: null };
  }
  return {
    ok: true,
    ticket: {
      title: out.title,
      description: out.description,
      acceptanceCriteria: out.acceptanceCriteria,
      criteria,
    },
  };
}

// ---- vocabularies ----

export const FOLLOW_UP_STATUS_LABEL: Record<ClaudeFollowUpStatus, string> = {
  addressed: 'Addressed',
  partly_addressed: 'Partly addressed',
  not_addressed: 'Not addressed',
  no_longer_applies: 'No longer applies',
  not_checked: 'Not checked',
};

export const TICKET_CRITERION_STATUS_LABEL: Record<ClaudeTicketCriterionStatus, string> = {
  met: 'Met',
  partly_met: 'Partly met',
  not_met: 'Not met',
  unclear: "Can't tell from the code",
  not_checked: 'Not checked',
};

export const TICKET_ALIGNMENT_LABEL: Record<ClaudeTicketAlignment, string> = {
  aligned: 'Matches the user story',
  partly_aligned: 'Partly matches the user story',
  not_aligned: "Doesn't match the user story",
  unclear: "Can't tell",
  not_checked: 'Not checked',
};

// ---- templated sentences (code-derived figures) ----

export interface ClaudeFollowUpCounts {
  total: number;
  addressed: number;
  partly: number;
  notAddressed: number;
  noLongerApplies: number;
  notChecked: number;
}

export function followUpCounts(
  items: ReadonlyArray<{ status: ClaudeFollowUpStatus }>,
): ClaudeFollowUpCounts {
  const c: ClaudeFollowUpCounts = {
    total: items.length,
    addressed: 0,
    partly: 0,
    notAddressed: 0,
    noLongerApplies: 0,
    notChecked: 0,
  };
  for (const it of items) {
    if (it.status === 'addressed') c.addressed += 1;
    else if (it.status === 'partly_addressed') c.partly += 1;
    else if (it.status === 'not_addressed') c.notAddressed += 1;
    else if (it.status === 'no_longer_applies') c.noLongerApplies += 1;
    else c.notChecked += 1;
  }
  return c;
}

/**
 * "Last review's 5 comments: 3 addressed, 1 partly addressed, 1 not addressed." — "N addressed"
 * always appears (including "0 addressed"); the other parts only when non-zero. null for none.
 *
 * ⚠ A CARRIED item is not one of the last review's comments (it came from an older review), so
 * the subject names the two populations apart — "Last review's 3 comments and 2 older ones" —
 * rather than attributing all five to the last review while the rows below say otherwise.
 */
export function followUpSentence(
  fu:
    | { items: ReadonlyArray<{ status: ClaudeFollowUpStatus; carried?: boolean }> }
    | null
    | undefined,
): string | null {
  if (!fu || fu.items.length === 0) return null;
  const c = followUpCounts(fu.items);
  const parts = [`${c.addressed} addressed`];
  if (c.partly > 0) parts.push(`${c.partly} partly addressed`);
  if (c.notAddressed > 0) parts.push(`${c.notAddressed} not addressed`);
  if (c.noLongerApplies > 0) {
    parts.push(`${c.noLongerApplies} no longer ${c.noLongerApplies === 1 ? 'applies' : 'apply'}`);
  }
  if (c.notChecked > 0) parts.push(`${c.notChecked} not checked`);
  const older = fu.items.filter((it) => it.carried === true).length;
  const own = c.total - older;
  const noun = (n: number): string => (n === 1 ? 'comment' : 'comments');
  const subject =
    older === 0
      ? `Last review's ${own} ${noun(own)}`
      : own === 0
        ? `${older} older ${noun(older)}`
        : `Last review's ${own} ${noun(own)} and ${older} older ${older === 1 ? 'one' : 'ones'}`;
  return `${subject}: ${parts.join(', ')}.`;
}

/** "4 of 6 criteria met." / "1 of 1 criterion met." — null when there are no criteria. */
export function ticketCriteriaSentence(
  a: Pick<ClaudeTicketAssessment, 'criteria'> | null | undefined,
): string | null {
  if (!a || a.criteria.length === 0) return null;
  const met = a.criteria.filter((c) => c.status === 'met').length;
  const total = a.criteria.length;
  return `${met} of ${total} ${total === 1 ? 'criterion' : 'criteria'} met.`;
}
