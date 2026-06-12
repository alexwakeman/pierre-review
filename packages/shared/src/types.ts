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

// The review verdicts filterable in the timeline's Events panel — the ones that emit
// a `review_submitted` marker. 'pending' never submits an event, so it's excluded.
// Order is the UI display order.
export const REVIEW_FILTER_STATES: ReviewState[] = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
];

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
  // Two-phase first sync: true once the fast "foreground" window (the default
  // timeline range) is fully loaded and the slower backfill of older history is
  // continuing in the background. Lets the UI drop the user into the recent view
  // immediately. Absent/false for incremental syncs and during the foreground pass.
  foregroundComplete?: boolean;
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

// A single file changed by a PR, with its per-file line counts. Stored as a JSON
// column on pull_requests (synced from GitHub's pullRequest.files connection) and
// surfaced in the PR-detail "Changes" tab. `githubUrl` deep-links to the file's
// diff in the PR's "Files changed" view (built server-side in getPrDetail).
export interface PrFileChange {
  path: string;
  additions: number;
  deletions: number;
  githubUrl: string;
}

// The DB-stored shape of a changed file (the `files` JSON column on pull_requests):
// the API's PrFileChange minus the `githubUrl`, which is derived on read.
export type StoredPrFile = Omit<PrFileChange, 'githubUrl'>;

// Hard cap on how many repositories a single account may watch. Enforced on the
// add-repo route (backend, the source of truth) and surfaced in the add-repo UI.
export const MAX_REPOS_PER_ACCOUNT = 15;

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
  // Deployment mode. 'cloud' tells the SPA to show a sign-out control and treat a
  // 401 from /api/me as "signed out" (vs local, where /api/me never 401s).
  deploymentMode: 'local' | 'cloud';
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
  // Diff size summary (from GitHub's pullRequest.additions/deletions/changedFiles).
  // `changedFilesCount` is the true file count, which may exceed `files.length` when
  // a PR touches more files than the synced page (files is capped at 100).
  additions: number;
  deletions: number;
  changedFilesCount: number;
  // Per-file breakdown for the "Changes" tab (capped at 100 files; ordered as
  // GitHub returns them). Empty until a sync has populated it.
  files: PrFileChange[];
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

// ---- my turn: completed / dismissed (the "Done" tab) ----
// Previously-dismissed entries, for the My Turn "Done" tab (past 90 days). Only the
// dismissal-backed kinds appear here (review_request + thread, from myTurnDismissals)
// — "Your PRs" are cleared via mark-viewed, not a restorable dismissal. Each carries
// when it was dismissed and can be moved back to the inbox ("To do" = un-dismiss).
export interface DismissedReviewItem extends MyTurnPr {
  kind: 'review_request';
  dismissedAt: string;
}

export interface DismissedThreadItem extends ThreadAwaitingItem {
  kind: 'thread';
  dismissedAt: string;
}

export type DismissedItem = DismissedReviewItem | DismissedThreadItem;

export interface DismissedMyTurnResponse {
  items: DismissedItem[];
  // Users referenced by any item, for client-side lookup.
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
  // comma-separated ReviewState (approved/changes_requested/commented/dismissed) —
  // filters review_submitted events by verdict. Absent = no filter (all verdicts);
  // present (even empty) = explicit set, an empty value showing no review markers.
  // Only affects review_submitted events; other event types are untouched.
  reviewStates?: string;
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

export type ClaudeReviewModel = 'claude-opus-4-8' | 'claude-sonnet-4-6';

// Runtime list for the model picker (frontend bundles shared; the backend keeps a
// local copy and only `import type`s from here — shared isn't shipped at runtime).
export const CLAUDE_REVIEW_MODELS: ClaudeReviewModel[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
];

export type ClaudeReviewStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ClaudeReviewScope = 'diff_only' | 'worktree';

// The RESOLVED review mode a run actually used, chosen by the deterministic router
// (or forced by the user) BEFORE the agent runs:
//  - 'skip'       — the diff is entirely noise (generated/vendored/lockfile/binary);
//                   nothing substantive to review, so no agent runs.
//  - 'diff_only'  — small/localized change; reviewed from the diff alone, tool-less,
//                   with NO cloned worktree (fast, fixed turn count).
//  - 'worktree'   — large/cross-cutting/contract-changing; reviewed with the full
//                   cloned worktree as explorable context (the original behaviour).
export type ReviewMode = 'skip' | 'diff_only' | 'worktree';

// What the user asked for when starting a run. 'auto' lets the router decide (and is
// the only path that can resolve to 'skip'); 'diff_only'/'worktree' force that mode,
// overriding the router's metrics.
export type RequestedReviewMode = 'auto' | 'diff_only' | 'worktree';

// Runtime list for the depth picker (frontend bundles shared; the backend keeps a
// local copy and only `import type`s from here — shared isn't shipped at runtime).
export const REQUESTED_REVIEW_MODES: RequestedReviewMode[] = [
  'auto',
  'diff_only',
  'worktree',
];

// The deterministic routing decision's inputs + outcome, recorded on every run so
// the thresholds can be calibrated (and the choice audited) after the fact. All
// metrics are computed over the noise-stripped diff's non-noise files.
export interface ReviewRouteReason {
  // What the user asked for ('auto' = let the router decide).
  requested: RequestedReviewMode;
  // Who actually chose the resolved mode.
  decidedBy: 'router' | 'user';
  // Number of (non-noise) files changed.
  changedFiles: number;
  // Total added + deleted lines across those files.
  linesChanged: number;
  // Distinct directories touched.
  dirsTouched: number;
  // Distinct top-level path segments (subsystems) touched.
  subsystems: number;
  // A modified/removed exported-or-public symbol, or a changed IDL/schema/route path
  // — the load-bearing "needs broad context" signal.
  apiTouch: boolean;
  // Fraction of changed lines that delete existing code (deletions / linesChanged);
  // computed + logged for calibration, not yet a gate input.
  modifyingFraction: number;
  // Every changed file is a brand-new file (purely additive). Logged for calibration.
  allFilesNew: boolean;
  // The first gate ceiling that forced 'worktree' (e.g. 'files', 'lines', 'dirs',
  // 'subsystems', 'apiTouch'); null when the run stayed diff_only / skip / was forced.
  trippedBy: string | null;
}

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
  // The deterministic routing decision: the mode this run actually used, and the
  // metrics behind it. Null on pre-routing rows (older runs / not yet decided).
  // `scope` above is the AGENT's self-report; a run with reviewMode 'diff_only' but
  // scope 'worktree' is the agent flagging that a deeper review was warranted.
  reviewMode: ReviewMode | null;
  routeReason: ReviewRouteReason | null;
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
  reviewMode: ReviewMode | null;
  verdict: ClaudeReviewVerdict | null;
  userVerdict: ClaudeReviewVerdict | null;
  costUsd: number | null;
  postedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// One entry in the cross-PR "prior Claude reviews" list (GET /api/claude-reviews):
// a PR's most-recent SUCCEEDED review, enriched with its PR/repo coordinates so
// the list can render and deep-link without a second fetch.
export interface ClaudeReviewListItem {
  reviewId: number;
  prId: number;
  repoFullName: string; // `${owner}/${name}`
  prNumber: number;
  prTitle: string;
  prState: PrState;
  // Claude's high-level summary (read-only).
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  headSha: string;
  status: ClaudeReviewStatus;
  createdAt: string; // ISO-8601
  finishedAt: string | null; // ISO-8601 — "last run" time
}

export interface ClaudeReviewListResponse {
  reviews: ClaudeReviewListItem[];
}

export type ClaudeAuthStatus = 'ok' | 'none';

export interface ClaudeReviewResponse {
  // Whether the feature is enabled at all (ENABLE_CLAUDE_REVIEW).
  enabled: boolean;
  // Claude-auth availability for running a review.
  auth: ClaudeAuthStatus;
  authMessage?: string;
  // Whether a user-supplied Anthropic API key is stored locally (local mode
  // only). When true, that key overrides the ambient Claude auth at run time.
  hasUserKey: boolean;
  // The latest run for the PR (with findings), or null if never run.
  review: ClaudeReview | null;
  // All prior runs for the PR (newest first), lighter shape.
  history: ClaudeReviewSummary[];
}

// Set (non-empty) or clear (empty) the locally-stored Anthropic API key.
export interface SetClaudeKeyBody {
  key: string;
}

export interface ClaudeKeyResponse {
  hasUserKey: boolean;
  auth: ClaudeAuthStatus;
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
  // A newest-last rolling log of short, human-readable lines describing what the
  // agent is doing right now (tool calls, brief text snippets). Live progress
  // only — NOT persisted to the DB; rides the /status poll while running.
  recentActivity?: string[];
  // The resolved review mode, set once the router has decided (and carried through
  // the rest of the run), so the UI can show the depth while the review runs.
  reviewMode?: ReviewMode;
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
  // Review depth. Omitted / 'auto' lets the deterministic router decide; an explicit
  // 'diff_only' or 'worktree' forces that mode, overriding the router's metrics.
  mode?: RequestedReviewMode;
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
