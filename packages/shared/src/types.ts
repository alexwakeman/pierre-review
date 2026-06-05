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

// PR status as exposed by the top-level filter. Derived from (state, isDraft):
// draft = open & isDraft, open = open & ready, merged, closed.
export type PrStatus = 'draft' | 'open' | 'merged' | 'closed';

export const PR_STATUSES: PrStatus[] = ['draft', 'open', 'merged', 'closed'];

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

// Live progress of an in-flight sync. Present only while status === 'running'.
// `percent` is a 0..1 estimate based on how far back in time the sync has walked
// toward its cutoff (PRs are paginated newest-first); it is monotonic and reaches
// 1 when the cutoff is hit. `prsProcessed` is the honest running count.
export interface SyncProgress {
  percent: number;
  prsProcessed: number;
  pages: number;
  mode: 'full' | 'incremental';
}

export interface SyncStatus {
  repoId: number;
  status: SyncRunStatus;
  progress: SyncProgress | null;
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
  // Whether the Claude Review feature is enabled (ENABLE_CLAUDE_REVIEW). The
  // frontend hides the Claude Review tab when false.
  claudeReviewEnabled: boolean;
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

// Per-repo "merge rights" inference: the distinct users who have actually merged
// a PR in that repo (GraphQL mergedBy). Used to badge maintainers on the
// timeline. Reference data — not bounded by the timeline window or filters.
export interface RepoMergers {
  repoId: number;
  userIds: number[];
}

export type MergersResponse = RepoMergers[];

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
  // Who merged the PR (GraphQL `mergedBy`), distinct from the author; null on
  // open/closed-unmerged PRs. Resolved via the `users` array below.
  mergedById: number | null;
  closedAt: string | null;
  updatedAt: string;
  githubUrl: string;
  // The head commit SHA (null until synced). Drives the Claude Review tab's
  // "you already reviewed this exact SHA" warning.
  headSha: string | null;
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

// ---- repo search (Add-repo picker) ----

// A single GitHub repository-search hit, shaped for the Add-repo picker. Sourced
// live from the GitHub GraphQL search API (never persisted) — only the fields the
// picker renders. `isOwnedOrMember` floats repos you own or are an org member of
// to the top of the result list.
export interface RepoSearchResult {
  githubNodeId: string;
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  description: string | null;
  ownerAvatarUrl: string | null;
  stargazerCount: number;
  openPrCount: number;
  url: string;
  isPrivate: boolean;
  isOwnedOrMember: boolean;
}

// One page of repo-search results. `cursor` feeds the next page's request when
// `hasNextPage` is true (GitHub's opaque endCursor); null when exhausted.
export interface RepoSearchResponse {
  results: RepoSearchResult[];
  hasNextPage: boolean;
  cursor: string | null;
}

export interface RepoSearchQuery {
  q: string;
  cursor?: string;
  limit?: number;
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
  // comma-separated PrStatus. Absent = no status filter (all). Present (even
  // empty) = explicit set; an empty value shows nothing.
  statuses?: string;
  excludeBots?: string; // "true" | "false"
  // "true" → drop "stale" open PRs: open PRs with no commit / comment / review
  // event inside [from, to]. They (and their events) are removed so the row can
  // disappear entirely. Absent/"false" = keep them.
  excludeStale?: string;
}

// ---- Claude Review (agentic PR review) ----
// The app's first agentic feature: an in-app Claude Agent SDK run that reviews a
// PR and returns structured findings. Claude's output is read-only reference; the
// user authors their own review body/verdict and ticks which findings to post.

export type ClaudeReviewModel =
  | 'claude-opus-4-8'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

// Runtime list for the model picker (frontend bundles shared; the backend keeps a
// local copy and only `import type`s from here — shared isn't shipped at runtime).
export const CLAUDE_REVIEW_MODELS: ClaudeReviewModel[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

export type ClaudeReviewStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ClaudeReviewScope = 'diff_only' | 'worktree';

export type ClaudeReviewVerdict = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export type ClaudeFindingSeverity =
  | 'blocker'
  | 'warning'
  | 'nit'
  | 'question'
  | 'praise';

export type ClaudeFindingSide = 'LEFT' | 'RIGHT';

// One line-level finding from a review run. Claude's wording (title/body/
// suggestion) is read-only; only `included` (the user's tick) is mutable.
export interface ClaudeFinding {
  id: number;
  reviewId: number;
  path: string;
  // null ⇒ no line anchor (file-level / unanchored).
  line: number | null;
  side: ClaudeFindingSide;
  // SHA-256 of `path` (hex) — GitHub's PR "Files changed" diff anchor, so the
  // code ref can deep-link into the PR diff at this file/line.
  diffAnchorId: string;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  // The user's reworded version (markdown). When set and the finding is
  // included, this posts instead of `body`. null ⇒ use Claude's wording.
  editedBody: string | null;
  suggestion: string | null;
  // The unified-diff hunk this finding covers, for showing the code in context.
  // null for older runs / unanchored findings.
  diffHunk: string | null;
  // false ⇒ couldn't map onto an addable diff line → can't post inline.
  anchored: boolean;
  // The user ticked this finding to post it as an inline comment.
  included: boolean;
  postedAt: string | null;
  githubCommentId: string | null;
  createdAt: string;
}

// One review run (re-review = a new run; history kept, keyed by head SHA).
export interface ClaudeReview {
  id: number;
  prId: number;
  headSha: string;
  status: ClaudeReviewStatus;
  model: ClaudeReviewModel;
  scope: ClaudeReviewScope | null;
  // Claude's output (read-only reference).
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  // The user-authored review that actually gets posted.
  userBody: string | null;
  userVerdict: ClaudeReviewVerdict | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  error: string | null;
  excludedFiles: string[];
  postedReviewId: string | null;
  postedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  findings: ClaudeFinding[];
}

// A lighter run row for the history selector (no findings).
export interface ClaudeReviewSummary {
  id: number;
  headSha: string;
  status: ClaudeReviewStatus;
  model: ClaudeReviewModel;
  scope: ClaudeReviewScope | null;
  verdict: ClaudeReviewVerdict | null;
  userVerdict: ClaudeReviewVerdict | null;
  costUsd: number | null;
  postedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type ClaudeAuthStatus = 'ok' | 'none';

export interface ClaudeReviewResponse {
  // Whether the feature is enabled at all (ENABLE_CLAUDE_REVIEW).
  enabled: boolean;
  // Claude-auth availability for running a review.
  auth: ClaudeAuthStatus;
  authMessage?: string;
  // The latest run for the PR (with findings), or null if never run.
  review: ClaudeReview | null;
  // All prior runs for the PR (newest first), lighter shape.
  history: ClaudeReviewSummary[];
}

export type ClaudeReviewPhase =
  | 'cloning'
  | 'fetching_diff'
  | 'deciding'
  | 'reviewing'
  | 'persisting';

export interface ClaudeReviewProgress {
  phase: ClaudeReviewPhase;
  message?: string;
}

export interface ClaudeReviewStatusResponse {
  status: ClaudeReviewStatus | 'idle';
  reviewId: number | null;
  progress: ClaudeReviewProgress | null;
}

// A finding ticked for posting but not anchorable to a diff line (surfaced so the
// UI can flag it; the user can Copy it into their own body instead).
export interface SkippedFinding {
  findingId: number;
  path: string;
  title: string;
}

// The exact GitHub review payload — returned verbatim by the dry-run preview and
// used as the body of the real POST.
export interface PostReviewComment {
  path: string;
  line: number;
  side: ClaudeFindingSide;
  body: string;
}

export interface PostReviewPreview {
  commitId: string;
  body: string;
  event: ClaudeReviewVerdict;
  comments: PostReviewComment[];
  skippedUnanchored: SkippedFinding[];
}

export interface PostReviewResult {
  postedReviewId: string | null;
  postedAt: string;
  postedCommentCount: number;
  skippedUnanchored: SkippedFinding[];
}

// Result of posting a single finding as a standalone inline comment (not a review).
export interface PostCommentResult {
  githubCommentId: string | null;
  postedAt: string;
}

// ---- request payloads (Claude review) ----

export interface GenerateReviewBody {
  model: ClaudeReviewModel;
}

// Saves the user's authored draft; never mutates Claude's summary/verdict.
export interface UpdateReviewBody {
  userBody?: string;
  userVerdict?: ClaudeReviewVerdict;
}

// Tick a finding for inline posting and/or save the user's reworded body. An
// empty-string editedBody clears the reword (reverts to Claude's wording).
export interface UpdateFindingBody {
  included?: boolean;
  editedBody?: string;
}

// A review currently in flight, for the global progress banner. Surfaced from the
// review manager's in-memory state joined with the PR's coordinates.
export interface ActiveReview {
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  status: ClaudeReviewStatus;
  phase: ClaudeReviewPhase | null;
}

export interface ActiveReviewsResponse {
  reviews: ActiveReview[];
}

export interface PostReviewBody {
  userVerdict: ClaudeReviewVerdict;
}
