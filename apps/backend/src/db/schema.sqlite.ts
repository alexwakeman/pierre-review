// SQLite schema (local / default deployment mode, via better-sqlite3).
//
// This is the canonical schema for LOCAL mode. Its Postgres twin lives in
// `schema.pg.ts` and MUST be kept structurally identical (same table + column
// names, same `$type`s) — the shared query layer is typed against ONE of them
// and cast in `client.ts`, so any drift breaks the cast's soundness. See the
// `assertSchemaParity` test for the structural guard.
//
// Multi-tenancy: every GitHub entity is owned by an `accounts` row. Locally
// there is exactly ONE synthesized account (id 1, isLocal=true). `accountId` is
// denormalized onto the tables that anchor list/feed isolation (repos,
// pullRequests, events, claudeReviews, myTurnDismissals); everything else
// reaches its account transitively via repoId/prId. `users` and `commitFiles`
// stay GLOBAL (non-sensitive actor metadata / content-addressed cache).
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type {
  BranchCheckRun,
  CheckRun,
  Label,
  ReviewRouteReason,
  StoredPrFile,
} from '@pierre-review/shared';

// A tenant. Local mode synthesizes exactly one row (id 1, isLocal=true) from
// `gh api user`; cloud mode creates one per signed-in GitHub user. Replaces the
// old singleton `local_user` table.
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // GitHub user node id (the stable GraphQL id) — the login can change, this can't.
  githubUserId: text('github_user_id').notNull().unique(),
  githubLogin: text('github_login').notNull(),
  // The user's GitHub display name (the `name` field from `gh api user` / OAuth
  // `GET /user`). Nullable — GitHub `name` can be unset; the UI falls back to the
  // login. Shown wherever the signed-in identity appears (header, greeting).
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  // AES-256-GCM sealed access token (iv:tag:ciphertext, base64). Null for the
  // local account, whose token comes live from `gh auth token`.
  accessTokenEnc: text('access_token_enc'),
  isLocal: integer('is_local', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  // Last time a loaded frontend was seen talking to the backend (cloud: stamped,
  // throttled, by the per-request account hook + an SPA heartbeat). The scheduler
  // syncs only accounts active within config.syncActiveWindowMinutes, so a tenant
  // with no open tab stops being re-synced. Null until first activity.
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }),
  // Last time this account VIEWED the Activity Feed — a server-side "seen" marker (the
  // successor to the removed per-item "Done"). Makes "new My Turn since you were last here"
  // server-truth, consistent across devices/sessions (vs the old client-only localStorage
  // heuristic). Bumped by POST /api/activity/feed/mark-seen; null until the first view,
  // so nothing counts as "new" until a baseline exists. One column, O(1) — no growth.
  feedLastSeenAt: integer('feed_last_seen_at', { mode: 'timestamp' }),
  // Billing plan: 'free' (default) or 'pro'. Set ONLY by the Stripe webhook
  // (api/routes/billing.ts) — never by the OAuth upsert, so re-login can't reset
  // a paid plan. Local accounts ignore it (isLocal is always fully entitled).
  plan: text('plan').notNull().default('free'),
  // Stripe customer id (cus_…), captured from checkout.session.completed so later
  // subscription webhooks can resolve the account. Null until first checkout.
  stripeCustomerId: text('stripe_customer_id'),
  // Per-account monthly SUMMARY-AI credit allowance override (metered cloud plan). null =
  // use the plan default (2,500 for a paid cloud account); local/unlimited accounts ignore
  // it entirely. A forward hook for top-ups / alternate plans without another migration.
  aiCreditAllowance: integer('ai_credit_allowance'),
  // CLOUD-ONLY, opt-in (default OFF): whether this account contributes de-identified,
  // aggregate weekly review-bot outcome stats to the cross-org benchmark network (see
  // `benchmarkContributions`). Consent is a distinct PURPOSE from running the dashboard,
  // so it must be explicit + reversible; withdrawing (set false) deletes the account's
  // contributions. Local accounts never contribute (never phone home) — always false.
  benchmarkOptIn: integer('benchmark_opt_in', { mode: 'boolean' }).notNull().default(false),
});

export const repos = sqliteTable(
  'repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    githubNodeId: text('github_node_id').notNull(),
    // The repo's default branch (GraphQL defaultBranchRef.name), captured each
    // activity sync. Used to scope the "maintainer" inference to PRs merged into
    // the default branch. Null until a sync populates it.
    defaultBranch: text('default_branch'),
    // The viewer's permission on the repo (GraphQL Repository.viewerPermission,
    // enum RepositoryPermission: ADMIN/MAINTAIN/WRITE/TRIAGE/READ), captured each
    // activity sync. Drives whether the viewer may approve a PR (WRITE+). Null
    // until a sync populates it (or when GitHub returns null).
    viewerPermission: text('viewer_permission'),
    backfillUntil: integer('backfill_until', { mode: 'timestamp' }),
    // "Watch for inbox": when true, new open PRs by others (opened on/after
    // inboxWatchStartedAt) surface in the My Turn inbox. Independent of timeline
    // visibility and of removing the repo. inboxWatchStartedAt is set on the first
    // watch and preserved across unwatch so re-watching restores the same window.
    inboxWatch: integer('inbox_watch', { mode: 'boolean' })
      .notNull()
      .default(false),
    inboxWatchStartedAt: integer('inbox_watch_started_at', { mode: 'timestamp' }),
    // ---- Default-branch status ("is trunk green?") ----
    // A snapshot of the repo's DEFAULT BRANCH head, distinct from `defaultBranch` above
    // (which is just the name and has been here since the maintainer inference). All four
    // are nullable — a freshly added repo has none until the branch sync runs, and rendering
    // "unknown" is correct there. `defaultBranchName` is deliberately separate from
    // `defaultBranch` rather than reusing it: the latter is written by the ACTIVITY sync from
    // GraphQL defaultBranchRef.name, and conflating the two would make either sync silently
    // clobber the other's freshness expectations.
    defaultBranchName: text('default_branch_name'),
    defaultBranchHeadSha: text('default_branch_head_sha'),
    // Same enum as pullRequests.ciStatus (the shared CiStatus union).
    defaultBranchCiStatus: text('default_branch_ci_status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }),
    // When the branch snapshot was last refreshed (OUR observation time, not the commit time
    // — that lives on the branch_commits rows).
    defaultBranchUpdatedAt: integer('default_branch_updated_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // Composite uniques so two accounts can watch the same GitHub repo (each
    // gets its own row). The upsert conflict targets these.
    ownerNameUx: uniqueIndex('repos_account_owner_name').on(
      t.accountId,
      t.owner,
      t.name,
    ),
    nodeUx: uniqueIndex('repos_account_node').on(t.accountId, t.githubNodeId),
    accountIdx: index('repos_account_idx').on(t.accountId),
  }),
);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubLogin: text('github_login').notNull().unique(),
  githubNodeId: text('github_node_id').unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
  // Set when a user toggles is_bot by hand; auto-detection won't override it.
  isBotOverridden: integer('is_bot_overridden', { mode: 'boolean' })
    .notNull()
    .default(false),
  // GitHub GraphQL __typename of the actor ('Bot' | 'User' | 'Organization' | …),
  // captured during sync. Plain text (no enum — the __typename set varies). Feeds the
  // bot-triage classifier (a 'Bot' typename is a hard automated-reviewer signal).
  // Nullable; stays GLOBAL like the rest of `users`.
  githubType: text('github_type'),
});

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull(),
    // Denormalized tenant owner (== repos.accountId) so list/feed isolation is a
    // single indexed predicate instead of a join to repos.
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    authorId: integer('author_id').references(() => users.id),
    // Who actually merged the PR (GraphQL `mergedBy`), distinct from the author.
    // Drives the "has merge rights / maintainer" inference. Null for non-merged
    // PRs and until a (deep) sync backfills it on already-synced merged PRs.
    mergedById: integer('merged_by_id').references(() => users.id),
    // The branch this PR targets (GraphQL `baseRefName`). The maintainer
    // inference only counts merges into the repo's default branch, so a merge
    // into a feature/integration branch doesn't elevate the merger. Null until a
    // (deep) sync backfills it on already-synced PRs.
    baseRefName: text('base_ref_name'),
    // The PR's SOURCE branch (GraphQL `headRefName`), e.g. `feature/PROJ-123-foo`. The standard
    // carrier of a Jira/Linear ticket key — read by the Pro ticket-link enricher (compute-on-read).
    // Null until a sync backfills it on already-synced PRs.
    headRefName: text('head_ref_name'),
    state: text('state', { enum: ['open', 'merged', 'closed'] }).notNull(),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    openedAt: integer('opened_at', { mode: 'timestamp' }).notNull(),
    firstReviewAt: integer('first_review_at', { mode: 'timestamp' }),
    // Earliest review-request time (first ReviewRequestedEvent), null if never requested — the
    // clock start for "review pickup time" (request→first review). Distinct from openedAt.
    firstReviewRequestedAt: integer('first_review_requested_at', { mode: 'timestamp' }),
    lastCommitAt: integer('last_commit_at', { mode: 'timestamp' }),
    mergedAt: integer('merged_at', { mode: 'timestamp' }),
    closedAt: integer('closed_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    // ---- v1.1: CI / mergeability / labels (head-commit derived) ----
    headSha: text('head_sha'),
    ciStatus: text('ci_status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }),
    mergeable: text('mergeable', {
      enum: ['mergeable', 'conflicting', 'unknown'],
    }),
    mergeStateStatus: text('merge_state_status', {
      enum: [
        'clean',
        'dirty',
        'unstable',
        'blocked',
        'behind',
        'has_hooks',
        'unknown',
      ],
    }),
    // GitHub's overall review decision (GraphQL PullRequest.reviewDecision, lowercased).
    // `mergeStateStatus: 'blocked'` says protection is unmet but never WHY; this names the
    // review half of that ('review_required' / 'changes_requested'), which is what lets the
    // merge verdict render a reason instead of a shrug. Null when the repo requires no
    // review, or until a sync backfills it on already-synced PRs.
    reviewDecision: text('review_decision', {
      enum: ['approved', 'changes_requested', 'review_required'],
    }),
    labels: text('labels', { mode: 'json' }).$type<Label[]>(),
    // Per-job CI checks on the head commit (CheckRuns + StatusContexts).
    checkRuns: text('check_runs', { mode: 'json' }).$type<CheckRun[]>(),
    // ---- Diff size (GraphQL additions/deletions/changedFiles + files connection) ----
    // Small metadata (not bulky text), so ALWAYS stored — independent of lean mode —
    // and served straight from the DB for the PR-detail LOC label + "Changes" tab.
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    changedFiles: integer('changed_files').notNull().default(0),
    // Per-file breakdown (capped at 100 files by the sync query). Nullable; the
    // API resolves it to [] and computes each file's GitHub deep link on read.
    files: text('files', { mode: 'json' }).$type<StoredPrFile[]>(),
  },
  (t) => ({
    repoIdx: index('pr_repo_idx').on(t.repoId),
    openedIdx: index('pr_opened_idx').on(t.openedAt),
    accountIdx: index('pr_account_idx').on(t.accountId),
    // Drives getUserStats (the contributor popover) from the person rather than the account.
    authorIdx: index('pr_author_idx').on(t.authorId),
    // Serves resolving a PR NUMBER to a local id within a repo — the branch strip's
    // commit → PR link, which looks up a batch of numbers on a route the Activity console
    // hits on every mount. Without it the planner narrows to the repo via `pr_repo_idx` and
    // then SCANS that repo's whole PR set, so the cost tracks tenant size rather than the
    // handful of numbers asked for (the same trap the author indexes fixed).
    accountRepoNumberIdx: index('pr_account_repo_number_idx').on(
      t.accountId,
      t.repoId,
      t.number,
    ),
    nodeUx: uniqueIndex('pr_account_node').on(t.accountId, t.githubNodeId),
  }),
);

// Outstanding review requests on a PR. GitHub removes a request once the
// reviewer submits, so presence here == still awaiting. Re-derived each sync
// (delete + reinsert per PR). `userId` null for team requests (teamName set).
export const reviewRequests = sqliteTable(
  'review_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    userId: integer('user_id').references(() => users.id),
    teamName: text('team_name'),
  },
  (t) => ({
    prIdx: index('rr_pr_idx').on(t.prId),
    userIdx: index('rr_user_idx').on(t.userId),
  }),
);

// Per-PR "last viewed" state for incremental review. One row per PR. Implicitly
// per-account (prId is account-specific).
export const prViews = sqliteTable('pr_views', {
  prId: integer('pr_id')
    .primaryKey()
    .references(() => pullRequests.id),
  lastViewedSha: text('last_viewed_sha'),
  lastViewedAt: integer('last_viewed_at', { mode: 'timestamp' }).notNull(),
});

// Manual dismissals of "my turn" entries. `refId` is a PR id (review_request),
// a review-thread id (thread), or a Claude-review run id (claude_review). The
// dismissal is honoured only while no newer activity has happened — getMyTurn
// compares dismissedAt against the PR's updatedAt / the thread's last reply, and a
// claude_review is keyed by run id so a fresh run is a new (undismissed) entry.
// `accountId` scopes the dismissal set per tenant.
export const myTurnDismissals = sqliteTable(
  'my_turn_dismissals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    kind: text('kind', {
      enum: ['review_request', 'thread', 'watched_repo_pr', 'pr_approved', 'claude_review'],
    }).notNull(),
    refId: integer('ref_id').notNull(),
    dismissedAt: integer('dismissed_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    kindRefUx: uniqueIndex('mtd_kind_ref_ux').on(t.kind, t.refId),
    accountIdx: index('mtd_account_idx').on(t.accountId),
  }),
);

export const reviewThreads = sqliteTable(
  'review_threads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    path: text('path').notNull(),
    line: integer('line'),
    isResolved: integer('is_resolved', { mode: 'boolean' }).notNull(),
    isOutdated: integer('is_outdated', { mode: 'boolean' })
      .notNull()
      .default(false),
    derivedState: text('derived_state', {
      enum: ['resolved', 'likely_addressed', 'replied_unresolved', 'untouched'],
    }).notNull(),
    // Deterministic "how sure are we it was addressed?" grade computed alongside derivedState
    // (sync/derive-thread-state.ts). Additive to the 4-state contract — advisory only.
    addressedConfidence: text('addressed_confidence', {
      enum: ['none', 'low', 'medium', 'high'],
    })
      .notNull()
      .default('none'),
    // Compact machine tag explaining the grade (e.g. 'outdated+commit', 'bot-marker:coderabbit').
    addressedReason: text('addressed_reason'),
    // GitHub login of whoever resolved the thread (from `resolvedBy`), null when unresolved —
    // lets us distinguish a bot self-resolve from a human resolve.
    resolvedByLogin: text('resolved_by_login'),
    // When we FIRST OBSERVED the thread flip unresolved→resolved (sync-observation time, ~5min
    // granularity — GitHub's thread type exposes no resolve timestamp). Stamped only on a witnessed
    // transition; a thread already resolved the first time we see it (backfill) stays null (unknown
    // resolution time). Powers the resolution-latency trend. NOT a lean-gated field.
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    originalCommenterId: integer('original_commenter_id').references(
      () => users.id,
    ),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    prIdx: index('thread_pr_idx').on(t.prId),
    nodeUx: uniqueIndex('thread_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull(),
    threadId: integer('thread_id')
      .notNull()
      .references(() => reviewThreads.id),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    // Nullable: in cloud "lean storage" mode the full body is NOT persisted (it's
    // hydrated on demand from GitHub + browser-cached). `excerpt` keeps a short
    // (~160 char) preview so the lean triage path (getMyTurn) and graceful UI
    // degradation work without a network round trip. Local mode still stores body.
    body: text('body'),
    excerpt: text('excerpt'),
    diffHunk: text('diff_hunk'),
    // GitHub numeric id (fullDatabaseId) for the #discussion_r<id> deep link.
    databaseId: text('database_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    threadIdx: index('rc_thread_idx').on(t.threadId),
    authorIdx: index('rc_author_idx').on(t.authorId),
    nodeUx: uniqueIndex('rc_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const prComments = sqliteTable(
  'pr_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    // Nullable: not persisted in cloud lean-storage mode (hydrated on demand).
    body: text('body'),
    // GitHub numeric id (fullDatabaseId) for the #issuecomment-<id> deep link.
    databaseId: text('database_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    prIdx: index('prc_pr_idx').on(t.prId),
    authorIdx: index('prc_author_idx').on(t.authorId),
    nodeUx: uniqueIndex('prc_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    state: text('state', {
      enum: ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'],
    }).notNull(),
    body: text('body'),
    // GitHub numeric id (fullDatabaseId) for the #pullrequestreview-<id> deep link.
    databaseId: text('database_id'),
    submittedAt: integer('submitted_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    prIdx: index('rv_pr_idx').on(t.prId),
    authorIdx: index('rv_author_idx').on(t.authorId),
    nodeUx: uniqueIndex('reviews_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const commits = sqliteTable(
  'commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha: text('sha').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    committerId: integer('committer_id').references(() => users.id),
    message: text('message'),
    committedAt: integer('committed_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    prIdx: index('commit_pr_idx').on(t.prId),
    shaPrUx: uniqueIndex('commit_sha_pr_ux').on(t.sha, t.prId),
  }),
);

// SHA -> string[] of changed paths. Cached forever (SHAs are immutable). Stays
// GLOBAL — content-addressed, identical across tenants.
export const commitFiles = sqliteTable('commit_files', {
  sha: text('sha').primaryKey(),
  paths: text('paths', { mode: 'json' }).$type<string[]>().notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Unified events log -- what the timeline reads.
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Denormalized tenant owner (== the repo's accountId) — the lean timeline
    // feed filters on this directly.
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id),
    actorId: integer('actor_id').references(() => users.id),
    prId: integer('pr_id').references(() => pullRequests.id),
    type: text('type', {
      enum: [
        'pr_opened',
        'pr_merged',
        'pr_closed',
        'pr_reopened',
        'pr_ready_for_review',
        'review_submitted',
        'review_comment',
        'pr_comment',
        'commit_pushed',
      ],
    }).notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
    refTable: text('ref_table'),
    refId: integer('ref_id'),
    // Stable identity for idempotent upserts: e.g. "pr_opened:<prNodeId>".
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => ({
    timeIdx: index('events_time_idx').on(t.occurredAt),
    repoTimeIdx: index('events_repo_time_idx').on(t.repoId, t.occurredAt),
    actorIdx: index('events_actor_idx').on(t.actorId),
    accountIdx: index('events_account_idx').on(t.accountId),
    // Correlated "does this PR have an event since <cutoff>" EXISTS lookups (getTeamInsights
    // open-PR staleness, getOpenPrs, new-since checks, feed joins) filter by pr_id — WITHOUT
    // this they fall back to events_account_idx and scan every account event per PR (O(open PRs
    // × events)). Composite so the occurred_at bound resolves inside the index too.
    prTimeIdx: index('events_pr_idx').on(t.prId, t.occurredAt),
    // Composite so the same dedupeKey can exist once per account (two accounts
    // watching the same repo share GitHub node ids). Upsert conflict target.
    dedupeUx: uniqueIndex('events_account_dedupe').on(t.accountId, t.dedupeKey),
  }),
);

// ---- CI status history (DORA-ish CI metrics) ----
// Append-only log of a PR head's CI-state TRANSITIONS, recorded during sync when a PR's
// CI rollup / failing-check set / head SHA changes vs the last row. The current
// pull_requests.ciStatus is only a snapshot (and checkRuns is lean-gated), so this table
// is what makes real CI failure-RESOLUTION time + failure-reason-by-stage-over-time
// computable. `failingChecks` = the names of the checks failing at that observation (the
// stage-level reasons). `observedAt` is when WE saw it (may lag the actual CI event by up
// to a sync interval).
export const ciStatusEvents = sqliteTable(
  'ci_status_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    headSha: text('head_sha').notNull(),
    status: text('status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }).notNull(),
    failingChecks: text('failing_checks', { mode: 'json' }).$type<string[]>(),
    observedAt: integer('observed_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    accountPrObservedIdx: index('cse_account_pr_observed').on(
      t.accountId,
      t.prId,
      t.observedAt,
    ),
    accountRepoObservedIdx: index('cse_account_repo_observed').on(
      t.accountId,
      t.repoId,
      t.observedAt,
    ),
  }),
);

// Append-only AI-spend ledger. Every billable AI operation (LLM completion or Agent-SDK
// run) records ONE row here, so month-to-date usage can be summed across features — the
// per-feature cost columns (claude_reviews / repo_digests / sprint_reports / ai_* in the
// Pro submodule) upsert-overwrite and can't be summed. Surfaced ONLY as credits (never
// dollars) via /api/pro/ai-usage. `seam` splits summary (cheap completions) vs agent
// (Agent-SDK runs). No FK on pr_id/repo_id — the ledger must survive PR/repo pruning.
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    seam: text('seam', { enum: ['summary', 'agent'] }).notNull(),
    // Which feature spent it: digest / sprint_report / ai_analysis / ci_analysis /
    // claude_review / ai_fix. Free-text so a new feature needs no migration.
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    prId: integer('pr_id'),
    repoId: integer('repo_id'),
    occurredAt: integer('occurred_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountOccurredIdx: index('au_account_occurred').on(t.accountId, t.occurredAt),
  }),
);

// ---- Auto-merge intents ("arm it and walk away") ----------------------------------------
// One row per (account, PR) recording a STANDING INTENT to merge once the blockers clear.
// Pierre-side, not GitHub's native auto-merge, so it works on repos that don't enable it and
// can offer a rebase-from-trunk step GitHub can't.
//
// The safety property lives in `expectedHeadOid`: arming is consent to merge THAT code. A new
// push moves the head, the watcher notices the mismatch, and the row goes to
// 'disarmed_head_moved' rather than merging commits the user never looked at. `expiresAt` is
// the second backstop — an intent that never becomes mergeable dies rather than lingering.
//
// FKs cascade so a repo/PR delete (deleteRepo) and an account erasure clean up automatically.
export const autoMergeRequests = sqliteTable(
  'auto_merge_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    // shared MergeMethod: 'merge' | 'squash' | 'rebase'.
    mergeMethod: text('merge_method', {
      enum: ['merge', 'squash', 'rebase'],
    }).notNull(),
    // Whether to bring a merely-behind branch up to date first, and how. 'none' = wait.
    updateStrategy: text('update_strategy', {
      enum: ['rebase', 'merge', 'none'],
    }).notNull(),
    // The head SHA at arming time — the consent anchor (see above).
    expectedHeadOid: text('expected_head_oid').notNull(),
    // shared ArmedMergeState.
    state: text('state', {
      enum: [
        'armed',
        'merged',
        'disarmed_head_moved',
        'disarmed_blocked',
        'expired',
        'failed',
      ],
    }).notNull(),
    armedAt: integer('armed_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    lastCheckedAt: integer('last_checked_at', { mode: 'timestamp' }),
    // Why it is in its current state ('required reviews missing', 'head moved abc→def').
    lastReason: text('last_reason'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // One armed request per PR per tenant — the upsert conflict target. Re-arming a PR
    // OVERWRITES the previous row (including a terminal one), so history is not kept here;
    // an armed intent is current state, not a log.
    accountPrUx: uniqueIndex('amr_account_pr').on(t.accountId, t.prId),
    accountIdx: index('amr_account_idx').on(t.accountId),
    // The watcher's scan: "every still-armed row", cheapest as an indexed state probe.
    stateIdx: index('amr_state_idx').on(t.state),
  }),
);

// ---- Default-branch commits ("is trunk green?") -----------------------------------------
// The recent commits on each repo's DEFAULT branch, with the CI state observed for each. Not
// derivable from `commits`, which is PR-scoped (a commit merged via squash never appears
// there under its trunk SHA). Small and bounded: the branch sync keeps only a recent window
// per repo. `accountId` is denormalized for isolation exactly like events/pullRequests.
//
// `authorUserId` is a nullable link to the global `users` row when the commit author maps to
// a GitHub account; `authorName`/`authorAvatarUrl` carry the raw git identity for the many
// trunk commits (merge commits, bot pushes, non-GitHub emails) that don't.
export const branchCommits = sqliteTable(
  'branch_commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    messageHeadline: text('message_headline').notNull(),
    authorUserId: integer('author_user_id').references(() => users.id),
    authorName: text('author_name'),
    authorAvatarUrl: text('author_avatar_url'),
    committedAt: integer('committed_at', { mode: 'timestamp' }).notNull(),
    // Same enum as pullRequests.ciStatus; nullable because a just-pushed commit has no
    // status yet (distinct from an explicit 'unknown').
    ciStatus: text('ci_status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }),
    // The checks that were FAILING on this commit (state 'failure' | 'error' only) — never the
    // passing contexts, so a green commit stores NULL and its row stays exactly as small as it
    // is today. Same object the PR checks UI renders, plus the workflow name, so the two
    // surfaces speak ONE vocabulary.
    //
    // NOT lean-gated (unlike pullRequests.checkRuns, which is): this is names-only metadata,
    // capped per commit by the writer, and there is NO hydrate-on-demand path for a trunk
    // commit — it belongs to no PR, so gating it would simply delete the feature in cloud
    // rather than make it lazy. Follows the ci_status_events.failing_checks precedent, which is
    // written unconditionally for the same reason.
    //
    // NOTE: the SAME column name as ci_status_events.failing_checks but a DIFFERENT shape (that
    // one is string[] — bare names for the CI metrics log; this one is the full render payload).
    // The $type<>() makes the difference a compile-time fact at every call site.
    failingChecks: text('failing_checks', { mode: 'json' }).$type<
      BranchCheckRun[]
    >(),
    // The PR this commit landed from (GraphQL Commit.associatedPullRequests), or null for a
    // direct push to trunk. Stored as a plain NUMBER, deliberately NOT a pull_requests FK:
    //  (a) the PR is often not synced when the commit is observed (squash-merged before the
    //      backfill window, or the repo was added later),
    //  (b) a stored id would go stale the moment that PR's subtree is re-synced, and
    //  (c) a real FK would drag this table into BOTH delete paths.
    // The read layer resolves the number to a local id per request, scoped by
    // (accountId, repoId) — a PR number is unique only WITHIN a repo.
    prNumber: integer('pr_number'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // Idempotent upsert target — a re-sync of the same window must update CI state in place,
    // not duplicate the commit.
    accountRepoShaUx: uniqueIndex('bc_account_repo_sha').on(
      t.accountId,
      t.repoId,
      t.sha,
    ),
    // The read: one repo's window, newest first.
    accountRepoTimeIdx: index('bc_account_repo_time').on(
      t.accountId,
      t.repoId,
      t.committedAt,
    ),
    accountIdx: index('bc_account_idx').on(t.accountId),
  }),
);

export const syncState = sqliteTable('sync_state', {
  repoId: integer('repo_id')
    .primaryKey()
    .references(() => repos.id),
  lastFullSyncAt: integer('last_full_sync_at', { mode: 'timestamp' }),
  lastIncrementalSyncAt: integer('last_incremental_sync_at', {
    mode: 'timestamp',
  }),
  lastSyncStatus: text('last_sync_status'),
  lastSyncError: text('last_sync_error'),
});

// ---- Claude Review (agentic PR review) ----
// One row per review run. Re-reviewing a PR inserts a new row (history kept,
// keyed by head SHA via cr_pr_sha_idx). Claude's summary/verdict are read-only
// reference; the user authors `userBody`/`userVerdict` which is what gets posted.
// Local-only feature (force-disabled in cloud), but `accountId` is stamped for
// consistency (always the local account).
export const claudeReviews = sqliteTable(
  'claude_reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    headSha: text('head_sha').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
    }).notNull(),
    model: text('model', {
      enum: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    }).notNull(),
    // Null until the agent decides whether it explored the worktree.
    scope: text('scope', { enum: ['diff_only', 'worktree'] }),
    // The deterministic router's decision (skip/diff_only/worktree) + its inputs,
    // recorded BEFORE the agent runs (or when the user forces a mode). `scope` above
    // is the AGENT's self-report; a row with reviewMode 'diff_only' but scope
    // 'worktree' is the agent flagging it needed a deeper review. Null on pre-routing
    // rows. See review/routing.ts.
    reviewMode: text('review_mode', { enum: ['skip', 'diff_only', 'worktree'] }),
    routeReason: text('route_reason', { mode: 'json' }).$type<ReviewRouteReason>(),
    // Claude's output (read-only; never edited in place).
    summary: text('summary'),
    verdict: text('verdict', {
      enum: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'],
    }),
    // The user-authored review body + verdict that actually get posted.
    userBody: text('user_body'),
    userVerdict: text('user_verdict', {
      enum: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'],
    }),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // Cache-token split (a multi-turn run's input is mostly cache reads — the hidden
    // cost driver the plain input_tokens column hid). Null when not captured.
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    numTurns: integer('num_turns'),
    // Full (noise-stripped) diff size in chars + whether the diff-size cap truncated
    // the prompt — for A/B cost comparison of capped vs uncapped runs.
    diffBytes: integer('diff_bytes'),
    diffCapped: integer('diff_capped', { mode: 'boolean' }),
    error: text('error'),
    // Noise files (lockfiles/generated) stripped from the diff before review.
    excludedFiles: text('excluded_files', { mode: 'json' }).$type<string[]>(),
    // GitHub review id + when it was posted (null until posted).
    postedReviewId: text('posted_review_id'),
    postedAt: integer('posted_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => ({
    prIdx: index('cr_pr_idx').on(t.prId),
    prShaIdx: index('cr_pr_sha_idx').on(t.prId, t.headSha),
    accountIdx: index('cr_account_idx').on(t.accountId),
  }),
);

// One row per line-level finding. Claude's wording is read-only; only `included`
// (the user's tick) mutates. `anchored` false ⇒ couldn't map onto an addable diff
// line, so it can't post as an inline comment.
export const claudeReviewFindings = sqliteTable(
  'claude_review_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: integer('review_id')
      .notNull()
      .references(() => claudeReviews.id),
    path: text('path').notNull(),
    line: integer('line'),
    side: text('side', { enum: ['LEFT', 'RIGHT'] })
      .notNull()
      .default('RIGHT'),
    severity: text('severity', {
      enum: ['blocker', 'warning', 'nit', 'question', 'praise'],
    }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // The user's reworded version of the finding (markdown). When set and the
    // finding is included, this is posted verbatim instead of `body`.
    editedBody: text('edited_body'),
    suggestion: text('suggestion'),
    // The unified-diff hunk this finding covers, captured at review time, to show
    // the code in context in the UI. Null for older runs / unanchored findings.
    diffHunk: text('diff_hunk'),
    anchored: integer('anchored', { mode: 'boolean' }).notNull().default(true),
    // Whether the finding's file is part of the PR diff. true ⇒ an unanchored finding
    // posts inline on the file's first change; false ⇒ outside the diff → posts as a
    // standalone PR-level comment. Defaults true (back-compat: pre-existing findings).
    fileInDiff: integer('file_in_diff', { mode: 'boolean' }).notNull().default(true),
    included: integer('included', { mode: 'boolean' }).notNull().default(false),
    postedAt: integer('posted_at', { mode: 'timestamp' }),
    githubCommentId: text('github_comment_id'),
    // How a posted comment was attached: 'inline' (a review comment on a diff line)
    // or 'pr_comment' (a standalone PR-level issue comment, for an unanchored
    // finding posted individually). Null until posted; drives the correct GitHub
    // permalink (#discussion_r vs #issuecomment).
    postedCommentKind: text('posted_comment_kind', {
      enum: ['inline', 'pr_comment'],
    }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({ reviewIdx: index('crf_review_idx').on(t.reviewId) }),
);

// ---- Bot-Triage Platform (WS1 / WS6) ----
// Account-scoped classification cache for automated reviewers. One row per
// (account, TEAM, author) — the layered resolver (sync/reviewer-classify.ts) writes AUTO
// rows; the override route writes MANUAL rows (source='manual', never overwritten by
// auto). Merged with the global vendor login map on read, so known vendors need no
// row. Account-scoped isolation: every read/write filters accountId.
export const botReviewClassification = sqliteTable(
  'bot_review_classification',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    // Which TEAM's answer to "is this login a bot, and what kind" this row holds.
    //
    // NOT NULL with the sentinel 0 (`NO_TEAM_KEY` in shared), never nullable: a UNIQUE index
    // over a NULLable column dedupes in NEITHER dialect (NULLs compare distinct), so a
    // nullable key would silently allow duplicate rows per (account, author) and make the
    // upsert's conflict target unreachable.
    //
    // 0 is BOTH the "No team" scope AND the inheritance ROOT — resolution is `explicit team
    // row → the team-0 row → auto-detect`. That is why migration 0042 needs no backfill:
    // every pre-existing account-global row is already at 0, i.e. already the default every
    // team inherits, so behaviour is preserved byte-for-byte in every scope and a team created
    // later inherits the account default for free.
    //
    // NO `.references(() => teams.id)` ON PURPOSE: 0 is not a team id, so an FK would reject
    // every default row. The price is manual cleanup — `deleteTeam` must delete this table's
    // rows for the team inside its transaction, or a recycled team id inherits a dead team's
    // classifications.
    teamId: integer('team_id').notNull().default(0),
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    automated: integer('automated', { mode: 'boolean' }).notNull(),
    kind: text('kind'), // AutomatedReviewerKind | null
    label: text('label'),
    // ReviewerRole — 'review' (an AI code reviewer) | 'quality_check' (static analysis /
    // coverage / lint). ORTHOGONAL to `kind`, which is vendor identity: a login keeps its brand
    // while being marked a linter. `automated` stays TRUE for a quality check, so exclusion +
    // the feed are unaffected; only the SCORING sets (behaviour, dedup, benchmark, and ROI —
    // which splits rather than filters, see below) treat role='review' as the reviewer cohort.
    // BOT-ONLY PRs DELIBERATELY DO NOT NARROW: that list answers "did a human look at this", and
    // a PR reviewed only by SonarQube is exactly what it exists to surface — narrowing would drop
    // it for having no review-role bot, hiding the risk instead of flagging it.
    // NOT NULL DEFAULT 'review' so every existing row keeps today's meaning without a backfill.
    role: text('role').notNull().default('review'),
    // What this bot COSTS per month at this team key, in INTEGER CENTS (migration 0043).
    //
    // 1. MONEY IS NEVER A FLOAT HERE. The core schema has no `real(` column at all (the only
    //    float columns in the repo are in @pierre/pro, for MEASURED model spend, which genuinely
    //    is one). SQLite has no DECIMAL and its REAL is a float64 where $0.10 + $0.20 !== $0.30,
    //    and this value gets divided ($/acted-on) and formatted with toFixed(2). pg `numeric`
    //    was rejected too: it has no sqlite twin AND node-postgres returns it as a STRING,
    //    which would silently break the shared `number` wire type. integer↔integer is exact
    //    parity for schema-parity.test.ts. The WIRE unit is DOLLARS; convert only at the store
    //    boundary (Math.round(usd * 100) in, cents / 100 out).
    //
    // 2. NULLABILITY IS THE DESIGN. NULL = "no cost opinion at this key" → fall through to the
    //    team-0 row (or, at team 0, simply unset). 0 = "explicitly free HERE" and must BEAT an
    //    inherited $120. Hence every resolution step uses `??`, never `||` — a one-character bug
    //    with no type error.
    //
    // 3. ⚠ THIS COLUMN RESOLVES FIELD-WISE WHILE EVERY OTHER COLUMN ON THE ROW RESOLVES
    //    ROW-WISE. `automated`/`kind`/`label`/`role`/`confidence`/`source`/`reasons` are one
    //    indivisible judgement, so an explicit team row wins WHOLESALE. Cost is not part of that
    //    judgement: a row created merely to hold a role opinion carries no cost opinion, so
    //    row-level cost would silently zero an inherited price the instant someone pressed
    //    Apply on an inherited row. The mirror trap is just as real — a NEW team row must NOT
    //    seed this from the inherited value (that freezes a copy of the default and later edits
    //    to the team-0 price stop reaching this team), which is the exact OPPOSITE of what
    //    `role` above requires.
    //
    // 4. NO INDEX, deliberately: it is never a predicate, only read off rows already fetched by
    //    (account_id, team_id) via brc_account_team_idx.
    //
    // 5. reviewer-classify.ts persist() must keep this OUT of its shared insert/ON-CONFLICT
    //    values object, or every auto-classification pass would wipe a user's price.
    costMonthlyCents: integer('cost_monthly_cents'),
    confidence: text('confidence').notNull(), // 'high'|'medium'|'low'
    source: text('source').notNull(), // ClassificationSource
    reasonsJson: text('reasons_json', { mode: 'json' }).$type<string[]>(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // The upsert conflict target for BOTH writers (reviewer-classify.ts persist() and
    // setReviewerOverride). It replaced the 2-column `brc_account_author`; miss the swap in an
    // onConflictDoUpdate and Postgres raises "there is no unique or exclusion constraint
    // matching the ON CONFLICT specification" at RUNTIME, not at typecheck.
    accountTeamUx: uniqueIndex('brc_account_team_author').on(
      t.accountId,
      t.teamId,
      t.authorUserId,
    ),
    // Listing a single team's overrides (the per-team Bots settings tab).
    accountTeamIdx: index('brc_account_team_idx').on(t.accountId, t.teamId),
  }),
);

// NOTE: the `bot_mute_rules` table (migration 0029) backed a removed feature — the
// Pierre-only "hide" mute + the standing auto-resolve cron. Both were dropped; resolving
// likely-addressed bot threads is now strictly user-initiated + confirm-gated (see
// bot-triage/resolve.ts). The table is left orphaned in existing DBs (no drop migration);
// don't reintroduce a schema binding for it.

// ---- Teams (CORE) ----
// A named grouping of the account's repos (sprint teams / product areas). Account-scoped;
// a repo can belong to many teams (overlap allowed via the team_repos join). Drives the
// scope selector (all / none / <teamId>) that per-team AI + digests key off downstream.
export const teams = sqliteTable(
  'teams',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountNameUx: uniqueIndex('teams_account_name').on(t.accountId, t.name),
    accountIdx: index('teams_account_idx').on(t.accountId),
  }),
);

// Many-to-many join of teams ↔ repos (a repo may sit in several teams). `accountId` is
// denormalized for isolation (== teams.accountId == repos.accountId). Cascades from both
// teams and repos so deleting either cleans up membership rows automatically.
export const teamRepos = sqliteTable(
  'team_repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    teamRepoUx: uniqueIndex('team_repos_team_repo').on(t.teamId, t.repoId),
    accountIdx: index('team_repos_account_idx').on(t.accountId),
    repoIdx: index('team_repos_repo_idx').on(t.repoId),
  }),
);

// ── Cross-org benchmark network (CORE, cloud-only, opt-in) ──────────────────────────────
// Phase 0 of the neutral review-bot benchmark: de-identified, AGGREGATE-ONLY weekly outcome
// stats per known vendor, contributed by opted-in cloud accounts (see accounts.benchmarkOptIn),
// so a later paid feature can show "your CodeRabbit is 38% acted-on vs a 45% peer median".
// NO raw text / logins / repo names / PR titles ever land here — counts only. `in_house` /
// `pierre` are EXCLUDED at collection (not comparable across orgs / identifying). Written ONLY
// by the firewalled weekly rollup (sync/benchmark-rollup.ts) from each account's OWN data, so
// collection stays accountId-scoped; the CROSS-account read is the future serving job (Phase 1),
// which applies k-anonymity (K>=5). Serving (percentiles/cohorts) lives in the Pro plugin later.
export const benchmarkContributions = sqliteTable(
  'benchmark_contributions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // A known review-bot vendor kind (shared ReviewBotKind). Never in_house/pierre.
    vendorKind: text('vendor_kind').notNull(),
    // ISO-week start (UTC Monday 00:00) the aggregates cover.
    weekStart: integer('week_start', { mode: 'timestamp' }).notNull(),
    // Deterministic weekly outcome aggregates — counts only.
    threads: integer('threads').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    // "acted-on" = resolved | likely_addressed | a human replied after the bot (the same
    // heuristic the ROI panel uses; approximate — the UI says so).
    actedOn: integer('acted_on').notNull().default(0),
    untouched: integer('untouched').notNull().default(0),
    humanFollow: integer('human_follow').notNull().default(0),
    // Oldest still-untouched thread age (days) in the week; null when none untouched.
    oldestUntouchedDays: integer('oldest_untouched_days'),
    // Covariate: the account's active-contributor size bucket at contribution time
    // ('1' | '2-5' | '6-20' | '21-50' | '51-200' | '200+'), so cohorts can condition on size.
    orgSizeBucket: text('org_size_bucket').notNull(),
    // RESERVED for FUTURE ML-derived aggregate distributions (category mix / severity mix /
    // precision-by-category) — populated by the SAME rollup once the classifier ships, still
    // aggregate-only JSON. Null in Phase 0. Forward hook so ML enrichment needs no new migration.
    mlMetrics: text('ml_metrics'),
    // Contribution-format version so the row shape can evolve unambiguously.
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // One row per (account, vendor, week) — the idempotent upsert target. accountId-first so
    // uniqueness is per-tenant (two accounts contribute the same vendor+week independently).
    uniq: uniqueIndex('bench_contrib_uniq').on(t.accountId, t.vendorKind, t.weekStart),
    accountIdx: index('bench_contrib_account_idx').on(t.accountId),
    // Serving-side cohort scans (Phase 1): all accounts' rows for a vendor across weeks.
    cohortIdx: index('bench_contrib_cohort_idx').on(t.vendorKind, t.weekStart),
  }),
);

// ── Cross-team full-text search index (CORE, no AI) ─────────────────────────────────────
// One row per searchable text unit — a PR (title + description), a review body, a review-comment,
// or a PR-comment — so a team lead can "pinpoint where certain text exists" across every watched
// repo. Populated inside persistPr() (delete-by-prId then insert, so removed comments drop out) and
// backfilled from already-stored data at startup (sync/search-backfill.ts). Denormalized `accountId`
// is the tenant anchor: EVERY search filters on it, so cross-account isolation stays one indexed
// predicate (mirroring events/pullRequests). Matching is PORTABLE case-insensitive SUBSTRING
// (`lower(body) LIKE …`), so the identical query runs on SQLite and Postgres — substring is the
// right semantics for "find this exact text" (a Postgres `pg_trgm` GIN index is a drop-in
// accelerator, see the migration note). `threadId` lets a review-comment hit deep-link straight to
// its thread. Rebuilt per-PR, so no unique index is needed. FKs cascade so a repo/PR delete cleans up.
export const searchIndex = sqliteTable(
  'search_index',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['pr', 'review', 'review_comment', 'pr_comment'],
    }).notNull(),
    // The entity id within its kind (prId / reviewId / reviewCommentId / prCommentId) — builds the
    // in-app anchor for the hit.
    refId: integer('ref_id').notNull(),
    // For review_comment rows: the owning reviewThreads.id, so a hit deep-links to the thread.
    // Null for the other kinds.
    threadId: integer('thread_id'),
    // Who wrote this unit (users.id) — powers "search by person" (matched via the users join) and
    // the author chip on a result. Nullable (ghost / deleted authors).
    authorId: integer('author_id').references(() => users.id),
    // The searchable text (PR rows carry title + description; the others carry the body).
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    accountRepoIdx: index('search_account_repo_idx').on(t.accountId, t.repoId),
    prIdx: index('search_pr_idx').on(t.prId),
  }),
);
