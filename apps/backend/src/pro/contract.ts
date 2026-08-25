import type {
  FastifyInstance,
  FastifyRequest,
  FastifyBaseLogger,
} from 'fastify';
import type {
  BotWindowKind,
  CheckLogsResponse,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewModel,
  ClaudeReviewVerdict,
  DailyBriefCounts,
  PersonPeriod,
  PostReviewPreview,
  SynthesisInput,
  SynthesisScope,
} from '@pierre-review/shared';
import type { CompareDiffResult } from '../github/compare.js';
import type { PrReviewCommentHunks } from '../sync/hydrate-detail.js';
import type { ReviewEventBus, LearningsProvider } from '../review/events.js';
import type { PrDetailEnricher } from '../pr/detail-enricher.js';
import type { AiUsageRecord } from '../db/usage.js';
import type { AiCreditStatus } from '../db/credits.js';

// The typed boundary between OSS core and the optional, dynamically-imported
// @pierre/pro plugin. This file has NO dependency on @pierre/pro — it only
// defines the contract (the ProContext the host hands in, the ProCapabilities
// advertised back, the live capability singleton). The plugin imports a
// hand-copied import type-only mirror of these shapes; the host refactors freely
// behind this one versioned surface.

export interface ProCapabilities {
  activityDigest: boolean; // WS2 per-repo LLM headlines digest
  reviewMemory: boolean; // WS3 Claude Review learnings
  aiAnalysis: boolean; // AI Fix: CI failure analysis (Haiku, read-only) + the Analysis tab
  prSummary: boolean; // per-PR AI summary (Haiku, read-only) — cheap SUMMARY tier, on in cloud
  aiFix: boolean; // AI Fix: agentic inline code fix + push (Agent SDK, needs write)
  workspaceInsights: boolean; // workspace review-intelligence "Insights" (no AI; pure reads)
  claudeReview: boolean; // agentic Claude Review (Agent SDK; the product lives in the plugin)
  slackDigest: boolean; // Slack webhook delivery of the sprint + repo digest (Pro; mirrors activityDigest)
  issueLinks: boolean; // Jira/Linear ticket-link enrichment in PR detail (Pro; no AI)
  botTriage: boolean; // Review-bot triage tier — CORE/FREE, but its advanced settings + cost
  // overlay are pro_settings-backed, so this flag is true whenever the plugin is loaded
  // (regardless of the paid PRO_* flags). It gates the free bot Settings section + overlays,
  // NOT the Bots rail view (that reads the core bot routes and shows even with no plugin).
  botAdvisor: boolean; // Bot Tuning Advisor (paid, like workspaceInsights): findings → intents →
  // config-PR/brief/issue outputs + the effect panel. Gates the Bots "Advisor" inner tab and
  // the Tune/Drop row pills; the free amber TuningSuggestions box stays regardless.
  periodReports: boolean; // Period-over-period reporting (paid, like workspaceInsights): the
  // Insights "Reports" sub-tab — a stored, forwardable per-sprint artifact with a
  // coverage-honest comparison, a refusable forecast and a narrated summary. The metric vector
  // itself is CORE compute (db/period-metrics.ts), but it has no free surface.
  botDepth: boolean; // Non-AI paid DEPTH tier (paid, like workspaceInsights — NOT like
  // botTriage, which is true whenever the plugin is loaded): behaviour trends/anomalies,
  // per-bot drill-down, overlap, where-bots-work, inflation history, per-seat ROI cost.
  // The compute is CORE (db/queries.ts getBotBehaviourAnalytics etc.); this gates the surfaces.
}

// ---- AI Fix seams (github + coding) -------------------------------------------
// The generic, security-sensitive infrastructure for the Pro "AI Fix" feature lives
// in CORE (per-account tokens, the write-capable agent, git push) and is exposed to
// the plugin through these two seams; the plugin supplies only prompts + model and
// owns the product workflow. Inert in OSS (nothing calls it), exactly like llm.

// Progress emitted while the fixer / resolver / push jobs run (mirrors
// ClaudeReviewProgress). A superset covering the fix run and the merge/rebase/push
// jobs; the plugin maps it to AiFixProgress / AiFixResolveProgress on the wire.
export interface CodingProgress {
  phase:
    | 'fetching_diff'
    | 'cloning'
    | 'fixing'
    | 'capturing'
    | 'persisting'
    | 'applying_fix'
    | 'fetching_trunk'
    | 'rebasing'
    | 'merging'
    | 'resolving_conflicts'
    | 'verifying'
    | 'pushing';
  message?: string;
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

// Live PR head/fork metadata (fetched per-account from the GitHub API).
export interface GithubPrHeadInfo {
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  baseRef: string;
}

export interface GenerateFixArgs {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  // The commit the agent works from (the live PR head at generate time).
  baseSha: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  abortController: AbortController;
  onProgress: (p: CodingProgress) => void;
}

// One item's disposition from a LIST-seeded fix run (the "fix from comments" seed). The
// agent reports these through the core `submit_fix` tool; `ref` is the label the CALLER's
// prompt assigned, so core never needs to know what the items are. Self-report only —
// `filesTouched` is advisory and the changeset still comes from git.
export interface FixItemVerdict {
  ref: string;
  verdict:
    | 'fixed'
    | 'partially_fixed'
    | 'already_addressed'
    | 'invalid'
    | 'out_of_scope'
    | 'needs_human';
  valid: boolean;
  reasoning: string;
  pushback?: string;
  learning?: string;
  filesTouched?: string[];
}

export interface GenerateFixResult {
  summary: string;
  commitMessage: string;
  // Per-item dispositions, when the caller's prompt asked for them (apiVersion 19).
  // `undefined` for a plain/CI-seeded run — the agent had no list to report on, which is
  // deliberately distinct from an empty array.
  commentVerdicts?: FixItemVerdict[];
  // Unified-diff patch (git add -A + git diff --cached --binary — includes new files).
  patch: string;
  filesChanged: string[];
  baseSha: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  costUsd: number | null;
  numTurns: number | null;
  aborted: boolean;
}

// Where a completed fix is pushed. 'existing' pushes onto the PR's own head branch
// (hard-guarded on the head not having moved); 'new' creates a branch off baseSha and
// opens a PR against the base.
export type ApplyAndPushTarget =
  | { kind: 'existing'; headRef: string }
  | { kind: 'new'; branch: string; base: string; title: string; body: string };

export interface ApplyAndPushArgs {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  baseSha: string;
  patch: string;
  commitMessage: string;
  target: ApplyAndPushTarget;
}

export interface ApplyAndPushResult {
  pushedBranch: string;
  commitSha: string;
  prNumber?: number;
  prUrl?: string;
}

// ---- trunk-conflict handling (mergePreview / rebaseResolve / merge / pushResolved) ----

// How a completed fix is reconciled with the trunk before pushing.
export type CodingStrategy = 'plain' | 'merge' | 'rebase';

// A completed push that may have reconciled with the trunk (merge/rebase). Extends
// the plain push result with what actually happened.
export interface ApplyResolveResult extends ApplyAndPushResult {
  strategy: CodingStrategy;
  resolvedConflicts: boolean;
  conflictFilesResolved: string[];
  forcePushed: boolean; // only ever true for rebase onto the PR's own branch
}

export interface MergePreviewArgs {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  baseSha: string;
  patch: string;
  trunk: string; // the base branch to compare against
}

export interface MergePreviewResult {
  trunk: string;
  trunkSha: string | null; // null if the trunk fetch failed
  behindBy: number;
  aheadBy: number;
  clean: boolean;
  conflictFiles: string[];
}

// Shared knobs for the two agentic-resolution seams.
interface ResolveCommonArgs {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  baseSha: string;
  patch: string;
  commitMessage: string;
  trunk: string;
  autoResolve: boolean; // run the conflict-resolution agent
  model: string;
  resolverSystemPrompt?: string; // plugin-supplied static guidance
  maxTurns?: number;
  maxBudgetUsd?: number;
  abortController: AbortController;
  onProgress: (p: CodingProgress) => void;
}

// rebaseResolve: apply the fix, rebase onto the trunk (agentically resolving), and
// capture a reviewable diff + a `git am` mbox — WITHOUT pushing.
export type RebaseResolveArgs = ResolveCommonArgs;

export interface RebaseResolveResult {
  diff: string; // unified `git diff <trunk>..HEAD` for review
  mbox: string; // `git format-patch` mbox for a deterministic replay at push
  filesChanged: string[];
  conflictFiles: string[];
  resolvedConflicts: boolean;
  trunkSha: string;
  aborted: boolean;
}

// mergeResolveAndPush: apply the fix, merge the trunk in (agentically resolving),
// verify, and push the merge commit (never force-pushes). One step.
export interface MergeResolveAndPushArgs extends ResolveCommonArgs {
  target: ApplyAndPushTarget;
}

// pushResolved: replay a previously-resolved rebase mbox onto the CURRENT trunk tip and
// push (force-with-lease on the existing branch; plain for a new branch). Re-fetches
// `trunk` fresh; `resolvedBaseSha` is the tip it was reviewed against (moved-detection).
export interface PushResolvedArgs {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  trunk: string; // the base branch to replay onto (re-fetched fresh)
  resolvedBaseSha: string; // the trunk tip the mbox was generated against
  resolvedConflicts: boolean; // whether the stored resolution involved conflicts
  mbox: string;
  target: ApplyAndPushTarget;
  onProgress?: (p: CodingProgress) => void;
}

// applyAndPush / the resolve seams throw an Error carrying `.code` on the expected
// failures, so the plugin's routes can map them to HTTP status without importing a
// host class:
//   'HEAD_MOVED'           — existing-branch push and the live head !== baseSha (→ 409)
//   'PUSH_DENIED'          — the account lacks write / an un-pushable fork (→ 422)
//   'APPLY_FAILED'         — a stored patch/mbox didn't apply cleanly (→ 422)
//   'CONFLICTS_UNRESOLVED' — merge/rebase left conflicts we won't push (→ 422)
//   'MERGE_FAILED'         — the merge failed for a non-conflict reason (→ 422)
//   'REBASE_FAILED'        — the rebase failed for a non-conflict reason (→ 422)
//   'TRUNK_FETCH_FAILED'   — the trunk ref couldn't be fetched (→ 422)
//   'BRANCH_EXISTS'        — commitFilesAndOpenPr's target branch already exists (→ 409)
export type CodingErrorCode =
  | 'HEAD_MOVED'
  | 'PUSH_DENIED'
  | 'APPLY_FAILED'
  | 'CONFLICTS_UNRESOLVED'
  | 'MERGE_FAILED'
  | 'REBASE_FAILED'
  | 'TRUNK_FETCH_FAILED'
  | 'BRANCH_EXISTS';

export interface GithubSeam {
  fetchPrDiff(
    accountId: number,
    owner: string,
    name: string,
    prNumber: number,
  ): Promise<string>;
  fetchPrHeadInfo(
    accountId: number,
    owner: string,
    name: string,
    prNumber: number,
  ): Promise<GithubPrHeadInfo>;
  fetchCheckLogs(
    accountId: number,
    owner: string,
    name: string,
    jobId: number,
    tail?: number,
  ): Promise<CheckLogsResponse>;
  openPullRequest(
    accountId: number,
    args: {
      owner: string;
      name: string;
      head: string;
      base: string;
      title: string;
      body: string;
    },
  ): Promise<{ number: number; url: string }>;
  // Repo-file read primitives (advisor discovery + adapter config reads). Status-returning,
  // never throwing — a 404 is the ordinary "no config file yet" outcome. `ref` defaults to
  // the repo's default branch (the config that governs FUTURE reviews); file bytes come back
  // raw via the GitHub raw media type. ⚠ Whatever comes back is REPO-AUTHORED, i.e.
  // attacker-authored in cloud: callers must size-cap before parsing and never execute.
  readRepoFile(
    accountId: number,
    args: { owner: string; name: string; path: string; ref?: string },
  ): Promise<{ status: number; ok: boolean; text: string }>;
  listRepoDir(
    accountId: number,
    args: { owner: string; name: string; path: string; ref?: string },
  ): Promise<{
    status: number;
    ok: boolean;
    entries: { name: string; path: string; type: 'file' | 'dir'; size: number }[];
  }>;
  // File an issue (the advisor's "send the brief to the bot's own repo" output). Issues are
  // NOT synced — the caller stores the returned URL itself.
  openIssue(
    accountId: number,
    args: { owner: string; name: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  // TWO-SHA COMPARE (apiVersion 16) — the per-file unified patches between two commits, the
  // grounding evidence behind the `addressed` judgement ("what actually changed since the
  // comment"). ONE REST call covers every path in `paths`, so callers coalesce by
  // (baseSha, headSha) instead of asking per file. NEVER THROWS: a 404 / 403 / rate-limited
  // compare comes back `ok:false` with a `reason` so the judgement degrades to "no diff
  // evidence available" rather than failing. ⚠ The patches are REPO-AUTHORED, i.e.
  // attacker-authored — fence them before they reach a model, never execute them.
  fetchCompareDiff(
    accountId: number,
    args: {
      owner: string;
      name: string;
      baseSha: string;
      headSha: string;
      paths?: readonly string[];
      maxPatchChars?: number;
    },
  ): Promise<CompareDiffResult>;
  // REVIEW-COMMENT ANCHOR HUNKS (apiVersion 17) — the `diffHunk` each review comment was
  // written against. Under lean storage (`PERSIST_BODIES` unset, the DEFAULT in BOTH modes)
  // `review_comments.diff_hunk` is NULL for ~97% of rows, so a judgement that reads the stored
  // column sees NO CODE and can only answer "unclear, I can't see the surrounding code" — while
  // the SPA renders that very hunk directly above the verdict, from this same cache.
  //
  // ONE GraphQL call covers the WHOLE PR: coalesce per PR, never per comment. Served off the
  // 60s hydration cache, so a PR the SPA just opened is usually free — but NOT reliably, since
  // `refresh-pr.ts` busts that cache on every walk. Budget it as one PR_DETAIL_QUERY.
  //
  // NEVER THROWS: failures come back `ok:false` + `reason` and the caller falls back to the
  // stored column. ⚠ REPO-AUTHORED text — fence it before a model sees it, and it is PROMPT
  // CONTEXT ONLY: it must NEVER enter a payload hash (see contract-types.ts for why).
  fetchReviewCommentHunks(
    accountId: number,
    args: { owner: string; name: string; prNumber: number; maxHunkChars?: number },
  ): Promise<PrReviewCommentHunks>;
}

export interface CommitFilesAndOpenPrArgs {
  accountId: number;
  owner: string;
  name: string;
  // LITERAL file contents — the adapter merged them against the fetched originals upstream;
  // this seam writes bytes, it never merges. Paths are repo-relative; anything under
  // .github/workflows/ is refused outright (no `workflow` OAuth scope — the push would be
  // rejected AFTER the branch was created), as is any absolute or dot-dot path.
  files: { path: string; content: string }[];
  branch: string; // NEW branch name; an existing branch is a refusal (BRANCH_EXISTS), never a force-push
  title: string;
  body: string;
}

export interface CommitFilesAndOpenPrResult {
  prNumber: number;
  url: string;
  // The resync-after-write contract: false = the PR EXISTS on GitHub but the confirming sync
  // didn't land locally yet — the caller's copy must say "it'll show up shortly", never offer
  // a retry (a retry double-opens PRs).
  visible: boolean;
}

export interface CodingSeam {
  generateFix(args: GenerateFixArgs): Promise<GenerateFixResult>;
  applyAndPush(args: ApplyAndPushArgs): Promise<ApplyAndPushResult>;
  // The advisor's config-PR primitive: worktree at the DEFAULT branch → write files →
  // commit → push a NEW branch (never force) → open the PR → syncOnePr visibility tail.
  commitFilesAndOpenPr(args: CommitFilesAndOpenPrArgs): Promise<CommitFilesAndOpenPrResult>;
  // Trunk-conflict handling (all per-account, cloud-ready; inert in OSS).
  mergePreview(args: MergePreviewArgs): Promise<MergePreviewResult>;
  rebaseResolve(args: RebaseResolveArgs): Promise<RebaseResolveResult>;
  mergeResolveAndPush(args: MergeResolveAndPushArgs): Promise<ApplyResolveResult>;
  pushResolved(args: PushResolvedArgs): Promise<ApplyResolveResult>;
}

// ---- Claude Review seam (agentic PR review) -----------------------------------
// Like ctx.coding, the security-sensitive review INFRA lives in CORE: the Agent-SDK run
// (clone/worktree, the in-process submit_review MCP tool, the auth env policy, cost), the
// diff prep (gh pr diff + noise-strip + per-file metrics + cap), and the GitHub review
// POST (line-anchoring, per-account token). The plugin owns the PRODUCT: mode routing, the
// reviewer prompts, the queue/manager, persistence, the routes. The claudeReviews /
// claudeReviewFindings tables stay core-defined; the plugin writes them via ctx.db/schema.

// Live progress from the SDK run (mirrors CodingProgress). The plugin maps this to the wire
// ClaudeReviewProgress and emits its own fetching_diff/deciding/persisting phases around it.
export interface ReviewRunProgress {
  phase: 'cloning' | 'reviewing';
  reviewMode?: 'diff_only' | 'worktree';
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

// One changed file's metrics (core computes apiTouch); feeds the plugin's decideReviewMode.
export interface ReviewFileMetric {
  path: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  apiTouch: boolean;
}

// The result of core's diff prep — everything the plugin needs to route + build the prompt,
// WITHOUT any diff primitive leaving core (so run-time + post-time anchoring stay consistent).
export interface PreparedReview {
  strippedDiff: string; // full noise-stripped head diff (core anchors against this)
  promptDiff: string; // capped version for the prompt body
  changedFiles: string[];
  excludedFiles: string[];
  omittedFiles: string[]; // files dropped by the diff cap
  fileMetrics: ReviewFileMetric[];
  diffBytes: number;
  diffCapped: boolean;
}

// One anchored finding returned by runReview (anchored/fileInDiff/diffHunk computed by core
// against the stripped diff). The plugin persists these to the core tables verbatim.
export interface ReviewFinding {
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  suggestion: string | null;
  diffHunk: string | null;
  anchored: boolean;
  fileInDiff: boolean;
}

export interface RunReviewArgs {
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  model: ClaudeReviewModel;
  mode: 'diff_only' | 'worktree'; // resolved by the plugin ('skip' never reaches here)
  systemPrompt: string; // plugin-built reviewer "skill"
  prompt: string; // plugin-built user prompt (diff already inlined)
  strippedDiff: string; // for core's post-run anchoring (from prepareReview)
  // Apply the env auth policy (prefer ambient, strip an explicit key for the run). The
  // plugin sets this true ONLY when its review concurrency is 1 (else a mutated
  // process.env would race a concurrent run).
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress: (p: ReviewRunProgress) => void;
}

export interface RunReviewResult {
  submitted: boolean; // false ⇒ the agent never called submit_review → plugin marks failed
  failureReason?: string;
  scope: 'diff_only' | 'worktree' | null; // the agent's self-report
  summary: string;
  verdict: ClaudeReviewVerdict;
  findings: ReviewFinding[];
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number | null;
  aborted: boolean;
}

// The ticked findings the plugin hands to postReview (the plugin read them from the core
// tables; core never reads the product tables here). `body` is pre-resolved (editedBody ?? body).
export interface PostReviewFinding {
  id: number;
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  anchored: boolean;
  fileInDiff: boolean;
  body: string;
  suggestion: string | null;
}

export interface PostReviewArgs {
  owner: string;
  name: string;
  prNumber: number;
  reviewHeadSha: string; // pins commit_id; the seam 409s if the live head moved
  body: string;
  verdict: ClaudeReviewVerdict;
  includedFindings: PostReviewFinding[];
  dryRun: boolean;
  // Bot-Triage WS2c — stamp Pierre provenance onto the posted review body. Both ADDITIVE +
  // OPTIONAL (default false → byte-identical behavior when absent, so apiVersion stays 11):
  //
  // ⚠ NOTHING PASSES EITHER OF THESE ANY MORE, AND THEY ARE STILL DECLARED ON PURPOSE. The two
  // account settings that fed them were removed: the hidden marker is now stamped
  // UNCONDITIONALLY by `review/post-seam.ts` (it is the only producer of the 'pierre'
  // AutomatedReviewerKind, so a switch for it was a switch for deleting an analytics lane) and the
  // visible footer is gone. They stay in the interface because REMOVING an optional field is the
  // kind of contract narrowing that would want an apiVersion bump for no gain — a plugin build
  // that still sends them type-checks and is simply ignored. Do NOT re-gate the marker on
  // `pierreMarker`.
  pierreMarker?: boolean; // append a hidden `<!-- pierre:claude-review v=1 -->` marker
  pierreFooter?: boolean; // append a visible "🤖 Reviewed with Pierre + Claude" footer
}

export type PostReviewOutcome =
  | { headMoved: true }
  | { headMoved?: false; preview: PostReviewPreview } // dryRun
  | {
      headMoved?: false;
      postedReviewId: string;
      inlineFindingIds: number[];
      prComments: { findingId: number; commentId: string }[];
      commentCount: number;
      prCommentCount: number;
    };

export interface PostFindingArgs {
  owner: string;
  name: string;
  prNumber: number;
  reviewHeadSha: string;
  finding: PostReviewFinding;
}

export type PostFindingOutcome =
  | { headMoved: true }
  | { headMoved?: false; commentId: string; postedCommentKind: 'inline' | 'pr_comment' };

export interface ReviewSeam {
  // Fetch (gh pr diff) + noise-strip + per-file metrics + cap — everything the plugin needs
  // to route + build the prompt, keeping every diff primitive in core so anchoring is stable.
  prepareReview(args: { owner: string; name: string; prNumber: number }): Promise<PreparedReview>;
  // Run the SDK review (clone/worktree, submit_review MCP, auth policy, cost); returns anchored
  // findings. Streams progress via onProgress; abortable via the AbortController.
  runReview(args: RunReviewArgs): Promise<RunReviewResult>;
  // Post ONE GitHub review (inline + body + verdict), pinned to reviewHeadSha (409 on
  // head-moved). dryRun returns the preview instead of posting.
  postReview(args: PostReviewArgs): Promise<PostReviewOutcome>;
  // Post ONE finding as a standalone inline / PR-level comment.
  postFinding(args: PostFindingArgs): Promise<PostFindingOutcome>;
  // Local Anthropic key (local-only credential store) — applied inside runReview.
  // Also carries the local per-review budget: `reviewBudgetUsd` is the effective cap a
  // run will use (user override or operator default), `reviewBudgetMax` the hard ceiling.
  getLocalKeyStatus(): {
    hasUserKey: boolean;
    reviewBudgetUsd: number;
    reviewBudgetMax: number;
  };
  setLocalKey(key: string | null): { hasUserKey: boolean; auth: 'ok' | 'none' };
  // Set (number, clamped to the max) or clear (null → operator default) the local per-review
  // budget cap; returns the new effective value.
  setReviewBudget(usd: number | null): { reviewBudgetUsd: number };
}

// An explicit Insights metrics window (epoch millis, inclusive) used to override the default
// window with a configured SPRINT. Open PRs always count regardless of age — the window only
// bounds time-based facts (merges, review latency, throughput). Passed across the boundary as
// plain numbers to avoid Date/ISO ambiguity.
export interface SprintWindow {
  fromMs: number;
  toMs: number;
}

// The wire form of the host's `BotScope` — the ONE shape every workspace-scoped getter takes.
// Structurally identical to `db/queries.ts`'s `BotScope`, re-declared here (and mirrored in
// packages/pro/src/contract-types.ts) because the plugin imports no host internals.
//
// It carries TWO different things, which the predecessor `repoIds: number[] | null` conflated:
// `workspaceId` decides WHO COUNTS AS A BOT (the judgement grain — always exactly one), and
// `repoIds` narrows WHICH DATA IS MEASURED (always concrete; `[]` is a legal, ordinary state
// meaning "this workspace has no repos", not an edge case). Two named fields, so a call site
// cannot transpose a number and a number[] and cannot forget which one the verdict comes from.
//
// ⚠ A BotScopeWire is only ever produced by the host — `resolveWorkspaceScope` (per request) or
// `workspaceScopeForRepo` (below). The plugin must NOT hand-assemble one from a repo list it
// gathered elsewhere: the host's resolver is what guarantees `repoIds ⊆ the workspace's
// membership`, and an out-of-workspace repo id makes one workspace's data get measured through
// another workspace's verdicts.
export interface BotScopeWire {
  workspaceId: number;
  repoIds: number[];
}

// A curated, stable slice of the read layer, handed to the plugin via ctx.queries
// (the plugin never imports the host's query module). Returns are `unknown` to
// keep the contract decoupled from the host's concrete result types; the plugin
// re-derives the shapes it needs. getInsights/getOpenPrs take an account id +
// optional repo ids (the host adapts these to its internal filters objects).
export interface ProHostQueries {
  getInsights(accountId: number, repoIds: number[] | null): Promise<unknown>;
  getRepoAnalytics(accountId: number, repoId: number): Promise<unknown>;
  getOpenPrs(args: {
    accountId: number;
    repoIds?: number[] | null;
  }): Promise<unknown>;
  // The Activity aggregate. Takes a full scope, not a repo list: its acted-on bot stat needs the
  // WORKSPACE to know who counts as an automated reviewer.
  getActivity(accountId: number, scope: BotScopeWire): Promise<unknown>;
  // Workspace review-intelligence cards (stalled reviews / untouched threads / reviewer load /
  // routing). Returns WorkspaceInsightsResponse. `window` (epoch-millis) overrides the default
  // metrics window with the account's configured SPRINT (see the Pro sprint config); open PRs
  // always count regardless of age. `undefined` → the built-in default window.
  // `scope` is a full BotScopeWire because the `bot_signal` and `bot_only_review` cards need the
  // WORKSPACE to know who counts as an automated reviewer; `scope.repoIds` only narrows the data.
  // (`window` is a REQUIRED-but-undefined-able parameter, not optional: it precedes a required
  // one, so `window?` would not compile.)
  getWorkspaceInsights(
    accountId: number,
    window: SprintWindow | undefined,
    scope: BotScopeWire,
  ): Promise<unknown>;
  // The per-metric PR drill-down behind the flow-metric tiles. Returns WorkspaceMetricsDetail.
  // Heavier than getWorkspaceInsights — loaded on demand. Same sprint `window` override.
  // `repoIds` is REQUIRED and CONCRETE — this getter is pure flow metrics and needs no judgement
  // grain, so it takes the repo list alone. `[]` is a legal state (an empty workspace) and yields
  // the empty result; there is no null "means the watched set" widening.
  getWorkspaceMetricsDetail(
    accountId: number,
    window: SprintWindow | undefined,
    repoIds: number[],
  ): Promise<unknown>;
  // The repo → workspace direction, as a ready-made scope. TWO plugin call sites hold only a
  // repoId and nothing else (the per-repo Insights metrics route and the per-repo Haiku digest's
  // payload builder), and the plugin cannot compute a workspace from one: ctx exposes no such
  // lookup and its own resolveWorkspaceRepoIds goes the other way. Ownership-bound — a foreign or
  // unknown repo yields null, never another tenant's workspace id.
  workspaceScopeForRepo(accountId: number, repoId: number): Promise<BotScopeWire | null>;
  // The account's Default workspace id (creating the row if it is somehow absent). For the two
  // ACCOUNT-WIDE CRON paths — the Slack digest and the AI-policy sprint refresh — which have no
  // request and therefore no `?workspace=`. They previously leaned on a `scope = 'all'` default
  // that covered every watched repo in the account; 'all' no longer exists.
  // ⚠ BEHAVIOUR CHANGE, stated deliberately: those sweeps now cover the DEFAULT WORKSPACE ONLY.
  // Iterating every workspace would multiply a billed LLM call by workspace count on a cron.
  defaultWorkspaceId(accountId: number): Promise<number>;
  // Month-to-date-style AI-spend rollup for an account, split by seam (summary / agent).
  // Returns { summaryUsd, agentUsd, totalUsd }. Currently UNUSED by the plugin (the ai-usage
  // route now reads ctx.aiCredits.check, which carries turns + credits) — retained as a forward
  // hook for any future raw-USD Pro surface.
  getAiUsage(accountId: number, sinceMs: number): Promise<unknown>;
  // Deterministic review-bot ROI/behaviour rollup (CORE) — per-reviewer volume / acted-on% /
  // untouched / verdict, over `window`. Returns BotAnalyticsResponse; the plugin casts it.
  // Powers the ad-hoc Insights chat's optional bot-performance context.
  //
  // `window` (apiVersion 18) takes a bare kind OR a kind WITH explicit bounds. The second form is
  // the plugin's: core resolves `'sprint'` to a trailing 14 days because the cadence + start live
  // in the plugin-owned `pro_settings`, so only the plugin can say what the sprint actually is.
  // Passing them makes the chat's "Sprint to date" range measure the real sprint rather than a
  // 14-day stand-in nothing labelled as one.
  getBotAnalytics(
    accountId: number,
    window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
    scope: BotScopeWire,
  ): Promise<unknown>;
  // The raw automated-reviewer comment CONTENT for a scope/window (Pro "Themes" AI summary — the
  // one bot query that returns bodies). Returns { comments: BotReviewCommentRow[]; truncated }
  // (cast by the plugin). Only automated-reviewer authors, capped most-recent.
  getBotReviewComments(
    accountId: number,
    window: BotWindowKind,
    scope: BotScopeWire,
  ): Promise<unknown>;
  // The HUMAN sibling of getBotReviewComments — non-bot review + PR comment CONTENT for a
  // scope/window (the Pro "Discussion themes" Feed summary). Returns
  // { comments: HumanReviewCommentRow[]; truncated } (cast by the plugin). Excludes every
  // bot/automated reviewer.
  getHumanReviewComments(
    accountId: number,
    window: BotWindowKind,
    scope: BotScopeWire,
  ): Promise<unknown>;
  // Bot Tuning Advisor evidence cells (CORE, deterministic — per-(bot × path-bucket) /
  // (bot × category) / (bot × partner) aggregation over threads + ml_comment_labels, with
  // cell-emission floors + the path-coverage disclosure). Returns AdvisorFindingsPayload;
  // the plugin casts it and derives intents. Nothing here ever feeds botVerdict.
  getAdvisorFindings(
    accountId: number,
    window: BotWindowKind,
    scope: BotScopeWire,
  ): Promise<unknown>;
  // The advisor's verification loop (CORE math): five weekly series over the 12-week span,
  // split before/after `anchorMs` — or unattributed changepoint detection when null. The
  // PLUGIN resolves anchors (config events ∪ merged advisor PRs) and passes a timestamp;
  // this query never sees a recommendation, which keeps measurement independent of emission.
  // Returns AdvisorEffectPanel (cast by the plugin).
  getBotEffectPanel(
    accountId: number,
    scope: BotScopeWire,
    botUserId: number,
    anchorMs: number | null,
  ): Promise<unknown>;
  // ---- Period-over-period reporting (apiVersion 20) ----
  // The closed, ordered 12-metric vector for ONE window, plus the fingerprint the plugin stores
  // to decide whether a saved report has gone `stale`. Returns PeriodMetricsResult (cast by the
  // plugin). It writes its OWN window-pure SQL and reuses none of the getters above: their
  // series are a fixed trailing 12 weeks, several of their figures are current-state snapshots,
  // and getWorkspaceMetricsDetail ignores `window.toMs` entirely — all fine for "now", all
  // wrong for a historical period that must stay reproducible.
  // `scope.workspaceId` decides who counts as an automated reviewer (metrics 9-11);
  // `scope.repoIds` narrows what is measured, and `[]` yields all-null metrics, not an error.
  getPeriodMetrics(
    accountId: number,
    scope: BotScopeWire,
    window: { fromMs: number; toMs: number },
  ): Promise<unknown>;
  // Which of `repoIds` were ALREADY TRACKED at `atMs` (`repos.createdAt <= atMs`). Returns
  // { trackedRepoIds } (cast by the plugin). This is the rule that keeps the whole feature
  // honest: naive retroactive history reads as explosive growth purely because repos were
  // onboarded over time (measured on the dev DB: merged-PR counts 39 → 570 across 13 periods,
  // over 4 → 18 CONTRIBUTING repos). The plugin compares over the intersection of two periods'
  // tracked sets and forecasts only over periods whose coverage is complete for that subset.
  getPeriodCoverage(accountId: number, repoIds: number[], atMs: number): Promise<unknown>;
  // The forecast estimator (CORE, PURE — db/forecast.ts: Theil–Sen slope + a MAD band, no DB, no
  // I/O). Returns ForecastResult | { refused } (cast by the plugin). Crossed as async purely to
  // match this seam's style — it awaits nothing. The split is deliberate: the PLUGIN owns the
  // stored period history so it holds the series, while CORE owns the estimator so the refusal
  // rules ('insufficient_history' / 'too_volatile') live with the maths and are unit-tested there.
  // `values` are oldest-first; nulls are SKIPPED, never imputed.
  //
  // `opts.max` is a DECLARED ceiling, clamped like the built-in 0 floor. The caller must declare
  // it and core must never infer it: three of the twelve period metrics are 0–100 percentages
  // that a rising series extrapolates straight past ("CI success next period ≈ 104%"), while
  // inferring a ceiling from the observed data would silently truncate a real forecast for a
  // count-like metric whose values happen to sit low.
  computePeriodForecast(
    values: (number | null)[],
    opts?: { max?: number },
  ): Promise<unknown>;
  // The EFFORT-vs-AUTOMATION breakdown for one window (db/period-metrics.ts `getPeriodLanes`).
  // Returns PeriodLanes. Separate from `getPeriodMetrics` because it answers a different question
  // over a different comment channel: the vector counts INLINE review comments, this counts all
  // three surfaces, which is the only way a quality gate that posts issue comments is visible at
  // all (measured: 786 SonarQube comments reading as zero bot activity).
  getPeriodLanes(
    accountId: number,
    scope: BotScopeWire,
    window: { fromMs: number; toMs: number },
  ): Promise<unknown>;
  // ---- Phase-0 seams (apiVersion 21) — land INERT; consumed by later phases ----
  // The existing CORE bot-behaviour rollup (db/queries.ts getBotBehaviourAnalytics — trends,
  // anomalies, heatmaps, overlap, where-bots-work, the ML fold), re-exposed through the seam so
  // the route can move into the plugin behind the `botDepth` entitlement. Returns
  // BotBehaviourResponse (cast by the plugin). `botUserId` narrows the result to ONE bot —
  // the per-bot drill-down tab's fetch, which must not compute fifteen bots' heatmaps to
  // render one. Unset = every bot in scope, exactly as before.
  getBotBehaviour(
    accountId: number,
    window: BotWindowKind,
    scope: BotScopeWire,
    botUserId?: number,
  ): Promise<unknown>;
  // The per-workspace period vectors behind the Reports "By workspace" axis: for EACH of the
  // account's workspaces (listWorkspaces order — Default first, then by name), the same
  // window-pure vector `getPeriodMetrics` computes, over that workspace's full membership.
  // Returns WorkspacePeriodMetricsRow[] (cast by the plugin):
  // [{workspaceId, name, isDefault, coverage: {trackedRepos, totalRepos, complete}, metrics}] —
  // `coverage` is the per-workspace onboarded-mid-window disclosure, measured at the window's
  // start. WINDOW-PURE (the two-sided predicates ride on getPeriodMetrics), and it carries NO
  // cost fields at all — cost is per-workspace and must never be summed across workspaces, so it
  // simply does not travel here.
  getPeriodMetricsForWorkspaces(
    accountId: number,
    window: { fromMs: number; toMs: number },
  ): Promise<unknown>;
  // The synthesis seam's input assembly (P2.1, now LIVE): the EXACT item rows a drill-down lists
  // for a scope descriptor, so the model summarises precisely the set the receipt list shows.
  // ⚠ One predicate, three consumers — a drill-down's list, its count and this input set read the
  // SAME core query per kind (db/synthesis-input.ts documents which; the bots-flagging
  // tile-number-vs-hydration lesson generalised). The descriptor and row shapes are the SHARED
  // `SynthesisScope`/`SynthesisInput` types — typed here (replacing the declared-inert
  // `Promise<unknown>` sketch, a permitted no-version refinement: the plugin mirror moved in the
  // same commit) because the plugin's payload hash folds the per-item ids + created-at, and a
  // `cast-and-hope` seam is exactly where a hash formula drifts. Notes that moved into the types:
  // the P2.1 kinds are the FOUR drill-down grains (Phase 3 widens the union additively); `window`
  // is a bare BotWindowKind (every consuming drill-down is enum-windowed — the widened
  // {fromMs,toMs} form stays a Phase-3 concern) and is IGNORED for the windowless 'bot-threads'
  // backlog; the old `direction`/`filters` sketch became typed fields
  // (direction/select/severities/category). Returns capped rows + analyzed/total counts +
  // `truncated` — silent truncation reads as "covered everything", so the card renders
  // "Summarised X of Y" from exactly these numbers.
  getSynthesisInput(accountId: number, scope: SynthesisScope): Promise<SynthesisInput>;
  // The deterministic daily-brief fold (P3.1 — NOW LIVE: core db/daily-brief.ts, computed on
  // read behind a module-level 5-min TTL cache, no storage): My Turn count, stalled/attention
  // counts, resolve-backlog count, trunk red repos, and a NARROW volume-only bot-anomaly slice
  // (weekly event counts through the same exported weeklyAnomalies fold the behaviour tab uses —
  // deliberately NOT the full behaviour/heatmap compute). Each line carries what its strip line
  // needs to deep-link to the surface that owns it. ⚠ Every count REUSES that surface's own fold
  // (the consolidated feed's my-turn facet under the default 'hide' lens — inheriting its
  // actor-less CI-row exclusion — the /api/attention cards, getResolvableBotThreadPrs'
  // totalThreads, the repos head columns), never a re-derivation that can disagree with the
  // surface it links to. Typed with the SHARED DailyBriefCounts (replacing the declared-inert
  // `Promise<unknown>` sketch — the permitted no-version refinement; the plugin mirror moved in
  // the same task) because the plugin's brief-narration payload hash folds these very counts.
  // NO cost fields travel here, ever (§8.18 — the roll-up loops this per workspace).
  getDailyBriefCounts(accountId: number, workspaceId: number): Promise<DailyBriefCounts>;
  // The 1:1-prep person vector (P4.2 — NOW LIVE: core db/person-period.ts): a small fixed
  // vector for one person in one workspace — merged/opened authored · reviews given · review
  // comments · median request→their-review response · their PRs' first-human-review wait ·
  // threads opened on their PRs vs addressed · waiting-on-them · WIP — seven window-pure keys
  // with two-sided predicates plus three keys explicitly marked `basis:'live'`, with its own
  // PERSON_METRICS_SCHEMA_VERSION and per-person coverage honesty (onboarded-mid-window repos
  // AND a first-observed-mid-window person both disclose). ⚠ `users` is a GLOBAL table — the
  // fold admits the subject only via a workspace activity probe (the listUsers precedent) and
  // returns login/name only; humans resolve through the ONE lane resolver (an automation-lane
  // actor yields null — no 1:1 with Dependabot), and the first-human-review figure reuses
  // loadFirstHumanReviewHours via its authorUserId narrowing (the one-fold rule). Prep, not
  // scoring: one userId in, one person out — no cross-person shape travels here.
  // Typed with the SHARED `PersonPeriod` (replacing the declared-inert `Promise<unknown>`
  // sketch — the permitted no-version refinement; the plugin mirror moved in the same task)
  // because the plugin's person-narration hash folds these very values (via the count-encoded
  // synthesis item ids core builds from this vector). `null` covers every degrade in one shape:
  // unknown/foreign user, a bot, no footprint in the workspace.
  // `opts.evidence` (the People report) is an OPTIONAL trailing widening — apiVersion unchanged
  // (the registerAccountErasure "purely additive" precedent): an older plugin calls with four
  // args and type-checks; an older HOST simply never sets `person.evidence`, which the shared
  // type declares optional for exactly that reason. When set, the same fold (same guardrails,
  // run once) widens its windowed scans to capped row selects and returns the receipt rows —
  // `PersonPeriod.evidence` — beside the untouched metric cells.
  getPersonPeriod(
    accountId: number,
    workspaceId: number,
    userId: number,
    window: { fromMs: number; toMs: number },
    opts?: { evidence?: boolean },
  ): Promise<PersonPeriod | null>;
}

export interface ProContext {
  log: FastifyBaseLogger;
  host: { version: string; deploymentMode: 'local' | 'cloud'; isCloud: boolean };
  accountIdOf(req: FastifyRequest): number; // the single scoping seam
  // node-postgres-TYPED drizzle instance → a stray .get()/.all()/.run() is a
  // compile error in the plugin too.
  db: typeof import('../db/client.js').db;
  schema: typeof import('../db/client.js').schema;
  runTransaction: typeof import('../db/client.js').runTransaction;
  isPg: boolean;
  // Plugin-owned dual-dialect migrator hook (CREATE TABLE IF NOT EXISTS + its own
  // pro_migrations bookkeeping; see pro/migrate.ts).
  registerMigrations(sqliteFolder: string, pgFolder: string): Promise<void>;
  // Retention hook: the core TTL sweep (db/retention.ts) deletes core PR subtrees; the
  // plugin registers a handler here to prune ITS OWN tables (ai_fixes / ai_pr_analyses /
  // review_learnings) for the same PR ids — core can't name plugin tables (open-core
  // boundary). Called once per delete batch. Inert in OSS (no plugin → never registered).
  registerRetention(
    handler: (args: { prIds: number[] }) => Promise<void> | void,
  ): void;
  // Erasure hook (GDPR Art. 17), the account-scoped twin of registerRetention. Core's
  // DELETE /api/me/account removes the account and every core-owned row, then calls each
  // registered handler so the plugin can delete ITS OWN account-scoped tables (pro_settings,
  // sprint_reports, repo_digests, …). Core can't name them across the open-core boundary, and
  // an "account deleted" that quietly left them behind would make the privacy policy untrue.
  // OPTIONAL so a plugin built against an older host still type-checks; apiVersion unchanged
  // (purely additive — an older plugin simply never registers one).
  registerAccountErasure?(
    handler: (args: { accountId: number }) => Promise<void> | void,
  ): void;
  // The cheap-tier completion seam (review/llm.ts) — so the plugin adds no new
  // Anthropic dependency.
  llm: {
    complete(opts: {
      model?: string;
      system?: string;
      prompt: string;
      maxTokens?: number;
      // Explicit API key → the raw metered path; omitted → the ambient Claude
      // session. Lets the summary use its OWN discrete credential.
      apiKey?: string;
      // 'local-review-key' → CORE resolves the local BYO Anthropic key
      // (review/local-settings.ts) itself — the key never crosses the plugin boundary —
      // falling through to the ambient session when unset. Ignored when `apiKey` is given.
      credential?: 'local-review-key';
    }): Promise<{
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
    }>;
    // Best-effort detection of whether Claude auth is available (for a pre-flight
    // before an LLM/agent run). Mirrors Claude Review's detectClaudeAuth.
    detectAuth(): { status: 'ok' | 'none'; message?: string };
  };
  queries: ProHostQueries;
  // Append one billable AI operation to the core AI-usage ledger. Lets the plugin record
  // its own summary/agent spend (digests, sprint report, AI Fix) into the SAME ledger the
  // core Claude Review path writes, so month-to-date usage is summable across features.
  recordAiUsage(row: AiUsageRecord): Promise<void>;
  // Metered-plan credit gate. The accounts table + billing plan + allowance rules all live
  // in core, so the allowance math is core-owned and the plugin stays oblivious to the plan:
  // it just asks "may I spend?" before a paid generation. `check` returns the account's
  // month-to-date credit status (allowance / used / remaining / blocked); the plugin skips
  // the LLM call and surfaces a creditsExhausted state when `blocked`. Local accounts are
  // unmetered (allowanceCredits null → never blocked), preserving today's behavior.
  aiCredits: {
    check(accountId: number): Promise<AiCreditStatus>;
  };
  reviewEvents: ReviewEventBus; // WS3 capture seam
  registerLearningsProvider(p: LearningsProvider): void; // WS3 injection seam
  // Background-job seam (host owns process/scheduler infra). The plugin registers node-cron
  // jobs here during register(); the core scheduler cron.schedule()s them AFTER bind, so they
  // ride the config.disableScheduler gate and are torn down with the app. Used by the Slack
  // digest cron + the AI-summary update policy. Inert in OSS. `label` is for logs.
  registerScheduledJob(
    cron: string,
    handler: () => Promise<void> | void,
    label?: string,
  ): void;
  // PR-detail enrichment seam. The plugin registers an enricher that computes Jira/Linear
  // ticket links (compute-on-read) from a PR's title + head branch; core getPrDetail calls it
  // and sets PrDetail.tickets. Inert in OSS (tickets stays null).
  registerPrDetailEnricher(e: PrDetailEnricher): void;
  // AI Fix infra (per-account, cloud-ready). Inert in OSS.
  github: GithubSeam;
  coding: CodingSeam;
  // Claude Review infra (the SDK run + diff prep + GitHub post). Inert in OSS.
  review: ReviewSeam;
}

export interface ProPlugin {
  // Contract handshake; host warns on mismatch.
  //
  // 20 → 21: THE PHASE-0 TIER LINE (one bump carrying every seam the calm-consolidation plan
  // needs — later phases consume seams that land inert). `ProCapabilities` gains `botDepth`
  // (the non-AI paid depth tier, gated like workspaceInsights). `ProHostQueries` gains FIVE
  // members: `getBotBehaviour` (the core behaviour rollup re-exposed through the seam, widened
  // with an optional `botUserId` one-bot narrowing) and `getPeriodMetricsForWorkspaces` (the
  // per-workspace period vectors behind the Reports "By workspace" axis) — both live — plus
  // three DECLARED-inert seams whose core folds are their consuming phases' deliverables:
  // `getSynthesisInput` (P2.1 input assembly), `getDailyBriefCounts` (P3.1 brief fold) and
  // `getPersonPeriod` (P4.2 person vector). Declaring all five HERE is what D2's single bump
  // buys: swapping the inert bodies for the real folds later changes no contract, so no 21→22.
  //
  // 19 → 20: PERIOD-OVER-PERIOD REPORTING. `ProHostQueries` gains three members —
  // `getPeriodMetrics` (the closed 12-metric window-pure vector + its data fingerprint),
  // `getPeriodCoverage` (which repos were already tracked at a period start — the rule that stops
  // repo onboarding from reading as team growth) and `computePeriodForecast` (the pure Theil–Sen
  // estimator, crossed as async) — and `ProCapabilities` gains `periodReports`. The plugin owns
  // the stored history, the narration and the routes; core owns the metrics and the maths.
  //
  // 18 → 19: `CodingSeam.generateFix`'s result gains OPTIONAL `commentVerdicts`
  // (`FixItemVerdict[]`) — the per-item dispositions behind "fix from comments", reported by
  // the agent through core's `submit_fix` tool. Core stays ignorant of what the items ARE:
  // the plugin's prompt assigns the `ref` labels and maps them back to comment rows. Additive
  // and optional, so a plain / CI-seeded run is byte-identical to before.
  //
  // 17 → 18: `ProHostQueries.getBotAnalytics`'s `window` widened from a bare `BotWindowKind` to
  // `kind | {kind, fromMs, toMs}`, so the Insights chat's user-chosen range (which now includes
  // "Sprint to date" and 90d) can hand core the REAL window. Core alone cannot: `'sprint'` there
  // resolves to a trailing 14 days, since the cadence + start are plugin-owned. `BotWindowKind`
  // also gained `'rolling_90'`.
  //
  // 16 → 17: GithubSeam gained `fetchReviewCommentHunks` — the lean-storage anchor-hunk
  // hydration behind the `addressed` and `validity` judgements (see src/sync/hydrate-detail.ts).
  // Without it both read a `diff_hunk` column that is NULL for ~97% of rows and answer
  // "I can't see the code".
  // 15 → 16: GithubSeam gained `fetchCompareDiff`
  // (the two-sha compare primitive the `addressed` annotation is grounded on — see
  // src/github/compare.ts). 14 → 15 was the Bot Tuning Advisor — GithubSeam gained
  // readRepoFile/listRepoDir/openIssue, CodingSeam gained commitFilesAndOpenPr,
  // ProHostQueries gained getAdvisorFindings/getBotEffectPanel, CodingErrorCode gained
  // BRANCH_EXISTS, llm.complete gained `credential`, and ProCapabilities gained `botAdvisor`.
  //
  // ⚠ THIS LITERAL HAS A TWIN IN bind.ts (its `plugin?.apiVersion !==` runtime gate — THE only
  // enforcer) and two more in the plugin (packages/pro/src/index.ts,
  // packages/pro/src/contract-types.ts). Bump ALL FOUR or the plugin log-and-degrades to OSS mode
  // against a version that is actually correct: capabilities go dark, every /api/pro/* route
  // 404s, and nothing throws. ⚠ The plugin's half lives in a SUBMODULE, so "all four" spans TWO
  // repos — the gitlink committed here must point at a plugin commit carrying the same number.
  apiVersion: 21;
  register(app: FastifyInstance, ctx: ProContext): Promise<ProCapabilities>;
}

// The live capability singleton, mirrored to the frontend via /api/me exactly
// like claudeReviewEnabled. All-false in OSS mode (no plugin ever calls the
// setter).
export const EMPTY_CAPABILITIES: ProCapabilities = {
  activityDigest: false,
  reviewMemory: false,
  aiAnalysis: false,
  prSummary: false,
  aiFix: false,
  workspaceInsights: false,
  claudeReview: false,
  slackDigest: false,
  issueLinks: false,
  botTriage: false,
  botAdvisor: false,
  periodReports: false,
  botDepth: false,
};
let active: ProCapabilities = EMPTY_CAPABILITIES;
export function setProCapabilities(c: ProCapabilities): void {
  active = c;
}
export function getProCapabilities(): ProCapabilities {
  return active;
}

/**
 * The per-account ENTITLEMENT view of the capability singleton (the billing
 * seam). The singleton says what the loaded plugin CAN do; this intersects it
 * with what the account has PAID for: local accounts are always fully entitled
 * (today's behavior, exactly), a cloud account is entitled once its plan is
 * anything but 'free' (set by the Stripe webhook). Used by /api/me (the SPA
 * honors the all-false shape as the plain OSS render path) and mirrored by the
 * /api/pro/* 402 gate in api/plugins/auth.ts.
 */
export function entitledProCapabilities(account: {
  isLocal: boolean;
  plan: string;
}): ProCapabilities {
  return account.isLocal || account.plan !== 'free'
    ? getProCapabilities()
    : EMPTY_CAPABILITIES;
}
