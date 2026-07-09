import type {
  FastifyInstance,
  FastifyRequest,
  FastifyBaseLogger,
} from 'fastify';
import type {
  CheckLogsResponse,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewModel,
  ClaudeReviewVerdict,
  PostReviewPreview,
} from '@pierre-review/shared';
import type { ReviewEventBus, LearningsProvider } from '../review/events.js';
import type { FyiProvider } from '../feed/fyi-provider.js';
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
  teamInsights: boolean; // team review-intelligence "Insights" (no AI; pure reads)
  claudeReview: boolean; // agentic Claude Review (Agent SDK; the product lives in the plugin)
  feedMyTurn: boolean; // Activity Feed FYI / "My Turn" participation flagging (Pro; no AI)
  slackDigest: boolean; // Slack webhook delivery of the sprint + repo digest (Pro; mirrors activityDigest)
  issueLinks: boolean; // Jira/Linear ticket-link enrichment in PR detail (Pro; no AI)
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

export interface GenerateFixResult {
  summary: string;
  commitMessage: string;
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
export type CodingErrorCode =
  | 'HEAD_MOVED'
  | 'PUSH_DENIED'
  | 'APPLY_FAILED'
  | 'CONFLICTS_UNRESOLVED'
  | 'MERGE_FAILED'
  | 'REBASE_FAILED'
  | 'TRUNK_FETCH_FAILED';

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
}

export interface CodingSeam {
  generateFix(args: GenerateFixArgs): Promise<GenerateFixResult>;
  applyAndPush(args: ApplyAndPushArgs): Promise<ApplyAndPushResult>;
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
  getLocalKeyStatus(): { hasUserKey: boolean };
  setLocalKey(key: string | null): { hasUserKey: boolean; auth: 'ok' | 'none' };
}

// An explicit Insights metrics window (epoch millis, inclusive) used to override the default
// window with a configured SPRINT. Open PRs always count regardless of age — the window only
// bounds time-based facts (merges, review latency, throughput). Passed across the boundary as
// plain numbers to avoid Date/ISO ambiguity.
export interface SprintWindow {
  fromMs: number;
  toMs: number;
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
  getActivity(accountId: number, repoIds?: number[] | null): Promise<unknown>; // WS2 aggregate (lands in a later phase)
  // Team review-intelligence cards (stalled reviews / untouched threads / reviewer load /
  // routing), computed over the account's WATCHED repos. Returns InsightsResponse. The optional
  // `window` (epoch-millis) overrides the default metrics window with the account's configured
  // SPRINT (see the Pro sprint config); open PRs always count regardless of age. Omitted → the
  // built-in default window (unchanged legacy behavior).
  getTeamInsights(
    accountId: number,
    window?: SprintWindow,
  ): Promise<unknown>;
  // The per-metric PR drill-down behind the flow-metric tiles (watched repos + sprint).
  // Returns TeamMetricsDetail. Heavier than getTeamInsights — loaded on demand. Same optional
  // sprint `window` override.
  getTeamMetricsDetail(
    accountId: number,
    window?: SprintWindow,
  ): Promise<unknown>;
  // Month-to-date-style AI-spend rollup for an account, split by seam (summary / agent).
  // Returns { summaryUsd, agentUsd, totalUsd } — the plugin converts to credits.
  getAiUsage(accountId: number, sinceMs: number): Promise<unknown>;
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
  // Activity Feed FYI/"My Turn" enrichment seam. The plugin registers a provider that flags
  // each feed item `isMyTurn` by participation; inert (feed stays plain) without the plugin.
  registerFyiProvider(p: FyiProvider): void;
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
  apiVersion: 10; // contract handshake; host warns on mismatch
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
  teamInsights: false,
  claudeReview: false,
  feedMyTurn: false,
  slackDigest: false,
  issueLinks: false,
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
