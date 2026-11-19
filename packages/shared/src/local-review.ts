// REVIEW A LOCAL BRANCH (docs/CLAUDE-REVIEW.md § Reviewing a local branch; docs/API.md § Local reviews).
// The reader's coding agent (Claude Code, Codex) asks the RUNNING Ensemble, over loopback, to review the
// branch it is working on — before anything is pushed. Two clients speak this wire: `ensemble mcp` (a
// stdio MCP server) and `ensemble review` (a thin CLI). Neither runs a review itself.
//
// The client sends a git BUNDLE (base..head; the head may be a snapshot commit of the uncommitted
// tracked changes, built in a temporary object directory), never a filesystem path. The server fetches it
// into its clone cache (fsck on), pins it as a local ref and runs the SAME branch review halves as the
// review loops (a Claude + Codex pair is ONE consolidated review), plus the story check when a ticket
// resolves. Results are stored in `local_reviews` / `local_review_findings`. Nothing is posted, pushed,
// claimed or fixed.

import type { AiEffort } from './ai-effort.js';
import type { AiProviderId, ClaudeFindingSeverity, ClaudeFollowUpStatus, ClaudeReviewVerdict, ClaudeTicketCriterionStatus } from './types.js';

/** The largest bundle the server takes (raw bytes; the JSON body carries it base64). */
export const LOCAL_REVIEW_BUNDLE_MAX_BYTES = 25 * 1024 * 1024;
/** The longest a `GET /api/local-reviews/:id?waitMs=` holds the request open. */
export const LOCAL_REVIEW_WAIT_MAX_MS = 50_000;
/** At most this many answers in one start. */
export const LOCAL_REVIEW_ANSWERS_MAX = 200;
/** The longest answer reply (the review loop's own limit). */
export const LOCAL_REVIEW_REPLY_MAX = 600;
/** At most this many commit subjects are sent (newest first). */
export const LOCAL_REVIEW_SUBJECTS_MAX = 100;

/** The spend ledger's features (Reports → AI usage: code review / story review). */
export const LOCAL_REVIEW_FEATURE = 'local_review';
export const LOCAL_REVIEW_CHECK_FEATURE = 'local_review_check';

/** 'review': the code review (+ the story check when a ticket resolves). 'story': the story check only. */
export type LocalReviewKind = 'review' | 'story';
export type LocalReviewStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The review loop's answer vocabulary (`cannot_meet` and `not_applicable` only for a criterion AC<n> / M<n>). */
export type LocalReviewAnswerAction = 'fixed' | 'answered' | 'pushed_back' | 'not_applicable' | 'cannot_meet';

/** One answer to an earlier run of the same branch: `F<finding id>`, `AC<n>` or `M<n>`. */
export interface LocalReviewAnswer {
  ref: string;
  action: LocalReviewAnswerAction;
  reply: string;
}

/** POST /api/local-reviews. */
export interface LocalReviewStartRequest {
  /** The repository (the clone's origin remote). */
  owner: string;
  name: string;
  /** The branch name (shown in the prompt; one run in flight per repository and branch). */
  branch: string;
  /** The commit the review diffs against: a commit GitHub has. */
  baseSha: string;
  /** The ref the base came from ('origin/main'), for the prompt only. */
  baseRef: string;
  /** The reviewed commit (the bundle's tip). */
  headSha: string;
  /** The bundle (base..head), base64. */
  bundle: string;
  /** The commit subjects base..HEAD, newest first (ticket detection and "what the branch is for"). */
  subjects: string[];
  /** The uncommitted tracked changes were asked for, and whether there were any. */
  includeUncommitted: boolean;
  uncommittedChanges: boolean;
  kind: LocalReviewKind;
  /** An explicit ticket key ('PAY-142', 'owner/repo#12'); else it is detected. */
  ticket?: string | null;
  /** One vendor for this run (else Settings → AI → Review: a pair when both are on and signed in). */
  provider?: AiProviderId | null;
  /** One effort level for this run (else Settings → AI → Review's; REVIEW_EFFORT still wins). */
  effort?: AiEffort | null;
  /** Answers to the latest earlier run of this branch. */
  answers?: LocalReviewAnswer[];
}

export interface LocalReviewStartResponse {
  id: number;
  status: LocalReviewStatus;
  /** A run of this branch was already in flight: this is its id (nothing new started). */
  alreadyRunning: boolean;
  /** Answers that were not used, one line each (an unknown ref, a bad action). */
  ignoredAnswers: string[];
}

/** A refusal: one plain line. */
export interface LocalReviewError {
  error: string;
  message: string;
}

export interface LocalReviewFinding {
  /** The id an answer names as `F<id>`. */
  id: number;
  file: string;
  line: number | null;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  suggestion: string | null;
  /** Which reviewer raised it (both: the pair agreed). */
  raisedBy: AiProviderId[];
  /** The earlier finding this one raises again, or null. */
  earlierFindingId: number | null;
}

/** What this run found about an earlier finding (after the answers sent with it). */
export interface LocalReviewFollowUp {
  findingId: number;
  status: ClaudeFollowUpStatus;
  explanation: string | null;
}

export interface LocalReviewCriterion {
  /** 'AC1'…, or 'M1'… for an item the ticket asks for that the work does not do. */
  ref: string;
  text: string;
  status: ClaudeTicketCriterionStatus | 'missing';
  explanation: string | null;
  /** Still to do (not met, partly met, unclear, missing — unless a "not applicable" note was accepted). */
  open: boolean;
  /** The agent said it cannot meet it (its reason). The criterion stays NOT MET. */
  cannotMeet: string | null;
  /** The checker accepted the agent's "not applicable" note. */
  notApplicable: boolean;
  /** A met criterion only code OUTSIDE the ticket delivers, in words ("Already in acme/api (no PR on this
   *  ticket)"; shared `criterionOutsideWords`). Absent otherwise. */
  outside?: string;
}

export interface LocalReviewReviewer {
  provider: AiProviderId;
  model: string | null;
  effort: string | null;
  status: LocalReviewStatus | 'skipped';
  failureReason: string | null;
}

export interface LocalReview {
  id: number;
  kind: LocalReviewKind;
  status: LocalReviewStatus;
  /** owner/name. */
  repo: string;
  branch: string;
  baseSha: string;
  headSha: string;
  includeUncommitted: boolean;
  uncommittedChanges: boolean;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
  /** The code review (null on a story-only run). */
  review: {
    reviewers: LocalReviewReviewer[];
    summary: string | null;
    verdict: ClaudeReviewVerdict | null;
    findings: LocalReviewFinding[];
    followUp: LocalReviewFollowUp[];
  } | null;
  ticket: { key: string; title: string; url: string | null } | null;
  /** Why there is no story check (no ticket found, no tracker, ticket unknown), or null. */
  ticketNote: string | null;
  storyCheck: {
    status: LocalReviewStatus;
    failureReason: string | null;
    summary: string | null;
    criteria: LocalReviewCriterion[];
    /** How many criteria are still open. */
    open: number;
  } | null;
  /** The answers this run was sent (as used). */
  answers: LocalReviewAnswer[];
}

export interface LocalReviewListItem {
  id: number;
  kind: LocalReviewKind;
  status: LocalReviewStatus;
  branch: string;
  headSha: string;
  createdAt: string;
  findings: number;
  openCriteria: number | null;
}

/** GET /api/local-reviews?owner=&name=&branch= */
export interface LocalReviewListResponse {
  repo: string;
  branch: string | null;
  reviews: LocalReviewListItem[];
}
