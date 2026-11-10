import type { JiraAcCandidate, JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import { defaultAcCandidate } from '@pierre-review/shared';
import type { TicketDraft } from './claudeReviewFollowUp.js';

// Pure helpers for a story read from the tracker (TicketStory.tsx): its text, its provenance and
// the field its acceptance criteria come from. Kept out of the components so they are testable.
//
// ⚠ THE ACCEPTANCE-CRITERIA FIELD IS CHOSEN SERVER-SIDE, PER (workspace, Jira site, issue type).
// A Jira site can carry several fields named "Acceptance Criteria" and the one in use varies by
// issue type, so the server keeps every custom text field on the stored ticket
// (`details.candidates`) and names the one it picked (`details.acField`): the workspace's choice for
// the issue type when the ticket has it, else the strong name match (Settings → tracker).

/** A ticket whose criteria SOURCE is fixed by its tracker (GitHub Issues, Linear: sub-issues, a task
 *  list or an "Acceptance criteria" section), so there is no field to pick. */
export const hasFixedAcSource = (ref: Pick<TicketRef, 'provider'> | null | undefined): boolean =>
  ref?.provider === 'github' || ref?.provider === 'linear' || ref?.provider === 'notion';

/** The draft after a fill: title and description REPLACED; the criteria are left for the picker. */
export function applyJiraTicket(draft: TicketDraft, details: JiraTicketDetails): TicketDraft {
  return { ...draft, title: details.title, description: details.description };
}

/**
 * The provenance a tracker-read story carries: it renders read-only, as markdown (the tracker
 * converts Jira's markup), and the run stores where it came from.
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

// ── the field the SERVER picked ──────────────────────────────────────────────────────────────

/**
 * The field the criteria come from, as the server picked it ('' = none). An older plugin sends no
 * `acField`; then the shared default rule decides, exactly as the server would with no setting.
 */
export function serverAcField(details: JiraTicketDetails): string {
  if (details.acField !== undefined) return details.acField?.id ?? '';
  return defaultAcCandidate(details.candidates, null);
}

/** The Jira site a ticket link points at (host + port, lowercase), or null. */
export function jiraSiteOf(ticketUrl: string): string | null {
  try {
    return new URL(ticketUrl).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

// ── the default choice ─────────────────────────────────────────────────────────────────────────

// `defaultAcCandidate` lives in shared so the server picks the field by the SAME rule. Re-exported
// for this module's callers and tests.
export { defaultAcCandidate };
