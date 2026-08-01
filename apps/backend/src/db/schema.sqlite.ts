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
  foreignKey,
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
    // NOT a lookup index — `id` is already the primary key, so this is redundant for reads. It
    // exists solely as the PARENT KEY of `repo_reviewers`' composite FK
    // `(repo_id, account_id) → repos(id, account_id)`, which is what makes tenancy structural for
    // the one table whose repo id arrives in a request body. Both dialects require a unique index
    // over the parent key columns before such an FK is legal (Postgres accepts a plain unique
    // index — it does NOT need a named UNIQUE constraint; verified on 16.13). Drop it and the FK
    // becomes unexpressible, so a cross-account write goes back to being one handler's predicate.
    idAccountUx: uniqueIndex('repos_id_account').on(t.id, t.accountId),
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
    // "Which threads did this actor open?" — the per-repo reviewer FOOTPRINT counts
    // (`RepoReviewerFootprint.threads`, on every bot listing) and migration 0042's backfill CTE
    // both union on this column, and it had no index at all: every one of those was a full scan
    // of `review_threads`. Added in 0042 (pg 0029).
    originalCommenterIdx: index('thread_original_commenter_idx').on(t.originalCommenterId),
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
// ── THE BOT STORE IS TWO TABLES, ONE PER GRAIN ──────────────────────────────────────────────
// `repo_reviewers`    — (account, repo, author): the JUDGEMENT. Is this acting as an automated
//                        reviewer HERE, is that reviewing or quality-checking, and how we know.
// `account_reviewers` — (account, author):       the IDENTITY. What the bot IS, what it is
//                        CALLED, and what we PAY for it.
//
// EVERY FACT ON THIS PAGE LIVES AT EXACTLY ONE OF THEM. That is the whole design, and it is worth
// stating as a rule because the previous shape kept `kind`/`label`/`identity_source` on the
// per-repo row and held them consistent BY CONVENTION — replicated across an actor's rows with no
// constraint anywhere. That convention cost three standing obligations (a new repo row had to
// seed three columns from its siblings; persist() had to gate on two different provenance flags;
// and the account-wide identity was "a straight read of any one of them", which silently elects a
// winner the moment two rows disagree) and it is exactly the hazard that moving cost out of the
// row was meant to eliminate — left in place for three other columns.
//
// There is NO team key, NO inheritance, NO merge and NO DEDUPLICATION in either table.
//
// IF YOU ADD A FIELD, DECIDE ITS GRAIN FIRST. "Is this the same in every repo by definition?" is
// the whole test: a login is one vendor everywhere (identity), but it can be a reviewer on one
// repo and a quality gate on the next (judgement).
//
// A REVIEWER AS SEEN IN ONE REPO — this account's stored judgement about one actor in one repo.
// One row per (account, repo, author), and THAT ROW IS THE BOT OBJECT: is it automated, what is
// it for (`role`), and the provenance of that answer.
//
// WHY THE REPO IS THE KEY. A bot is installed per repository — GitHub Apps are installed on
// repos, CI configs live in repos — whereas a team is a bag of repos someone can re-bag tomorrow.
// The previous design keyed this judgement on a team, so the answer moved when team membership
// was edited, and it needed an inheritance chain (`team row → team-0 default → auto-detect`)
// whose null-means-inherit rules leaked into every read and every write path. Keying on the repo
// removes the chain outright: exactly one row per repo, nothing to fall back to, nothing to merge.
//
// THERE IS NO DEDUPLICATION ANYWHERE, deliberately. A vendor running on six repos is six rows and
// renders as six entries — in the team view and in the Feed bot summary alike. Within one repo
// there is nothing to dedupe, because the key already is (repo, actor).
//
// WHY `repo_reviewers` AND NOT `repo_bots`: a row may legitimately say `automated: false` — a
// human someone corrected off the bot list — so "bots" would be a lie for a real, load-bearing
// subset of the table. `repo_reviewers` reads exactly as its key: reviewers, per repo.
//
// DETECTION DERIVES ONCE PER ACTOR AND WRITES THE SAME VERDICT TO EVERY REPO ROW of that actor
// (sync/reviewer-classify.ts). Every strong signal — a known vendor login, `users.githubType`,
// app attribution, the branded-marker fingerprint — is a property of the ACTOR and is
// repo-independent, so deriving per repo would multiply the work AND the billed Haiku tie-break
// for an identical answer, and would weaken the behavioural score by computing it on a thin
// per-repo slice. The rows stay independently overridable: only a HUMAN edit should ever make two
// of an actor's rows disagree.
//
// NOTE THE ASYMMETRY WITH IDENTITY, because it is why the two grains are not one table: this is a
// derivation that happens once and is COPIED to N rows, so two rows CAN legitimately differ (a
// human overrode one). Identity is a fact that IS one value, so it gets one row.
//
// ── IT CARRIES NO IDENTITY, AND THAT IS THE POINT ───────────────────────────────────────────
// `kind`, `label` and `identity_source` USED TO BE COLUMNS HERE, replicated across an actor's
// rows and held consistent only by convention. They now live once, on `account_reviewers`.
//
// THE FAILURE THAT MOVE MAKES UNREPRESENTABLE, because it is not hypothetical: CodeRabbit is
// detected on api, web and infra; a user clicks "Not a bot" on web ONLY; that row's `kind` goes
// null and is the most recently updated; identity resolution reports kind=null account-wide; and
// useBotColors (which filters on kind != null) drops CodeRabbit's brand colour and vendor name on
// api and infra — repos the user never touched. A most-recently-updated tie-break does not fix
// it: it picks a winner, but it cannot make the losing rows editable or even visible. With
// identity at its own grain there is no losing row: one storage location, no election.
//
// The write side mirrors it exactly (packages/shared/src/types.ts): per-repo writes carry ONLY
// the judgement (`automated`, `role`); `kind`/`label` are an ACTOR-keyed write, as cost is. DO
// NOT MERGE THEM BACK into one body with a `repoId` — that is the shape this replaced.
export const repoReviewers = sqliteTable(
  'repo_reviewers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // NOTE THE MISSING `.references()`: this column's foreign key is the COMPOSITE one declared
    // in the table config below, `(repo_id, account_id) → repos(id, account_id)`, and a
    // single-column FK here as well would be a second, weaker constraint saying nearly the same
    // thing. See that declaration for why it is composite (tenancy) and why it cascades.
    repoId: integer('repo_id').notNull(),
    // No cascade: `users` is GLOBAL storage shared by every account and is never deleted.
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    automated: integer('automated', { mode: 'boolean' }).notNull(),
    // ReviewerRole — 'review' (an AI code reviewer) | 'quality_check' (static analysis / coverage
    // / lint). Just a FLAG ON THIS OBJECT, orthogonal to `kind` (vendor identity): a login keeps
    // its brand while being marked a linter, and it may honestly be a reviewer in one repo and a
    // quality gate in another. `automated` stays TRUE for a quality check, so exclusion + the feed
    // are unaffected; only the SCORING sets (behaviour, dedup, benchmark, ROI) treat 'review' as
    // the reviewer cohort. BOT-ONLY PRs DELIBERATELY DO NOT NARROW: that list answers "did a human
    // look at this", and a PR reviewed only by SonarQube is exactly what it exists to surface.
    // NOT NULL DEFAULT 'review' so a row written by an older code path still means something.
    role: text('role').notNull().default('review'),
    confidence: text('confidence').notNull(), // 'high'|'medium'|'low'
    source: text('source').notNull(), // ClassificationSource — 'manual' is never re-derived
    reasonsJson: text('reasons_json', { mode: 'json' }).$type<string[]>(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // The upsert conflict target for BOTH writers (reviewer-classify.ts persist() and the
    // override route). `account_id` is redundant with `repo_id` (a repo has one account) but is
    // kept in the key so the isolation predicate and the conflict target are the same columns —
    // miss it in an onConflictDoUpdate and Postgres raises "no unique or exclusion constraint
    // matching the ON CONFLICT specification" at RUNTIME, not at typecheck.
    accountRepoAuthorUx: uniqueIndex('repo_reviewers_account_repo_author').on(
      t.accountId,
      t.repoId,
      t.authorUserId,
    ),
    // Listing one repo's reviewers (the per-repo Bots settings list).
    accountRepoIdx: index('repo_reviewers_account_repo_idx').on(t.accountId, t.repoId),
    // Reaching every row of ONE actor: what "derive once per actor, write the verdict to each of
    // its repo rows" walks, and the join key from `account_reviewers` back to this table. It is
    // NOT what an identity write fans out over any more — there is nothing to fan out.
    accountAuthorIdx: index('repo_reviewers_account_author_idx').on(t.accountId, t.authorUserId),
    // ── TENANCY AS A CONSTRAINT, NOT A CONVENTION ────────────────────────────────────────
    // `repo_id` is the FIRST column in this schema that arrives in a REQUEST BODY rather than
    // from sync (the override names the repo row it edits). A plain `repo_id → repos(id)` FK
    // accepts (account 2, repo 10) where repo 10 belongs to account 1 — both halves are
    // individually valid — so the only thing between that and a row written into another
    // tenant's repo would be one hand-written predicate in one handler.
    //
    // The composite FK makes the pair itself the thing that must exist. Verified by insertion in
    // BOTH dialects: the cross-account row is rejected ("FOREIGN KEY constraint failed" /
    // "violates foreign key constraint"), and it needs the `repos_id_account` unique index that
    // exists for exactly this purpose.
    //
    // CASCADE, matching team_repos (the closest analogue). Core has no cascades on the PR subtree
    // because deleteRepo unwinds that by hand, but these rows are pure per-repo metadata with
    // nothing downstream: a repo's bot objects should die with the repo, and without the cascade
    // deleteRepo hits a foreign-key violation (local mode opens SQLite with `foreign_keys=ON`)
    // the moment a repo with a classified reviewer is removed.
    //
    // THE `name` IS REAL, NOT DECORATION — the hand-written migrations SPELL IT (`CONSTRAINT
    // "repo_reviewers_repo_account_fk" FOREIGN KEY …`) in both dialects, so the declaration and
    // the emitted DDL say the same thing. It previously did not: the SQL named nothing, so
    // Postgres auto-named the constraint `repo_reviewers_repo_id_account_id_fkey` and a grep for
    // the name in this file found no live constraint anywhere. In Postgres the name is what the
    // violation message quotes; SQLite parses and stores it but never reports it (its error is
    // the bare "FOREIGN KEY constraint failed" and `PRAGMA foreign_key_list` has no name column),
    // so on that side it is documentation that at least matches the stored DDL.
    repoAccountFk: foreignKey({
      name: 'repo_reviewers_repo_account_fk',
      columns: [t.repoId, t.accountId],
      foreignColumns: [repos.id, repos.accountId],
    }).onDelete('cascade'),
  }),
);

// WHAT AN AUTOMATED REVIEWER IS — one row per (account, actor), NEVER per repo. The ACTOR GRAIN:
// what the bot IS (`kind`), what it is CALLED (`label`), who decided that (`identity_source`),
// and what we PAY for it (`monthly_cents`).
//
// THESE ARE THE SAME IN EVERY REPO BY DEFINITION, which is the entire membership rule. A login is
// one vendor everywhere: CodeRabbit does not stop being CodeRabbit on the infra repo. And you buy
// ONE subscription from a vendor — six repos running CodeRabbit is $120, not $720 — so a per-repo
// price is a number that is wrong by construction the moment anyone sums it.
//
// ── THE NAME ────────────────────────────────────────────────────────────────────────────────
// `account_reviewers` is named for its KEY, exactly as `repo_reviewers` is, so the two table
// names ARE the statement of the model: one row per (account, author) here, one per (account,
// repo, author) there. Read them side by side and the grain of any fact is obvious from which
// file it is in.
//
// It is deliberately NOT named after any of the facts it holds. `reviewer_identities` would make
// `monthly_cents` look like a stray column someone bolted on; `reviewer_costs` (which this
// replaces) made `kind`/`label` look the same way. This table is defined by its GRAIN, not by its
// contents, and the next actor-level fact — a vendor's plan tier, a contract end date — belongs
// here without renaming anything.
//
// ── WHY COST IS IN HERE RATHER THAN IN A THIRD TABLE ────────────────────────────────────────
// Cost is simply another actor-level property. A separate `reviewer_costs` table alongside this
// one would key on the same two columns and be joined at every call site, i.e. it would be this
// table with extra steps. ONE TABLE PER GRAIN is the clearest possible statement of the model,
// and it is the same reason `kind`/`label` are here rather than replicated across repo rows.
//
// ── `monthly_cents` IS NULLABLE, AND THAT IS SAFE HERE IN A WAY IT WAS NOT BEFORE ───────────
// When cost had its own table, NOT NULL was the point: "no price" was "no row", so clearing a
// price was a DELETE and there was no third state. Folding it into a row that ALSO carries
// identity means the row can exist for reasons that have nothing to do with money, so the column
// must be nullable — an actor with a `kind` and no price is completely ordinary.
//
// DO NOT REINTRODUCE THE OLD FEAR. The bug class that made nullable money dangerous was
// nullable-means-INHERIT: NULL meant "fall through to the team-0 row", so 0 ("free HERE") and
// NULL ("ask my parent") had to be distinguished with `??` and never `||`, one character from a
// silent wrong price. THERE IS NO INHERITANCE ANYWHERE ANY MORE. NULL means exactly "no price
// set" and 0 means "free" — two states, no chain, no fallback, nothing to resolve. `||` is still
// wrong (it would turn a real 0 into "unset" for display), but it is now wrong in the ordinary,
// visible way that any falsy-vs-nullish mistake is, not in the way that silently bills a repo the
// wrong number. Clearing a price is `SET monthly_cents = NULL`, not a DELETE — deleting the row
// would take the identity with it.
//
// ⚠ RENDERING RULE, and it is the client's job because no schema can enforce it: a bot listing is
// one row per (repo, actor), so joining this price onto all six CodeRabbit rows and summing the
// column is both easy and wrong. Render it ONCE per actor and DEDUPE BY `author_user_id` before
// any total, average or $/acted-on. Stated again with the wire type
// (`ReviewerIdentity.costMonthlyUsd` in packages/shared/src/types.ts).
//
// MONEY IS NEVER A FLOAT HERE. SQLite has no DECIMAL and its REAL is a float64 where
// $0.10 + $0.20 !== $0.30, and this value gets divided ($/acted-on) and printed with toFixed(2).
// pg `numeric` was rejected as the twin: no sqlite equivalent, and node-postgres returns it as a
// STRING, which would silently break the shared `number` wire type. integer↔integer is exact
// parity for schema-parity.test.ts (which canonicalises int vs float precisely to catch this).
// The WIRE unit is DOLLARS; convert only at the store boundary. The ROUNDING RULE is fixed and
// identical in both dialects — cents = floor(usd × 100 + 0.5) evaluated in IEEE-754 binary64 —
// see the migrations for why anything computed in pg `numeric` disagrees with SQLite on $1.005.
//
// It is CORE, not Pro: an OSS/npx install can set and see a price. The legacy account-wide blob
// it replaces (`pro_settings.bot_cost_json`) is plugin-owned and stays put — see plugin
// migration 0019.
export const accountReviewers = sqliteTable(
  'account_reviewers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // No cascade: `users` is GLOBAL storage shared by every account and is never deleted.
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    // Vendor identity — drives BOT_VENDOR_META / automatedReviewerMeta() colour + brand name.
    // NULL when this actor is not automated anywhere.
    kind: text('kind'), // AutomatedReviewerKind | null
    // A human-set display name. NULL ⇒ fall back to the vendor's brand name, then the login.
    label: text('label'),
    // Provenance of `kind` + `label` ONLY — 'auto' (the classifier derived them) | 'manual' (a
    // human named this thing and the classifier must leave it alone).
    //
    // IT IS NOT THE SAME FIELD AS `repo_reviewers.source`, and the split is the reason both are
    // now trivially correct. "This is actually Greptile, not CodeRabbit" is an ACTOR-wide
    // identity correction; "not a bot HERE" is a per-repo judgement. They live on different
    // tables, so neither edit can reach the other's rows — where the previous shape needed
    // persist() to gate two provenance flags against columns sitting side by side.
    identitySource: text('identity_source', { enum: ['auto', 'manual'] })
      .notNull()
      .default('auto'),
    // NULL = no price set. 0 = free. See the nullability note above the table.
    monthlyCents: integer('monthly_cents'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // Upsert conflict target AND the isolation predicate — one row per actor per account, which
    // IS the table. Both identity writes and cost writes use it as their ON CONFLICT target.
    accountAuthorUx: uniqueIndex('account_reviewers_account_author').on(
      t.accountId,
      t.authorUserId,
    ),
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
