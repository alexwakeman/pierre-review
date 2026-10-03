import type { JiraAcCandidate, JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import { defaultAcCandidate } from '@pierre-review/shared';
import type { TicketDraft } from './claudeReviewFollowUp.js';

// Pure helpers for the Claude Review panel's "Fill from KEY" and its "Acceptance criteria from"
// dropdown. Kept out of the component so they are testable.
//
// ⚠ THE ACCEPTANCE-CRITERIA FIELD IS CHOSEN SERVER-SIDE, PER (workspace, Jira site, issue type).
// A Jira site can carry several fields named "Acceptance Criteria" and the one in use varies by
// issue type, so the server keeps every custom text field on the stored ticket
// (`details.candidates`) and names the one it picked (`details.acField`): the workspace's choice for
// the issue type when the ticket has it, else the strong name match. The panel's "Change" writes
// that choice (`PUT …/jira-ticket/ac-field`), so the background worker and the auto review use it
// too. It used to live in this browser's localStorage; `legacyAcFieldToMigrate` moves an old choice
// to the server ONCE and forgets it.

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

/**
 * The provenance a Jira-read story carries: the panel renders it read-only, as markdown (the
 * plugin converts Jira's markup), and the run stores where it came from.
 */
export function jiraProvenance(
  ref: Pick<TicketRef, 'key' | 'url'>,
  now: Date = new Date(),
): Pick<TicketDraft, 'source' | 'key' | 'url' | 'fetchedAt'> {
  return { source: 'jira', key: ref.key, url: ref.url, fetchedAt: now.toISOString() };
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

// ── the field the SERVER picked, and the one-shot move off localStorage ──────────────────────

/**
 * The field the criteria come from, as the server picked it ('' = none). An older plugin sends no
 * `acField`; then the shared default rule decides, exactly as the server would with no setting.
 */
export function serverAcField(details: JiraTicketDetails): string {
  if (details.acField !== undefined) return details.acField?.id ?? '';
  return defaultAcCandidate(details.candidates, null);
}

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

// The RETIRED per-browser key. Read only by the migration below, which deletes it.
const legacyKey = (site: string, issueTypeId: string): string =>
  `limn:jira-ac-field:v1:${site}:${issueTypeId}`;

/**
 * ONE-SHOT MIGRATION of the old per-browser choice: the field to send to the server for this
 * ticket's issue type, or null. The legacy key is REMOVED whenever it is read, so this answers at
 * most once per (site, issue type). Only when the server has no choice of its own
 * (`acFieldSource !== 'setting'`) and the old field is on this ticket and differs from the server's.
 */
export function legacyAcFieldToMigrate(
  store: AcMemoryStore | null,
  ticketUrl: string,
  details: JiraTicketDetails,
): string | null {
  const site = jiraSiteOf(ticketUrl);
  const type = details.issueType?.id;
  if (store == null || site == null || type == null) return null;
  let v: string | null = null;
  try {
    v = store.getItem(legacyKey(site, type));
    if (v != null) store.removeItem(legacyKey(site, type));
  } catch {
    return null;
  }
  if (v == null || v === '' || details.acFieldSource === 'setting') return null;
  if (!details.candidates.some((c) => c.id === v)) return null;
  return v === serverAcField(details) ? null : v;
}

// ── the default choice ─────────────────────────────────────────────────────────────────────────

// `defaultAcCandidate` lives in shared so the server picks the field by the SAME rule. Re-exported
// for this module's callers and tests.
export { defaultAcCandidate };

/**
 * A whole fill, the ONE way both callers do it — the panel and the Open PRs table's
 * click-to-review (over an empty draft): title and description replaced, then the criteria from
 * the field the server picked, or left as they were when it picked none. `chosen` is that field's
 * id, '' for none.
 */
export function fillDraftFromJira(
  draft: TicketDraft,
  details: JiraTicketDetails,
): { draft: TicketDraft; chosen: string } {
  const chosen = serverAcField(details);
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
  if (details.candidates.length === 0) return `${details.key} has no other fields with text.`;
  if (chosenId === '') return 'Pick the field that holds the acceptance criteria.';
  return null;
}
