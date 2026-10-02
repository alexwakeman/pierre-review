import type {
  ClaudeReviewPrState,
  ClaudeReviewTicket,
  ClaudeReviewTicketInput,
  ClaudeReviewVerdict,
  JiraTicketDetails,
  TicketRef,
} from '@pierre-review/shared';
import {
  EMPTY_TICKET_DRAFT,
  checkTicketDraft,
  ticketDraftFromStored,
  ticketDraftHasContent,
  ticketRequestFromCheck,
} from './claudeReviewFollowUp.js';
import {
  fillDraftFromJira,
  jiraProvenance,
  fillableJiraTickets,
  jiraSiteOf,
  readRememberedAcField,
  type AcMemoryStore,
} from './jiraTicket.js';

// Pure helpers for the Open PRs table's "Claude review" column (OpenPrsTable → ClaudeReviewCell).
// The column reads ONE batched `POST /api/claude-review/states` answer and starts runs through the
// SAME `POST /api/prs/:id/claude-review` the Claude Review tab uses — no picker, the defaults.

// The same words the Claude Review tab's verdict badge uses.
export const CLAUDE_VERDICT_LABEL: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

// `auto: true` = the workspace's auto review started that run; the cell adds an "Auto review"
// marker. A queued or running auto run HOLDS the PR: the start route answers 409
// AutoReviewInProgress, so those cells offer no button.
export type ReviewCell =
  | { kind: 'start' } // never reviewed, or the last run failed / was cancelled
  | { kind: 'starting' } // this click's request is in flight
  | { kind: 'queued'; auto?: true }
  | { kind: 'running'; auto?: true }
  | {
      kind: 'done';
      reviewId: number | null;
      verdictLabel: string;
      headMoved: boolean;
      auto?: true;
    };

/**
 * What one row's cell shows. `starting` (the start mutation for this PR is in flight, from this
 * table OR the PR's own Claude Review tab — they share a mutation key) wins over the stored state,
 * so the button disables the moment it is pressed.
 */
export function reviewCellFor(
  state: ClaudeReviewPrState | undefined,
  starting: boolean,
): ReviewCell {
  if (state == null) return starting ? { kind: 'starting' } : { kind: 'start' };
  const auto = state.trigger === 'auto' ? ({ auto: true } as const) : {};
  // ⚠ An auto review in flight wins even over a start in flight: that start is the one the
  // server is about to refuse, so the cell must not flicker back to a button in between.
  if (auto.auto && (state.status === 'queued' || state.status === 'running')) {
    return { kind: state.status, ...auto };
  }
  if (starting) return { kind: 'starting' };
  switch (state.status) {
    case 'queued':
      return { kind: 'queued' };
    case 'running':
      return { kind: 'running' };
    case 'succeeded':
      return {
        kind: 'done',
        reviewId: state.reviewId,
        verdictLabel: state.verdict != null ? CLAUDE_VERDICT_LABEL[state.verdict] : 'Reviewed',
        headMoved: state.headMoved,
        ...auto,
      };
    case 'failed':
    case 'cancelled':
      return { kind: 'start' };
  }
}

/**
 * The column's sort rank — under 'asc', the rows that still need a review lead: never reviewed or
 * failed, then reviewed-but-moved, then in flight, then reviewed at the current head.
 */
export function reviewCellRank(cell: ReviewCell): number {
  switch (cell.kind) {
    case 'start':
      return 0;
    case 'done':
      return cell.headMoved ? 1 : 4;
    case 'starting':
    case 'queued':
      return 2;
    case 'running':
      return 3;
  }
}

/** Is this PR held by an auto review (queued in its lane, or running)? A manual start is refused
 *  with 409 AutoReviewInProgress until the hold ends. */
export function heldByAutoReview(state: ClaudeReviewPrState | undefined): boolean {
  return (
    state?.trigger === 'auto' && (state.status === 'queued' || state.status === 'running')
  );
}

/** Does any listed PR have a run in flight? The column polls only while one does — which
 *  includes an auto review still waiting in its lane (reported as `queued`). */
export function anyReviewInFlight(states: readonly ClaudeReviewPrState[] | undefined): boolean {
  return (states ?? []).some((s) => s.status === 'queued' || s.status === 'running');
}

// ---- the user story a list-started run sends ----

export interface ListTicketResult {
  ticket: ClaudeReviewTicketInput | undefined;
  /** A short note for the cell after starting, or null when the story went with it. */
  note: string | null;
}

export const NO_STORY_NOTE = 'Started without a user story.';

/**
 * The user story for a run started from the list. A RE-REVIEW reuses the previous run's stored
 * ticket; otherwise (or when that run had none) the first FILLABLE Jira ticket detected on the PR
 * is fetched and filled the panel's way (`fillDraftFromJira`: title + description, the criteria
 * field remembered for this issue type on this site, else the best name match, else none).
 *
 * The review starts EITHER WAY: no ticket, no token, a failed fetch or a draft over a cap all
 * resolve to `ticket: undefined` with a note — this function never throws.
 */
export async function resolveListTicket(opts: {
  previous: ClaudeReviewTicket | null;
  loadTickets: () => Promise<readonly TicketRef[] | null | undefined>;
  loadDetails: (key: string) => Promise<JiraTicketDetails>;
  memory: AcMemoryStore | null;
}): Promise<ListTicketResult> {
  const prev = ticketDraftFromStored(opts.previous);
  if (ticketDraftHasContent(prev)) {
    const check = checkTicketDraft(prev);
    if (check.ok) return { ticket: ticketRequestFromCheck(check), note: null };
    return { ticket: undefined, note: `Started without the user story: ${check.message}` };
  }

  let refs: readonly TicketRef[] | null | undefined;
  try {
    refs = await opts.loadTickets();
  } catch {
    return { ticket: undefined, note: NO_STORY_NOTE };
  }
  const ref = fillableJiraTickets(refs)[0];
  if (ref == null) return { ticket: undefined, note: NO_STORY_NOTE };

  let details: JiraTicketDetails;
  try {
    details = await opts.loadDetails(ref.key);
  } catch {
    return { ticket: undefined, note: `Started without a user story: ${ref.key} could not be read.` };
  }
  const remembered = readRememberedAcField(opts.memory, jiraSiteOf(ref.url), details.issueType?.id);
  const draft = {
    ...fillDraftFromJira(EMPTY_TICKET_DRAFT, details, remembered).draft,
    ...jiraProvenance(ref),
  };
  const check = checkTicketDraft(draft);
  if (!check.ok) {
    return { ticket: undefined, note: `Started without ${ref.key}: ${check.message}` };
  }
  const ticket = ticketRequestFromCheck(check);
  return ticket != null ? { ticket, note: null } : { ticket: undefined, note: NO_STORY_NOTE };
}
