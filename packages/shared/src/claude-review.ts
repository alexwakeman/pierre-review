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

/** A tracker key as detection emits it: Jira/Linear `PROJ-123`, or a GitHub issue `owner/repo#12`
 *  (lower-cased — see `githubIssueKey`). */
export const TICKET_KEY_RE =
  /^(?:[A-Z][A-Z0-9_]{0,19}-\d{1,9}|[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}#\d{1,9})$/;
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

// ---- ticket review idents ----
// A ticket review is keyed by an IDENT (types.ts § Ticket review). The manual form's hash is
// computed on the server (it needs sha256); the SPA only ever echoes idents it was given.

// THE TICKET IDENT — `<provider>:<root>#<KEY>`, one string per ticket whoever names it (docs/TRACKERS.md
// § Identity). `root` is the provider's CANONICAL site root (Jira: `jiraApiRoot` below), so the same
// site and key are the same ticket across workspaces, repos and callers. Jira idents are unchanged
// from before the tracker seam (`jira:<apiRoot>#<KEY>`), so every stored ticket review keeps its key.
//
// ⚠ ONE KEY SHAPE PER PROVIDER, AND A PROVIDER WITH NO SHAPE DOES NOT PARSE (a request body cannot
// smuggle an ident in for a provider no adapter reads). Jira, GitHub Issues and Linear all read now.
const TICKET_KEY_SHAPE: Record<'jira' | 'github' | 'linear', RegExp | null> = {
  jira: /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/,
  // A GitHub ident's key is the issue NUMBER; its root names the repository (below).
  github: /^\d{1,9}$/,
  // A Linear key is the team key and the issue number, upper-cased: `ENG-123`.
  linear: /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/,
};
// A GitHub ident's root: `https://github.com/<owner>/<repo>`, lower-cased.
const GITHUB_IDENT_ROOT_RE = /^https:\/\/github\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
// A Linear ident's root: `https://linear.app/<workspace url key>`, lower-cased (`linearSiteRoot`).
const LINEAR_IDENT_ROOT_RE = /^https:\/\/linear\.app\/[a-z0-9][a-z0-9_-]{0,63}$/;
const TRACKER_IDENT_RE = /^(jira|github|linear):(.+)#([^#]+)$/;
const MANUAL_IDENT_RE = /^manual:(\d{1,12}):([0-9a-f]{8})$/;
// An ident is bounded so a request body can never carry an unbounded key.
export const TICKET_IDENT_MAX_CHARS = 600;

/**
 * ⚠ THE ONE DERIVATION OF A JIRA API ROOT — core's tracker runs it on the workspace's tracker base
 * URL (what it stores as `api_root` and builds every ident on), the SPA on a ticket's browse link
 * (`<base>/browse/<KEY>`), so both land on the same root. Scheme + host + port + the context path,
 * with everything from a `browse` / `rest` / `secure` segment onwards, the query, the hash and
 * trailing slashes removed. null for anything that is not an absolute http(s) URL. It lives here,
 * not in either caller, because a second copy that drifts by one character splits one ticket into
 * two idents. (The Jira adapter's `siteRoot` IS this function.)
 */
// `shared` compiles with no DOM or Node lib, so the WHATWG `URL` both runtimes provide is declared
// here, module-scoped, with only the members this fold reads.
declare const URL: new (input: string) => { protocol: string; host: string; pathname: string };

export function jiraApiRoot(baseUrl: string | null | undefined): string | null {
  if (baseUrl == null) return null;
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const segments = url.pathname.split('/').filter((s: string) => s !== '');
  const cut = segments.findIndex((s: string) => /^(browse|rest|secure)$/i.test(s));
  const kept = cut === -1 ? segments : segments.slice(0, cut);
  const path = kept.length > 0 ? `/${kept.join('/')}` : '';
  return `${url.protocol}//${url.host}${path}`;
}

/** `<provider>:<root>#<KEY>` — THE ident builder. `root` must already be the canonical root. */
export const ticketIdent = (provider: 'jira' | 'github' | 'linear', root: string, key: string): string =>
  `${provider}:${root}#${key}`;

/** 'jira:<apiRoot>#<KEY>' — the same Jira site and key are the same ticket across workspaces. */
export const jiraTicketIdent = (apiRoot: string, key: string): string => ticketIdent('jira', apiRoot, key);

/** A tracker ticket's parsed ident. `apiRoot` is `root` under its historical (Jira) name. */
export interface ParsedTrackerIdent {
  kind: 'jira' | 'github' | 'linear';
  provider: 'jira' | 'github' | 'linear';
  root: string;
  apiRoot: string;
  key: string;
}

export type ParsedTicketIdent = ParsedTrackerIdent | { kind: 'manual'; prId: number; hash: string };

/** A ticket that lives in a TRACKER (members from the stored tickets), as opposed to a pasted story. */
export function isTrackerIdent(p: ParsedTicketIdent | null | undefined): p is ParsedTrackerIdent {
  return p != null && p.kind !== 'manual';
}

/** null for anything that is not a well-formed ident. */
export function parseTicketIdent(ident: string): ParsedTicketIdent | null {
  if (typeof ident !== 'string' || ident.length === 0 || ident.length > TICKET_IDENT_MAX_CHARS) return null;
  const t = TRACKER_IDENT_RE.exec(ident);
  if (t) {
    const provider = t[1] as ParsedTrackerIdent['provider'];
    const shape = TICKET_KEY_SHAPE[provider];
    const key = t[3]!;
    if (shape == null || !shape.test(key)) return null;
    if (provider === 'github' && !GITHUB_IDENT_ROOT_RE.test(t[2]!)) return null;
    if (provider === 'linear' && !LINEAR_IDENT_ROOT_RE.test(t[2]!)) return null;
    return { kind: provider, provider, root: t[2]!, apiRoot: t[2]!, key };
  }
  const m = MANUAL_IDENT_RE.exec(ident);
  if (m) return { kind: 'manual', prId: Number(m[1]), hash: m[2]! };
  return null;
}

// ---- GitHub Issues keys (docs/TRACKERS.md § GitHub Issues) ----
//
// A GitHub issue is named by its repository AND its number, and one pull request may close issues
// in several repositories, so the KEY a PR's ticket is stored and shown under is `owner/repo#12`
// (lower-cased: GitHub names are case-insensitive, and the same issue must be one key whoever
// wrote it). Every GitHub row is stored on ONE site, `GITHUB_TRACKER_ROOT`, so every "same site"
// comparison the tracker makes holds unchanged.
//
// The IDENT names the repository in its ROOT and the number as its key —
// `github:https://github.com/owner/repo#12`. `trackerTicketIdent` / `trackerTicketRow` are the two
// directions between a stored row (provider, api_root, issue_key) and that ident, and they are the
// ONLY place the two spellings meet: for Jira and Linear both are the identity.

/** The site every GitHub Issues row is stored on (`tracker_tickets.api_root`). */
export const GITHUB_TRACKER_ROOT = 'https://github.com';

const GITHUB_ISSUE_KEY_RE = /^([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})#(\d{1,9})$/;

/** `owner/repo#12` from GitHub's `nameWithOwner` and an issue number; null if malformed. */
export function githubIssueKey(nameWithOwner: string, issueNumber: number): string | null {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const key = `${nameWithOwner.trim().toLowerCase()}#${issueNumber}`;
  return GITHUB_ISSUE_KEY_RE.test(key) ? key : null;
}

// ---- Linear (docs/TRACKERS.md § Linear) ----
//
// A Linear ticket lives in ONE Linear workspace (Linear calls it an organisation) and is named by
// its team key and number, `ENG-123`. Its site ROOT is `https://linear.app/<urlKey>` — the
// organisation's URL key, lower-cased, exactly the prefix of every issue URL Linear gives out
// (`https://linear.app/acme/issue/ENG-123/some-slug`). The API host is fixed and never part of it.

/** The host every Linear workspace URL lives on. */
export const LINEAR_APP_ORIGIN = 'https://linear.app';

/**
 * ⚠ THE ONE DERIVATION OF A LINEAR ROOT — from the workspace URL typed in Settings, from an issue
 * URL Linear returned, or from a chip's browse link: `https://linear.app/<urlKey>`, lower-cased.
 * null for anything that is not a linear.app URL with a workspace segment.
 */
export function linearSiteRoot(url: string | null | undefined): string | null {
  if (url == null) return null;
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (host !== 'linear.app' && host !== 'www.linear.app') return null;
  const first = (u.pathname.split('/').find((s: string) => s !== '') ?? '').toLowerCase();
  const root = `${LINEAR_APP_ORIGIN}/${first}`;
  return LINEAR_IDENT_ROOT_RE.test(root) ? root : null;
}

/** The parts of a GitHub issue key (case-insensitive input), or null. */
export function parseGithubIssueKey(key: string): { owner: string; repo: string; number: number } | null {
  const m = GITHUB_ISSUE_KEY_RE.exec(key.trim().toLowerCase());
  if (m == null) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** True for a GitHub issue key (`owner/repo#12`, any case). */
export const isGithubIssueKey = (key: string): boolean => parseGithubIssueKey(key) != null;

/**
 * A key as every surface compares it: a Jira/Linear key UPPER-cased, a GitHub key lower-cased; null
 * for anything that is neither. The server runs it on every key a request carries.
 */
export function canonicalTicketKey(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const gh = parseGithubIssueKey(s);
  if (gh != null) return `${gh.owner}/${gh.repo}#${gh.number}`;
  const up = s.toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(up) ? up : null;
}

/** The ident of a stored ticket row. ⚠ The ONE way a row becomes an ident. */
export function trackerTicketIdent(provider: 'jira' | 'github' | 'linear', apiRoot: string, issueKey: string): string {
  if (provider === 'github') {
    const gh = parseGithubIssueKey(issueKey);
    if (gh != null) return ticketIdent('github', `${GITHUB_TRACKER_ROOT}/${gh.owner}/${gh.repo}`, String(gh.number));
  }
  return ticketIdent(provider, apiRoot, issueKey);
}

/** The stored row identity of a parsed tracker ident — the inverse of `trackerTicketIdent`. */
export function trackerTicketRow(parsed: ParsedTrackerIdent): {
  provider: 'jira' | 'github' | 'linear';
  apiRoot: string;
  issueKey: string;
} {
  if (parsed.provider === 'github') {
    const repoPath = parsed.root.slice(GITHUB_TRACKER_ROOT.length + 1);
    return { provider: 'github', apiRoot: GITHUB_TRACKER_ROOT, issueKey: `${repoPath}#${parsed.key}` };
  }
  return { provider: parsed.provider, apiRoot: parsed.root, issueKey: parsed.key };
}

/**
 * A detected ticket link's ident, from what a PR's chip carries (key, browse URL, provider) — the
 * SPA's half of the same rule. Jira folds the browse link onto its API root (`jiraApiRoot`); GitHub
 * needs only the key; Linear folds the link onto its workspace root (`linearSiteRoot`). null for an
 * unusable link.
 */
export function ticketIdentForLink(link: { key: string; url: string | null; provider?: string | null }): string | null {
  const provider = link.provider ?? 'jira';
  let ident: string | null = null;
  if (provider === 'github') {
    const key = canonicalTicketKey(link.key);
    if (key != null && isGithubIssueKey(key)) ident = trackerTicketIdent('github', GITHUB_TRACKER_ROOT, key);
  } else if (provider === 'jira') {
    const key = link.key.trim().toUpperCase();
    const root = jiraApiRoot(link.url);
    if (key !== '' && root != null) ident = jiraTicketIdent(root, key);
  } else if (provider === 'linear') {
    const key = link.key.trim().toUpperCase();
    const root = linearSiteRoot(link.url);
    if (key !== '' && root != null) ident = ticketIdent('linear', root, key);
  }
  return ident != null && parseTicketIdent(ident) != null ? ident : null;
}

/** Providers whose tickets Limn READS (title, story, criteria) — every provider since Linear's reader
 *  (phase 3). Whether THIS workspace can read is `TicketRef.canFetchDetails` (a token saved). */
export const isReadingTrackerProvider = (p: string | null | undefined): boolean =>
  p === 'jira' || p === 'github' || p === 'linear';

/** The product's own name for a provider, for "Open in …" copy. */
export const TRACKER_PROVIDER_LABEL: Record<'jira' | 'github' | 'linear', string> = {
  jira: 'Jira',
  github: 'GitHub',
  linear: 'Linear',
};
