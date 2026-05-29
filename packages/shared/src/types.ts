// API types shared between frontend and backend.
// All timestamps are ISO-8601 strings over the wire.

export type DerivedState =
  | 'resolved'
  | 'likely_addressed'
  | 'replied_unresolved'
  | 'untouched';

export const DERIVED_STATES: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

export type PrState = 'open' | 'merged' | 'closed';

export type ReviewState =
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'dismissed'
  | 'pending';

export type EventType =
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_reopened'
  | 'pr_ready_for_review'
  | 'review_submitted'
  | 'review_comment'
  | 'pr_comment'
  | 'commit_pushed';

export const EVENT_TYPES: EventType[] = [
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'pr_reopened',
  'pr_ready_for_review',
  'review_submitted',
  'review_comment',
  'pr_comment',
  'commit_pushed',
];

// Coarse buckets used for the event-type filter toggles in the UI.
export type EventCategory =
  | 'lifecycle'
  | 'reviews'
  | 'review_comments'
  | 'pr_comments'
  | 'commits';

export const EVENT_CATEGORY_BY_TYPE: Record<EventType, EventCategory> = {
  pr_opened: 'lifecycle',
  pr_merged: 'lifecycle',
  pr_closed: 'lifecycle',
  pr_reopened: 'lifecycle',
  pr_ready_for_review: 'lifecycle',
  review_submitted: 'reviews',
  review_comment: 'review_comments',
  pr_comment: 'pr_comments',
  commit_pushed: 'commits',
};

export interface User {
  id: number;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  createdAt: string;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

export type SyncRunStatus = 'idle' | 'running' | 'ok' | 'error';

export interface SyncStatus {
  repoId: number;
  status: SyncRunStatus;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastSyncError: string | null;
}

export interface ThreadStateCounts {
  resolved: number;
  likely_addressed: number;
  replied_unresolved: number;
  untouched: number;
}

// ---- v1.1: CI / mergeability / triage ----

export type CiStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'error'
  | 'expected'
  | 'unknown';

export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';

export type MergeStateStatus =
  | 'clean'
  | 'dirty'
  | 'unstable'
  | 'blocked'
  | 'behind'
  | 'has_hooks'
  | 'unknown';

export interface Label {
  name: string;
  color: string;
}

// A single CI check (CheckRun or legacy StatusContext) on the head commit,
// normalised to one display state.
export type CheckRunState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'neutral'
  | 'skipped'
  | 'error'
  | 'unknown';

export interface CheckRun {
  name: string;
  state: CheckRunState;
  url: string | null;
}

// An outstanding review request on a PR (user resolved via the users array;
// team requests carry only a name).
export interface RequestedReviewer {
  userId: number | null;
  teamName: string | null;
}

// The single most useful reason a PR matters right now, in priority order.
export type ReasonTag =
  | 'awaiting_your_review'
  | 'your_pr_new_comments'
  | 'ci_failing'
  | 'merge_conflicts'
  | 'approved_ready'
  | 'stalled'
  | 'untouched_threads'
  | 'in_progress';

// Reason tags in descending priority — index 0 is most urgent. Used for the
// open-PRs sort and for the strip's "needs attention" filter.
export const REASON_PRIORITY: ReasonTag[] = [
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'approved_ready',
  'stalled',
  'untouched_threads',
  'in_progress',
];

// "My turn" = the two reasons that are actionable by you specifically.
export const MY_TURN_REASONS: ReasonTag[] = [
  'awaiting_your_review',
  'your_pr_new_comments',
];

export function isMyTurnReason(tag: ReasonTag): boolean {
  return MY_TURN_REASONS.includes(tag);
}

export interface NewSinceLastViewed {
  commits: number;
  comments: number;
  reviews: number;
}

export interface LocalUser {
  login: string;
  githubId: string;
  avatarUrl: string | null;
}

export interface MyTurnCounts {
  awaitingReview: number;
  yourPrsActivity: number;
  threadsAwaiting: number;
}

export interface MeResponse {
  user: LocalUser | null;
  counts: MyTurnCounts;
}

// Lean PR shape for the timeline. No bodies, no diff hunks.
export interface TimelinePr {
  id: number;
  repoId: number;
  number: number;
  title: string;
  authorId: number | null;
  state: PrState;
  isDraft: boolean;
  isStalled: boolean;
  openedAt: string;
  firstReviewAt: string | null;
  lastCommitAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  threadCounts: ThreadStateCounts;
  // v1.1 triage fields
  ciStatus: CiStatus;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  labels: Label[];
  reasonTag: ReasonTag;
  reviewRequestedFromMe: boolean;
  // null on closed/merged PRs (no "new" badges once a PR is done) and when
  // the PR has never been viewed.
  newSinceLastViewed: NewSinceLastViewed | null;
}

export interface OpenPrsResponse {
  prs: TimelinePr[];
}

// Lean event shape for the timeline. No bodies.
export interface TimelineEvent {
  id: number;
  repoId: number;
  actorId: number | null;
  prId: number | null;
  type: EventType;
  occurredAt: string;
  // For navigation: the thread this event points at, when applicable.
  threadId: number | null;
  // The underlying entity row id (events.ref_id). For commit_pushed this is the
  // commit row id, letting the marker modal resolve the commit via /api/prs/:id
  // without bloating the timeline payload.
  refId: number | null;
  // For review_submitted markers: the review outcome (drives icon/colour).
  reviewState: ReviewState | null;
}

export interface TimelineResponse {
  prs: TimelinePr[];
  events: TimelineEvent[];
}

export interface CommentDetail {
  id: number;
  authorId: number | null;
  body: string;
  diffHunk: string | null;
  createdAt: string;
  // Deep link to this comment on GitHub (#discussion_r<id>); null until synced.
  url: string | null;
}

export interface ThreadDetail {
  id: number;
  prId: number;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  derivedState: DerivedState;
  originalCommenterId: number | null;
  createdAt: string;
  comments: CommentDetail[];
  // Deep link to the thread on GitHub (its first comment's #discussion_r anchor);
  // null until synced.
  url: string | null;
}

export interface ReviewDetail {
  id: number;
  authorId: number | null;
  state: ReviewState;
  body: string | null;
  submittedAt: string;
  // Deep link to the review on GitHub (#pullrequestreview-<id>); null until synced.
  url: string | null;
}

export interface PrCommentDetail {
  id: number;
  authorId: number | null;
  body: string;
  createdAt: string;
  // Deep link to the comment on GitHub (#issuecomment-<id>); null until synced.
  url: string | null;
}

export interface CommitDetail {
  id: number;
  sha: string;
  authorId: number | null;
  committerId: number | null;
  message: string | null;
  committedAt: string;
}

export interface PrDetail {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  authorId: number | null;
  state: PrState;
  isDraft: boolean;
  isStalled: boolean;
  openedAt: string;
  firstReviewAt: string | null;
  lastCommitAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  githubUrl: string;
  // v1.2 Checks/Overview tab: CI + mergeability + labels + per-job checks +
  // outstanding reviewers (head-commit derived).
  ciStatus: CiStatus;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  labels: Label[];
  checkRuns: CheckRun[];
  requestedReviewers: RequestedReviewer[];
  threads: ThreadDetail[];
  reviews: ReviewDetail[];
  comments: PrCommentDetail[];
  commits: CommitDetail[];
  // Users referenced by any nested entity, for client-side lookup.
  users: User[];
  // Incremental review: when the local user last viewed this PR, and what's
  // happened since (null when never viewed or the PR is closed/merged).
  lastViewedAt: string | null;
  newSinceLastViewed: NewSinceLastViewed | null;
}

// ---- my turn ----

// A PR reference shared by the my-turn sections (enough to render a row and
// navigate on click).
export interface MyTurnPr {
  prId: number;
  repoFullName: string;
  number: number;
  title: string;
  authorId: number | null;
  state: PrState;
  openedAt: string;
  githubUrl: string;
}

export interface AwaitingReviewItem extends MyTurnPr {
  // Other reviewers still pending alongside you, for context.
  alsoRequested: number;
}

export interface YourPrActivityItem extends MyTurnPr {
  newSinceLastViewed: NewSinceLastViewed;
  // Human-readable summary of what's new, e.g. "3 new comments · 1 new commit".
  summary: string;
}

export interface ThreadAwaitingItem {
  threadId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  path: string;
  line: number | null;
  derivedState: DerivedState;
  // Last reply (the one awaiting your response), truncated.
  lastReplyExcerpt: string;
  lastReplyAt: string;
  lastReplyAuthorId: number | null;
  githubUrl: string;
}

export interface MyTurnResponse {
  awaitingReview: AwaitingReviewItem[];
  yourPrs: YourPrActivityItem[];
  threadsAwaiting: ThreadAwaitingItem[];
  // Users referenced by any row, for client-side lookup.
  users: User[];
}

// ---- request payloads ----

export interface CreateRepoBody {
  owner: string;
  name: string;
}

export interface MarkViewedBody {
  sha?: string;
}

// Dismissing a "my turn" entry. Auto-resurfaces when newer activity arrives:
// a review_request reappears when its PR is updated again; a thread reappears
// on a newer reply.
export type MyTurnDismissKind = 'review_request' | 'thread';

export interface MyTurnDismissBody {
  kind: MyTurnDismissKind;
  // PR id for review_request, thread id for thread.
  refId: number;
}

export interface UpdateUserBody {
  isBot: boolean;
}

export interface TimelineQuery {
  from?: string;
  to?: string;
  repoIds?: string; // comma-separated
  userIds?: string; // comma-separated
  types?: string; // comma-separated EventType
  excludeBots?: string; // "true" | "false"
}
