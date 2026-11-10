// A story read from the tracker, as the story views draw it (TicketStory.tsx, JiraStoryView): the
// story built from a stored ticket, the acceptance-criteria field the server picked, and whether the
// criteria open with their own heading. No JSX, so it is unit-tested from `test/storyText.test.ts`.
// (The Story check's typed-story tabs that this file used to drive were removed.)
import type { JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import { EMPTY_TICKET_DRAFT, type TicketDraft } from './claudeReviewFollowUp.js';
import { applyAcCandidate, applyJiraTicket, jiraProvenance, serverAcField } from './jiraTicket.js';

// ---- the acceptance-criteria field ----

/**
 * A story from a fetched ticket: title and description, the criteria from field `chosenId` ('' =
 * none, criteria left empty), the field it came from and the issue type, plus Jira provenance.
 */
export function jiraStoryFromDetails(
  ref: Pick<TicketRef, 'key' | 'url'>,
  details: JiraTicketDetails,
  chosenId: string,
  now: Date = new Date(),
): TicketDraft {
  const filled = applyAcCandidate(applyJiraTicket(EMPTY_TICKET_DRAFT, details), details.candidates, chosenId);
  const c = chosenId === '' ? undefined : details.candidates.find((x) => x.id === chosenId);
  return {
    ...filled,
    ...jiraProvenance(ref, now),
    acField: c != null ? { id: c.id, name: c.name } : null,
    issueTypeId: details.issueType?.id ?? null,
  };
}

/**
 * The field a pull uses: the one the SERVER picked for the stored ticket (the workspace's choice for
 * its issue type, else the name match). The panel no longer decides this itself.
 */
export const pulledAcField = (details: JiraTicketDetails): string => serverAcField(details);

/** The "Criteria from" value of a story read from the tracker. */
export function acFieldText(d: Pick<TicketDraft, 'acField'>): string {
  if (d.acField === undefined) return 'not recorded';
  if (d.acField === null) return 'none';
  return d.acField.name;
}

/**
 * Whether a story's criteria markdown OPENS with its own "Acceptance criteria" heading (Jira fields
 * often do: `h1. *ACCEPTANCE CRITERIA*`), so the label is not printed above it twice.
 */
export function criteriaHasOwnHeading(md: string): boolean {
  const first = md.trimStart().split('\n', 1)[0] ?? '';
  const m = first.match(/^#{1,6}\s+(.*)$/);
  if (m == null) return false;
  const text = m[1]!.replace(/[*_`:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return text === 'acceptance criteria';
}
