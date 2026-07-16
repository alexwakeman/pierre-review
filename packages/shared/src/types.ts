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

// ── Third-party AI review bots ────────────────────────────────────────────────
// Pierre is "the calm layer above your review bot": it classifies which vendor an
// AI reviewer belongs to so its firehose can be triaged, not just excluded as noise.
// The kind is the vendor; display label/colour live in the frontend (lib/ui.ts
// BOT_VENDOR_META) so shared stays presentation-free.
//
// The backend cannot import this map at runtime (shared isn't shipped server-side —
// see the `REASON_PRIORITY` note in db/queries.ts), so it keeps a LOCAL copy in
// sync/bot-detection.ts; `bot-detection.test.ts` asserts the two stay in lockstep.
export type ReviewBotKind =
  | 'coderabbit'
  | 'greptile'
  | 'copilot'
  | 'qodo'
  | 'sourcery'
  | 'bito'
  | 'ellipsis'
  | 'korbit'
  | 'baz'
  | 'graphite'
  | 'cursor'
  | 'devin'
  | 'entelligence';

// Bare GitHub login (lowercased, `[bot]` suffix stripped) → vendor. Verified 2026-07
// against each vendor's GitHub Marketplace listing / a live PR (App slugs, not mention
// handles). Login churn is covered by keeping every historical variant.
//
// Deliberately EXCLUDED (verified, not oversights): coding agents that AUTHOR PRs
// rather than review them — `sweep-ai`, `copilot-swe-agent` — and dependency/CI
// automation — `dependabot`, `renovate`, `snyk-bot`, `github-actions`. Those are still
// `isBot`, just not *review* bots, so they never carry a vendor triage badge.
export const REVIEW_BOTS: Record<string, ReviewBotKind> = {
  coderabbitai: 'coderabbit',
  'greptile-apps': 'greptile',
  'copilot-pull-request-reviewer': 'copilot',
  // Qodo (formerly CodiumAI): current + historical hosted logins.
  'qodo-ai': 'qodo',
  'qodo-merge': 'qodo',
  'qodo-merge-pro': 'qodo',
  'qodo-merge-for-open-source': 'qodo',
  'codiumai-pr-agent-free': 'qodo',
  'sourcery-ai': 'sourcery',
  'bito-code-review': 'bito',
  'ellipsis-dev': 'ellipsis',
  'korbit-ai': 'korbit',
  'baz-reviewer': 'baz',
  'graphite-app': 'graphite', // Diamond posts under the shared graphite-app account
  cursor: 'cursor', // Cursor Bugbot (app slug 'cursor', NOT 'bugbot')
  'devin-ai-integration': 'devin',
  'entelligence-ai-pr-reviews': 'entelligence',
};

// Classify a login as a known AI review bot's vendor, or null. Normalises case + the
// `[bot]` suffix so it matches whether the login arrived via GraphQL (bare slug) or
// REST (`slug[bot]`).
export function reviewBotKind(login: string | null | undefined): ReviewBotKind | null {
  if (!login) return null;
  const slug = login.toLowerCase().replace(/\[bot\]$/, '');
  return REVIEW_BOTS[slug] ?? null;
}

// ── Bot-Triage Platform (WS1–WS6) ──────────────────────────────────────────────
// The neutral measurement + triage layer above ALL automated reviewers — the known
// vendors (ReviewBotKind), a team's own in-house AI reviewer, and Pierre's own Claude
// Review. See docs/PRO-PLATFORM.md / the bot-triage plan.

// ── WS1 automated-reviewer classification ────────────────────────────
export type AutomatedReviewerKind = ReviewBotKind | 'in_house' | 'pierre';
export type ClassificationConfidence = 'high' | 'medium' | 'low';
export type ClassificationSource =
  | 'manual' | 'vendor_login' | 'github_type' | 'app_attribution'
  | 'fingerprint' | 'behavioral' | 'ai_tiebreak';
export interface ReviewerClassification {
  userId: number;
  login: string;
  automated: boolean;
  kind: AutomatedReviewerKind | null;   // null when human
  label: string;                        // "CodeRabbit" | "In-house AI" | "acme-ci" | "Pierre · Claude"
  confidence: ClassificationConfidence;
  source: ClassificationSource;
  reasons: string[];
}
export interface DetectedReviewer {
  userId: number;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  classification: ReviewerClassification;
  isManualOverride: boolean;
  threadsLast90d: number;
  sampleReviewBody: string | null;
}
export interface DetectedReviewersResponse { reviewers: DetectedReviewer[]; generatedAt: string; }
export interface ReviewerOverrideBody {
  automated: boolean;
  kind?: AutomatedReviewerKind | null;
  label?: string | null;
}

// ── WS2 Pierre-own-review provenance ────────────────────────────────
export type ReviewProvenance = 'ai_verbatim' | 'human_curated';
// Surfaced per-review on PR detail; see ReviewDetail additions below.

// ── WS3 Bot ROI / utilisation analytics ─────────────────────────────
export type BotWindowKind = 'rolling_7' | 'rolling_14' | 'rolling_30' | 'sprint';
export type BotVerdict = 'keep' | 'tune' | 'kill';
export interface BotVendorTrendPoint { weekStart: string; threads: number; actedOnPct: number | null; }
export interface BotVendorAnalytics {
  kind: AutomatedReviewerKind;
  label: string;
  reviewers: number;
  threads: number;
  comments: number;
  actedOn: number;
  actedOnPct: number | null;
  untouched: number;
  oldestUntouchedDays: number | null;
  humanFollowThroughPct: number | null;
  noiseRatioPct: number | null;
  verdict: BotVerdict;
  costMonthlyUsd: number | null;
  costPerActedOnUsd: number | null;
  trend: BotVendorTrendPoint[];   // ≤12 weekly points, oldest→newest
}
export interface BotAnalyticsResponse {
  enabled: boolean;
  generatedAt: string;
  window: { kind: BotWindowKind; from: string; to: string };
  vendors: BotVendorAnalytics[];  // most-threads-first
  // `botOnlyPrs` = PRs in the account's repos in the window whose only review/comment touch was
  // automated (incl. Pierre-verbatim) — no human review AND no human comment. See getBotVendorPrs.
  totals: { threads: number; comments: number; actedOn: number; actedOnPct: number | null; untouched: number; botOnlyPrs: number };
  suggestions: BotTuningSuggestion[];  // WS6c, deterministic
}

// One PR row behind a vendor's Bot-ROI panel — the drill-down list of PRs an automated reviewer
// KIND touched in the window (GET /api/bot-analytics/:kind/prs). Deterministic, no AI, account-
// scoped; ordered most-recent-bot-activity first.
export interface BotVendorPr {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  authorId: number | null;
  state: PrState;
  githubUrl: string;
  ciStatus: CiStatus | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: string; // ISO-8601
  botThreads: number;   // review threads this vendor opened on the PR (in window)
  botComments: number;  // review comments this vendor authored on the PR (in window)
  botActedOn: number;   // of botThreads, acted-on (resolved | likely_addressed | human follow-up)
  botUntouched: number; // of botThreads, still `untouched`
  lastBotActivityAt: string | null; // ISO-8601 — max createdAt across this vendor's threads+comments
  // This PR has automated touch and NO human review AND NO human comment since it opened.
  botOnly: boolean;
}

export interface BotVendorPrsResponse {
  enabled: boolean;
  kind: AutomatedReviewerKind;
  label: string;
  window: { kind: BotWindowKind; from: string; to: string };
  prs: BotVendorPr[]; // most-recent-bot-activity first
  generatedAt: string;
}

// ── WS4 cross-bot dedup + consensus ─────────────────────────────────
export interface BotDedupMember {
  threadId: number; userId: number; kind: AutomatedReviewerKind;
  login: string; label: string; excerpt: string | null; derivedState: DerivedState;
}
export interface BotDedupCluster {
  path: string; line: number | null;
  members: BotDedupMember[];   // ≥2 members of DISTINCT kinds
  consensus: boolean;          // all same broad signal
  conflict: boolean;           // divergent severity/verdict
}
export interface BotDedupResponse { prId: number; clusters: BotDedupCluster[]; }

// ── WS6 mute / auto-triage rules + tuning ───────────────────────────
export type BotMuteAction = 'hide' | 'auto_resolve';
export interface BotMuteRule {
  id: number;
  vendorKind: AutomatedReviewerKind | null;  // null = any
  pathGlob: string | null;                   // null = any
  severity: string | null;                   // null = any
  action: BotMuteAction;
  autoResolveDays: number | null;            // only meaningful for 'auto_resolve'
  createdAt: string;
}
export interface BotMuteRuleInput {
  vendorKind?: AutomatedReviewerKind | null;
  pathGlob?: string | null;
  severity?: string | null;
  action: BotMuteAction;
  autoResolveDays?: number | null;
}
export interface BotMuteRulesResponse { rules: BotMuteRule[]; }
export interface BotTuningSuggestion {
  vendorKind: AutomatedReviewerKind; label: string;
  pathGlob: string | null; severity: string | null;
  untouchedPct: number; volume: number; rationale: string;
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
  // Whether this repo is "Watched" for the My Turn inbox: when true, new open PRs
  // (opened after the watch began) by other people are surfaced in the inbox. This is
  // independent of timeline visibility (the repoIds filter) and of removing the repo.
  inboxWatch: boolean;
}

// ---- Teams (CORE) ----
// A named grouping of an account's repos (sprint teams / product areas). A repo may belong to
// several teams (overlap allowed). `repoIds` are the member repo ids; `repoCount` is their count.
export interface Team {
  id: number;
  name: string;
  repoIds: number[];
  repoCount: number;
  createdAt: string; // ISO-8601
}

export interface TeamsResponse {
  teams: Team[];
}

// The frontend store value for the active scope selector: 'all' (every account repo), 'none'
// (repos in no team), 'teams' (the UNION of every team's repos — cross-team monitoring; differs
// from 'all', which is every account repo incl. unassigned), or a teamId (that team's repos).
// NOTE the WIRE `scope` query param is the STRING form — `'all' | 'none' | 'teams' | '<teamId>'` —
// resolved server-side by resolveScopeRepoIds.
export type TeamScope = 'all' | 'none' | 'teams' | number;

// ---- Preset prompts (declared now; implemented later by Pro + the frontend) ----
// The fixed set of one-click "ask about this scope" questions the AI answer surface offers.
export type PresetPromptKey =
  | 'attention_now'
  | 'blocked_threads'
  | 'biggest_changes'
  | 'longest_to_merge'
  | 'review_bottlenecks'
  | 'ship_ready';

export interface PresetPrompt {
  key: PresetPromptKey;
  label: string; // short user-facing button label
  question: string; // the full natural-language question sent to the model
}

// The 6 presets (the last two — review_bottlenecks + ship_ready — are the "couple more"
// beyond the four core ones).
export const PRESET_PROMPTS: PresetPrompt[] = [
  {
    key: 'attention_now',
    label: 'Needs attention',
    question: 'What needs attention now?',
  },
  {
    key: 'blocked_threads',
    label: 'Blocked threads',
    question: 'Which review threads are blocked right now?',
  },
  {
    key: 'biggest_changes',
    label: 'Biggest changes',
    question:
      'What were the biggest changes merged this sprint (largest PRs by LoC)?',
  },
  {
    key: 'longest_to_merge',
    label: 'Slowest to merge',
    question: 'Which PRs took the longest to merge?',
  },
  {
    key: 'review_bottlenecks',
    label: 'Review bottlenecks',
    question:
      'Where are the review bottlenecks — who/what is holding up merges?',
  },
  {
    key: 'ship_ready',
    label: 'Ready to ship',
    question: 'Which open PRs look ready to ship?',
  },
];

// One preset-prompt answer (Markdown), keyed by preset + the model that produced it.
export interface PresetPromptResult {
  key: PresetPromptKey;
  markdown: string;
  generatedAt: string; // ISO-8601
  model: string;
  // Resolved `owner/name#N` PR references mentioned in `markdown`, for linkification —
  // re-derived on read from the answer text (same treatment as Sprint/Retro reports), so
  // preset answers render clickable PR links/tables. Empty when the answer names no PRs.
  prRefs: DigestPrRef[];
}

// GET /api/pro/preset-prompt?key=&scope= and its refresh POST. `enabled` false = the capability
// is off (plugin absent / not entitled); `throttled` / `creditsExhausted` mirror the digest gates.
export interface PresetPromptResponse {
  enabled: boolean;
  result: PresetPromptResult | null;
  throttled?: boolean;
  creditsExhausted?: boolean;
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
  // For GitHub Actions checks, the Actions run id + job id parsed from the check's
  // detailsUrl (.../actions/runs/<runId>/job/<jobId>). Lets the frontend offer
  // "view logs" on a failed Actions check (fetched on demand via the job id) and
  // gate it off for third-party CI, which only has an external detailsUrl. null when
  // the check isn't an Actions job (or the detailsUrl isn't in that shape).
  runId: number | null;
  jobId: number | null;
}

// On-demand failed-check log tail (GET /api/prs/:id/checks/:jobId/logs). Logs are
// fetched live from the GitHub Actions API, never stored. `available` is false when
// the logs can't be retrieved (expired after ~90 days, the job was re-run, or the
// token lacks actions:read) — `reason` explains why. `text` is the LAST `returnedLines`
// lines of the log; `totalLines` is the full count so the UI can say "last N of M".
export interface CheckLogsResponse {
  available: boolean;
  reason?: string;
  text: string;
  totalLines: number;
  returnedLines: number;
}

// Re-trigger a GitHub Actions workflow run for a PR (POST /api/prs/:id/ci/rerun).
// 'failed' reruns only the failed jobs of the run (/rerun-failed-jobs); 'all' reruns
// the whole run from scratch (/rerun). Requires repo write access (re-checked
// server-side); works local + cloud via the per-account token.
export type CiRerunMode = 'failed' | 'all';

export interface CiRerunBody {
  // The Actions run id to rerun (CheckRun.runId; null-runId checks aren't rerunnable).
  runId: number;
  mode: CiRerunMode;
}

export interface CiRerunResult {
  status: 'queued';
  runId: number;
  mode: CiRerunMode;
}

// Request reviewers on a PR (POST /api/prs/:id/request-reviewers). userIds are
// resolved to GitHub logins server-side (bots + the PR author dropped); requires repo
// write access (re-checked server-side). Powers the Insights "Assign reviewers" action
// AND the CORE PR-detail "Suggested reviewers" assign. At least one of the three arrays
// must be non-empty. `userIds` are resolved to logins; `logins` are sent through as-is
// (for suggested reviewers we haven't synced as users); `teamSlugs` become team review
// requests (`team_reviewers`) — a CODEOWNERS `@org/team` requestable without expanding
// its membership.
export interface RequestReviewersBody {
  userIds?: number[];
  logins?: string[];
  teamSlugs?: string[];
}

export interface RequestReviewersResult {
  status: 'ok';
  requestedLogins: string[]; // logins actually sent to GitHub (after filtering)
}

// ---- PR merge (CORE / free tier) — a merge control next to Approve ----
// GitHub's three merge methods. 'squash' is squash-and-merge; 'rebase' is rebase-and-merge.
export type MergeMethod = 'merge' | 'squash' | 'rebase';

// What the merge control needs, fetched lazily (GET /api/prs/:id/merge-options) so the hot
// PR-detail path isn't slowed by a live GitHub call. allowedMethods/defaultMethod come from
// the repo's own settings; the rest is GitHub's live mergeability.
export interface PrMergeOptions {
  allowedMethods: MergeMethod[]; // the repo's enabled merge methods (GitHub order)
  defaultMethod: MergeMethod; // the first allowed method — the pre-selected default
  mergeable: boolean | null; // GitHub's async mergeable flag (null = still computing)
  mergeStateStatus: string; // clean / dirty / behind / blocked / unstable / unknown / …
  conflicts: boolean; // mergeable===false or dirty → conflicts with the base
  behind: boolean; // the head branch is behind the base (an "Update branch" is available)
  blocked: boolean; // branch protection unmet (required reviews/checks) → merge disabled
  behindBy: number; // commits the head is behind the base
  baseRef: string; // the base (trunk) branch name
  // Whether an "Update branch from trunk" is offerable now (behind AND not conflicting).
  canUpdateBranch: boolean;
  // Whether a REBASE-from-trunk is available (local mode only — GitHub's native update-branch
  // can only merge trunk in). When false the update-from-trunk is merge-only.
  canRebaseUpdate: boolean;
}

export interface MergePrBody {
  method: MergeMethod;
}
export interface MergePrResult {
  merged: boolean;
  sha: string | null; // the merge commit SHA GitHub created
  state: 'merged';
}

// Update the PR's branch from the base/trunk before merging. strategy 'rebase' is local-only
// (clone-based); 'merge' works everywhere (native GitHub update-branch in cloud). No conflict
// resolution in the free tier — a conflicting PR returns 409 with { conflicts: true }.
export interface UpdateBranchBody {
  strategy?: 'rebase' | 'merge';
}
export interface UpdateBranchResult {
  ok: true;
  headSha: string | null; // the new head SHA after the update (null when GitHub-native)
  strategy: 'rebase' | 'merge';
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
  // The user's GitHub display name (the `name` field from `gh api user` / OAuth).
  // null when GitHub has no name set; the UI falls back to the login. Shown wherever
  // the signed-in identity appears (header, greeting) in place of the @handle.
  displayName: string | null;
}

export interface MyTurnCounts {
  awaitingReview: number;
  yourPrsActivity: number;
  // Your authored, still-open PRs that have a standing approval (ready to merge).
  approvedPrs: number;
  threadsAwaiting: number;
  // New open PRs by others in repos you've Watched (opened after the watch began),
  // not yet dismissed. 0 when no repos are watched.
  watchedRepoPrs: number;
  // Completed Claude reviews not yet actioned (no comments/review posted). Always 0
  // when Claude Review is disabled (cloud / flag off).
  claudeReviewsToAction: number;
}

// Premium (@pierre/pro) capability map, mirrored from a backend singleton the
// plugin populates at boot. All-false in OSS mode (plugin absent). Flows to the
// frontend through /api/me exactly like claudeReviewEnabled.
export interface ProCapabilities {
  activityDigest: boolean; // per-repo LLM headlines digest (Activity)
  reviewMemory: boolean; // Claude Review learnings
  // AI Fix (packages/pro/ai-fix). Two independent gates so the cheap, read-only
  // analysis can ship without the expensive, write-capable fixer:
  aiAnalysis: boolean; // CI failure analysis (Haiku, read-only) + the AI-Fix Analysis tab
  // Per-PR AI summary (cheap Haiku, read-only). Split OUT of aiAnalysis so it can ship on the
  // cheap SUMMARY tier (on in cloud, credit-metered) while CI-analysis + the fixer stay on the
  // pro+ advanced-AI tier. On whenever the digest/summary tier is on (or advanced AI is).
  prSummary: boolean;
  aiFix: boolean; // agentic inline code fix + push (Agent SDK, needs write access)
  teamInsights: boolean; // team review-intelligence "Insights" (no AI; pure reads)
  // Agentic Claude Review (Agent SDK). The product lives in the plugin (routes/manager/
  // prompts); the SDK-run infra + tables stay in core behind the ctx.review seam. Gated
  // by PRO_ADVANCED_AI_ENABLED (formerly PRO_CLAUDE_REVIEW_ENABLED, kept as an alias); all-false
  // in cloud / OSS. The frontend hides the tab/banner when false. This flag now gates the whole
  // "pro+" AI tier — aiAnalysis + aiFix + claudeReview flip together.
  claudeReview: boolean;
  // Slack digest delivery (Pro): a per-account webhook receives the freshly-generated sprint +
  // repo digest on a cadence. The report is AI-generated (Haiku), so this mirrors activityDigest.
  slackDigest: boolean;
  // Jira/Linear ticket-link enrichment in PR detail (Pro; no AI, no env flag — on whenever the
  // plugin is active locally, like activityDigest). Config (provider + base URL) lives in pro_settings.
  issueLinks: boolean;
}

export interface MeResponse {
  user: LocalUser | null;
  counts: MyTurnCounts;
  // Server-side Activity-Feed "seen" marker: when the account last viewed the feed
  // (ISO, null until the first view), and how many "My Turn" feed items are new
  // since then. Drives the Welcome-back banner (server-truth, consistent across devices).
  feedLastSeenAt: string | null;
  newFeedItems: number;
  // (Claude Review is now the Pro `pro.claudeReview` capability — the old top-level
  // `claudeReviewEnabled` flag was removed; read it off `pro` instead.)
  // Deployment mode. 'cloud' tells the SPA to show a sign-out control and treat a
  // 401 from /api/me as "signed out" (vs local, where /api/me never 401s).
  deploymentMode: 'local' | 'cloud';
  // Premium capability flags (all-false in OSS mode).
  pro: ProCapabilities;
  // Orgs whose sync is currently BLOCKED because the sign-in token isn't authorized for their
  // SAML SSO (cloud). Populated by the sync when it hits the SAML wall; drives the global
  // "Reconnect GitHub for <org>" banner. Empty in the normal case + always empty in local mode.
  authNotices: AuthNotice[];
}

// ---- Pro per-account settings (packages/pro `pro_settings`; via GET/PUT /api/pro/settings) ----
export type SlackDigestCadence = 'off' | 'daily' | 'twice_daily';
export type AiUpdateMode = 'manual' | 'interval' | 'on_change';
export type IssueProvider = 'jira' | 'linear';

// Read shape (GET /api/pro/settings). The Slack webhook URL is WRITE-ONLY — never returned;
// `slack.configured` reflects only whether one is stored.
// How the Insights flow-metrics + sprint report frame their comparison window:
//  - 'rolling_7' / 'rolling_14': the trailing N days vs the immediately-preceding N days. No sprint
//    needed; always a full window (no "day-1 cliff"), good for teams that don't run sprints.
//  - 'sprint': like-for-like by SPRINT POSITION — this sprint SO FAR vs the SAME elapsed slice of
//    the previous sprint. Requires a configured sprint (start + cadence); with none it falls back
//    to 'rolling_14'.
export type SprintComparisonMode = 'rolling_7' | 'rolling_14' | 'sprint';

export interface ProSettings {
  // Sprint that defines the Insights metrics window. cadenceDays = sprint length; the current
  // sprint auto-rolls (start + N whole cadence-lengths up to today). Open PRs always count.
  // `comparisonMode` picks the window model (default 'rolling_14'); 'sprint' uses cadence+start.
  sprint: {
    cadenceDays: number | null;
    startDate: string | null; // ISO (date @ midnight); null = no sprint configured
    comparisonMode: SprintComparisonMode;
  };
  slack: {
    configured: boolean;
    cadence: SlackDigestCadence;
    hour1: number; // 0-23, local to `timezone`
    hour2: number; // second daily send, used only for 'twice_daily'
    timezone: string | null; // IANA tz; null = server tz
  };
  aiUpdate: { mode: AiUpdateMode; intervalMinutes: number };
  // provider/baseUrl configure the deep-link target; projectKeys is an optional allowlist of
  // project prefixes (e.g. ['ENG','PROJ']) — when non-empty, ONLY keys with a listed prefix are
  // detected (near-zero false positives). Empty → heuristic detection.
  issue: { provider: IssueProvider | null; baseUrl: string | null; projectKeys: string[] };
  // Bot-Triage Platform (WS8 control surface). Toggles + scalars for detection, Pierre
  // tagging, Slack bot digest, standing auto-resolve, and per-vendor cost.
  bots: {
    inhouseDetect: boolean;
    autoTagHighConfidence: boolean;
    loginAllowlist: string[];
    deepDetect: boolean;        // WS1f app-attribution REST enrich
    aiTiebreak: boolean;        // WS1.6 Haiku medium-band tie-break
    tagPierreReviews: boolean;  // WS2a/b
    pierreFooter: boolean;      // WS2c visible footer
    slackDigest: boolean;       // WS5
    autoResolve: boolean;       // WS6b master enable
    autoResolveDays: number;
    cost: { kind: AutomatedReviewerKind; monthlyUsd: number }[];  // WS3b
  };
}

// Write shape (PUT /api/pro/settings) — a partial patch; only present sections/fields change.
// `slack.webhookUrl` is write-only ('' clears it).
export interface ProSettingsUpdate {
  // Pass startDate:null + cadenceDays:null to CLEAR the sprint (disable sprints entirely → the
  // metrics fall back to a rolling window). comparisonMode switches the window model.
  sprint?: {
    cadenceDays?: number | null;
    startDate?: string | null;
    comparisonMode?: SprintComparisonMode;
  };
  slack?: {
    webhookUrl?: string;
    cadence?: SlackDigestCadence;
    hour1?: number;
    hour2?: number;
    timezone?: string | null;
  };
  aiUpdate?: { mode?: AiUpdateMode; intervalMinutes?: number };
  // projectKeys: an allowlist of project prefixes; [] / null clears it (→ heuristic detection).
  issue?: { provider?: IssueProvider | null; baseUrl?: string | null; projectKeys?: string[] | null };
  // Bot-Triage settings patch (WS8). Only present fields change.
  bots?: {
    inhouseDetect?: boolean; autoTagHighConfidence?: boolean; loginAllowlist?: string[];
    deepDetect?: boolean; aiTiebreak?: boolean; tagPierreReviews?: boolean; pierreFooter?: boolean;
    slackDigest?: boolean; autoResolve?: boolean; autoResolveDays?: number;
    cost?: { kind: AutomatedReviewerKind; monthlyUsd: number }[];
  };
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
  // Standing review state, derived from each reviewer's LATEST decisive review,
  // independent of CI / mergeability. Drive the review-status outline on open timeline
  // bars (green = approved, red = changes requested). Mutually exclusive: a PR with any
  // blocking changes_requested is `isChangesRequested` (never `isApproved`). Always
  // present; the UI only emphasises them on open PRs.
  isApproved: boolean;
  isChangesRequested: boolean;
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

// ---- insights (per-repo team/sprint stats) ----

// Open review-requests still pending for one reviewer in a repo — the review-load
// signal that surfaces a bottleneck reviewer.
export interface RepoReviewLoad {
  userId: number;
  pending: number;
}

// One open PR in the Insights per-repo list. Independent of the timeline filters
// (the panel has its own Stale toggle), so isStalled is carried per row.
export interface InsightsOpenPr {
  prId: number;
  number: number;
  title: string;
  authorId: number | null;
  isDraft: boolean;
  isStalled: boolean;
  openedAt: string;
  githubUrl: string;
}

// One weekly bucket of the per-repo "average time a PR stays open" trend. The
// metric is PR CYCLE TIME bucketed by CLOSE week: over PRs merged/closed in this
// week, the mean (closedAt − openedAt). `avgOpenHours` is null for a week with no
// merged/closed PRs (the chart shows a gap / bridges it). Buckets span
// InsightsResponse.chartWindowDays back from now, oldest first.
export interface InsightsTimePoint {
  // ISO timestamp for the start of the weekly bucket.
  bucketStart: string;
  // Mean hours a PR stayed open, over PRs closed in this bucket. null = no sample.
  avgOpenHours: number | null;
  // How many merged/closed PRs fell in this bucket (the average's sample size).
  count: number;
}

// A per-repo snapshot for the Insights panel. Counts are current state; the
// time-windowed figures carry their window in InsightsResponse. Per repo only
// (no cross-repo/team aggregation yet).
export interface RepoInsights {
  repoId: number;
  repoFullName: string;
  // Currently-open PRs, split by draft.
  openPrs: number;
  draftPrs: number;
  // PRs merged within InsightsResponse.mergedWindowDays.
  mergedLast7d: number;
  // Open PRs flagged stalled (open threads + no recent commit; see stallThresholdDays).
  stalledPrs: number;
  // Median hours from open → first review, over PRs opened within reviewWindowDays
  // that have received a review. null when there's no sample.
  medianHoursToFirstReview: number | null;
  // The oldest currently-open, non-draft PR with no review yet — the thing most at
  // risk of falling through the cracks. null when every open PR has a review.
  oldestUnreviewed: {
    prId: number;
    number: number;
    title: string;
    openedAt: string;
    githubUrl: string;
  } | null;
  // Reviewers with the most pending review-requests (top few, desc). userId resolves
  // against the global user list (GET /api/users).
  reviewLoad: RepoReviewLoad[];
  // ALL currently-open PRs in this repo (oldest first; capped), independent of the
  // timeline filters — the collapsible per-repo list with its own Stale toggle. Each
  // carries isStalled so the client can filter without another round-trip.
  openPrList: InsightsOpenPr[];
  // Weekly "average time a PR stays open" trend (cycle time by close week) over
  // InsightsResponse.chartWindowDays, oldest first. One point per week.
  openDurationTrend: InsightsTimePoint[];
}

export interface InsightsResponse {
  repos: RepoInsights[];
  // Window descriptors so the UI copy stays in sync with the server's windows.
  mergedWindowDays: number;
  reviewWindowDays: number;
  stallThresholdDays: number;
  // Span (days, back from now) covered by each repo's openDurationTrend; weekly buckets.
  chartWindowDays: number;
  generatedAt: string;
}

// ---- Repo analytics drill-down (GET /api/insights/:repoId/analytics) ----
// A heavier, on-demand per-repo bundle of chart series, loaded only when the
// drill-down panel opens. Every WEEKLY series is an array aligned 1:1 to
// `weekBuckets` (index i ↔ weekBuckets[i], oldest first); distribution series are
// labelled bins; the scatter + heatmap carry their own shapes.

// A labelled histogram bin (a categorical bar).
export interface AnalyticsBin {
  label: string;
  count: number;
}

// One PR in the size-vs-cycle-time scatter.
export interface SizeCyclePoint {
  prNumber: number;
  loc: number; // additions + deletions
  hoursOpen: number; // close − open
  merged: boolean; // merged vs closed-without-merge
}

// Median time-open per LOC bucket, over PRs closed in the window — surfaces whether
// review time scales (super-linearly) with PR size. medianHours is null for an empty
// bucket. Buckets share the labels of `sizeDist`, ordered XS→XL.
export interface SizeCycleBucket {
  label: string;
  medianHours: number | null;
  count: number;
}

// Per-reviewer weekly review counts (reviews submitted), aligned to weekBuckets.
export interface ReviewerLoadSeries {
  userId: number; // resolves against GET /api/users
  total: number;
  weekly: number[];
}

export interface RepoAnalytics {
  repoId: number;
  repoFullName: string;
  windowDays: number;
  stallThresholdDays: number;
  generatedAt: string;
  // Shared x-axis for every weekly series: ISO bucket-start, oldest first.
  weekBuckets: string[];

  // Flow & throughput
  throughput: { opened: number[]; merged: number[]; closed: number[] };
  // Backlog of open PRs at each week's end, with the stalled subset (open + no
  // commit within stallThresholdDays at that snapshot).
  backlog: { open: number[]; stalled: number[] };

  // Speed & latency
  // Median hours open→first-review for PRs OPENED each week (null = no sample).
  reviewLatencyTrend: { medianHours: (number | null)[]; count: number[] };
  // Cycle time decomposed for PRs CLOSED each week: open→first-review and
  // first-review→close (mean hours; 0 when count is 0).
  cycleBreakdown: { toFirstReview: number[]; reviewToMerge: number[]; count: number[] };
  // Distribution of time-to-first-review across PRs first-reviewed in the window.
  reviewLatencyDist: AnalyticsBin[];

  // Review health
  // Review threads by derived state, bucketed by the thread's createdAt week.
  threadMix: {
    resolved: number[];
    likely_addressed: number[];
    replied_unresolved: number[];
    untouched: number[];
  };
  // Submitted reviews by verdict, bucketed by submittedAt week.
  reviewVerdicts: {
    approved: number[];
    changes_requested: number[];
    commented: number[];
    dismissed: number[];
  };
  // Reviews given per reviewer per week (top reviewers; rest folded into an
  // `others` row with userId = null-sentinel -1).
  reviewerLoad: ReviewerLoadSeries[];

  // Size & risk
  sizeDist: AnalyticsBin[]; // PRs opened in window, by LOC bucket
  sizeVsCycle: SizeCyclePoint[]; // PRs closed in window (capped)
  sizeCycleByBucket: SizeCycleBucket[]; // median time-open per LOC bucket (all closed)

  // Cadence: activity counts by weekday×hour (UTC), row-major dow*24+hour,
  // dow 0=Sunday. Length 168.
  activityHeatmap: number[];

  // CI recovery (from the ci_status_events transition log), per weekly bucket (aligned to
  // weekBuckets): the median hours a PR head spent red before CI went green again that week,
  // plus how many recoveries (incidents) resolved in the week. medianHours null = no sample.
  // Empty array when the repo has no CI transition history yet.
  ciRecovery: { weekStart: string; medianHours: number | null; incidents: number }[];
  // Top CI failure reasons over the window, by failing check/stage name (desc). Empty when
  // there's no CI transition history.
  ciFailuresByStage: { stage: string; count: number }[];
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
  // For review_comment markers: the derived state of the thread this comment
  // belongs to (resolved / likely_addressed / replied_unresolved / untouched),
  // so the timeline's "Threads" filter can narrow markers to a specific state
  // rather than showing every comment on a matching PR. null for other events.
  derivedState: DerivedState | null;
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
  // Bot-triage (compute-on-read in getPrDetail): when the review's author is classified
  // automated, the vendor/in_house/pierre kind (else absent/null → a human review).
  automatedKind?: AutomatedReviewerKind | null;
  // Set ONLY for kind==='pierre' — whether the posted body was Claude's verbatim summary
  // ('ai_verbatim') or a materially human-edited review ('human_curated').
  provenance?: ReviewProvenance | null;
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

// A Jira/Linear ticket reference detected in a PR (compute-on-read by the Pro enricher, from
// the PR title + head branch). Rendered as a link chip in the PR-detail Overview.
export interface TicketRef {
  key: string; // e.g. "PROJ-123"
  url: string; // deep link into the configured Jira/Linear workspace
  provider: IssueProvider;
}

export interface PrDetail {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  // Jira/Linear ticket links (Pro, compute-on-read via registerPrDetailEnricher). Tri-state:
  //   null → feature off or no provider configured (render nothing)
  //   []   → provider configured but no ticket key found (render a muted "No ticket found")
  //   [..] → render a link chip per detected ticket
  tickets: TicketRef[] | null;
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
  // Whether the viewer may approve this PR: they have GitHub WRITE/MAINTAIN/ADMIN
  // permission on the repo AND are not the PR's author. Computed on read from the
  // synced repos.viewerPermission + the account's user id. The approve route
  // re-checks this server-side.
  viewerCanApprove: boolean;
  // Whether the viewer may PUSH to the repo: they have GitHub WRITE/MAINTAIN/ADMIN
  // permission on the repo. Unlike viewerCanApprove this does NOT exclude the author
  // (an author can push to their own PR branch). Gates the Pro "AI Fix" push
  // controls; the push route re-checks server-side. Computed on read from the synced
  // repos.viewerPermission.
  viewerCanPush: boolean;
  // Whether the viewer's STANDING review on this PR (their latest decisive review:
  // approved / changes_requested / dismissed) is 'approved'. When true the Approve
  // control renders disabled ("Approved") — you've already approved and it still
  // stands. Distinct from viewerCanApprove (the right to approve at all).
  viewerHasApprovedStanding: boolean;
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
  // Set (cloud) when on-demand hydration was BLOCKED by the repo owner's org policy — the
  // GitHub token authenticates but isn't authorized for that org, so the description, CI
  // jobs, comment bodies etc. couldn't be fetched. The SPA renders a "why is this blank +
  // how to fix" banner. null when hydration succeeded (the normal case).
  authNotice?: AuthNotice | null;
}

// Why a PR's on-demand detail couldn't be fully hydrated in cloud (an org authorization
// wall, not a bug). `org` is the repo owner whose policy blocked the token.
export interface AuthNotice {
  kind: 'saml_sso';
  org: string;
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

// A PR you authored that is still open and has a standing approval — at least one
// approving review and no outstanding changes-requested. I.e. someone approved your
// PR, so it's likely ready to merge. `approvals` is how many reviewers approved;
// mergeable/mergeStateStatus let the row hint whether GitHub would actually let it
// merge yet (it's shown even when blocked — the approval itself is the signal).
export interface ApprovedPrItem extends MyTurnPr {
  approvals: number;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
}

// A new open PR (by someone other than you, non-draft) in a repo you've Watched,
// opened after the watch began. Surfaced so new work in repos you care about doesn't
// get missed. Dismissing one is sticky (it acknowledges that specific PR); unwatching
// the repo hides all of them, re-watching restores them.
export type WatchedRepoPrItem = MyTurnPr;

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
  // Full markdown of the awaiting reply; null on rows synced lean before full-body
  // persistence — the consumer falls back to `lastReplyExcerpt`.
  lastReplyBody: string | null;
  lastReplyAt: string;
  lastReplyAuthorId: number | null;
  githubUrl: string;
}

// A completed Claude review that hasn't been actioned yet — no GitHub review/
// comments posted from it. Surfaced in My Turn so finished reviews don't get
// forgotten. headStale = the reviewed head no longer matches the PR's head.
export interface ClaudeReviewToAction {
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  verdict: ClaudeReviewVerdict | null;
  finishedAt: string | null;
  headStale: boolean;
  githubUrl: string;
}

export interface MyTurnResponse {
  awaitingReview: AwaitingReviewItem[];
  yourPrs: YourPrActivityItem[];
  // Your authored, open PRs with a standing approval (ready to merge). Deduped
  // against `yourPrs` — an approved PR shows here, not under "new activity".
  approvedPrs: ApprovedPrItem[];
  threadsAwaiting: ThreadAwaitingItem[];
  // New open PRs by others in repos you've Watched (deduped against the sections
  // above). Empty when no repos are watched.
  watchedRepoPrs: WatchedRepoPrItem[];
  // Completed Claude reviews awaiting action (empty when Claude Review is disabled).
  claudeReviewsToAction: ClaudeReviewToAction[];
  // Users referenced by any row, for client-side lookup.
  users: User[];
}

// ---- my turn: completed / dismissed (the "Done" tab) ----
// Previously-dismissed entries, for the My Turn "Done" tab (past 90 days). Only the
// dismissal-backed kinds appear here (review_request + thread + claude_review, from
// myTurnDismissals) — "Your PRs" are cleared via mark-viewed, not a restorable
// dismissal. Each carries when it was dismissed and can be moved back to the inbox
// ("To do" = un-dismiss).
// Whether un-dismissing ("To do") would actually return the entry to the inbox.
// The inbox is derived live from GitHub state, so an entry whose PR has since been
// merged/closed (or thread resolved, or Claude run superseded) can no longer be
// actioned: restoring it would be a silent no-op. The UI shows a working "To do"
// button only when `restorable`, else a static `reason` chip ("PR merged", …).
interface Restorability {
  restorable: boolean;
  // Why it can't be restored; present only when `restorable` is false.
  reason?: string;
}

export interface DismissedReviewItem extends MyTurnPr, Restorability {
  kind: 'review_request';
  dismissedAt: string;
}

export interface DismissedThreadItem extends ThreadAwaitingItem, Restorability {
  kind: 'thread';
  dismissedAt: string;
}

// A dismissed Claude review (local-only feature). Keyed by the run id; opening it
// jumps to the PR's Claude Review tab, "To do" restores it to the inbox (only if it
// is still that PR's most-recent unposted run).
export interface DismissedClaudeReviewItem extends Restorability {
  kind: 'claude_review';
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  verdict: ClaudeReviewVerdict | null;
  githubUrl: string;
  dismissedAt: string;
}

// A dismissed watched-repo PR. Opening it loads the PR; "To do" restores it to the
// inbox (only if the PR is still open and the repo is still watched).
export interface DismissedWatchedRepoPrItem extends MyTurnPr, Restorability {
  kind: 'watched_repo_pr';
  dismissedAt: string;
}

// A dismissed "your PR was approved" entry. Opening it loads the PR; "To do" restores
// it (only while the PR is still open and approved).
export interface DismissedApprovedPrItem extends MyTurnPr, Restorability {
  kind: 'pr_approved';
  dismissedAt: string;
}

export type DismissedItem =
  | DismissedReviewItem
  | DismissedThreadItem
  | DismissedWatchedRepoPrItem
  | DismissedApprovedPrItem
  | DismissedClaudeReviewItem;

export interface DismissedMyTurnResponse {
  items: DismissedItem[];
  // Users referenced by any item, for client-side lookup.
  users: User[];
}

// ---- my turn: activity Feed (watched repos, last 14 days) ----
// One activity entry in the watched-repo Feed. A denormalized, render-ready view of
// an `events` row (commit pushes excluded) — the frontend mirrors these into an
// append-only IndexedDB store. `id` is the stable `events.id`, used to dedupe on
// merge. Excludes `commit_pushed`; includes `pr_ready_for_review` / `pr_reopened`.
export interface FeedEvent {
  id: number;
  type: EventType;
  occurredAt: string;
  repoId: number;
  repoFullName: string;
  prId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  prState: PrState | null;
  actorId: number | null;
  // The underlying entity row id (for the timeline "Show" deep link).
  refId: number | null;
  // review_submitted → the verdict (approved / changes_requested / …); else null.
  reviewState: ReviewState | null;
  // review_comment / pr_comment → a short preview of the comment; else null.
  // (Kept for the legacy IndexedDB activity mirror.)
  excerpt: string | null;
  // Full markdown body for text events (review_comment / pr_comment /
  // review_submitted); null for non-text events. Null on rows synced lean before
  // full-body persistence — the consumer falls back to `excerpt`.
  content: string | null;
}

export interface FeedResponse {
  events: FeedEvent[];
  // Actors referenced by any entry, for client-side login/avatar lookup.
  users: User[];
}

// ---- request payloads ----

export interface CreateRepoBody {
  owner: string;
  name: string;
  // When true, the repo is also Watched for the My Turn inbox on add (the picker
  // passes true for repos that are "yours" — owned or org-member).
  watch?: boolean;
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
// on a newer reply; a claude_review reappears when a newer review run finishes
// (the dismissal is keyed by the run's id, so a fresh run is a new entry); a
// pr_approved reappears when a NEWER approval lands (compared against the latest
// approving review's timestamp — not the PR's updatedAt, which any commit bumps).
// A watched_repo_pr dismissal is sticky — it acknowledges that specific new PR and
// does not resurface on activity (the PR leaves the inbox for good once dismissed,
// or when it's merged/closed).
export type MyTurnDismissKind =
  | 'review_request'
  | 'thread'
  | 'watched_repo_pr'
  | 'pr_approved'
  | 'claude_review';

export interface MyTurnDismissBody {
  kind: MyTurnDismissKind;
  // PR id for review_request, watched_repo_pr and pr_approved; thread id for thread;
  // Claude-review run id for claude_review.
  refId: number;
}

export interface UpdateUserBody {
  isBot: boolean;
}

export interface TimelineQuery {
  from?: string;
  to?: string;
  repoIds?: string; // comma-separated
  // comma-separated PR ids. When present (non-empty), returns EXACTLY those PRs + all their
  // events, bypassing every other filter — a pr-focus tab uses this so its subject PR loads
  // regardless of the board's repo/date/status filters. Account-scoped server-side.
  prIds?: string;
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
  // comma-separated user ids of bots to KEEP visible even when excludeBots is on — the
  // per-repo "allowed bots" override (some bots are important to always see). Ignored
  // when excludeBots is false. Absent = no allow-list (exclude every bot).
  allowBotIds?: string;
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
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

// Runtime list for the model picker (frontend bundles shared; the backend keeps a
// local copy and only `import type`s from here — shared isn't shipped at runtime).
// Ordered by recommendation (the DEFAULT first): Sonnet 5 is near-Opus quality at
// Sonnet cost — the best-value default; Opus 4.8 stays for the hardest runs; Sonnet
// 4.6 for continuity; Haiku 4.5 is the cheap fast option — ideal for a quick pass on
// a small/bounded diff; it does not accept the `effort` knob, so it runs at the
// model's own default thinking depth.
export const CLAUDE_REVIEW_MODELS: ClaudeReviewModel[] = [
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

// Friendly labels (with a short cost/quality hint) for the model picker.
export const CLAUDE_REVIEW_MODEL_LABELS: Record<ClaudeReviewModel, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5 (best value)',
  'claude-opus-4-8': 'Claude Opus 4.8 (most thorough)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5 (fast, cheap)',
};

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
  // false ⇒ couldn't map onto an addable diff line → can't post on its own line.
  anchored: boolean;
  // Whether the finding's file is part of the PR's diff. true ⇒ an unanchored
  // finding posts inline on the file's first change; false ⇒ the file is outside the
  // PR's diff (e.g. a deep review on an unchanged file) so it posts as a standalone
  // PR-level comment. (Anchored findings are always fileInDiff.)
  fileInDiff: boolean;
  // The user ticked this finding to post it as an inline comment.
  included: boolean;
  postedAt: string | null;
  githubCommentId: string | null;
  // How a posted comment was attached: 'inline' (a review comment on a diff line)
  // or 'pr_comment' (a standalone PR-level issue comment, for an unanchored finding
  // posted individually). null until posted; drives the GitHub permalink scheme
  // (#discussion_r vs #issuecomment).
  postedCommentKind: 'inline' | 'pr_comment' | null;
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
  // Cache-token split — on a multi-turn run the input is mostly cache reads, the
  // dominant cost the plain inputTokens figure hid. Null on older/uncaptured runs.
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  // Full noise-stripped diff size (chars) + whether the diff-size cap truncated the
  // prompt — for cost-comparing capped vs uncapped runs. Null on older runs.
  diffBytes: number | null;
  diffCapped: boolean | null;
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
  // The per-review USD budget cap a run will use (the user's local override, or the
  // operator default when unset) and the hard ceiling the user can set it to. Local
  // mode only; meaningless (and ignored) in cloud.
  reviewBudgetUsd: number;
  reviewBudgetMax: number;
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

// Set (a positive number, clamped server-side to the max) or clear (null → operator
// default) the local per-review budget cap.
export interface SetReviewBudgetBody {
  usd: number | null;
}

export interface ReviewBudgetResponse {
  reviewBudgetUsd: number;
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
  // Live, cumulative token usage + a running cost ESTIMATE (from a per-model price
  // table — the persisted run uses the SDK's authoritative cost). Present once the
  // agent has produced at least one turn. Live-only; not persisted.
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

export interface ClaudeReviewStatusResponse {
  status: ClaudeReviewStatus | 'idle';
  reviewId: number | null;
  progress: ClaudeReviewProgress | null;
}

// Server-Sent-Events payload streamed by GET /api/prs/:id/claude-review/stream.
// A `snapshot` is sent once on connect (the current state), `progress` on every
// phase/activity/usage change while the run is live, and a single terminal `done`
// (carrying the persisted final status) right before the stream closes. This is
// the real-time replacement for polling the /status endpoint.
export type ClaudeReviewStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      status: ClaudeReviewStatus | 'idle';
      reviewId: number | null;
      progress: ClaudeReviewProgress | null;
    }
  | { type: 'done'; status: ClaudeReviewStatus | 'idle'; reviewId: number | null };

// A finding whose file isn't part of the PR's diff (e.g. a deep review flagging an
// unchanged file). It can't anchor to a diff line, so it posts as a standalone
// PR-level (issue) comment, marked as outside the PR's diff.
export interface PostReviewPrComment {
  findingId: number;
  path: string;
  body: string;
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
  // Findings whose file isn't in the PR diff — posted as standalone PR-level
  // comments alongside the review (not dropped).
  prComments: PostReviewPrComment[];
}

export interface PostReviewResult {
  postedReviewId: string | null;
  postedAt: string;
  postedCommentCount: number;
  // Number of findings posted as standalone PR-level comments (file outside the diff).
  prCommentCount: number;
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

// ---- AI Fix (Pro: PR summary + CI failure analysis + agentic inline fix) ----
// A Pro-only suite (packages/pro/ai-fix). Two cheap read-only tools (PR summary, CI
// failure analysis via Haiku) plus an Agent-SDK run that MODIFIES files in a cloned
// worktree, captures a unified-diff patch, and — with repo write access — pushes to
// the PR's head branch or a new branch (opening a PR). All wire types mirror the
// Claude Review shapes above; the backend keeps local `import type`s (shared isn't
// shipped at runtime).

// The fixer reuses the Claude Review model set.
export type AiFixModel = ClaudeReviewModel;

// ---- read-only analyses (aiAnalysis capability) ----

export interface PrSummaryResponse {
  enabled: boolean;
  // The generated overview (markdown), or null if never generated.
  summary: string | null;
  model: string | null;
  // The head SHA the summary was generated against; lets the UI flag staleness.
  headSha: string | null;
  generatedAt: string | null;
  // Metered (paid cloud) plan out of credits: generation is refused and the last summary is
  // served unchanged. Absent (undefined) for unmetered/local accounts. Drives the disabled
  // Generate button + "out of credits" note (mirrors the digest/sprint report).
  creditsExhausted?: boolean;
}

// An honesty score: how confident the analysis is (in the root cause, and in whether
// Pierre's agentic fixer could actually fix it). Drives how much the report elaborates.
export type AiConfidence = 'high' | 'medium' | 'low';

export interface CiAnalysisResponse {
  enabled: boolean;
  // The root-cause + potential-fixes report (markdown), or null if never generated.
  analysis: string | null;
  model: string | null;
  headSha: string | null;
  generatedAt: string | null;
  // Whether the PR currently has failing CI (drives whether the tool is offered).
  hasFailures: boolean;
  // How sure the analysis is about the root cause.
  rootCauseConfidence: AiConfidence | null;
  // How likely Pierre's agentic fixer (edit repo files + push) could fix it, given the
  // available context. Low for external/quality-gate/unknown causes.
  fixability: AiConfidence | null;
}

// One failing check the client asks the analyzer to consider. `jobId` is the GitHub
// Actions job id (null for external checks like SonarCloud, which carry no Actions
// log). Passing the NAME too lets the analyzer reason about failing checks it can't
// fetch logs for (a code-analysis gate) instead of treating them as "no output".
export interface FailingCheckInput {
  name: string;
  jobId: number | null;
  state: string;
}

// Body for POST …/ci-analysis — the full set of failing checks from the client
// (pr.checkRuns), since the checkRuns JSON is lean-gated in the DB.
export interface GenerateCiAnalysisBody {
  checks: FailingCheckInput[];
}

// ---- the agentic fixer (aiFix capability) ----

export type AiFixStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

// What seeded the fix prompt: the stored CI analysis, the latest Claude review, or a
// plain request (summary/description only).
export type AiFixSeed = 'ci_analysis' | 'review' | 'plain';

export type AiFixPhase =
  | 'fetching_diff'
  | 'cloning'
  | 'fixing'
  | 'capturing'
  | 'persisting';

export interface AiFixProgress {
  phase: AiFixPhase;
  message?: string;
  // Newest-last rolling log of short lines describing the agent's tool calls / text.
  // Live-only; not persisted.
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

// Live PR head + fork info, so the UI can gate the branch picker. `canPushSameBranch`
// is false when the head is a fork we can't write to (or the viewer lacks write).
export interface PrHeadInfo {
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  baseRef: string;
  canPushSameBranch: boolean;
  // Suggested name for a new branch, pre-derived from the head ref (e.g. `${ref}-ai-fix`).
  suggestedBranch: string;
}

// One fix run (history kept; a re-run is a new row).
export interface AiFix {
  id: number;
  prId: number;
  status: AiFixStatus;
  model: string;
  seed: AiFixSeed;
  // Set once the run succeeds:
  summary: string | null;
  commitMessage: string | null;
  // The captured unified-diff patch (includes new files; binary-safe). Null until
  // the run succeeds.
  patch: string | null;
  filesChanged: string[];
  // The base commit the patch applies onto (the live PR head at generate time).
  baseSha: string | null;
  // A stored, reviewable rebase resolution (the fix replayed onto the trunk with
  // conflicts resolved), or null. Only rebase produces this reviewable artifact.
  resolved: AiFixResolved | null;
  // The Claude review this fix was seeded from, if any.
  sourceReviewId: number | null;
  costUsd: number | null;
  numTurns: number | null;
  error: string | null;
  // Set once pushed:
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// A lighter shape for the run history list — enough to show every fix Pierre made
// for a PR with its commit message + where it landed (branch / PR / when).
export interface AiFixSummary {
  id: number;
  status: AiFixStatus;
  model: string;
  seed: AiFixSeed;
  commitMessage: string | null;
  filesChanged: string[];
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AiFixResponse {
  enabled: boolean;
  auth: ClaudeAuthStatus;
  authMessage?: string;
  // Whether the viewer may push (mirrors PrDetail.viewerCanPush; also re-checked
  // server-side on push).
  viewerCanPush: boolean;
  // Live head/fork info for the branch picker (null when it can't be fetched).
  headInfo: PrHeadInfo | null;
  // The latest run, or null if never run.
  fix: AiFix | null;
  history: AiFixSummary[];
}

export interface AiFixStatusResponse {
  status: AiFixStatus | 'idle';
  fixId: number | null;
  progress: AiFixProgress | null;
}

export type AiFixStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      status: AiFixStatus | 'idle';
      fixId: number | null;
      progress: AiFixProgress | null;
    }
  | { type: 'done'; status: AiFixStatus | 'idle'; fixId: number | null };

// Start a fix run.
export interface GenerateFixBody {
  model: AiFixModel;
  seed?: AiFixSeed;
  // When seed === 'review', the review text to seed the prompt with.
  reviewText?: string;
}

// Push a completed fix. `target` is which branch to push onto; a 'new' branch also
// opens a PR against the base branch.
export interface AiFixPushBody {
  target: 'existing' | 'new';
  // Required when target === 'new' — the branch name to create.
  branch?: string;
  // How to reconcile with the trunk before pushing. 'plain' (default) pushes the
  // fix as-is (never force-pushes; may leave the PR conflicted). 'merge' merges the
  // trunk in as a merge commit (never force-pushes). 'rebase' pushes the previously
  // resolved+reviewed rebase artifact (force-with-lease on the existing branch).
  strategy?: AiFixPushStrategy;
  // For 'merge': let Claude resolve any conflicts as part of the push job.
  autoResolve?: boolean;
  // Model for the conflict-resolution agent (defaults like the fixer).
  model?: AiFixModel;
}

export interface AiFixPushResult {
  pushedBranch: string;
  commitSha: string;
  // Set when target === 'new' (a PR was opened).
  prNumber?: number;
  prUrl?: string;
  strategy: AiFixPushStrategy;
  // Whether any conflict resolution happened during this push.
  resolvedConflicts: boolean;
  // Whether the push rewrote history (force-with-lease). Only ever true for a rebase
  // onto the PR's own existing branch.
  forcePushed: boolean;
}

// ---- trunk-conflict handling (rebase / merge before push) ----

export type AiFixPushStrategy = 'plain' | 'merge' | 'rebase';

// The state of the fix branch (baseSha + patch) relative to the PR's trunk (its base
// branch), computed by a local trial merge before offering resolution options.
export interface AiFixMergePreview {
  // True when the tool is available (aiFix on + a stored, pushable fix).
  available: boolean;
  trunk: string; // the base branch name compared against
  trunkSha: string | null; // its current tip (null if the fetch failed)
  behindBy: number; // commits on trunk not in the fix branch
  aheadBy: number; // commits on the fix branch not in trunk
  clean: boolean; // merges cleanly (no conflicts)
  conflictFiles: string[];
}

// Progress phases for the async resolve / merge / push jobs. Shared with the fixer's
// CodingProgress on the backend; a superset covering both.
export type AiFixResolvePhase =
  | 'cloning'
  | 'applying_fix'
  | 'fetching_trunk'
  | 'rebasing'
  | 'merging'
  | 'resolving_conflicts'
  | 'verifying'
  | 'pushing';

export interface AiFixResolveProgress {
  phase: AiFixResolvePhase;
  message?: string;
  // Newest-last rolling log of the resolver agent's tool calls / text (live-only).
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

export interface AiFixResolveStatusResponse {
  status: AiFixStatus | 'idle';
  fixId: number | null;
  progress: AiFixResolveProgress | null;
  // Set on a terminal failure (e.g. unresolved conflicts).
  error?: string | null;
}

export type AiFixResolveStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      status: AiFixStatus | 'idle';
      fixId: number | null;
      progress: AiFixResolveProgress | null;
    }
  | {
      type: 'done';
      status: AiFixStatus | 'idle';
      fixId: number | null;
      error?: string | null;
    };

// The stored, reviewable result of a rebase resolution (the fix replayed onto the
// trunk with conflicts resolved). The `git am` mbox that reproduces it is kept
// server-side; the client sees only the reviewable unified diff + metadata.
export interface AiFixResolved {
  strategy: AiFixPushStrategy; // 'rebase' — the only strategy with a reviewable artifact
  diff: string; // unified `git diff <trunk>..HEAD` for FileDiffView
  filesChanged: string[];
  conflictFiles: string[]; // files whose conflicts Claude resolved
  resolvedConflicts: boolean; // whether any conflict resolution happened
  trunk: string;
  trunkSha: string;
  at: string; // ISO timestamp
}

// Start a rebase-resolve job (rebase the fix onto the trunk, agentically resolving
// conflicts, and store a reviewable artifact — no push yet).
export interface AiFixRebaseBody {
  autoResolve?: boolean;
  model?: AiFixModel;
}

// ---- PR write actions (review threads, comments, approve, inline review comments) ----
// Standard product features (not feature-gated, not cloud-disabled) for acting on a
// PR directly from the dashboard. Each maps to a per-account GitHub mutation; the
// optimistic local stamp keeps the UI in sync until the next sync.

// ---- request payloads ----

// Reply to an existing review thread (GraphQL addPullRequestReviewThreadReply).
export interface ReplyToThreadBody {
  body: string;
}

// Resolve (true) or unresolve (false) a review thread.
export interface ResolveThreadBody {
  resolved: boolean;
}

// Bulk-resolve review-bot threads that a later commit has likely addressed — Pierre's
// "clear the bot backlog in one click." The client sends the explicit reviewed list of
// thread ids (never automatic); the server re-validates each belongs to the PR/account,
// is bot-originated AND in state `likely_addressed`, then resolves it on GitHub.
export interface ResolveBotThreadsBody {
  threadIds: number[];
}

export interface ResolveBotThreadsResult {
  resolved: number; // threads successfully resolved on GitHub
  failed: number; // threads that errored or were rejected by the server guardrail
  results: {
    threadId: number;
    ok: boolean;
    derivedState: DerivedState | null; // the new stored state (null on failure)
  }[];
}

// Post a new issue-level (PR) comment.
export interface CreatePrCommentBody {
  body: string;
}

// Approve the PR. Only allowed when the viewer has write+ permission and isn't the
// author (the server re-checks). An optional body accompanies the approval.
export interface ApprovePrBody {
  body?: string;
}

// Add ONE inline review comment, posted immediately as a standalone comment.
export interface AddReviewCommentBody {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

// ---- result types ----

// Reply result: the newly-created review comment, in the standard detail shape.
export type ReplyResult = CommentDetail;

export interface ResolveThreadResult {
  threadId: number;
  isResolved: boolean;
  derivedState: DerivedState;
}

// New PR comment result: the standard issue-comment detail shape.
export type CreatePrCommentResult = PrCommentDetail;

// Approve result: the submitted review, in the standard review detail shape.
export type ApprovePrResult = ReviewDetail;

export interface AddReviewCommentResult {
  commentId: number | null;
  url: string | null;
  line: number;
  side: 'LEFT' | 'RIGHT';
  // false ⇒ GitHub re-anchored the comment to a different line (the requested
  // (path, line, side) didn't land on an addable diff line).
  anchored: boolean;
}

// ---- Changes tab: per-file diff patches (GET /api/prs/:id/files) ----

// GitHub's per-file PR diff status (REST `status`), passed through verbatim.
export type PrFileDiffStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'changed'
  | 'copied'
  | 'unchanged';

// One changed file with its unified-diff patch, loaded on demand for the Changes
// tab. `patch` is null for binary/too-large files. `githubUrl` deep-links to the
// file's diff in the PR's "Files changed" view; `blobUrl` links to the file blob.
export interface PrFileDiff {
  path: string;
  previousPath?: string | null;
  status: PrFileDiffStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  githubUrl: string;
  blobUrl: string;
}

export interface PrFilesResponse {
  files: PrFileDiff[];
  // true ⇒ the PR has more files than the server's fetch cap; not all are listed.
  truncated: boolean;
}

// ---- Activity tab (Workstream 1; CORE, always-on, no AI) ----

// Per-repo current-state stats for an Activity repo card. A RepoInsights subset
// (reuses getInsights internals) plus the oldest still-unreviewed open PR.
export interface ActivityRepoStats {
  openPrs: number;
  draftPrs: number;
  mergedLast7d: number;
  stalledPrs: number;
  medianHoursToFirstReview: number | null;
  oldestUnreviewed: {
    prId: number;
    number: number;
    title: string;
    openedAt: string;
    githubUrl: string;
  } | null;
  // Review-bot signal-to-noise over this repo's open PRs — Pierre as the calm layer
  // above CodeRabbit/Greptile/Copilot/Qodo. Deterministic, no AI: `botThreads` = review
  // threads originated by a known AI review bot; `botThreadsActedOn` = those in state
  // resolved|likely_addressed (the "acted-on" heuristic). 0 when no review bot is active.
  botThreads: number;
  botThreadsActedOn: number;
}

export interface ActivityRepo {
  repoId: number;
  repoFullName: string; // `${owner}/${name}`
  stats: ActivityRepoStats;
  // Sum of buildThreadCounts over the repo's open-PR ids (the one new aggregation).
  threadTotals: ThreadStateCounts;
  maintainerIds: number[]; // from getMergers
  attentionCount: number; // PRs needing attention (my-turn reason | stalled | untouched>0)
  hasUnread: boolean; // any PR newSinceLastViewed != null
  prs: TimelinePr[]; // caller groups by authorId
}

export interface ActivityResponse {
  repos: ActivityRepo[];
  generatedAt: string; // ISO-8601
}

// Repo-scoped Claude review history (retrieval; no new storage). One PR with all
// its runs (newest-first) — richer than the cross-PR latest-only list.
export interface RepoClaudeReviewPr {
  prId: number;
  prNumber: number;
  prTitle: string;
  prState: PrState;
  authorId: number | null;
  runs: ClaudeReviewSummary[];
}

export interface RepoClaudeReviewsResponse {
  enabled: boolean;
  prs: RepoClaudeReviewPr[];
}

// ---- Pro per-repo digest (Workstream 2; @pierre/pro, flagged) ----

// One resolved PR reference inside a digest's markdown. The Haiku digests reference
// PRs as "#123" tokens; the backend resolves each to its watched PR so the frontend
// can linkify the token and open the PR as a new tab. `prId` is null when a "#N"
// token didn't resolve to a known PR in that repo (render it as plain text).
export interface DigestPrRef {
  prNumber: number;
  prId: number | null;
  repoId: number;
  repoFullName: string;
  title: string | null;
  // GitHub login of the PR author, resolved alongside the ref so the digest can show
  // "title #<number> · by <author>" for every concrete PR mention. Null when unknown.
  authorLogin: string | null;
  // The PR author's user id (resolves against a `users` roster for avatar/display).
  // Null when unknown / unresolved. Enrichment for the tabular digest view.
  authorId: number | null;
  state: PrState | null;
  // At-a-glance enrichment for the TABULAR digest/sprint rendering (a PR-referencing
  // bullet becomes a table row: PR | CI | age | author | diff | summary). All are
  // 0/null for an unresolved "#N" token (prId null). ciStatus is the head-commit rollup
  // ('unknown'/null = no checks); additions/deletions/changedFiles are the diff size;
  // openedAt drives the "age" column.
  ciStatus: CiStatus | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: string | null; // ISO-8601
}

export interface RepoDigest {
  repoId: number;
  repoFullName: string;
  // Markdown change-report: a bulleted list of key events. May contain "#123" PR
  // tokens (resolved in `prRefs`). Chained from the prior digest to highlight change.
  summary: string;
  // Resolved "#N" references mentioned in `summary`, for linkification.
  prRefs: DigestPrRef[];
  model: string;
  generatedAt: string; // ISO-8601
  costUsd: number | null;
  stale: boolean;
}

export interface RepoDigestsResponse {
  enabled: boolean;
  model: string;
  digests: RepoDigest[];
  generatedAt: string; // ISO-8601
  budgetReached?: boolean;
  // The account's month-to-date credit allowance is spent (metered cloud plan). Set when a
  // refresh was skipped without billing; the already-stored `digests` still render, and the
  // Generate/Regenerate controls disable with an "out of AI credits" message.
  creditsExhausted?: boolean;
}

// Server-Sent-Events payload streamed by POST /api/pro/activity/digests/refresh/stream.
// `start` announces the repo denominator; one `repo` event fires as EACH repo's digest
// finishes (cache hits arrive instantly, regenerations as their Haiku call returns),
// carrying the fresh digest so the client can drop it straight into the cache — this is
// what makes the UI update live instead of only after a manual reload. `done` closes the
// stream. `throttled` means the min-interval/in-flight guard served cache without billing.
export type DigestRefreshEvent =
  // `creditsExhausted` closes the stream immediately (metered cloud plan out of credits) —
  // nothing regenerates and the stored digests are left intact.
  | { type: 'start'; throttled?: boolean; creditsExhausted?: boolean }
  // Sent once, after a cheap payload-hash pass, listing ONLY the repos whose content
  // actually changed since their last digest — the repos that will really regenerate.
  // Everything else is already up to date and is left untouched (no LLM, no skeleton).
  // `toRegenerate.length` is the honest progress denominator.
  | { type: 'plan'; toRegenerate: number[] }
  | {
      type: 'repo';
      index: number; // 1-based position among the repos being regenerated
      total: number; // == toRegenerate.length
      digest: RepoDigest;
      // true = served from the payload-hash cache (unchanged repo, $0, no LLM call);
      // false = freshly regenerated.
      cached: boolean;
    }
  | { type: 'error'; repoId: number; message: string }
  | { type: 'done'; total: number; completed: number; budgetReached?: boolean };

// NOTE: the old cross-repo "Feed digest" (FeedDigest*) was removed. The Activity "Feed"
// entry now renders the COLLECTION of per-repo RepoDigests directly (scoped to the
// watched repos), each in a collapsible card — one source of truth, no aggregate LLM pass.

// ---- Consolidated Feed (CORE, no AI; the Activity "Feed" entry's main list) ----
// One flat, purely-chronological (newest-first) stream of real activity events (opens /
// merges / reviews / comments, plus commit pushes that addressed a review thread). Each
// item carries an `isMyTurn` flag — true when the event is on a PR the viewer participates
// in (authored / requested reviewer / previously reviewed or commented) AND the actor is
// someone other than the viewer. That flag replaces the old two-source (my_turn vs feed)
// synthesis + dedup, so there is now exactly ONE row per underlying event. Click nav: any
// item → the PR detail tab (its Show/Focus links then drive the timeline).

// One review thread that a feed item's change likely addressed — a commit touched the
// thread's file AFTER its last comment, so the thread flipped to 'likely_addressed'.
// Rendered inline under the item so the reader sees WHAT changed without opening the PR.
export interface FeedAffectedThread {
  threadId: number;
  path: string;
  line: number | null;
  derivedState: DerivedState;
  // A short preview of the thread's opening comment (what the reviewer originally asked).
  excerpt: string;
  // The thread's original commenter (whose point was likely addressed); resolved via the
  // response's `users` array.
  authorId: number | null;
}

// The relationship(s) that make a feed item "my turn" — surfaced as a reason pill so the
// reader knows WHY the item concerns them. Ordered most-relevant first.
export type MyTurnReason = 'requested' | 'authored' | 'merged' | 'reviewed' | 'commented';

export interface ConsolidatedFeedItem {
  // Stable unique id, e.g. "feed:1234", "feed:commitrun:99:1234", "feed:claude:42".
  id: string;
  // True when this event is "my turn": it's on a PR the viewer participates in
  // (authored / requested reviewer / reviewed / commented / merged) and the actor isn't
  // the viewer. Drives the yellow card + the "My Turn only" filter.
  isMyTurn: boolean;
  // The relationships that make this item "my turn" (see MyTurnReason), most-relevant first;
  // empty for non-my-turn rows. The UI renders the primary reason as a pill.
  myTurnReasons: MyTurnReason[];
  // An activity EventType ('pr_opened' | 'pr_merged' | 'pr_closed' | 'review_submitted' |
  // 'review_comment' | 'pr_comment' | 'commit_pushed'), or 'claude_review' for a
  // Claude Review run surfaced in the stream.
  kind: string;
  occurredAt: string; // ISO-8601 — the item's relevant timestamp (sort + display)
  repoId: number;
  repoFullName: string;
  prId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  prState: PrState | null;
  actorId: number | null;
  // Inlined content for comment-based items (thread reply, review_comment, pr_comment);
  // null otherwise.
  content: string | null;
  // Thread ("awaiting your reply") items only — for code anchor + thread-scoped nav.
  threadId: number | null;
  // Issue-level PR-comment items (kind 'pr_comment') only: the comment id, so a click can
  // deep-link straight to + highlight that comment in the PR detail's Overview tab. null
  // on every other kind.
  commentId: number | null;
  path: string | null;
  line: number | null;
  // A coarse reason for the My Turn badge ('awaiting_your_review' when a review is
  // requested of you; 'your_pr_new_comments' for activity on a PR you authored); null for
  // non-My-Turn rows.
  reasonTag: ReasonTag | null;
  reviewState: ReviewState | null;
  githubUrl: string | null;
  // Merge context: who merged the PR (pr_merged items) — null otherwise. Backfilled
  // into `users`.
  mergedById: number | null;
  // Review context: who submitted reviews on this PR, each with their latest standing
  // state (for merge/review-credit cards); null when not loaded / no reviews. User ids
  // are backfilled into `users`.
  reviewers: { userId: number; state: ReviewState }[] | null;
  // At-a-glance PR state, enriched for the page's PRs and surfaced on 'pr_opened'
  // cards: the CI rollup ('unknown' when there are no checks) and the changed-file
  // count. null when not enriched / unknown.
  ciStatus: CiStatus | null;
  changedFilesCount: number | null;
  // Context — review threads this item's change likely addressed. Populated for
  // 'commit_pushed' feed items (a push that touched a thread's file after its last
  // comment). Rendered inline so the reader sees WHAT changed. null/empty otherwise.
  affectedThreads: FeedAffectedThread[] | null;
  // For a coalesced commit-push item: how many commits the push run contained (so the
  // row can read "pushed N commits"). null for non-commit items.
  commitCount: number | null;
  // Short human-readable "what changed" summary (e.g. "pushed 3 commits · addressed 2
  // threads"); null when the row chrome already says everything.
  changeSummary: string | null;
  // Claude Review items (kind 'claude_review') only: the run id — so the card can
  // deep-link into the PR's Claude Review tab — and Claude's verdict for the badge.
  // null on every other kind.
  claudeReviewId: number | null;
  claudeVerdict: ClaudeReviewVerdict | null;
  // Consolidated top-level PR comment(s) folded INTO a review_submitted item — the actor's
  // issue-level comments posted within a short window of the review. When non-empty the
  // review card is the headline (its verdict pill) and these render below as an "Also
  // commented" block, INSTEAD of separate pr_comment rows. Chronological. Empty for every
  // other kind / an un-coalesced review.
  mergedComments: { commentId: number; content: string; occurredAt: string }[];
}

export interface ConsolidatedFeedResponse {
  // The requested page of the merged, newest-first stream (see the `limit`/`offset`
  // query params). `items` is just this page; `total` is the full stream length so the
  // client knows when to stop "Load more". Users are those referenced by THIS page.
  items: ConsolidatedFeedItem[];
  // Actors/authors referenced by items on this page, for client-side login/avatar lookup.
  users: User[];
  total: number;
  generatedAt: string; // ISO-8601
}

// ---- Team review-intelligence "Insights" (Pro; `teamInsights` capability) ----
// Discrete, Feed-style cards computed on the sync cadence from data already synced (NO
// AI): PRs stalled on review, review threads left untouched, reviewer load/queue depth,
// and reviewer-routing suggestions. Scoped to WATCHED repos (= the team). "Sprint" is
// the trailing 2 weeks. Each card is a self-contained work item, ranked most-urgent first.
export type InsightKind =
  | 'stalled_review' // an open PR awaiting review too long
  | 'untouched_thread' // a review thread nobody has responded to
  | 'reviewer_load' // a reviewer's pending-queue depth (+ sprint load)
  | 'reviewer_routing' // a PR with no reviewer + who should review it
  | 'bot_signal' // AI-review-bot signal-to-noise across the sprint (deterministic)
  | 'bot_only_review'; // PRs whose only review(s) came from an automated reviewer (WS7)

export type InsightSeverity = 'info' | 'warn' | 'high';

interface InsightCardBase {
  id: string; // stable-ish key (e.g. `stalled:<prId>`)
  kind: InsightKind;
  severity: InsightSeverity; // drives the card's accent (info/warn/high)
}

// Shared PR context carried by every PR-bearing insight card — enough to render the
// at-a-glance CI / size indicators and open the PR without a second fetch.
export interface InsightPrRef {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  authorId: number | null;
  githubUrl: string;
  ciStatus: CiStatus | null; // head-commit CI rollup (null = no checks)
  changedFiles: number; // files touched
  additions: number; // LOC added
  deletions: number; // LOC removed
  openedAt: string; // ISO-8601 PR open time — drives the deterministic LOC×age priority + the age column
}

// A suggested reviewer + the human-readable rationale for the suggestion
// (e.g. "committed to auth/ this sprint" / "has merge rights here").
export interface SuggestedReviewer {
  userId: number;
  reason: string;
}

// A CORE PR-detail suggested reviewer (a peer of SuggestedReviewer, but richer so it
// can carry BOTH GitHub users and CODEOWNERS teams, and users we haven't synced).
// `kind` discriminates:
//   'user' → `login` is always set (the assign key); `userId` is set when we've synced
//            that user (drives the avatar / profile link) and null otherwise.
//   'team' → `teamSlug` is the assign key (sent as `team_reviewers`); `teamName` is the
//            'org/team' display label. userId/login are null.
// `reason` is the human rationale; `source` records where the suggestion came from.
export interface ReviewerSuggestion {
  kind: 'user' | 'team';
  login: string | null;
  userId: number | null;
  teamSlug: string | null;
  teamName: string | null;
  reason: string;
  source: 'codeowners' | 'history';
}

// Response of GET /api/prs/:id/suggested-reviewers — the CORE "Suggested" row, served as
// its OWN live query (short staleTime, NOT persisted to IndexedDB) rather than embedded in
// the aggressively-cached PR detail, so it always reflects current state (e.g. it empties
// the moment a reviewer is requested). `users` carries any CODEOWNERS-resolved users the PR
// detail didn't already include (for avatar/link rendering). Empty when the PR doesn't
// warrant suggestions (has a reviewer/review, or isn't open+non-draft).
export interface SuggestedReviewersResponse {
  suggestedReviewers: ReviewerSuggestion[];
  users: User[];
}

export interface StalledReviewCard extends InsightCardBase, InsightPrRef {
  kind: 'stalled_review';
  ageHours: number; // hours the PR has been open awaiting review
  requestedReviewerIds: number[]; // reviewers still on the hook (GitHub-pending)
}

export interface UntouchedThreadCard extends InsightCardBase, InsightPrRef {
  kind: 'untouched_thread';
  threadId: number;
  path: string;
  ageHours: number;
  originalCommenterId: number | null;
  // When the thread's originalCommenter is an automated reviewer, the vendor kind + display label
  // (so the card can show a bot pill). Undefined/null when a human opened the thread.
  botKind?: AutomatedReviewerKind | null;
  botLabel?: string | null;
}

export interface ReviewerLoadCard extends InsightCardBase {
  kind: 'reviewer_load';
  reviewerId: number;
  pendingCount: number; // open PRs where they're requested & haven't reviewed
  reviewsThisSprint: number; // reviews they submitted in the sprint window
  pendingPrs: {
    prId: number;
    repoFullName: string;
    prNumber: number;
    prTitle: string;
  }[];
}

export interface ReviewerRoutingCard extends InsightCardBase, InsightPrRef {
  kind: 'reviewer_routing';
  topPaths: string[]; // representative changed paths (e.g. "auth/login.ts")
  suggestedReviewers: SuggestedReviewer[]; // who + why (merge rights + recent commits)
}

// Per-vendor rollup carried by the bot_signal card.
export interface BotSignalVendorStat {
  kind: AutomatedReviewerKind; // vendor, in-house, or Pierre (widened from ReviewBotKind for the bot-triage platform)
  threads: number; // review threads this bot opened in the sprint window
  actedOn: number; // of those, in state resolved|likely_addressed (the acted-on heuristic)
  untouched: number; // in state untouched (the pure backlog/noise)
  oldestUntouchedDays: number | null; // age of the oldest still-untouched thread
}

// A cross-repo, cross-bot "signal-to-noise" summary — the un-copyable view no single
// review bot can produce ("CodeRabbit left 214 comments this sprint; 38% acted on; 46
// untouched, oldest 9 days"). Deterministic (no AI); aggregate (no single PR ref).
export interface BotSignalCard extends InsightCardBase {
  kind: 'bot_signal';
  totalThreads: number;
  totalActedOn: number;
  totalUntouched: number;
  actedOnPct: number | null; // totalActedOn / totalThreads, 0-100 (null when no threads)
  oldestUntouchedDays: number | null;
  vendors: BotSignalVendorStat[]; // most-threads-first
}

// "Only a bot reviewed this" governance risk (WS7): PRs merged (or open-and-mergeable)
// whose ONLY reviews come from automated reviewers (incl. Pierre-verbatim) — no human
// review. Deterministic; a rubber-stamping-fatigue trust/safety hook. Aggregate (a PR
// list, no single ref).
export interface BotOnlyReviewCard extends InsightCardBase {
  kind: 'bot_only_review';
  prs: { prId: number; number: number; title: string; repoFullName: string;
         botLabel: string; state: string; githubUrl: string }[];
}

export type InsightCard =
  | StalledReviewCard
  | UntouchedThreadCard
  | ReviewerLoadCard
  | ReviewerRoutingCard
  | BotSignalCard
  | BotOnlyReviewCard;

// ---- Team DORA-ish flow metrics (Insights header; no AI) ----
// Best-effort DORA mapping from synced PR/CI data (there is NO stored CI-state history,
// so recovery is a current-state proxy — see fields). Each stat carries the current
// sprint value + the prior sprint's (for a Δ trend arrow). Weekly series align to
// `weekBuckets` (a shared x-axis, oldest first) and reuse the repo-analytics chart format.
export interface TeamMetricStat {
  value: number | null; // this sprint SO FAR (null = no sample)
  previous: number | null; // the SAME elapsed slice of the prior sprint (apples-to-apples)
  // How many items fed each figure (for counts this equals the value; for medians/percentages
  // it's the sample behind the statistic). Drives the low-confidence guard.
  sampleSize?: number;
  previousSampleSize?: number;
  // True when the comparison is too thin to state a trend (either side below the sample floor,
  // typical early in a sprint). The tile hides the delta arrow and the AI report must state the
  // raw "so far" figure WITHOUT a percentage / "cliff" / "spike" — it's noise, not a signal.
  lowConfidence?: boolean;
}

export interface TeamMetrics {
  // Which window model produced value/previous — the panel + AI report label accordingly
  // ("day N of M · vs same point last sprint" for 'sprint'; "rolling N days · vs prior N days" for
  // 'rolling_*'). Optional for back-compat with cached responses predating the setting.
  comparisonMode?: SprintComparisonMode;
  sprintDays: number; // FULL length of the sprint/rolling window in days (e.g. 14)
  // How far into the sprint we are. The stat tiles compare "this sprint so far" against the
  // SAME elapsed slice of the previous sprint (elapsed-matched), so on day 1 you compare day-1
  // vs day-1 — not a few hours against a complete prior sprint (which read as a false "cliff").
  // At sprint end elapsedDays === sprintDays and it's the full-vs-full comparison. Optional for
  // back-compat with cached responses predating this field.
  elapsedDays?: number; // days elapsed so far (may be fractional early in the sprint)
  elapsedFraction?: number; // elapsedDays / sprintDays, clamped 0..1
  weekBuckets: string[]; // ISO bucket-start per week, oldest first (chart x-axis)

  // Currently-open PRs (non-draft) across the repos — a snapshot count (no trend).
  openPrs: number;

  // Deployment frequency → PRs merged to a base branch.
  merges: TeamMetricStat;
  // Lead time for changes → median hours open → merge.
  leadTimeHours: TeamMetricStat;
  // Review responsiveness → median hours open → first review.
  timeToFirstReviewHours: TeamMetricStat;
  // Change failure rate (inverted) → % of merged PRs whose head CI was green.
  mergeCiSuccessPct: TeamMetricStat;
  // Time to restore (snapshot proxy) → open PRs currently red on CI + how long sat.
  ciFailingNow: number;
  ciFailingMedianAgeHours: number | null;

  // Time to restore (REAL, from the ci_status_events transition log) → median hours a
  // PR head spends red before CI goes green again. Null until enough history accrues.
  ciRecoveryHours: TeamMetricStat;

  // Weekly series (length === weekBuckets.length).
  throughput: { opened: number[]; merged: number[] }; // flow + deploy frequency
  leadTimeTrend: (number | null)[]; // median open→merge hours, by merge week
  ciSuccessTrend: (number | null)[]; // % merged PRs green, by merge week
  ciRecoveryTrend: (number | null)[]; // median CI recovery hours, by resolution week

  // CI failure reasons over the window, by check/stage name (top stages, desc). The
  // dimension that tells you WHY CI is failing over time.
  ciFailureReasons: { stage: string; count: number }[];
}

export interface TeamInsightsResponse {
  enabled: boolean; // false when the capability is off (plugin absent)
  generatedAt: string; // ISO-8601
  sprint: { from: string; to: string };
  metrics: TeamMetrics | null; // team flow metrics header (null = no repos)
  cards: InsightCard[];
  users: User[]; // actors referenced by the cards (avatar/login lookup)
}

// The Insights flow-metric header (TeamMetrics tiles + trend charts) computed for a SINGLE
// repo — powers the per-repo console's "Insights-style" panel (getTeamInsights scoped to
// [repoId]). Metrics-only; the repo console renders these tiles NON-clickable.
export interface RepoTeamMetricsResponse {
  enabled: boolean; // false when the Pro plugin/capability is off
  metrics: TeamMetrics | null; // null = repo not owned / no data
}

// ---- Team flow-metric DRILL-DOWN (Insights; clicking a metric tile) ----
// Each of the 6 flow-metric tiles opens a drill-down tab; this is the per-metric PR
// list behind each. Loaded on demand (a separate, heavier read than the always-loaded
// TeamMetrics), scoped to the WATCHED repos + the current sprint. Lets the user see
// WHERE issues cluster (which PRs/repos drag a metric).
export type TeamMetricKey =
  | 'open_prs' // ALL currently-open PRs across the repos, oldest first
  | 'merges' // deploy frequency → all merged PRs (per repo)
  | 'lead_time' // open → merge, merged + open, longest first
  | 'review_latency' // open → first review, longest first
  | 'merge_ci' // merged PRs by CI-at-merge (failures first)
  | 'ci_recovery' // red → green recovery, slowest first
  | 'ci_red'; // currently CI-failing open branches

export const TEAM_METRIC_KEYS: TeamMetricKey[] = [
  'open_prs',
  'merges',
  'lead_time',
  'review_latency',
  'merge_ci',
  'ci_recovery',
  'ci_red',
];

// One PR row in a metric drill-down list. Carries the shared PR context plus the
// metric-specific figures (only the fields relevant to the list it appears in are
// populated; the rest are null). Users referenced by authorId / mergedById /
// reviewerIds resolve against TeamMetricsDetail.users.
export interface MetricPr {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  authorId: number | null;
  state: PrState;
  githubUrl: string;
  ciStatus: CiStatus | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: string; // ISO-8601
  mergedAt: string | null; // ISO-8601 (merged PRs)
  // Metric-specific figures (null unless relevant to this row's list):
  leadTimeHours: number | null; // open→merge (merged) / open→now (open) — merges + lead_time
  reviewLatencyHours: number | null; // open→first review — review_latency
  recoveryHours: number | null; // red→green — ci_recovery
  redAgeHours: number | null; // how long currently red — ci_red
  mergedById: number | null; // who merged — merges
  reviewerIds: number[]; // distinct reviewers — review_latency
}

export interface TeamMetricsDetail {
  sprint: { from: string; to: string };
  openPrs: MetricPr[]; // ALL currently-open non-draft PRs, longest-open first
  merges: MetricPr[]; // merged in the sprint (per repo on the client)
  leadTime: MetricPr[]; // merged-in-sprint + currently-open, longest lead first
  reviewLatency: MetricPr[]; // reviewed PRs, longest open→first-review first
  mergeCi: MetricPr[]; // merged-in-sprint PRs, CI-failed-at-merge first
  ciRecovery: MetricPr[]; // PRs with a red→green recovery, slowest first
  ciRed: MetricPr[]; // currently CI-failing open PRs, longest red first
  users: User[]; // actors referenced by any list
}

export interface TeamMetricsDetailResponse {
  enabled: boolean; // false when the capability is off (plugin absent)
  detail: TeamMetricsDetail | null; // null when there are no watched repos
}

// ---- Cross-team comparison (Insights "Compare" sub-tab; All-Teams scope only) ----
// One row per team: that team's full flow metrics (same TeamMetrics shape the per-team
// Insights header uses), so the SPA can render a compact metric×team comparison matrix
// with per-team throughput sparklines. `metrics` null when the team has no repos/data.
export interface TeamComparisonRow {
  teamId: number;
  teamName: string;
  repoCount: number;
  metrics: TeamMetrics | null;
}

export interface TeamComparisonResponse {
  enabled: boolean; // false when the capability is off (plugin absent / not entitled)
  generatedAt: string; // ISO-8601
  sprint: { from: string; to: string };
  teams: TeamComparisonRow[]; // one per team the account owns, in list order
}

// ---- Comment-validity assessment (Pro; reuses the prSummary capability) ----
// A Haiku "is this review comment valid, given the thread + diff context?" assessment,
// keyed to a review thread's ORIGINATING (root) comment and retained after generation.
// `verdict` is a short at-a-glance label; `assessment` is the full Markdown rationale
// (critical but not dismissive). One row per (account, root comment).
export type CommentAssessmentVerdict =
  | 'valid' // the comment holds up — worth acting on
  | 'partly' // partially valid / needs nuance or scoping
  | 'weak' // shaky — likely a false positive / low value
  | 'unclear'; // not enough context to judge

export interface CommentAssessment {
  threadId: number;
  commentId: number; // the root comment the assessment is about
  verdict: CommentAssessmentVerdict;
  assessment: string; // Markdown rationale
  model: string;
  generatedAt: string; // ISO-8601
}

// GET /api/pro/threads/:id/assessment and its POST refresh. `enabled` false = capability off;
// `creditsExhausted` mirrors the other AI gates; `noAuth` = no resolvable Claude/Anthropic auth.
export interface CommentAssessmentResponse {
  enabled: boolean;
  assessment: CommentAssessment | null;
  creditsExhausted?: boolean;
  noAuth?: boolean;
}

// ---- AI usage tracking (Pro; credits, transparency) ----
// A non-currency view of AI spend. Cost is tracked in USD server-side (needed for the
// per-run budget caps) but NEVER surfaced to the client as dollars — only as CREDITS,
// to decouple the app's price from its underlying running cost. Conversion: $1 of model
// cost = 1250 credits (1 credit ≈ $0.0008), so the paid cloud plan's 2,500-credit monthly
// allowance ≈ $2.00 of Haiku spend. Split by the two seams that spend: the SUMMARY seam
// (cheap one-shot LLM completions — digests, sprint report, PR summary, CI analysis) and
// the AGENTIC seam (Agent-SDK runs — Claude Review, AI Fix). Covers ALL usage on the
// account, including work outside the Watched repos.
export const AI_CREDITS_PER_USD = 1250; // $1 of model cost = 1250 credits

export interface AiUsageResponse {
  enabled: boolean;
  monthStart: string; // ISO-8601 — start of the current calendar month (the MTD window)
  summaryCredits: number; // the summary / LLM-completion seam, month-to-date
  agentCredits: number; // the agentic-tooling seam, month-to-date
  totalCredits: number; // summary + agent
  // The monthly credit allowance for this account. null = unmetered (local mode / an
  // unlimited account) → the UI shows no bar. A finite number (e.g. 2500 for paid cloud)
  // → the UI renders a used/allowance meter and blocks generation once it's exhausted.
  allowanceCredits: number | null;
  // allowanceCredits − totalCredits, floored at 0. null when allowanceCredits is null.
  remainingCredits: number | null;
}

// ---- Sprint report (Pro; Haiku summary of the Insights, gated on activityDigest) ----
// A single cross-repo report generated from the current Insights state: headline
// metrics + prioritised, PR-linked issues, with repos ranked by activity + code volume.
// Tied to the Insights via `stale` (the Insights changed since it was generated →
// regenerate). PRs are referenced as `owner/name#N` and resolved via `prRefs`.
export interface SprintReport {
  summary: string; // markdown: headline metrics then bulleted, prioritised issues
  prRefs: DigestPrRef[]; // PRs referenced in the summary (cross-repo `owner/name#N`)
  model: string;
  generatedAt: string; // ISO-8601
  costUsd: number | null;
  stale: boolean; // the Insights changed since this was generated
  sprint: { from: string; to: string };
}

// The Sprint "Retro" — a retrospective NARRATIVE over the sprint window (Pro Insights AI,
// Haiku): the story of what happened in the period — what merged and what it did, resolved-
// thread highlights + time-to-resolve, CI failures + root causes + rates, recurring themes, a
// light sentiment read, and follow-ups. A peer of SprintReport: where the sprint report is the
// "state of play" (what needs attention NOW), the retro is the retrograde "what just happened"
// over the same window setting (sprint-to-date / rolling 7 / 14). One per account (regenerated
// for the current window; no history in v1).
export interface RetroReport {
  summary: string; // markdown narrative, sectioned
  prRefs: DigestPrRef[]; // notable PRs referenced (merged in-window), cross-repo `owner/name#N`
  model: string;
  generatedAt: string; // ISO-8601
  costUsd: number | null;
  stale: boolean; // the window's activity changed since this was generated
  window: { from: string; to: string };
}

export interface RetroReportResponse {
  enabled: boolean; // false when the AI digest capability is off
  model: string;
  report: RetroReport | null; // null = not generated yet (or nothing happened in the window)
  // Served from cache due to the per-account throttle / in-flight guard (see SprintReportResponse).
  throttled?: boolean;
  // Metered plan out of month-to-date credits: refresh skipped without billing; cache still renders.
  creditsExhausted?: boolean;
}

export interface SprintReportResponse {
  enabled: boolean; // false when the AI digest capability is off
  model: string;
  report: SprintReport | null; // null = not generated yet (or nothing to report right now)
  // True when a refresh request was served from cache because it hit the per-account
  // throttle / in-flight guard (a regeneration ran < MIN_INTERVAL_SEC ago). Lets the client
  // explain a no-op "Regenerate" ("refreshed moments ago") instead of it reading as broken.
  throttled?: boolean;
  // True when the account's month-to-date credit allowance is spent (metered cloud plan): the
  // refresh was skipped without billing, any cached `report` still renders, and the client
  // disables Generate/Regenerate with an "out of AI credits" message.
  creditsExhausted?: boolean;
}

// ---- Claude Review learnings / memory (Workstream 3; @pierre/pro, flagged) ----

// The 9 captured action kinds (see PRO-PLATFORM.md §5.2).
export type ReviewLearningKind =
  | 'finding_dismissed'
  | 'finding_kept'
  | 'finding_reworded'
  | 'finding_reword_cleared'
  | 'finding_posted'
  | 'review_body_rewritten'
  | 'verdict_overridden'
  | 'review_posted'
  | 'run_requested';

// One aggregated retrieval signal shown BEFORE a run ("Matches from past reviews").
export interface LearningMatch {
  glob: string;
  category: string | null;
  kind: string;
  summary: string;
  confidence: 'low' | 'medium' | 'high';
  example?: { claude?: string | null; you?: string | null };
  // Provenance/transparency (for the "what feeds the next review" surface): how many raw
  // captured actions this signal aggregates, when the most recent one landed, and the
  // per-kind breakdown. Optional so an older plugin build still satisfies the type.
  count?: number;
  lastActionAt?: string | null; // ISO-8601
  kinds?: { kind: string; count: number }[];
}

export interface ReviewLearningsResponse {
  enabled: boolean;
  matches: LearningMatch[];
  // The VERBATIM markdown block that will be injected into the next review's prompt as
  // `priorReviewContext` — byte-identical to what the plugin sends to Claude, so the UI can
  // show "exactly what feeds the next review". null when there's nothing to inject.
  contextBlock?: string | null;
}

// One raw captured action, for the per-review action log (Surface 2).
export interface ReviewAction {
  id: number;
  kind: ReviewLearningKind;
  category: string | null;
  path: string | null;
  glob: string | null;
  claudeText: string | null;
  userText: string | null;
  claudeVerdict: ClaudeReviewVerdict | null;
  userVerdict: ClaudeReviewVerdict | null;
  postedCommentKind: string | null;
  createdAt: string; // ISO-8601
}

export interface ReviewActionsResponse {
  actions: ReviewAction[];
}
