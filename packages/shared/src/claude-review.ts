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
  ClaudeFindingSeverity,
  ClaudeFindingStory,
  ClaudeFollowUpStatus,
  ClaudeThreadAddressed,
  ClaudeThreadAssessmentCounts,
  ClaudeThreadValidity,
  ClaudeReviewTicket,
  ClaudeReviewTicketInput,
  ClaudeTicketAlignment,
  ClaudeTicketAssessment,
  ClaudeTicketCriterionStatus,
  JiraAcCandidate,
} from './types.js';

// ---- caps ----

export const CLAUDE_REVIEW_TICKET_LIMITS = {
  titleChars: 300,
  descriptionChars: 8000,
  acceptanceCriteriaChars: 8000,
} as const;

// The most criteria rows kept from one assessment (Claude's list is clipped past this).
export const CLAUDE_REVIEW_TICKET_MAX_CRITERIA = 40;

// The most user stories one review carries (each is assessed on its own).
export const CLAUDE_REVIEW_MAX_TICKETS = 5;

/** A tracker key as detection emits it (`PROJ-123`). */
export const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const TICKET_URL_MAX = 2000;

/** 'T1'… — the ref of the ticket at `index` (0-based), as Claude sees it. */
export const ticketRef = (index: number): string => `T${index + 1}`;

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
  const ticket: ClaudeReviewTicket = {
    title: out.title,
    description: out.description,
    acceptanceCriteria: out.acceptanceCriteria,
  };
  // Provenance: kept only for a Jira-read ticket, and only when well-formed (dropped otherwise —
  // it labels the text, it is never a reason to refuse it).
  if (raw?.source === 'jira') {
    ticket.source = 'jira';
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    ticket.key = TICKET_KEY_RE.test(key) ? key : null;
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    ticket.url = url.length <= TICKET_URL_MAX && /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
    const at = typeof raw.fetchedAt === 'string' ? Date.parse(raw.fetchedAt) : Number.NaN;
    ticket.fetchedAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
  } else if (raw?.source === 'manual') {
    ticket.source = 'manual';
  }
  return { ok: true, ticket };
}

export type ClaudeReviewTicketsCheck =
  | { ok: true; tickets: ClaudeReviewTicket[] }
  | { ok: false; index: number | null; field: ClaudeReviewTicketField | 'tickets'; message: string };

/**
 * Validate a review's user stories: each through `checkClaudeReviewTicket`, all-blank entries
 * dropped, at most CLAUDE_REVIEW_MAX_TICKETS left. `index` names the failing entry (null for the
 * count). It NEVER truncates.
 */
export function checkClaudeReviewTickets(
  raw: ReadonlyArray<ClaudeReviewTicketInput | null | undefined> | null | undefined,
): ClaudeReviewTicketsCheck {
  const tickets: ClaudeReviewTicket[] = [];
  const list = raw ?? [];
  for (let i = 0; i < list.length; i += 1) {
    const one = checkClaudeReviewTicket(list[i]);
    if (!one.ok) {
      // Named as every other surface names it: the Jira key, else "Story N" where N counts the
      // stories that will be STORED (blank entries are dropped below, so a raw position would
      // disagree with the panel's tabs and the run's results).
      const raw = list[i];
      const key = raw?.source === 'jira' && typeof raw.key === 'string' ? raw.key.trim() : '';
      const name = storyName({ key: TICKET_KEY_RE.test(key) ? key : null }, tickets.length);
      const message = list.length > 1 ? `${name}: ${one.message}` : one.message;
      return { ok: false, index: i, field: one.field, message };
    }
    if (one.ticket) tickets.push(one.ticket);
  }
  if (tickets.length > CLAUDE_REVIEW_MAX_TICKETS) {
    return {
      ok: false,
      index: null,
      field: 'tickets',
      message: `${tickets.length} tickets; the limit is ${CLAUDE_REVIEW_MAX_TICKETS}.`,
    };
  }
  return { ok: true, tickets };
}

/**
 * A stored `ticket` / `ticket_assessment` column → a list. Runs from before several tickets stored
 * ONE object; newer runs store an array. Anything else reads as none.
 */
export function storedList<T extends object>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x): x is T => x != null && typeof x === 'object');
  return typeof v === 'object' ? [v] : [];
}

// ---- the acceptance-criteria field to preselect ----

const EXACT_AC = /^\s*acceptance[\s_-]*criteria\s*$/i;

/**
 * The Jira field to take the acceptance criteria from, or '' for none. ONE rule for both halves:
 * the panel's "Fill from KEY" / the Open PRs click (which pass the viewer's remembered field) and
 * the server's auto review (which passes `null` — it cannot read a browser's memory).
 *   1. the remembered field for this issue type, when THIS ticket has it with text;
 *   2. else the best STRONG name match (an "acceptance criteria" name) — an exact "Acceptance
 *      Criteria" beats one that merely contains it, then the server's order. A WEAK match ("AC",
 *      "Definition of Done") is never preselected: a definition of done is not the ticket's
 *      acceptance criteria, and a wrong prefill is worse than a blank;
 *   3. else ''.
 * Every candidate has text by construction (the server drops empty fields).
 */
export function defaultAcCandidate(
  candidates: readonly JiraAcCandidate[],
  remembered: string | null,
): string {
  if (remembered != null && candidates.some((c) => c.id === remembered)) return remembered;
  const hits = candidates.filter((c) => c.match === 'strong');
  return (hits.find((c) => EXACT_AC.test(c.name)) ?? hits[0])?.id ?? '';
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

export const THREAD_VALIDITY_LABEL: Record<ClaudeThreadValidity, string> = {
  valid: 'Valid',
  partly_valid: 'Partly valid',
  not_valid: 'Not valid',
  unclear: "Can't tell",
  not_checked: 'Not checked',
};

export const THREAD_ADDRESSED_LABEL: Record<ClaudeThreadAddressed, string> = {
  addressed: 'Addressed',
  partly_addressed: 'Partly addressed',
  not_addressed: 'Not addressed',
  unclear: "Can't tell",
  not_checked: 'Not checked',
};

// ---- review threads (other reviewers' comments) ----

/**
 * THE ONE "still needs a fix" rule for a judged review thread: Claude found the comment right (or
 * partly right) and the code has not (or only partly) dealt with it. AI Fix's review seed, the
 * counts and the Open PRs column all read this — never retype it.
 */
export function isThreadToFix(t: { validity: ClaudeThreadValidity; addressed: ClaudeThreadAddressed }): boolean {
  return (
    (t.validity === 'valid' || t.validity === 'partly_valid') &&
    (t.addressed === 'not_addressed' || t.addressed === 'partly_addressed')
  );
}

/** Counts over a run's thread assessments (code-derived). */
export function threadAssessmentCounts(
  items: ReadonlyArray<{ validity: ClaudeThreadValidity; addressed: ClaudeThreadAddressed }>,
): ClaudeThreadAssessmentCounts {
  const c: ClaudeThreadAssessmentCounts = {
    total: items.length,
    assessed: 0,
    validUnaddressed: 0,
    notValid: 0,
    addressed: 0,
    notChecked: 0,
  };
  for (const it of items) {
    const judged = it.validity !== 'not_checked' || it.addressed !== 'not_checked';
    if (judged) c.assessed += 1;
    else c.notChecked += 1;
    if (isThreadToFix(it)) c.validUnaddressed += 1;
    if (it.validity === 'not_valid') c.notValid += 1;
    if (it.addressed === 'addressed') c.addressed += 1;
  }
  return c;
}

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

// ---- story findings ----
// Every unmet / partly met acceptance criterion and every "Not done" item of a run's user-story
// assessment becomes a FINDING of that run, made by the SERVER (review/claude-review/ticket.ts
// `storyFindingsFrom`) — so a story reaches GitHub exactly the way every other finding does
// (Post, Reword, Ignore, Submit review). "Not asked for" never becomes a finding: adding something
// is not a defect. The severity is fixed here, ONCE:
//   not met  → 'warning'  (should be fixed before it lands)
//   not done → 'warning'
//   partly met → 'nit'    (the closest member to "worth finishing, not blocking")
// 'blocker' is never used: whether a missing piece blocks the change is the reader's call.
export const STORY_CRITERION_SEVERITY: Record<'not_met' | 'partly_met', ClaudeFindingSeverity> = {
  not_met: 'warning',
  partly_met: 'nit',
};
export const STORY_MISSING_SEVERITY: ClaudeFindingSeverity = 'warning';

/** The ref of the not-done item at `index` (0-based) in an assessment's `missing` list: 'M1'…. */
export const storyMissingRef = (index: number): string => `M${index + 1}`;

/** A story's plain-text name: its tracker key, else "Story N" (1-based). */
export function storyName(ticket: Pick<ClaudeReviewTicket, 'key'>, index: number): string {
  return ticket.key != null && ticket.key !== '' ? ticket.key : `Story ${index + 1}`;
}

// The story's own words go into a GitHub comment: one line, and no @-mention ping (a Jira
// criterion can name people).
export const storyOneLine = (s: string): string =>
  s.replace(/\s+/g, ' ').replace(/@(?=[A-Za-z0-9])/g, '@\u200b').trim();

/**
 * The FIRST LINE of a story finding's GitHub comment — "BMD-1040 · AC2 (partly met): <criterion>"
 * or "Story 1 · Not done: <title>". ⚠ It is NOT stored in the finding's body: on screen the card
 * already sits under its story with the criterion as its title, so the line only ever repeated the
 * title. It is added when the comment is built (post-review.ts `findingCommentBody` /
 * `prLevelFindingBody`, via the routes), so GitHub — where the card's context is absent — still
 * names the story. `entries` is the run's ticket list; a story or criterion no longer found falls
 * back to the finding's own title and ref, never to nothing.
 */
export function storyCommentLead(
  f: { title: string; story: ClaudeFindingStory },
  entries: ReadonlyArray<{ index: number; ticket: Pick<ClaudeReviewTicket, 'key'>; assessment: Pick<ClaudeTicketAssessment, 'criteria'> | null }>,
): string {
  const entry = entries.find((e) => e.index === f.story.index);
  const name = entry ? storyName(entry.ticket, f.story.index) : `Story ${f.story.index + 1}`;
  if (/^M\d+$/.test(f.story.ref)) return `${name} · Not done: ${storyOneLine(f.title)}`;
  const c = entry?.assessment?.criteria.find((x) => x.ref === f.story.ref);
  if (c && (c.status === 'not_met' || c.status === 'partly_met')) {
    return `${name} · ${c.ref} (${TICKET_CRITERION_STATUS_LABEL[c.status].toLowerCase()}): ${storyOneLine(c.text)}`;
  }
  return `${name} · ${f.story.ref}: ${storyOneLine(f.title)}`;
}

// A story finding's body as stored before the lead moved out of it began with that lead line.
const STORED_STORY_LEAD_RE = /^[^\n]* · (?:Not done|[A-Za-z0-9]+ \((?:not met|partly met)\)): [^\n]*(?:\n\n|\n|$)/;

/**
 * A story finding's body WITHOUT the story lead an older row stored at its start (rows written
 * before the lead moved to post time). Anything else is returned unchanged — an ordinary finding,
 * a story finding stored since, or a reworded body.
 */
export function stripStoredStoryLead(body: string, story: ClaudeFindingStory | null | undefined): string {
  if (!story) return body;
  return body.replace(STORED_STORY_LEAD_RE, '');
}
