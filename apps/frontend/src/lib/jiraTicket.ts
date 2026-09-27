import type {
  JiraFieldOption,
  JiraTicketDetails,
  TicketRef,
  WorkspaceJiraApiSettings,
} from '@pierre-review/shared';
import type { TicketDraft } from './claudeReviewFollowUp.js';

// Pure helpers for Jira API access: the Claude Review panel's "Fill from KEY" buttons and the
// Settings acceptance-criteria picker. Kept out of the components so they are testable.

/**
 * The detected tickets the panel may offer a "Fill from" button for: Jira tickets the server
 * marked `canFetchDetails` (Jira + a token saved for the PR's workspace). Nothing when the PR has
 * no detected ticket — the button never appears for a ticket Limn did not find, because the server
 * would refuse it anyway.
 */
export function fillableJiraTickets(tickets: readonly TicketRef[] | null | undefined): TicketRef[] {
  if (!tickets) return [];
  return tickets.filter((t) => t.provider === 'jira' && t.canFetchDetails === true);
}

/**
 * The draft after filling from a ticket. Title and description are REPLACED. Acceptance criteria
 * are replaced only when the workspace maps a criteria field — otherwise Jira was never asked for
 * them, and wiping what the reader pasted would lose it for nothing.
 */
export function applyJiraTicket(draft: TicketDraft, details: JiraTicketDetails): TicketDraft {
  return {
    title: details.title,
    description: details.description,
    acceptanceCriteria: details.acField != null ? details.acceptanceCriteria : draft.acceptanceCriteria,
  };
}

/** The one short line shown after a fill, or null when there is nothing to say. */
export function jiraFillNote(details: JiraTicketDetails): string | null {
  if (details.acField == null)
    return 'No acceptance criteria field is set for this workspace in Settings, so those were left as they were.';
  if (details.acceptanceCriteria.trim() === '')
    return `${details.key} has nothing in ${details.acField.name ?? details.acField.id}.`;
  return null;
}

/**
 * The picker's options: the loaded fields, plus the SAVED field when it is not among them (before
 * the list is loaded, or after the field was renamed/removed in Jira) so the select can still show
 * what is stored.
 */
export function acFieldOptions(
  saved: WorkspaceJiraApiSettings['acceptanceCriteriaField'],
  loaded: readonly JiraFieldOption[] | null,
): { id: string; label: string }[] {
  const out = (loaded ?? []).map((f) => ({ id: f.id, label: `${f.name} (${f.id})` }));
  if (saved != null && !out.some((o) => o.id === saved.id)) {
    out.unshift({ id: saved.id, label: saved.name != null ? `${saved.name} (${saved.id})` : saved.id });
  }
  return out;
}

/** The display name to store beside a chosen field id. */
export function acFieldName(
  id: string,
  saved: WorkspaceJiraApiSettings['acceptanceCriteriaField'],
  loaded: readonly JiraFieldOption[] | null,
): string | null {
  if (id === '') return null;
  const hit = loaded?.find((f) => f.id === id);
  if (hit) return hit.name;
  return saved?.id === id ? saved.name : null;
}
