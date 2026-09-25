// Claude Review: the ONE spelling of the user-story caps, the ticket validator, and the status
// vocabularies + templated sentences.
//
// ⚠ READ BY BOTH HALVES. The plugin's generate route validates with `checkClaudeReviewTicket`
// (400 on failure, never a silent truncation); the SPA runs the SAME function to show the counter
// and the message before a request is sent. Shared is vendored into the release
// (build-release.mjs), so this is real runtime code on both sides — never retype a cap anywhere
// else.
//
// ⚠ THERE IS NO CODE-SIDE ACCEPTANCE-CRITERIA SPLIT. An earlier cut split the text by line /
// bullet / Gherkin rules and made Claude answer per server-numbered item; real tickets come in far
// more shapes than any rule set (nested sub-bullets, tables, "Given/When/Then" blocks, prose with
// numbered clauses), and every mis-split became a wrong row on screen. Claude now reads the whole
// text and enumerates the criteria itself, best effort; the server only renumbers and sanitises.
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
  acceptanceCriteriaChars: 8000,
} as const;

// The most criteria rows kept from one assessment (Claude's list is clipped past this).
export const CLAUDE_REVIEW_TICKET_MAX_CRITERIA = 40;

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
 * truncates.
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
  if (out.title == null && out.description == null && out.acceptanceCriteria == null) {
    return { ok: true, ticket: null };
  }
  return {
    ok: true,
    ticket: {
      title: out.title,
      description: out.description,
      acceptanceCriteria: out.acceptanceCriteria,
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
