import type {
  ClaudeFindingSeverity,
  ClaudeFollowUpStatus,
  ClaudeReviewPrState,
  ClaudeReviewStateSummary,
  ClaudeTicketAlignment,
  ClaudeReviewTicket,
  ClaudeReviewTicketInput,
  ClaudeReviewVerdict,
  JiraTicketDetails,
  TicketRef,
} from '@pierre-review/shared';
import {
  CLEAN_CLASS,
  EMPTY_TICKET_DRAFT,
  OUTDATED_CLASS,
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

// Pure helpers for the Claude Review panel on each Open PRs card (OpenPrsCards → ClaudeReviewCell).
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
  // never reviewed, or the last run failed / was cancelled (`failed` = it failed: the strip says so)
  | { kind: 'start'; failed?: true }
  | { kind: 'starting' } // this click's request is in flight
  | { kind: 'queued'; auto?: true }
  | { kind: 'running'; auto?: true }
  | {
      kind: 'done';
      reviewId: number | null;
      verdict?: ClaudeReviewVerdict;
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
        ...(state.verdict != null ? { verdict: state.verdict } : {}),
        verdictLabel: state.verdict != null ? CLAUDE_VERDICT_LABEL[state.verdict] : 'Reviewed',
        headMoved: state.headMoved,
        ...auto,
      };
    case 'failed':
      return { kind: 'start', failed: true };
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

// ---- the strip's figures (all read off the server's `summary`; nothing here decides a status) ----

/** The severities the strip counts, most pressing first. `praise` is not something to act on. */
export const STRIP_SEVERITIES: readonly ClaudeFindingSeverity[] = ['blocker', 'warning', 'nit', 'question'];

const SEVERITY_WORDS: Record<ClaudeFindingSeverity, [string, string]> = {
  blocker: ['blocker', 'blockers'],
  warning: ['warning', 'warnings'],
  nit: ['nit', 'nits'],
  question: ['question', 'questions'],
  praise: ['praise', 'praise'],
};

export interface SeverityPill {
  severity: ClaudeFindingSeverity;
  count: number;
  label: string; // "2 blockers"
}

/** One pill per severity the run found, most pressing first. [] for a clean run. */
export function severityPills(summary: ClaudeReviewStateSummary): SeverityPill[] {
  return STRIP_SEVERITIES.filter((sev) => (summary.findings[sev] ?? 0) > 0).map((sev) => {
    const n = summary.findings[sev];
    return { severity: sev, count: n, label: `${n} ${SEVERITY_WORDS[sev][n === 1 ? 0 : 1]}` };
  });
}

/** Every finding the run raised, praise included (the posted denominator). */
export function findingTotal(summary: ClaudeReviewStateSummary): number {
  return Object.values(summary.findings).reduce((a, b) => a + b, 0);
}

/**
 * IS THIS REVIEW ON THE PR'S CURRENT COMMIT? The ONE answer the Claude Review pane's header and the
 * Open PRs card both print, so the two can never disagree.
 *
 *   current  -> green "On latest commit" (+ `sha`, the short head, for a caller with room for it)
 *   behind   -> amber "N newer commits" / "1 newer commit", or "Branch changed" when the newer
 *               commits cannot be counted (a rewritten history, or the reviewed commit not synced)
 *
 * null when either commit is unknown: no reading is never "current" and never "moved".
 */
export interface ReviewCurrency {
  tone: 'current' | 'behind';
  label: string;
  /** The PR's current head, shortened (7 chars). */
  sha: string;
  /** The chip colour: CLEAN_CLASS when current, OUTDATED_CLASS when behind. */
  className: string;
  /** A hover line naming both commits. */
  title: string;
}

export function reviewCurrency(r: {
  reviewedHeadSha: string | null | undefined;
  currentHeadSha: string | null | undefined;
  commitsSince?: number | null;
}): ReviewCurrency | null {
  const reviewed = r.reviewedHeadSha;
  const current = r.currentHeadSha;
  if (!reviewed || !current) return null;
  const sha = current.slice(0, 7);
  if (reviewed === current) {
    return { tone: 'current', label: 'On latest commit', sha, className: CLEAN_CLASS, title: `Reviewed ${sha}, the PR's latest commit` };
  }
  const n = r.commitsSince;
  return {
    tone: 'behind',
    label: n == null || n <= 0 ? 'Branch changed' : `${n} newer commit${n === 1 ? '' : 's'}`,
    sha,
    className: OUTDATED_CLASS,
    title: `Reviewed ${reviewed.slice(0, 7)}; the PR is now at ${sha}`,
  };
}

/** A story's alignment in a pill's room. */
export const ALIGNMENT_SHORT: Record<ClaudeTicketAlignment, string> = {
  aligned: 'Matches',
  partly_aligned: 'Partly',
  not_aligned: "Doesn't match",
  unclear: "Can't tell",
  not_checked: 'Not checked',
};

/** The previous review's findings, in two figures: fixed, and still open (not or partly fixed).
 *  `not_checked` / `no_longer_applies` are neither. null when there was nothing to follow up. */
export function followUpTally(
  followUp: Record<ClaudeFollowUpStatus, number> | null,
): { fixed: number; open: number } | null {
  if (followUp == null) return null;
  const fixed = followUp.addressed;
  const open = followUp.not_addressed + followUp.partly_addressed;
  if (fixed === 0 && open === 0) return null;
  return { fixed, open };
}

/**
 * The Claude Review panel's left accent on an Open PRs card — the run's OUTCOME at a glance.
 * `none` = never reviewed (or cancelled): no accent, the panel is just an offer to review.
 */
export type ReviewTone = 'none' | 'active' | 'bad' | 'ok' | 'neutral';

export function reviewTone(cell: ReviewCell): ReviewTone {
  switch (cell.kind) {
    case 'start':
      return cell.failed ? 'bad' : 'none';
    case 'starting':
    case 'queued':
    case 'running':
      return 'active';
    case 'done':
      if (cell.verdict === 'REQUEST_CHANGES') return 'bad';
      if (cell.verdict === 'APPROVE') return 'ok';
      return 'neutral';
  }
}

/** The CI half of a finished run: "2 CI failures explained" / "3 CI failures, 1 explained".
 *  null when the run did not look at CI, or nothing was failing (nothing to say). */
export function ciDiagnosisLabel(ci: ClaudeReviewStateSummary['ci']): string | null {
  if (ci == null || ci.failing <= 0) return null;
  const noun = `CI failure${ci.failing === 1 ? '' : 's'}`;
  if (ci.diagnosed >= ci.failing) return `${ci.failing} ${noun} explained`;
  return `${ci.failing} ${noun}, ${ci.diagnosed === 0 ? 'none' : ci.diagnosed} explained`;
}

/** Other reviewers' threads Claude judged right and not yet dealt with. null when none, or when
 *  the run did not judge threads (never a fake zero). */
export function threadsToFixLabel(summary: Pick<ClaudeReviewStateSummary, 'threadAssessments'>): string | null {
  const n = summary.threadAssessments?.validUnaddressed ?? 0;
  return n > 0 ? `${n} thread${n === 1 ? '' : 's'} to fix` : null;
}

/** The Findings sort value: most severe run first under 'desc'. A PR with no finished run sorts
 *  below a clean one (-1), so "nothing known" never ranks as "nothing found". */
export function findingsRank(state: ClaudeReviewPrState | undefined): number {
  const f = state?.summary?.findings;
  if (f == null) return -1;
  return f.blocker * 1_000_000 + f.warning * 1_000 + f.nit + f.question;
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
