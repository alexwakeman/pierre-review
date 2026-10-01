import type { JiraAcCandidate, JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import { defaultAcCandidate } from '@pierre-review/shared';
import type { TicketDraft } from './claudeReviewFollowUp.js';

// Pure helpers for the Claude Review panel's "Fill from KEY" and its "Acceptance criteria from"
// dropdown. Kept out of the component so they are testable.
//
// ⚠ THE ACCEPTANCE-CRITERIA FIELD IS CHOSEN PER TICKET, HERE — not in Settings. A Jira site can
// carry several fields named "Acceptance Criteria" and the one in use varies by issue type, so the
// server returns every custom text field on the ticket (`details.candidates`, strong name matches
// first) and the reader picks. The choice is remembered PER VIEWER, per Jira site + issue type, in
// localStorage — a convenience only, so every read and write is wrapped and a missing store simply
// means "nothing remembered".

/**
 * The detected tickets the panel may offer a "Fill from" button for: Jira tickets the server
 * marked `canFetchDetails` (Jira + a token saved for the PR's workspace). Nothing when the PR has
 * no detected ticket — the button never appears for a ticket Limn did not find.
 */
export function fillableJiraTickets(tickets: readonly TicketRef[] | null | undefined): TicketRef[] {
  if (!tickets) return [];
  return tickets.filter((t) => t.provider === 'jira' && t.canFetchDetails === true);
}

/**
 * Jira tickets detected on the PR that CANNOT be filled — the PR's own workspace (the one that
 * owns its repo, not the workspace being viewed) has no Jira token. The panel names that
 * workspace instead of silently showing no button.
 */
export function unfillableJiraTickets(tickets: readonly TicketRef[] | null | undefined): TicketRef[] {
  if (!tickets) return [];
  return tickets.filter((t) => t.provider === 'jira' && t.canFetchDetails !== true);
}

/** The draft after a fill: title and description REPLACED; the criteria are left for the picker. */
export function applyJiraTicket(draft: TicketDraft, details: JiraTicketDetails): TicketDraft {
  return { ...draft, title: details.title, description: details.description };
}

/** The draft after choosing a candidate. '' (the blank option) leaves the box as it is. */
export function applyAcCandidate(
  draft: TicketDraft,
  candidates: readonly JiraAcCandidate[],
  id: string,
): TicketDraft {
  if (id === '') return draft;
  const c = candidates.find((x) => x.id === id);
  return c ? { ...draft, acceptanceCriteria: c.text } : draft;
}

// ── the remembered choice (per viewer, per Jira site + issue type) ─────────────────────────────

export type AcMemoryStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, or null where it is unavailable (private window, blocked site data, previews). */
export function browserAcMemory(): AcMemoryStore | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The Jira site a ticket link points at (host + port, lowercase), or null. */
export function jiraSiteOf(ticketUrl: string): string | null {
  try {
    return new URL(ticketUrl).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

const memoryKey = (site: string, issueTypeId: string): string =>
  `limn:jira-ac-field:v1:${site}:${issueTypeId}`;

export function readRememberedAcField(
  store: AcMemoryStore | null,
  site: string | null,
  issueTypeId: string | null | undefined,
): string | null {
  if (store == null || site == null || issueTypeId == null) return null;
  try {
    const v = store.getItem(memoryKey(site, issueTypeId));
    return v != null && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/** Remember an EXPLICIT choice; the blank option forgets, so the name match decides next time. */
export function rememberAcField(
  store: AcMemoryStore | null,
  site: string | null,
  issueTypeId: string | null | undefined,
  fieldId: string,
): void {
  if (store == null || site == null || issueTypeId == null) return;
  try {
    if (fieldId === '') store.removeItem(memoryKey(site, issueTypeId));
    else store.setItem(memoryKey(site, issueTypeId), fieldId);
  } catch {
    /* a convenience: a full or blocked store just means nothing is remembered */
  }
}

// ── the default choice ─────────────────────────────────────────────────────────────────────────

// `defaultAcCandidate` lives in shared so the server's auto review picks the field by the SAME
// rule (with no remembered field). Re-exported for this module's callers and tests.
export { defaultAcCandidate };

/**
 * A whole fill, the ONE way both callers do it — the panel's "Fill from KEY" (over the reader's
 * current draft) and the Open PRs table's click-to-review (over an empty one): title and
 * description replaced, then the criteria from the preselected field (`defaultAcCandidate`), or
 * left as they were when nothing is preselected. `chosen` is that field's id, '' for none.
 */
export function fillDraftFromJira(
  draft: TicketDraft,
  details: JiraTicketDetails,
  remembered: string | null,
): { draft: TicketDraft; chosen: string } {
  const chosen = defaultAcCandidate(details.candidates, remembered);
  return { draft: applyAcCandidate(applyJiraTicket(draft, details), details.candidates, chosen), chosen };
}

const PREVIEW_CHARS = 60;

/** The dropdown's option text: "Name (customfield_123) — first words of the value…". */
// ⚠ A CHARACTER, NOT AN Icons.tsx COMPONENT: an <option>'s content is plain text and cannot hold
// an SVG (CLAUDE.md's listed exception for strings that cannot hold one).
export const AC_MATCH_STAR = '★';

/**
 * The dropdown's option text: "★ Name (customfield_123) — first words of the value…". The star
 * marks a STRONG match (an "acceptance criteria" name) — the same fields the default may pick.
 */
export function acCandidateLabel(c: JiraAcCandidate): string {
  const flat = c.text.replace(/\s+/g, ' ').trim();
  const preview = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat;
  const star = c.match === 'strong' ? `${AC_MATCH_STAR} ` : '';
  return `${star}${c.name} (${c.id}) — ${preview}`;
}

/** The one short line under the dropdown, or null. */
export function jiraFillNote(details: JiraTicketDetails, chosenId: string): string | null {
  if (details.candidates.length === 0)
    return `${details.key} has no other fields with text, so the acceptance criteria were left as they were.`;
  if (chosenId === '') return 'Pick the field that holds the acceptance criteria. The box is unchanged until you do.';
  return null;
}
