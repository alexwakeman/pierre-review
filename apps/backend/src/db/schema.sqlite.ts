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
    // The repo's GitHub "About" description, captured each activity sync. Grounding for the
    // workspace-purpose sprint-chat preset — the app's only repo-purpose text (READMEs are
    // never fetched or stored). Null until a sync populates it or when unset on GitHub.
    description: text('description'),
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
    // When the repo was added to this account. LOAD-BEARING beyond bookkeeping: it is My Turn's
    // clock. An open, non-draft PR by a human other than you qualifies for the "New PRs" section
    // only when `openedAt >= createdAt`, so adding a repo with 400 open PRs does not dump them
    // all into My Turn on day one. (It replaced `inbox_watch_started_at`, dropped in 0046 along
    // with the whole "watched" concept — a Workspace IS the scope now, and a second visibility
    // axis on top of it was just confusing.)
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
    // exists solely as the PARENT KEY of `workspace_repos`' composite FK
    // `(repo_id, account_id) → repos(id, account_id)`, which is what makes tenancy structural for
    // a table whose repo ids arrive in a request body. Both dialects require a unique index
    // over the parent key columns before such an FK is legal (Postgres accepts a plain unique
    // index — it does NOT need a named UNIQUE constraint; verified on 16.13). Drop it and the FK
    // becomes unexpressible, so a cross-account write goes back to being one handler's predicate.
    // `workspaces_id_account` is the exact same trick for the workspace half of those FKs.
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
  // The GitHub App slug behind this actor's comments (`performed_via_github_app.slug`,
  // REST-only), captured by the app-attribution probe (sync/app-attribution.ts) which used
  // to receive and DISCARD it. A bot's App identity is a global fact about the actor, so it
  // lives on the global `users` table — the advisor's discovery tier splits App-authored
  // from Actions-authored comments on it. Nullable: null = never observed (a PAT/OAuth
  // poster has no app), and an observed slug is never cleared by a later app-less comment.
  appSlug: text('app_slug'),
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
    // ALWAYS persisted (the Feed renders full comment markdown) — lean storage stopped
    // gating comment/review bodies; only the PR description, diffHunk, commit message and
    // checkRuns stay hydration-only. Nullable for legacy rows written during the 2026-06
    // lean window (hydrated on demand). `excerpt` keeps a short (~160 char) preview for
    // the lean triage path (getMyTurn) and graceful UI degradation.
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
    // ALWAYS persisted (the Feed renders full markdown) — see reviewComments.body; nullable
    // only for legacy rows from the 2026-06 lean window.
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
    // Correlated "does this PR have an event since <cutoff>" EXISTS lookups (getWorkspaceInsights
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
    // Set at arm time when the base branch had a merge queue: the watcher's terminal action
    // is then "add to the queue", not a direct merge (GitHub refuses PUT .../merge on a
    // queue-protected branch). Re-checked live each tick — a queue disabled after arming
    // falls back to the direct merge.
    viaMergeQueue: integer('via_merge_queue', { mode: 'boolean' }).notNull().default(false),
    // When the WATCHER added the PR to the merge queue; null until then (and always null for
    // direct-merge intents). Load-bearing for attribution: a PR that merges while this is set
    // resolves 'merged' (the watcher's doing — the toast fires); one a human queued resolves
    // 'disarmed_blocked' like any outside merge.
    enqueuedAt: integer('enqueued_at', { mode: 'timestamp' }),
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

// ---- Default-branch ("trunk") CI TRANSITION log ----
// The trunk twin of `ciStatusEvents`, and it exists for exactly the reason that table does:
// `branch_commits.ciStatus` is UPDATED IN PLACE by the branch snapshot's upsert, so a commit
// that turns red hours after it landed carries no record of WHEN it turned red — the only
// timestamps on that row are `committedAt` (git commit time) and `createdAt` (first insertion).
// Presenting either as "trunk CI failed at" would be a quiet lie, so the observation gets its
// own append-only row here.
//
// Written by `sync/branch-status.ts` at the end of every repo walk, ONLY on a transition (the
// status / head sha / failing-check name set differs from this repo's last row) and ONLY on a
// POSITIVE statement from GitHub — an `unknown` rollup, which is also what `graphqlTolerant`
// yields when a partial response NULLs the selection, records nothing. Strictly non-fatal: a
// failure here must never cost the branch snapshot that just succeeded.
//
// `observedAt` is when WE saw it, never GitHub's completion time (the branch query selects no
// `completedAt`), so any UI wording must say "detected", not "failed at".
//
// Bounded by its OWN per-repo trim, not by the retention sweep: `pruneOldData` anchors everything
// to a parent PR's `updatedAt`, and a trunk row has no PR. ⚠ That trim is HYBRID, like
// `branch_commits`' — the newest TRUNK_CI_EVENT_WINDOW rows ∪ everything inside FEED_WINDOW_DAYS
// (`staleTrunkCiEventIds`) — because a pure count bound silently evicted the failure rows the Feed
// reads on repos that sync faster than the read window elapses, and a pure age bound would wipe a
// dormant repo's whole log. FKs CASCADE so a repo delete / account erasure cleans up regardless
// (both also delete explicitly, so the guarantee never rests on `foreign_keys=ON`).
//
// NOTE: `failing_checks` is `BranchCheckRun[]` here — the SAME shape as `branch_commits`
// (the trunk vocabulary), and deliberately NOT the bare `string[]` of `ci_status_events`.
// The $type<>() makes the difference a compile-time fact at every call site.
export const trunkCiStatusEvents = sqliteTable(
  'trunk_ci_status_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    // The default branch this observation is about, as GitHub named it at the time. Nullable
    // because a partial response can null `defaultBranchRef.name` while still carrying the
    // target's oid + rollup — the branch NAME is display sugar, the sha is the identity.
    branchName: text('branch_name'),
    headSha: text('head_sha').notNull(),
    status: text('status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }).notNull(),
    failingChecks: text('failing_checks', { mode: 'json' }).$type<BranchCheckRun[]>(),
    observedAt: integer('observed_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    // The read (the Feed builder) and the trim: one repo's log, newest first.
    accountRepoObservedIdx: index('tcse_account_repo_observed').on(
      t.accountId,
      t.repoId,
      t.observedAt,
    ),
    accountIdx: index('tcse_account_idx').on(t.accountId),
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

// ---- Workspaces (CORE) ----
// A named grouping of an account's repos, and the ONE scope this app has. Exactly one row per
// account carries is_default: it is auto-created, RENAMEABLE, NOT deletable, and new repos land
// in it. Everything the old `teams` table did, minus the many-to-many and minus the four scope
// sentinels ('all' / 'none' / 'teams' / a set) that made "which repos am I looking at" a
// five-branch question with three independent parsers.
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Exactly one true row per account. ensureDefaultWorkspace() is the ONLY writer of `true`;
    // createWorkspace always writes false and deleteWorkspace refuses a true row. That invariant
    // is ALSO enforced by a PARTIAL UNIQUE INDEX created in the .sql migrations (not here — see
    // the note under the table), so two concurrent ensureDefaultWorkspace() calls cannot both
    // insert.
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountNameUx: uniqueIndex('workspaces_account_name').on(t.accountId, t.name),
    accountIdx: index('workspaces_account_idx').on(t.accountId),
    // NOT a lookup index — `id` is already the PK. It is the PARENT KEY of the composite FKs on
    // workspace_repos and workspace_reviewers, exactly as `repos_id_account` is for those tables'
    // repo FKs. Both dialects require a unique index over the parent-key columns before such an
    // FK is legal (Postgres accepts a plain unique index; it does not need a named constraint).
    // Drop it and both composite FKs become unexpressible.
    idAccountUx: uniqueIndex('workspaces_id_account').on(t.id, t.accountId),
  }),
);

// THE PARTIAL UNIQUE INDEX ON `is_default` LIVES IN THE MIGRATIONS, NOT HERE. Drizzle index
// predicates are DDL-only metadata that nothing in this repo consumes (core sqlite migrations are
// hand-written and the pg baseline is not regenerated for this change), so declaring it in the
// table config above would buy nothing — but the CONSTRAINT ITSELF is required, because
// `ensureDefaultWorkspace` runs on effectively every request and two concurrent calls for an
// account with no default would otherwise both SELECT nothing and both INSERT. Both dialects
// enforce it, one literal apart:
//   sqlite (0044):   CREATE UNIQUE INDEX … `workspaces_one_default` ON `workspaces` (`account_id`)
//                    WHERE `is_default` = 1;
//   postgres (0031): CREATE UNIQUE INDEX … workspaces_one_default ON workspaces (account_id)
//                    WHERE is_default;
// With it in place, `ensureDefaultWorkspace` is `INSERT … ON CONFLICT DO NOTHING` then re-SELECT
// — the loser of a race reads the winner's row instead of 500ing.

// EXACTLY ONE WORKSPACE PER REPO, AS A DATABASE FACT. The unique on (account_id, repo_id) is what
// makes that structural: assigning a repo elsewhere is an UPSERT on that key, i.e. a MOVE, and no
// code path can produce a second membership row. `repo_id` alone would do (repos.id is a global
// PK) — account_id rides in the key so the isolation predicate and the conflict target are the
// same columns, the same discipline the old repo_reviewers used.
//
// WHY A TABLE AND NOT A `repos.workspace_id` COLUMN. SQLite cannot ADD a CONSTRAINT to an
// existing table and cannot cheaply make an existing column NOT NULL; a NOT NULL FK column on
// `repos` therefore means rebuilding `repos` (create-copy-drop-rename) under `foreign_keys=ON`,
// with every child FK in the schema pointing at it mid-flight. That is a large, irreversible
// risk for a column, and it is exactly why 0042 created `repo_reviewers` fresh rather than
// altering anything. A join table arrives fully constrained on day one.
//
// THE RESIDUAL RISK, and it is real: a repo with NO membership row is invisible to every
// workspace-scoped read. It is closed on both sides —
//   • WRITE: sync/upsert.ts `upsertRepo` inserts the membership row in the SAME runTransaction
//     as the repo row, ON CONFLICT (account_id, repo_id) DO NOTHING so re-adding an existing repo
//     never moves it out of the workspace a human put it in.
//   • READ: `ensureRepoMemberships(accountId)` (queries.ts) diffs the account's repo ids against
//     its membership repo ids IN JS (the portable anti-join `getUnassignedRepoIds` already used)
//     and inserts the missing ones into Default. It is called from `listWorkspaces` and from
//     `resolveWorkspaceScope`, i.e. on every page load and every scoped request.
//     ⚠ IT IS A WRITE ON ESSENTIALLY EVERY GET, so the insert MUST carry
//     `ON CONFLICT (account_id, repo_id) DO NOTHING` (concurrent requests WILL race the unique).
//     It writes the membership row and NOTHING else — there is no second visibility column left
//     to touch (`repos.inbox_watch` was dropped in 0046), which is one of the things that made
//     collapsing to a single axis worth doing: a repair pass can no longer have a side effect.
//
// THE WORKSPACE CASCADE IS A SAFETY NET, NOT THE DELETE PATH. `deleteWorkspace` MOVES the
// workspace's repos to Default inside its transaction BEFORE deleting the row, so the cascade
// finds nothing to do. It exists so account erasure and a hand-run `DELETE FROM workspaces`
// cannot leave orphan membership rows.
export const workspaceRepos = sqliteTable(
  'workspace_repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // No single-column FKs: both are the COMPOSITE declarations below.
    workspaceId: integer('workspace_id').notNull(),
    repoId: integer('repo_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // One workspace per repo, structurally. Also the upsert conflict target for
    // assignReposToWorkspace.
    accountRepoUx: uniqueIndex('workspace_repos_account_repo').on(t.accountId, t.repoId),
    accountWorkspaceIdx: index('workspace_repos_account_workspace_idx').on(
      t.accountId,
      t.workspaceId,
    ),
    repoIdx: index('workspace_repos_repo_idx').on(t.repoId),
    // Tenancy as a constraint. `workspaceId` arrives in a REQUEST BODY, so a plain
    // `REFERENCES workspaces(id)` would accept (account 2, workspace 10) where workspace 10
    // belongs to account 1 — both halves individually valid. NAMED so Postgres quotes it in the
    // violation message and a grep for the name finds a live constraint. (SQLite parses and
    // stores the name but never reports it — its error is the bare "FOREIGN KEY constraint
    // failed" and `PRAGMA foreign_key_list` has no name column — so on that side it is
    // documentation that at least matches the stored DDL.)
    workspaceAccountFk: foreignKey({
      name: 'workspace_repos_workspace_account_fk',
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete('cascade'),
    repoAccountFk: foreignKey({
      name: 'workspace_repos_repo_account_fk',
      columns: [t.repoId, t.accountId],
      foreignColumns: [repos.id, repos.accountId],
    }).onDelete('cascade'),
  }),
);

// ---- Bot-Triage Platform (WS1 / WS6) ----
// THE BOT OBJECT: one row per (account, WORKSPACE, actor). It replaces BOTH `repo_reviewers`
// (the judgement, per repo) and `account_reviewers` (identity + price, per account).
//
// WHY ONE TABLE NOW. The two-table split existed because judgement and identity lived at
// DIFFERENT grains: "not a bot on web" had to not blank CodeRabbit's brand colour on api and
// infra. With one workspace as the only scope, both facts are about the same key — so a second
// table would key on the identical three columns and be joined at every call site, i.e. this
// table with extra steps. "CodeRabbit in 6 repos of a workspace" is ONE row: one judgement, one
// price, one brand colour.
//
// ⚠ WHAT MUST NOT BE LOST WITH THE SPLIT: the two PROVENANCE FLAGS stay separate columns and are
// honoured INDEPENDENTLY. `source` owns automated/role/confidence/reasons; `identity_source` owns
// kind/label. A classification pass that respects only one of them either reverts a human's vendor
// correction or freezes auto-detection. Inside one row this is a narrowed `set:` object, not a
// table boundary, so it is code discipline now and it is pinned by tests.
//
// ⚠ `monthly_cents` IS NEVER IN ANY DERIVED **UPDATE**. It is the one column no classifier can
// regenerate, so exactly ONE writer touches it and it names exactly ONE row:
//   `setReviewerCost` — an UPDATE keyed on (account_id, workspace_id, author_user_id). The price
//   is per WORKSPACE, like every other attribute on this row: editing it in workspace A leaves
//   A's siblings alone and they may hold different numbers. There is no fan-out and no INSERT
//   seed. A newly created row's price is simply NULL until someone sets it, and the column
//   appears in no other `set:` object anywhere in the codebase.
// NULL = no price set, 0 = "recorded as free". Nothing inherits; there is no chain behind a `??`.
// Storage is integer CENTS in both dialects (pg `numeric` has no sqlite twin and node-postgres
// returns it as a STRING; REAL is a float64 that cannot hold money); the WIRE is DOLLARS,
// converted only at the store boundary, clamped to MAX_MONTHLY_CENTS. The ROUNDING RULE is fixed
// and identical in both dialects — cents = floor(usd × 100 + 0.5) evaluated in IEEE-754 binary64.
//
// ⚠ RENDERING RULE, and it is the client's job because no schema can enforce it: within ONE
// workspace there is exactly one row per actor, so a total there is a plain sum. ACROSS
// workspaces it must never be summed — six workspaces each listing a $120 CodeRabbit is either
// six subscriptions or one seen six ways, and the app must not assert which. Compare-workspaces
// shows the figures side by side and does not total them.
//
// WHY `workspace_reviewers` AND NOT `workspace_bots`: a row may legitimately say
// `automated: false` — a human someone corrected off the bot list — so "bots" would be a lie for
// a real, load-bearing subset of the table. The name states the KEY, exactly as the table names
// it replaces did: reviewers, per workspace.
//
// ⚠ THE WORKSPACE CASCADE IS FAR MORE DANGEROUS HERE than on workspace_repos: it would destroy
// every manual judgement, every manual vendor name and every `monthly_cents` in the workspace —
// money the user typed — while the repos survive. `deleteWorkspace` therefore ALSO re-homes the
// reviewer rows to Default before deleting the workspace row. Under the old model deleting a team
// touched no classification at all, so this is a NEW failure mode and it must be closed in code,
// not in copy.
export const workspaceReviewers = sqliteTable(
  'workspace_reviewers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // NOTE THE MISSING `.references()`: this column's foreign key is the COMPOSITE one declared
    // in the table config below, `(workspace_id, account_id) → workspaces(id, account_id)`.
    workspaceId: integer('workspace_id').notNull(),
    // No cascade: `users` is GLOBAL storage shared by every account and is never deleted.
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    // ── JUDGEMENT (owned by `source`) ──
    automated: integer('automated', { mode: 'boolean' }).notNull(),
    // ReviewerRole — 'review' (an AI code reviewer) | 'quality_check' (static analysis / coverage
    // / lint). Just a FLAG ON THIS OBJECT, orthogonal to `kind` (vendor identity): a login keeps
    // its brand while being marked a linter. `automated` stays TRUE for a quality check, so
    // exclusion + the feed are unaffected; only the SCORING sets (behaviour, dedup, benchmark,
    // ROI) treat 'review' as the reviewer cohort. BOT-ONLY PRs DELIBERATELY DO NOT NARROW: that
    // list answers "did a human look at this", and a PR reviewed only by SonarQube is exactly
    // what it exists to surface. NOT NULL DEFAULT 'review' so a row written by an older code path
    // still means something.
    role: text('role').notNull().default('review'),
    confidence: text('confidence').notNull(), // ClassificationConfidence — 'high'|'medium'|'low'
    source: text('source').notNull(), // ClassificationSource; 'manual' is never re-derived
    reasonsJson: text('reasons_json', { mode: 'json' }).$type<string[]>(),
    // ── IDENTITY (owned by `identity_source`) ──
    // Vendor identity — drives BOT_VENDOR_META / automatedReviewerMeta() colour + brand name.
    // NULL when this actor is not automated in this workspace.
    kind: text('kind'), // AutomatedReviewerKind | null
    label: text('label'), // human-set display name; null ⇒ brand name ⇒ login
    // Provenance of `kind` + `label` ONLY — 'auto' (the classifier derived them) | 'manual' (a
    // human named this thing and the classifier must leave it alone). IT IS NOT THE SAME FIELD AS
    // `source`, and keeping the two apart is what stops a vendor correction reverting a
    // judgement (and vice versa) now that they share a row.
    identitySource: text('identity_source', { enum: ['auto', 'manual'] })
      .notNull()
      .default('auto'),
    // ── PRICE (owned by nothing derived; one writer only) ──
    monthlyCents: integer('monthly_cents'),
    // How `monthly_cents` is READ: 'flat' = the whole workspace subscription; 'per_seat' = a
    // per-seat unit price, multiplied on read by the workspace's derived human seat count.
    // The product (seats × cents) is NEVER stored — it can exceed int4 and would go stale.
    // Written ONLY by `setReviewerCost`, exactly like `monthly_cents` (same one-writer rule,
    // same standalone cost route; never in any derived UPDATE, never in the PATCH body).
    costModel: text('cost_model', { enum: ['flat', 'per_seat'] })
      .notNull()
      .default('flat'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // The upsert conflict target for EVERY writer. A stale target type-checks perfectly and
    // raises "no unique or exclusion constraint matching the ON CONFLICT specification" at
    // RUNTIME, in both dialects, only when a row is actually written.
    accountWorkspaceAuthorUx: uniqueIndex('workspace_reviewers_account_workspace_author').on(
      t.accountId,
      t.workspaceId,
      t.authorUserId,
    ),
    // Listing one workspace's reviewers (the Bots settings list).
    accountWorkspaceIdx: index('workspace_reviewers_account_workspace_idx').on(
      t.accountId,
      t.workspaceId,
    ),
    // Reaching every row of ONE actor across the account's workspaces.
    accountAuthorIdx: index('workspace_reviewers_account_author_idx').on(
      t.accountId,
      t.authorUserId,
    ),
    // ── TENANCY AS A CONSTRAINT, NOT A CONVENTION ────────────────────────────────────────
    // `workspace_id` arrives in a REQUEST BODY rather than from sync. A plain
    // `workspace_id → workspaces(id)` FK accepts (account 2, workspace 10) where workspace 10
    // belongs to account 1 — both halves are individually valid — so the only thing between that
    // and a row written into another tenant's workspace would be one hand-written predicate in
    // one handler. The composite FK makes the PAIR itself the thing that must exist, and it needs
    // the `workspaces_id_account` unique index that exists for exactly this purpose.
    //
    // THE `name` IS REAL, NOT DECORATION — the hand-written migrations SPELL IT (`CONSTRAINT
    // "workspace_reviewers_workspace_account_fk" FOREIGN KEY …`) in both dialects, so the
    // declaration and the emitted DDL say the same thing. In Postgres the name is what the
    // violation message quotes; SQLite stores it but never reports it.
    workspaceAccountFk: foreignKey({
      name: 'workspace_reviewers_workspace_account_fk',
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete('cascade'),
  }),
);

// NOTE: `repo_reviewers` (account, repo, author) and `account_reviewers` (account, author) were
// the TWO-GRAIN bot store this replaces — the judgement per repo, the identity + price per actor.
// Both are DROPPED by migration 0045 / pg 0032, which folds them onto `workspace_reviewers`
// above. The split existed only because those facts sat at different grains; with the workspace
// as the one scope they are facts about the same key. Leaving either table behind would leave a
// second, differently-keyed answer to the same question in every database — the exact failure
// `bot_review_classification` was dropped to avoid. Don't reintroduce a schema binding for either.

// NOTE: the `bot_mute_rules` table (migration 0029) backed a removed feature — the
// Pierre-only "hide" mute + the standing auto-resolve cron. Both were dropped; resolving
// likely-addressed bot threads is now strictly user-initiated + confirm-gated (see
// bot-triage/resolve.ts). The table is left orphaned in existing DBs (no drop migration);
// don't reintroduce a schema binding for it.

// NOTE: `teams` + `team_repos` (the many-to-many grouping a repo could sit in 0..N of) are what
// `workspaces` + `workspace_repos` above replace. Both are DROPPED by migration 0044 / pg 0031,
// which preserves the team IDS as workspace ids (a URL, a bookmark, a persisted filter and a
// plugin cache row all carry the number) and gives every repo exactly one membership row. The
// four scope sentinels those tables needed ('all' / 'none' / 'teams' / a set) are gone with them:
// there is one workspace id and no parsers. Don't reintroduce a schema binding for either.

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

// ── Cross-workspace full-text search index (CORE, no AI) ────────────────────────────────
// One row per searchable text unit — a PR (title + description), a review body, a review-comment,
// or a PR-comment — so a team lead can "pinpoint where certain text exists" across every repo on
// the account. Populated inside persistPr() (delete-by-prId then insert, so removed comments drop out) and
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

// ── ML severity/category labels for BOT-authored text (CORE, free tier, no LLM) ──────────
// One row per classified target. Written ONLY by the background enrichment worker
// (sync/ml-enrichment.ts), which POSTs batches to the `severity-api` microservice from the
// sibling `pierre-ml` repo. Read by the per-PR badge index and the Bots severity rollup.
// Full contract: docs/ML-SEVERITY.md.
//
// WHY THE ROW DENORMALISES accountId / repoId / prId / authorUserId, when `targetId` already
// names a row that could be joined for all four: `target_kind` is polymorphic across THREE
// tables, so every scoped read would otherwise be a three-way UNION of joins — including the
// Bots rollup, which groups by author across a whole workspace. These are SNAPSHOT facts about
// an immutable parent (a comment never changes PR or author), not a second writable copy of a
// live fact, so the "one fact, one grain" rule is not in play. accountId is additionally the
// tenant anchor every read filters on, per the project-wide rule.
//
// TARGET IDS ARE NOT FOREIGN KEYS. `target_id` lives in three different id spaces
// (reviewComments.id / prComments.id / reviews.id) so no single FK can express it — the same
// shape the plugin's `pr_comment_annotations` uses. Cleanup rides the CASCADING pr_id FK
// instead: deleting a PR (deleteRepo, the retention sweep) takes its labels with it, which is
// why this table is deliberately absent from both hand-written delete paths (the `search_index`
// precedent). Its own comments can only be deleted WITH their PR, so nothing dangles.
export const mlCommentLabels = sqliteTable(
  'ml_comment_labels',
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
    // MlLabelTargetKind — 'review_comment' | 'pr_comment' | 'review'. NOT the plugin's
    // AnnotationTargetKind (that one has 'thread' and no 'review').
    targetKind: text('target_kind', {
      enum: ['review_comment', 'pr_comment', 'review'],
    }).notNull(),
    // The target's own primary key WITHIN its kind. Not globally unique — which is exactly why
    // the unique index below carries target_kind.
    targetId: integer('target_id').notNull(),
    // The bot that wrote the labelled text (users.id). Denormalised so the Bots rollup is one
    // GROUP BY rather than a three-way union back to the source tables.
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    // MlSeverity, lowercased at the wire boundary ('nit'|'minor'|'major'|'critical').
    severity: text('severity', {
      enum: ['nit', 'minor', 'major', 'critical'],
    }).notNull(),
    // 0..3, nit → critical. The service's own ordinal, stored so ordering/thresholding is an
    // indexed integer comparison instead of a CASE over the enum.
    severityOrd: integer('severity_ord').notNull(),
    severityProb: real('severity_prob').notNull(),
    // ── THE VENDOR'S OWN CLAIM, kept BESIDE ours — never folded into it. ──────────────────
    // The severity the review bot declared for itself in its own markup (CodeRabbit's
    // "Major" badge and friends), parsed by the service's deterministic marker reader.
    // NULLABLE because most comments carry no vendor badge at all, and because an older
    // severity-api build omits the field entirely (the client reads it defensively → null).
    //
    // It is stored to be SHOWN NEXT TO ours ("CodeRabbit: Major · Pierre: Minor"), and for no
    // other purpose. On the 300-comment `gold_v2_sample` adjudication our model scores 0.700
    // exact / 0.303 ordinal MAE against the vendor badge's 0.474 / 0.697 — so this column is
    // materially LESS accurate than the one next to it. Nothing may derive, correct or
    // fall back to it: the disagreement is the product.
    vendorSeverity: text('vendor_severity', {
      enum: ['nit', 'minor', 'major', 'critical'],
    }),
    // How sure the marker reader is that it read a real vendor badge rather than inferred one
    // from prose. Advisory metadata ABOUT the column above, not about our own severity.
    vendorSeverityConfidence: text('vendor_severity_confidence', {
      enum: ['high', 'medium', 'low'],
    }),
    // MlCategory[] — multi-label, never empty.
    categories: text('categories', { mode: 'json' }).$type<string[]>().notNull(),
    // The service returns a probability for ALL eight categories; kept whole so a later
    // threshold change is a re-read rather than a re-score of the entire corpus.
    categoryProbs: text('category_probs', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull(),
    isSummary: integer('is_summary', { mode: 'boolean' }).notNull(),
    // Which backends served it, verbatim. Lacking 'modernbert-onnx' means the marker fallback
    // answered — a degraded deployment that must be VISIBLE, not silently lower quality.
    backend: text('backend').notNull(),
    modelVersion: text('model_version').notNull(),
    // sha256 of the exact text sent to the service. Comment bodies are MUTABLE (every sync
    // re-upserts them), so a boolean "enriched" flag or the row id would both go stale
    // invisibly; the hash is what lets a re-score be decided without a second model call.
    bodyHash: text('body_hash').notNull(),
    // The SOURCE comment's createdAt, copied so the Bots rollup can window without a
    // three-way union back to the polymorphic parents (and so the worker can order a
    // re-score newest-first). Immutable on the parent, so it never diverges.
    targetCreatedAt: integer('target_created_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    // THE conflict target for every writer. accountId first so uniqueness is per tenant, and
    // target_kind is load-bearing: the three id spaces overlap freely.
    accountTargetUx: uniqueIndex('mcl_account_target').on(
      t.accountId,
      t.targetKind,
      t.targetId,
    ),
    // The per-PR badge index (one query serves every card on a PR).
    accountPrIdx: index('mcl_account_pr_idx').on(t.accountId, t.prId),
    // The Bots rollup: one workspace's repos, grouped by bot.
    accountRepoAuthorIdx: index('mcl_account_repo_author_idx').on(
      t.accountId,
      t.repoId,
      t.authorUserId,
    ),
  }),
);
