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
  ClaudeFindingLens,
  ClaudeReviewVerdict,
  DailyBriefCounts,
  PersonPeriod,
  PostReviewPreview,
  SynthesisInput,
  SynthesisScope,
  BlastSignals,
  FlowPointerEvidence,
  PendingBoardSnapshot,
  SprintComparisonMode,
  WorkPlanEvidence,
} from '@pierre-review/shared';
import type { CompareDiffResult } from '../github/compare.js';
import type { PrReviewCommentHunks } from '../sync/hydrate-detail.js';
import type { AiUsageRecord } from '../db/usage.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ConflictSeam } from '../conflict/seam.js';

// THE PLATFORM CONTEXT — the one context type handed to the reporting / bots / Slack / settings
// modules under src/platform/ (formerly the private @pierre/pro plugin, folded into core). It is
// built ONCE at boot by platform/context.ts and passed to platform/index.ts `registerPlatform`.
// Nothing here is optional at runtime and nothing is gated: every account gets every feature.
// The agentic types below (review, fix, post) are shared with core's review/ and coding/ modules.

// The platform modules reach their OWN tables via `proSchemaFor()` and core tables via the
// `schema` value below, typed loosely: the drizzle instance with an empty schema generic, and the
// core schema object accessed by table name.
export type ProDb = BetterSQLite3Database<Record<string, never>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProCoreSchema = Record<string, any>;

export type { AiUsageRecord, CompareDiffResult, PrReviewCommentHunks, ConflictSeam };


// ---- AI Fix seams (github + coding) -------------------------------------------
// The generic, security-sensitive infrastructure for the Pro "AI Fix" feature lives
// in CORE (per-account tokens, the write-capable agent, git push) and is exposed to
// the plugin through these two seams; the plugin supplies only prompts + model and
// owns the product workflow. Inert in OSS (nothing calls it), exactly like llm.

// Progress emitted while a fix run goes (mirrors ClaudeReviewProgress). The plugin maps it
// straight onto AiFixProgress on the wire, so the two phase unions are the same five members.
export interface CodingProgress {
  phase:
    | 'fetching_diff'
    | 'cloning'
    | 'fixing'
    | 'capturing'
    | 'persisting';
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
  /** The PR, for the ledger row a provider that records its own usage (Codex) writes. */
  prId?: number;
  /** The provider the prompt was worded for (ai/prompt-tools.ts). Absent ⇒ the active one. */
  provider?: 'claude' | 'codex';
  /** Codex-only run knobs (the opt-in live test's effort). */
  codex?: { effort?: string; timeoutMs?: number };
  /** The run's effort (ai/effort.ts `agenticRunEffort`, decided by the manager). Absent ⇒ Default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

// The fix agent's self-report, as the `submit_fix` tool received it (UNVALIDATED — the AI Fix
// manager checks refs against the set the run was shown and clips text before storing it). Self-
// report only: the changeset still comes from git.
export interface FixAgentReport {
  changes?: Array<{ path: string; summary: string; refs?: string[] }>;
  unaddressed?: Array<{ ref: string; reason: string }>;
}

export interface GenerateFixResult {
  summary: string;
  commitMessage: string;
  // The per-change report and the items deliberately not fixed. Absent when the agent never
  // called submit_fix (or reported neither list).
  report?: FixAgentReport;
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
  /** True ⇒ the provider already wrote this run's AI-usage ledger row (Codex): write no second one. */
  usageRecorded?: boolean;
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

// The coding paths (applyAndPush) and core's own update-from-trunk throw an Error carrying `.code`
// on the expected failures, so routes can map them to HTTP status without importing a host class.
// Every member stays even where nothing throws it any more: core's `updatePrBranchFromTrunk`
// throws the trunk ones, and `coding/git.ts`'s `codedError` is typed by this union.
//   'HEAD_MOVED'           — existing-branch push and the live head !== baseSha (→ 409)
//   'PUSH_DENIED'          — the account lacks write / an un-pushable fork (→ 422)
//   'APPLY_FAILED'         — a stored patch didn't apply cleanly (→ 422)
//   'CONFLICTS_UNRESOLVED' — merge/rebase left conflicts we won't push (→ 422)
//   'MERGE_FAILED'         — the merge failed for a non-conflict reason (→ 422)
//   'REBASE_FAILED'        — the rebase failed for a non-conflict reason (→ 422)
//   'TRUNK_FETCH_FAILED'   — the trunk ref couldn't be fetched (→ 422)
//   'BRANCH_EXISTS'        — a NEW push target branch already exists (→ 409)
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
  // No plugin caller since the Pro CI analysis was retired (Claude Review reads failing CI in core,
  // review/claude-review/ci-failures.ts). Kept because it is a REQUIRED member: removing it is an
  // apiVersion bump, which nothing else here needs.
  fetchCheckLogs(
    accountId: number,
    owner: string,
    name: string,
    jobId: number,
    tail?: number,
  ): Promise<CheckLogsResponse>;
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
  // The ref ('P1'…) of the previous-review finding this one RE-RAISES, verbatim from the model
  // (the plugin validates it against the refs it sent). Absent/null otherwise.
  // ⚠ OPTIONAL, SO apiVersion STAYS 21.
  priorRef?: string | null;
  // The specialist lens on a deep review (review/claude-review/specialists.ts); null/absent ⇒ a
  // general finding. Core-only (Claude Review left the plugin), so no apiVersion question.
  lens?: ClaudeFindingLens | null;
  // A docs run only: the library section links the model said this finding rests on, RAW (the
  // manager checks them into `docCitations` before storing).
  docRefs?: unknown;
  // (A STORY FINDING's origin used to ride here. Stories left the PR review for the ticket review
  // (review/ticket-review/), so a run makes none; old rows keep theirs in the story_* columns.)
}

// ---- Follow-up + user-story reports (host→plugin RESULT fields) ----
// ⚠ OPTIONAL, SO apiVersion STAYS 21. These are host→plugin result fields; an older host omits
// them and the plugin records every item not_checked. They are passed through VERBATIM from the
// model's submit_review payload — the plugin validates coverage (each ref once, unknown refs
// dropped, missing refs 'not_checked', never an invented 'addressed').
export interface ReviewFollowUpReport {
  ref: string;
  // The two reply statuses are core-only (Claude Review left the plugin) and valid only on a ref
  // whose thread had a person's reply; follow-up.ts `reconcileFollowUp` enforces both.
  status:
    | 'addressed'
    | 'partly_addressed'
    | 'not_addressed'
    | 'no_longer_applies'
    | 'reply_accepted'
    | 'reply_disputed';
  explanation: string;
  // 'reply_accepted' only: how the reply settled it.
  acceptKind?: 'not_valid' | 'deferred' | null;
  // The reply-status text: the one-sentence acknowledgement, or the pushback.
  reply?: string | null;
}

// One OTHER reviewer's open thread, as Claude judged it ('R1'… as the prompt named them). Core-only
// (Claude Review left the plugin), passed through VERBATIM; review/claude-review/threads.ts
// reconciles it (each ref once, unknown refs dropped, missing refs 'not_checked').
export interface ReviewThreadReport {
  ref: string;
  validity: 'valid' | 'partly_valid' | 'not_valid' | 'unclear';
  addressed: 'addressed' | 'partly_addressed' | 'not_addressed' | 'unclear';
  explanation: string;
  // One line (≤ 120 chars): why. Optional here — the server clips it and stores null when absent.
  reason?: string | null;
  draftReply?: string | null;
}

// One FAILING CI check, as Claude diagnosed it ('F1'… as the prompt named them). Core-only, passed
// through VERBATIM; review/claude-review/ci-failures.ts reconciles it (each ref once, unknown refs
// and malformed entries dropped, missing refs 'not_checked' — never an invented cause).
export interface ReviewCiFailureReport {
  ref: string;
  cause: string;
  explanation: string;
  category: 'code' | 'test' | 'flaky_or_infra' | 'config' | 'unclear';
  step?: string | null;
  relatedFiles?: Array<{ path: string; line?: number | null }>;
  fixableInPr: boolean;
  // 0-100, how sure Claude is of `cause` (the CI review's submit tool). Absent ⇒ null.
  confidence?: number | null;
}

// The ticket-report shapes (one ticket's criteria / gaps as the model reports them). No longer a
// RunReviewResult field — stories left the PR review for the ticket review — but still the input
// shape of claude-review/ticket.ts's reconcile.
export interface ReviewTicketItemReport {
  // The criterion as Claude read it from the acceptance-criteria text (Claude enumerates them).
  text: string;
  status: 'met' | 'partly_met' | 'not_met' | 'unclear';
  explanation: string;
  path?: string | null;
  line?: number | null;
}

export interface ReviewTicketGapReport {
  title: string;
  explanation: string;
  path?: string | null;
  line?: number | null;
}

export interface ReviewTicketReport {
  // Which ticket this reports on: 'T1'… as the prompt named them. Absent on the legacy single
  // `ticket` report (read as T1).
  ref?: string;
  alignment: 'aligned' | 'partly_aligned' | 'not_aligned' | 'unclear';
  summary: string;
  criteria?: ReviewTicketItemReport[];
  missing?: ReviewTicketGapReport[];
  notRequested?: ReviewTicketGapReport[];
}

export interface RunReviewArgs {
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  model: ClaudeReviewModel;
  // WHICH PROVIDER RUNS IT — the job's own (a manual run's per-run choice, or the default for an
  // automatic run), decided once by the manager. Absent ⇒ the default provider (Settings → AI).
  provider?: 'claude' | 'codex';
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
  // The specialist sub-agents OFFERED to the lead on a deep review (specialists.ts
  // `offeredSpecialists`). Honoured ONLY when `mode === 'worktree'`; a diff-only run gets none
  // whatever is passed. The lead picks among them, at most CLAUDE_REVIEW_MAX_SPECIALISTS.
  specialists?: ClaudeFindingLens[];
  // OTHER PRs on the same ticket(s), checked out READ-ONLY beside the PR so a deep review can check
  // cross-repo interactions (an API this PR changes against a consumer in a peer). Honoured ONLY
  // when `mode === 'worktree'`; at most TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW. `ref` ('X1'…) is the
  // name the prompt's "Related PRs" block gives it; core appends where each one sits on disk (or
  // that it could not be checked out). Core-only, so no apiVersion question.
  // A RELATED REPO's peer (docs/CLAUDE-REVIEW.md § Related repos) may also be a BRANCH with no PR or
  // the repo's DEFAULT BRANCH (`kind`), checked out at the branch's tip.
  peers?: ReviewRunPeer[];
  // The workspace's REFERENCE LIBRARY folder when the review should read it (docs/REFERENCE-DOCS.md
  // § Use in reviews): a READ-ONLY root of the run's path guard, and the tool gains `docReferences` /
  // a finding's `docRefs`. Absent/null ⇒ the run is exactly as before. Core-only (Claude Review left
  // the plugin), so no apiVersion question.
  docsDir?: string | null;
  // WHO TO BILL, for a provider that writes its own ledger row (Codex: a ChatGPT run is US$ 0, so the
  // manager's cost-gated row would never be written; ai/provider.ts `usageRecord`). Claude ignores it
  // and the manager records Claude's run exactly as before. Core-only.
  usage?: { accountId: number; prId: number | null; repoId?: number | null };
  // Asked before EACH specialist starts on a CODEX deep review, where Limn runs them as separate runs
  // (ai/codex/specialists.ts `allowStart`; the manager passes the spend-budget gate for an automatic
  // review). Claude's specialists are sub-agents of the one run and never ask it. Core-only.
  allowSpecialistStart?: (lens: string) => boolean | Promise<boolean>;
}

/** One peer a deep review checks out read-only (RunReviewArgs.peers). */
export type ReviewRunPeer =
  | { ref: string; owner: string; name: string; kind?: 'pr'; prNumber: number; headSha: string }
  | {
      ref: string;
      owner: string;
      name: string;
      kind: 'branch' | 'default_branch';
      // The branch to check out; null = the remote's HEAD (a default branch whose name is not known).
      branch: string | null;
    };

export interface RunReviewResult {
  submitted: boolean; // false ⇒ the agent never called submit_review → plugin marks failed
  // What RAN: the provider and the model id it resolved (ai/provider.ts `ranOn`). The manager stores
  // both on the run row, so a Codex run reads "Codex · GPT-6 Astra", never the Claude id it was asked
  // for. Optional: a fake runner in a test may omit it (the row then keeps its queued model).
  ranOn?: { provider: 'claude' | 'codex'; model: string; effort?: string };
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
  // ⚠ OPTIONAL, SO apiVersion STAYS 21 (see ReviewFollowUpReport). Present only when the model
  // reported them — i.e. when the prompt carried a "Previous review" block.
  followUp?: ReviewFollowUpReport[];
  // Present only when the prompt carried a "Review threads" section and the model reported.
  threads?: ReviewThreadReport[];
  // Present only when the prompt carried a "CI failures" section and the model reported.
  ciFailures?: ReviewCiFailureReport[];
  // A docs run only (RunReviewArgs.docsDir): the model's `docReferences`, RAW — the manager checks each
  // against the library before anything is stored.
  docReferences?: unknown;
  // The refs of the peers that WERE checked out (a deep run handed peers); absent otherwise. The
  // manager stores what was read (`claude_reviews.peers_read`).
  peersCheckedOut?: string[];
  // True when the PROVIDER already wrote this run's ledger row (Codex, given `usage`): the manager
  // must not record it again. Absent ⇒ the manager records it as it always did (Claude).
  usageRecorded?: boolean;
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
  // A user-story finding's first comment line (shared `storyCommentLead`), added by the comment
  // builders; absent / null for every other finding. OPTIONAL, so no apiVersion bump.
  storyLead?: string | null;
  // A visible last line (shared `AUTO_POST_FOOTER`), set only by auto-posting; it sits just above
  // the hidden marker. OPTIONAL, so no apiVersion bump.
  footer?: string | null;
  // The finding's severity: the comment LEADS with its bold word (shared `limnSeverityLead`, read
  // through `severityForPostedFinding`). Absent / praise ⇒ no lead (a ticket review's story-gaps
  // comment). OPTIONAL, so no apiVersion bump.
  severity?: ClaudeFindingSeverity | null;
  // A tag on that lead line: the provider that raised the finding on a Claude + Codex pair's ONE
  // review ("**Warning** · Codex"). Absent / null on every other post. OPTIONAL.
  severityTag?: string | null;
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
  //
  // ⚠ THE `pierre` IN BOTH FIELD NAMES IS FROZEN, and so is the marker they refer to. The app is
  // called Limn now; these are wire/contract surface and the marker is already in GitHub review
  // bodies we cannot edit, so neither spelling follows the rename. The footer they mention is
  // GONE — it never read "Limn"; it read "🤖 Reviewed with Pierre + Claude", appeared in no
  // detector, and was deleted (review/post-seam.ts:90). Recorded here as history, not as a thing
  // that ships.
  pierreMarker?: boolean; // append a hidden `<!-- pierre:claude-review v=1 -->` marker
  pierreFooter?: boolean; // RETIRED: once appended a visible footer to the posted review body
}

export type PostReviewOutcome =
  | { headMoved: true }
  | { headMoved?: false; preview: PostReviewPreview } // dryRun
  | {
      headMoved?: false;
      postedReviewId: string;
      inlineFindingIds: number[];
      // The GitHub comment id of each inline finding, read back after the submit (best-effort: a
      // finding missing here is still posted). OPTIONAL, so no apiVersion bump.
      inlineComments?: { findingId: number; commentId: string }[];
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
  // true = always a PR-level comment, never inline (auto-posting's questions), naming the file
  // without the "outside the diff" note. OPTIONAL, so no apiVersion bump.
  prLevel?: boolean;
}

export type PostFindingOutcome =
  | { headMoved: true }
  | { headMoved?: false; commentId: string; postedCommentKind: 'inline' | 'pr_comment' };

// ---- Claude Review chat (one answered turn about a SUCCEEDED review) ----
// ⚠ OPTIONAL ON THE SEAM, SO apiVersion STAYS 21 (`ReviewSeam.chat?`). The plugin builds the whole
// prompt — the review, every finding, the diff and the prior turns, rebuilt from stored rows and
// fenced with the review nonce — and core runs ONE agent turn that MIRRORS the review's mode: a
// worktree review gets Read/Glob/Grep on a worktree at the REVIEWED head (never the PR's current
// one), a diff-only review is tool-less. Bash is denied outright either way, exactly as for the
// review. Same model, same credential ladder (`applyClaudeReviewAuth`), its own small per-turn
// budget (`config.reviewChatBudgetUsd`) and a low turn cap. The answer is free text; no MCP tool.
export interface ReviewChatArgs {
  owner: string;
  name: string;
  prNumber: number;
  // The REVIEWED head — the worktree is checked out here even when the PR has moved on.
  headSha: string;
  model: ClaudeReviewModel;
  // Which provider answers (chat.ts: the review's own when it is signed in, else the default).
  // Absent ⇒ the default provider.
  provider?: 'claude' | 'codex';
  mode: 'diff_only' | 'worktree';
  systemPrompt: string;
  prompt: string;
  // Same contract as RunReviewArgs.applyAuthEnv: true ONLY when no other run can share the env.
  applyAuthEnv: boolean;
  abortController: AbortController;
  // An "explain these" turn (review/claude-review/chat-explain.ts): the run also gets the in-process
  // `submit_explanations` tool and succeeds ONLY by calling it. Optional, so no apiVersion bump.
  explain?: boolean;
  // Who to bill, for a provider that writes its own ledger row (Codex) — RunReviewArgs.usage.
  usage?: { accountId: number; prId: number | null; repoId?: number | null };
}

export interface ReviewChatResult {
  ok: boolean; // false ⇒ no usable answer (failureReason says why); the turn may still have cost
  // What RAN (RunReviewResult.ranOn): the answer row stores both. Optional for fakes in tests.
  ranOn?: { provider: 'claude' | 'codex'; model: string };
  text: string;
  // An explain turn: the raw `submit_explanations` payload, UNVALIDATED (chat.ts validates it).
  submitted?: unknown;
  failureReason?: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  numTurns: number | null;
  aborted: boolean;
  // True when the provider already wrote the turn's ledger row (Codex) — RunReviewResult.usageRecorded.
  usageRecorded?: boolean;
}

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
  // ⚠ `getLocalKeyStatus` / `setReviewBudget` ARE DELETED. The per-review budget is the
  // environment's `REVIEW_BUDGET_USD` (config.reviewBudgetUsd) alone: no stored override, no route,
  // no seam. The plugin never called either member, so apiVersion stays 22.
  // ONE chat turn about a succeeded review (see ReviewChatArgs). ⚠ OPTIONAL, SO apiVersion STAYS
  // 21: absent against an older host, and the plugin's chat routes then answer 404.
  chat?(args: ReviewChatArgs): Promise<ReviewChatResult>;
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
// apps/backend/src/platform/contract-types.ts) because the plugin imports no host internals.
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
  // ⚠ `DailyBriefCounts` gained an OPTIONAL trailing `myTurnTotal` (the uncapped my_turn
  // population behind MY_TURN_CARD_CAP = 50) — additive, so apiVersion stays 21 and an older
  // plugin simply never reads it. It is a DISCLOSURE, not a figure: `myTurn` remains the count
  // every surface displays and the only one a narration may be grounded in, so nothing here
  // should start phrasing lines from `myTurnTotal` (D4 keeps digits out of the phrasing anyway).
  // ⚠ Same again for the NARROW my_turn pair, `myTurnPersonal` / `myTurnPersonalTotal` (the
  // `MyTurnCard.personal` subset — see PLATFORM.md): both OPTIONAL and TRAILING,
  // both additive, apiVersion still 21. They exist for the surfaces that INTERRUPT the viewer,
  // not for narration; `myTurn` remains this seam's grounded figure, and the two totals only
  // ever qualify the count they were folded from — never each other's.
  // ⚠ And again for the three-way `MyTurnCard.relevance` split — `myTurnDirect` /
  // `myTurnMaintained` / `myTurnOther`, each with its OWN `…Total`. All six OPTIONAL and
  // additive, apiVersion still 21. `myTurnPersonal` keeps its meaning exactly (direct ∪
  // maintained), so nothing already reading it moves; the split exists because the brief now
  // renders TWO mutually exclusive lines and each one opens a board filtered to its own number.
  // Same rule as above, one level down: a count may only ever be qualified by the total folded
  // from the same population, and none of them may be derived by subtracting another.
  getDailyBriefCounts(accountId: number, workspaceId: number): Promise<DailyBriefCounts>;
  // ⚠ INERT SINCE 2026-10-22 — NO PLUGIN CALLER. The 1:1 prep section, the People report and the
  // 'person' / 'person_report' synthesis grains that read it were removed. It stays a REQUIRED
  // member (still wired to core db/person-period.ts) because removing it means bumping apiVersion
  // across four literals in two repos, and a half-bump silently drops the plugin to OSS mode.
  // Do not build on it without reading docs/PLATFORM.md § The People report.
  //
  // The 1:1-prep person vector (P4.2 — core db/person-period.ts): a small fixed
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
  // The work-plan fold (core db/work-plan.ts): the workspace's prioritised worklist — every
  // figure, id, link and RANK code-derived, capped at WORK_PLAN_ITEM_CAP, with the uncapped
  // per-kind totals beside it. Typed with the SHARED `WorkPlanEvidence` (not `Promise<unknown>`)
  // for the same reason getSynthesisInput and getDailyBriefCounts are: the plugin's payload hash
  // folds these very fields, and a cast-and-hope seam is exactly where a hash formula drifts.
  // ⚠ THE ALIGNMENT CONTRACT rides on this return: `counts` is folded from the SAME
  // `/api/attention` cards `getDailyBriefCounts` above counts, so the panel can be ASSERTED equal
  // to the strip above it. A divergence is a defect in ONE fold, not two opinions — so neither
  // this seam nor the plugin may re-derive a count it could have read from here.
  // ⚠ `evidence.generatedAt` and any `facts.ageHours` are DERIVED FROM `now`: they must never
  // enter the plugin's payload hash, or a dormant workspace re-bills on a timer.
  //
  // ⚠ OPTIONAL ON PURPOSE — apiVersion STAYS 21. This is the `registerAccountErasure?` precedent
  // (above) applied to a query member: a REQUIRED addition here is the case that would demand a
  // bump, and a bump is four literals across TWO REPOS whose half-application degrades the ENTIRE
  // plugin to OSS mode with nothing thrown. Optional degrades in ONE feature instead: a newer
  // plugin against an older host finds it `undefined` and reports `enabled: false` for the work
  // plan alone, while every other capability keeps serving. Purely additive — an older plugin
  // simply never calls it.
  getWorkPlan?(accountId: number, scope: BotScopeWire): Promise<WorkPlanEvidence>;

  // CHRONOLOGY POINTERS: the evidence the plugin's Haiku narration may see (core
  // db/flow-pointers.ts) — the same `getFlowCourts` pass the panel renders, trimmed to bounded
  // rows, plus the slowest and quickest PR per size band with the first thing a reviewer said.
  // ⚠ NO PERSON: no actor ids, and every @handle in the text is masked before it leaves core.
  // ⚠ OPTIONAL ON PURPOSE — apiVersion STAYS 21, the `getWorkPlan` precedent verbatim. A newer
  // plugin against an older host finds it `undefined` and reports `enabled:false` for the pointers
  // alone.
  // `opts.reporting` (trailing optional, no bump): measure the workspace's REPORTING WINDOW instead
  // of `windowDays` — the Chronology default. The evidence then carries `reportingWindow`.
  getFlowPointerEvidence?(
    accountId: number,
    scope: BotScopeWire,
    windowDays: number,
    opts?: { reporting?: boolean },
  ): Promise<FlowPointerEvidence>;

  // BLAST RADIUS: the signal vector for ONE pull request — how far it can reach, folded by core's
  // `db/blast-radius.ts` from the stored `files[]` (which never leaves the backend) plus the
  // repo's co-change index. The plugin's `impact` annotation grounds its two sentences on this
  // rather than re-classifying paths itself: a SECOND path classifier on the plugin side could
  // disagree with the chip rendered inches away, and the whole point of the note is to explain
  // the chip.
  //
  // ⚠ THE MODEL MAY NOT MOVE THE LEVEL, so this seam is one-way: the plugin READS the deterministic
  // evidence and writes prose. Nothing it returns feeds back into a level.
  // ⚠ Returns null for the same population the chip renders nothing for — an unmeasured pull
  // request. The caller must skip rather than invent a description of a diff nobody measured.
  // ⚠ OPTIONAL ON PURPOSE — apiVersion STAYS 21, the `getWorkPlan` precedent verbatim. A newer
  // plugin against an older host finds it `undefined` and disables the impact note ALONE, rather
  // than a required addition demanding a bump across four literals in two repositories.
  getBlastSignals?(accountId: number, prId: number): Promise<BlastSignals | null>;

  // The workspace's derived HUMAN SEAT COUNT (core db/queries.ts `workspaceHumanSeatCount`):
  // distinct human PR authors across the workspace's repos over a FIXED trailing 30 days, judged
  // by the workspace's own bot verdicts (a manual "this is a human" makes a seat of a `users.isBot`
  // login; a workspace-classified in-house bot is excluded even where the global table calls it
  // human). ONE number per workspace.
  //
  // ⚠ IT EXISTS FOR EXACTLY ONE JOB: reading a `per_seat` price. `monthly_cents` under
  // `cost_model: 'per_seat'` is the per-developer UNIT, and the monthly figure is unit × this
  // number — MULTIPLIED ON READ, never stored (the product can exceed int4 as cents and would go
  // stale). Every other per-seat derivation in the app (`effectiveMonthlyUsd`, the ROI table's
  // effective `costMonthlyUsd`) multiplies by this same function, so exposing it is what stops the
  // benchmark quoting a different price for the same bot than the Bots tab does.
  //
  // ⚠ THE WINDOW IS FIXED AND MUST STAY FIXED. It deliberately does NOT follow whatever analytics
  // window the caller is rendering: a price is an invoice-shaped fact, and a monthly figure that
  // moved when a chart flipped from 7d to 30d would read as a billing bug. It also keys on
  // WORKSPACE MEMBERSHIP, never on a `repoIds` narrowing — a per-seat invoice does not shrink
  // because the reader filtered a chart.
  //
  // ⚠ OPTIONAL ON PURPOSE — apiVersion STAYS 21, the `getWorkPlan` precedent above, verbatim. A
  // required addition is the case that would demand a bump, and a bump is four literals across TWO
  // REPOS whose half-application degrades the ENTIRE plugin to OSS mode with nothing thrown.
  // Optional degrades ONE reading instead: a newer plugin against an older host cannot resolve a
  // per-seat price, EXCLUDES it from the figure rather than reading the unit as the monthly one
  // (which would understate it by the seat count, silently), and discloses that it did.
  workspaceHumanSeatCount?(accountId: number, workspaceId: number): Promise<number>;
  // DORMANT AUTOMATION (core db/bot-dormancy.ts): of the reviewer ids the caller hands in, the ones
  // that produced NO observable work in this workspace over a FIXED trailing 30 days — no review
  // thread opened, no review comment left, no review submitted (a body-only "nothing to flag" pass
  // counts as work). The same evidence union the Bots ROI table calls a reviewer `dormant` on.
  //
  // ⚠ ONE DORMANCY RULE. The Benchmark's placement route hides dormant reviewers through this seam;
  // a second rule computed plugin-side would be a different sentence about the same reviewer.
  //
  // ⚠ THE WINDOW IS FIXED AND MUST STAY FIXED — it is NOT the ROI table's user-flipped chip. A
  // workspace's peer placement may not vanish because somebody changed a window selector on
  // another tab. The grain is the WORKSPACE (membership, never a `repoIds` narrowing), because a
  // narrowed benchmark request builds no rollup.
  //
  // ⚠ CANDIDATES ARE THE CALLER'S — this seam never re-decides who is a bot, and the result is
  // always a subset of what was passed in.
  //
  // ⚠ OPTIONAL ON PURPOSE — apiVersion STAYS 21, the `getWorkPlan` / `workspaceHumanSeatCount`
  // precedent verbatim. Absent, the plugin hides nothing and the Benchmark behaves exactly as it
  // did before this existed; nothing else degrades.
  dormantBotUserIds?(
    accountId: number,
    workspaceId: number,
    candidateUserIds: number[],
  ): Promise<number[]>;

  // AUTO CLAUDE REVIEW (core db/queries.ts `getAutoReviewCandidates`): the PRs one workspace's
  // auto-review sweeper may start a run on - open, not draft, opened at or after `openedSinceMs`,
  // authored by a PERSON under THIS workspace's bot judgement (the resolver behind
  // `InsightPrRef.authorIsBot`), with no `claude_reviews` row at all - oldest first, at most
  // `limit`; plus how many AUTO runs this workspace started at or after `dayStartMs`. null = the
  // workspace is not the account's.
  // ⚠ OPTIONAL ON PURPOSE - apiVersion STAYS 21, the `getWorkPlan` precedent verbatim. Absent, the
  // sweeper does nothing.
  getAutoReviewCandidates?(
    accountId: number,
    workspaceId: number,
    opts: { openedSinceMs: number; dayStartMs: number; limit: number; pressPrId?: number; pressed?: boolean },
  ): Promise<{
    prIds: number[];
    autoToday: number;
    // Already-reviewed PRs whose head moved past every run (auto RE-review). Absent on an older
    // host ⇒ none.
    reReview?: Array<{ prId: number; headSha: string }>;
  } | null>;

  // THE PENDING BOARD (core db/pending-tabs.ts `getPendingBoardSnapshot`): the configuring
  // account's own six tabs for one workspace — the SAME fold `GET /api/attention` serves
  // (`buildPendingBoard`), so the Slack digest and the board cannot list different cards. It skips
  // the route's two live extras (failing-check names, suggested reviewers): a cron send may not
  // spend GitHub budget. ⚠ LIVE STATE — never part of a payload hash (the sprint report's
  // included), or every send re-bills. ⚠ OPTIONAL ON PURPOSE — apiVersion STAYS 21, the
  // `getWorkPlan` precedent: an older host leaves it undefined and the Pending sections are absent.
  getPendingBoard?(accountId: number, workspaceId: number): Promise<PendingBoardSnapshot>;
}

// The host → plugin event hooks (see `ProContext.registerEventHooks`). Every member optional.
export interface ProEventHooks {
  onClaudeReviewCompleted?(e: {
    accountId: number;
    prId: number;
    reviewId: number;
    trigger: 'manual' | 'auto';
  }): Promise<void> | void;
  onPullRequestMerged?(e: { accountId: number; repoId: number; prId: number }): Promise<void> | void;
}

export interface ProContext {
  log: FastifyBaseLogger;
  host: {
    version: string;
    // WHERE A HUMAN'S BROWSER REACHES THE SPA, no trailing slash (core config.ts `appWebUrl`).
    // The plugin builds DEEP LINKS back into the SPA from it — today, EVERY link in the Slack
    // digest and sprint report: the workspace, each repo heading and each PR.
    //
    // ⚠ THIS IS `appWebUrl`, NOT `appBaseUrl`, AND THE DIFFERENCE IS LOAD-BEARING. `appBaseUrl`
    // is the API origin: it builds the OAuth `redirect_uri` and is the exact CORS allowlist entry
    // in cloud. They are the same string in every SINGLE-ORIGIN deployment (the packaged release,
    // cloud on Railway) and differ under `pnpm dev`, where this server is :4000 and never serves
    // the SPA while Vite serves it on :5173. Wiring a deep link to `appBaseUrl` 404s there —
    // which is exactly the bug that produced this seam's current name.
    //
    // ⚠ IT IS PASSED IN RATHER THAN READ FROM `process.env`. The plugin reading APP_BASE_URL
    // itself would duplicate core's `?? http://localhost:${PORT}` fallback across the open-core
    // boundary — the "TWO SPELLINGS MUST AGREE" hazard this file's sibling config.ts already
    // records for the report model id — and, because a LOCAL install sets no APP_BASE_URL at all,
    // it would emit a link with no host on exactly the deployment mode the feature exists to
    // serve.
    //
    // ⚠ OPTIONAL, SO apiVersion STAYS 21 — a TRAILING optional FIELD on an existing object, the
    // narrow "additive" test. A newer plugin against an older host finds it `undefined` and emits
    // a digest with no app links; nothing else degrades. A required field here would be the case
    // that demands a bump, and a bump is four literals across TWO REPOS whose half-application
    // degrades the ENTIRE plugin to OSS mode with nothing thrown.
    appWebUrl?: string;
    // (apiVersion 23: `sealSecret` / `openSecret` LEFT with the per-workspace Jira token — the
    // tracker is core, and seals its own secret with auth/crypto.ts directly. Nothing in the
    // plugin stores a secret any more.)
  };
  accountIdOf(req: FastifyRequest): number; // the single scoping seam
  db: ProDb;
  schema: ProCoreSchema;
  runTransaction: <T>(fn: (tx: ProDb) => Promise<T>) => Promise<T>;
  // The platform's own migrator (CREATE TABLE IF NOT EXISTS + its own pro_migrations
  // bookkeeping; see platform/migrate.ts).
  registerMigrations(folder: string): Promise<void>;
  // Retention hook: the core TTL sweep (db/retention.ts) deletes core PR subtrees; the
  // plugin registers a handler here to prune ITS OWN tables (e.g. ai_pr_analyses) for the same
  // PR ids — core can't name plugin tables (open-core
  // boundary). Called once per delete batch. Inert in OSS (no plugin → never registered).
  registerRetention(
    handler: (args: { prIds: number[] }) => Promise<void> | void,
  ): void;
  // Erasure hook (GDPR Art. 17), the account-scoped twin of registerRetention. Core's
  // Account erasure (db/erase-account.ts) removes the account and every core-owned row, then calls each
  // registered handler so the plugin can delete ITS OWN account-scoped tables (pro_settings,
  // sprint_reports, repo_digests, …). Core can't name them across the open-core boundary, and
  // an "account deleted" that quietly left them behind would make the privacy policy untrue.
  // OPTIONAL so a plugin built against an older host still type-checks; apiVersion unchanged
  // (purely additive — an older plugin simply never registers one).
  registerAccountErasure?(
    handler: (args: { accountId: number }) => Promise<void> | void,
  ): void;
  // THE REPORTING WINDOW. The plugin registers its comparison-window resolver (the workspace's
  // mode + cadence → this sprint so far, or the trailing 7/14 days) so CORE's free Reports surfaces
  // (the flow tiles, Activity by repository, Reach by repository, Chronology) are tied to the same
  // window the Pro surfaces use, without core re-deriving a cadence it cannot read
  // (db/reporting-window.ts). OPTIONAL, apiVersion unchanged: an older plugin never registers one
  // and core falls back to the trailing 14 days.
  registerReportingWindow?(
    resolver: (args: {
      accountId: number;
      workspaceId: number;
      nowMs: number;
    }) => Promise<{ fromMs: number; toMs: number; mode: SprintComparisonMode }>,
  ): void;
  // EVENT HOOKS (Slack's two event signals). The host calls each registered hook AFTER the fact
  // is committed — a Claude Review run that SUCCEEDED, a PR seen merging LIVE (never from a first
  // sync or a backfill) — fire-and-forget: a hook's failure is logged and never fails the review or
  // the sync. Ids only; the plugin reads what it needs. ⚠ OPTIONAL, so apiVersion stays 23.
  registerEventHooks?(hooks: ProEventHooks): void;
  // The cheap-tier completion seam (review/llm.ts) — so the plugin adds no new
  // Anthropic dependency.
  llm: {
    complete(opts: {
      model?: string;
      system?: string;
      prompt: string;
      maxTokens?: number;
      // No credential option: every call takes the ONE ladder (ai/credentials.ts) — the
      // reader's Claude Code login, else ANTHROPIC_API_KEY (LIMN_AI_USE_API_KEY=true: key first).
    }): Promise<{
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
      // Who answered (review/llm.ts CheapCompleteResult). 'codex' ⇒ `costUsd` is Codex's own figure
      // and `model` the Codex model: never price it at a Claude rate. Optional ⇒ no apiVersion bump.
      provider?: 'claude' | 'codex';
      model?: string;
      costUsd?: number;
    }>;
    // Best-effort detection of whether the ACTIVE provider can run (a pre-flight before an LLM
    // call). Mirrors Claude Review's detectClaudeAuth, PER RUN KIND: this is the ONE-SHOT client,
    // so no kind means 'complete' (which runs on Codex too). A trailing optional parameter: no
    // apiVersion bump.
    detectAuth(kind?: 'complete'): { status: 'ok' | 'none'; message?: string };
  };
  queries: ProHostQueries;
  // Append one billable AI operation to the core AI-usage ledger. Lets the plugin record
  // its own summary/agent spend (digests, sprint report, AI Fix) into the SAME ledger the
  // core Claude Review path writes, so month-to-date usage is summable across features.
  recordAiUsage(row: AiUsageRecord): Promise<void>;
  // THE CLAUDE SPEND BUDGET's gate (core ai/budget.ts). Every AUTOMATIC (scheduled) model call the
  // platform makes asks it first and SKIPS the call when it answers false — today the Slack digest's
  // sprint summary. A reader's click never asks. Optional: absent (a test's fake ctx) ⇒ allowed.
  aiBudget?: { allowAutomaticRun(accountId: number, what: string): Promise<boolean> };
  // apiVersion 22: `reviewEvents` and `registerLearningsProvider` LEFT with Claude Review's memory,
  // and `review` with Claude Review itself (all core now). apiVersion 23: `registerAgenticProviders`
  // LEFT too — its only members were the tracker's (the Jira fill and the ticket review's
  // membership/story), and the tracker is core (tracker/ticket-source.ts).
  // Background-job seam (host owns process/scheduler infra). The plugin registers node-cron
  // jobs here during register(); the core scheduler cron.schedule()s them AFTER bind, so they
  // ride the config.disableScheduler gate and are torn down with the app. Used by the Slack
  // digest cron + the AI-summary update policy. Inert in OSS. `label` is for logs.
  registerScheduledJob(
    cron: string,
    handler: () => Promise<void> | void,
    label?: string,
  ): void;
  // (apiVersion 23: `registerPrDetailEnricher` and `registerRepoSyncedHook` LEFT. Both existed only
  // for the plugin's Jira/Linear ticket links and its ticket worker; core's tracker computes
  // PrDetail.tickets itself (tracker/enricher.ts) and registers its own post-walk kick.)
  // GitHub reads (per-account).
  github: GithubSeam;
  // The merge-conflict resolver's per-hunk suggestion seam (`conflict/seam.ts`). The plugin runs
  // the model; the HOST owns the hunk, the validators and the suggestion store.
  //
  // ⚠ OPTIONAL, SO apiVersion STAYS 21 — a new optional MEMBER on `ProContext`, the narrow
  // "additive" test the `appWebUrl` / `registerAccountErasure` / `getWorkPlan` precedents already
  // ride. A plugin built against an older host finds it `undefined` and registers no
  // conflict-assist route at all; nothing else degrades. A REQUIRED member here would be the case
  // that demands a bump, and a bump is four literals across TWO REPOS whose half-application
  // degrades the ENTIRE plugin to OSS mode with nothing thrown.
  conflicts?: ConflictSeam;
}

