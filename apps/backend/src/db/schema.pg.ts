// Postgres schema (cloud / Railway deployment mode, via node-postgres).
//
// The structural twin of `schema.sqlite.ts` — SAME table names, SAME column
// names, SAME `$type`s — with pg-core column types. Keep the two in lockstep by
// hand (the repo's "kept-in-sync copy" convention); `client.ts` casts the active
// driver+schema to this module's types, and `assertSchemaParity` guards drift.
//
// Type mapping from the sqlite twin:
//   integer().primaryKey({autoIncrement})       -> serial().primaryKey()
//   integer({mode:'timestamp'})                 -> timestamp({withTimezone, mode:'date'})  (keeps the Date contract)
//   integer({mode:'boolean'})                   -> boolean()
//   text({mode:'json'}).$type<T>()              -> jsonb().$type<T>()
//   real()                                      -> doublePrecision()
//   .default(sql`(unixepoch())`)                -> .defaultNow()
//   text({enum:[...]})                          -> text({enum:[...]})  (kept as text, no native pg enum)
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  serial,
  doublePrecision,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import type {
  BranchCheckRun,
  CheckRun,
  Label,
  ReviewRouteReason,
  StoredPrFile,
} from '@pierre-review/shared';

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  githubUserId: text('github_user_id').notNull().unique(),
  githubLogin: text('github_login').notNull(),
  // The user's GitHub display name (the `name` field from `gh api user` / OAuth
  // `GET /user`). Nullable — GitHub `name` can be unset; the UI falls back to the
  // login. Shown wherever the signed-in identity appears (header, greeting).
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  accessTokenEnc: text('access_token_enc'),
  isLocal: boolean('is_local').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  // Last time a loaded frontend was seen talking to the backend (cloud: stamped,
  // throttled, by the per-request account hook + an SPA heartbeat). The scheduler
  // syncs only accounts active within config.syncActiveWindowMinutes, so a tenant
  // with no open tab stops being re-synced. Null until first activity.
  lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
  // Last time this account viewed the Activity Feed — server-side "seen" marker (see the
  // sqlite twin). Drives "new My Turn since you were last here"; null until the first view.
  feedLastSeenAt: timestamp('feed_last_seen_at', { withTimezone: true, mode: 'date' }),
  // Billing plan ('free' | 'pro') — set only by the Stripe webhook. See the
  // sqlite twin. Kept in sync by hand (schema-parity.test.ts).
  plan: text('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  // Per-account monthly SUMMARY-AI credit allowance override (metered cloud plan). null =
  // plan default (2,500 for paid cloud); local/unlimited accounts ignore it. See the sqlite
  // twin. Kept in sync by hand (schema-parity.test.ts).
  aiCreditAllowance: integer('ai_credit_allowance'),
  // CLOUD-ONLY, opt-in (default OFF): contribute de-identified aggregate weekly review-bot
  // outcome stats to the cross-org benchmark network. See the sqlite twin + benchmarkContributions.
  benchmarkOptIn: boolean('benchmark_opt_in').notNull().default(false),
});

export const repos = pgTable(
  'repos',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    githubNodeId: text('github_node_id').notNull(),
    defaultBranch: text('default_branch'),
    // The viewer's permission on the repo (GraphQL Repository.viewerPermission).
    // Drives whether the viewer may approve a PR (WRITE+). See schema.sqlite.ts.
    // Kept in sync by hand (schema-parity.test.ts).
    viewerPermission: text('viewer_permission'),
    backfillUntil: timestamp('backfill_until', {
      withTimezone: true,
      mode: 'date',
    }),
    // Default-branch status snapshot ("is trunk green?") — the pg twin of schema.sqlite.ts.
    // All nullable until the branch sync runs. Kept in sync by hand (schema-parity.test.ts).
    defaultBranchName: text('default_branch_name'),
    defaultBranchHeadSha: text('default_branch_head_sha'),
    defaultBranchCiStatus: text('default_branch_ci_status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }),
    defaultBranchUpdatedAt: timestamp('default_branch_updated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // When the repo was added to this account — My Turn's clock. See schema.sqlite.ts for why
    // that is load-bearing. Kept in sync by hand (schema-parity.test.ts).
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerNameUx: uniqueIndex('repos_account_owner_name').on(
      t.accountId,
      t.owner,
      t.name,
    ),
    nodeUx: uniqueIndex('repos_account_node').on(t.accountId, t.githubNodeId),
    accountIdx: index('repos_account_idx').on(t.accountId),
    // Parent key for `workspace_repos`' composite FK — not a lookup index. Postgres accepts a
    // plain UNIQUE INDEX here (a named UNIQUE CONSTRAINT is not required; verified on 16.13),
    // which is what lets this be the same DDL as the sqlite twin. See schema.sqlite.ts.
    // `workspaces_id_account` is the same trick for the workspace half of those FKs.
    idAccountUx: uniqueIndex('repos_id_account').on(t.id, t.accountId),
  }),
);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  githubLogin: text('github_login').notNull().unique(),
  githubNodeId: text('github_node_id').unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  isBot: boolean('is_bot').notNull().default(false),
  isBotOverridden: boolean('is_bot_overridden').notNull().default(false),
  // GitHub GraphQL __typename of the actor, captured during sync — the pg twin of
  // schema.sqlite.ts. Plain text (no enum), nullable, GLOBAL. Feeds the bot-triage
  // classifier. Kept in sync by hand (schema-parity.test.ts).
  githubType: text('github_type'),
});

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: serial('id').primaryKey(),
    githubNodeId: text('github_node_id').notNull(),
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
    mergedById: integer('merged_by_id').references(() => users.id),
    baseRefName: text('base_ref_name'),
    // The PR's SOURCE branch (GraphQL `headRefName`); carrier of a Jira/Linear ticket key,
    // read by the Pro ticket-link enricher. Null until a sync backfills it.
    headRefName: text('head_ref_name'),
    state: text('state', { enum: ['open', 'merged', 'closed'] }).notNull(),
    isDraft: boolean('is_draft').notNull().default(false),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
    firstReviewAt: timestamp('first_review_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // Earliest review-request time (first ReviewRequestedEvent) — clock start for review-pickup
    // latency. See the sqlite twin for the rationale.
    firstReviewRequestedAt: timestamp('first_review_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastCommitAt: timestamp('last_commit_at', {
      withTimezone: true,
      mode: 'date',
    }),
    mergedAt: timestamp('merged_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
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
    // GitHub's overall review decision (GraphQL PullRequest.reviewDecision, lowercased) — the
    // pg twin of schema.sqlite.ts. Names the review half of a `blocked` merge state.
    reviewDecision: text('review_decision', {
      enum: ['approved', 'changes_requested', 'review_required'],
    }),
    labels: jsonb('labels').$type<Label[]>(),
    checkRuns: jsonb('check_runs').$type<CheckRun[]>(),
    // ---- Diff size (GraphQL additions/deletions/changedFiles + files connection) ----
    // Small metadata (not bulky text), so ALWAYS stored — independent of lean mode —
    // and served straight from the DB for the PR-detail LOC label + "Changes" tab.
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    changedFiles: integer('changed_files').notNull().default(0),
    // Per-file breakdown (capped at 100 files by the sync query). Nullable; the
    // API resolves it to [] and computes each file's GitHub deep link on read.
    files: jsonb('files').$type<StoredPrFile[]>(),
  },
  (t) => ({
    repoIdx: index('pr_repo_idx').on(t.repoId),
    openedIdx: index('pr_opened_idx').on(t.openedAt),
    accountIdx: index('pr_account_idx').on(t.accountId),
    // Drives getUserStats (the contributor popover) from the person rather than the account.
    authorIdx: index('pr_author_idx').on(t.authorId),
    // Serves resolving a PR NUMBER to a local id within a repo (the branch strip's commit → PR
    // link). See schema.sqlite.ts for why it isn't optional polish.
    accountRepoNumberIdx: index('pr_account_repo_number_idx').on(
      t.accountId,
      t.repoId,
      t.number,
    ),
    nodeUx: uniqueIndex('pr_account_node').on(t.accountId, t.githubNodeId),
  }),
);

export const reviewRequests = pgTable(
  'review_requests',
  {
    id: serial('id').primaryKey(),
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

export const prViews = pgTable('pr_views', {
  prId: integer('pr_id')
    .primaryKey()
    .references(() => pullRequests.id),
  lastViewedSha: text('last_viewed_sha'),
  lastViewedAt: timestamp('last_viewed_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

export const myTurnDismissals = pgTable(
  'my_turn_dismissals',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    kind: text('kind', {
      enum: ['review_request', 'thread', 'watched_repo_pr', 'pr_approved', 'claude_review'],
    }).notNull(),
    refId: integer('ref_id').notNull(),
    dismissedAt: timestamp('dismissed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (t) => ({
    kindRefUx: uniqueIndex('mtd_kind_ref_ux').on(t.kind, t.refId),
    accountIdx: index('mtd_account_idx').on(t.accountId),
  }),
);

export const reviewThreads = pgTable(
  'review_threads',
  {
    id: serial('id').primaryKey(),
    githubNodeId: text('github_node_id').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    path: text('path').notNull(),
    line: integer('line'),
    isResolved: boolean('is_resolved').notNull(),
    isOutdated: boolean('is_outdated').notNull().default(false),
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
    // GitHub login of whoever resolved the thread (from `resolvedBy`), null when unresolved.
    resolvedByLogin: text('resolved_by_login'),
    // When we FIRST OBSERVED the thread flip unresolved→resolved (sync-observation time). Stamped
    // only on a witnessed transition; a thread already resolved when first seen stays null. Powers
    // the resolution-latency trend. See the sqlite twin for the full rationale.
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    originalCommenterId: integer('original_commenter_id').references(
      () => users.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => ({
    prIdx: index('thread_pr_idx').on(t.prId),
    nodeUx: uniqueIndex('thread_pr_node').on(t.prId, t.githubNodeId),
    // "Which threads did this actor open?" — the per-repo reviewer footprint counts and migration
    // pg 0029's backfill CTE both union on this column, which had no index at all. See the sqlite
    // twin. Added in pg 0029 (sqlite 0042).
    originalCommenterIdx: index('thread_original_commenter_idx').on(t.originalCommenterId),
  }),
);

export const reviewComments = pgTable(
  'review_comments',
  {
    id: serial('id').primaryKey(),
    githubNodeId: text('github_node_id').notNull(),
    threadId: integer('thread_id')
      .notNull()
      .references(() => reviewThreads.id),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    // Nullable in cloud lean-storage mode (body hydrated on demand; see the
    // sqlite twin for the full rationale). `excerpt` keeps a short preview.
    body: text('body'),
    excerpt: text('excerpt'),
    diffHunk: text('diff_hunk'),
    databaseId: text('database_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => ({
    threadIdx: index('rc_thread_idx').on(t.threadId),
    authorIdx: index('rc_author_idx').on(t.authorId),
    nodeUx: uniqueIndex('rc_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const prComments = pgTable(
  'pr_comments',
  {
    id: serial('id').primaryKey(),
    githubNodeId: text('github_node_id').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    // Nullable: not persisted in cloud lean-storage mode (hydrated on demand).
    body: text('body'),
    databaseId: text('database_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => ({
    prIdx: index('prc_pr_idx').on(t.prId),
    authorIdx: index('prc_author_idx').on(t.authorId),
    nodeUx: uniqueIndex('prc_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const reviews = pgTable(
  'reviews',
  {
    id: serial('id').primaryKey(),
    githubNodeId: text('github_node_id').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    state: text('state', {
      enum: ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'],
    }).notNull(),
    body: text('body'),
    databaseId: text('database_id'),
    submittedAt: timestamp('submitted_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (t) => ({
    prIdx: index('rv_pr_idx').on(t.prId),
    authorIdx: index('rv_author_idx').on(t.authorId),
    nodeUx: uniqueIndex('reviews_pr_node').on(t.prId, t.githubNodeId),
  }),
);

export const commits = pgTable(
  'commits',
  {
    id: serial('id').primaryKey(),
    sha: text('sha').notNull(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    committerId: integer('committer_id').references(() => users.id),
    message: text('message'),
    committedAt: timestamp('committed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (t) => ({
    prIdx: index('commit_pr_idx').on(t.prId),
    shaPrUx: uniqueIndex('commit_sha_pr_ux').on(t.sha, t.prId),
  }),
);

export const commitFiles = pgTable('commit_files', {
  sha: text('sha').primaryKey(),
  paths: jsonb('paths').$type<string[]>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
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
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    refTable: text('ref_table'),
    refId: integer('ref_id'),
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => ({
    timeIdx: index('events_time_idx').on(t.occurredAt),
    repoTimeIdx: index('events_repo_time_idx').on(t.repoId, t.occurredAt),
    actorIdx: index('events_actor_idx').on(t.actorId),
    accountIdx: index('events_account_idx').on(t.accountId),
    // pr_id-correlated EXISTS lookups (open-PR staleness, feed joins) — see schema.sqlite.ts.
    prTimeIdx: index('events_pr_idx').on(t.prId, t.occurredAt),
    dedupeUx: uniqueIndex('events_account_dedupe').on(t.accountId, t.dedupeKey),
  }),
);

// CI status transition history — the pg twin of schema.sqlite.ts ciStatusEvents. See
// there for the rationale (real CI failure-resolution + failure-reason metrics).
export const ciStatusEvents = pgTable(
  'ci_status_events',
  {
    id: serial('id').primaryKey(),
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
    failingChecks: jsonb('failing_checks').$type<string[]>(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
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

// Append-only AI-spend ledger (pg twin of the sqlite table). See schema.sqlite.ts.
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    seam: text('seam', { enum: ['summary', 'agent'] }).notNull(),
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    prId: integer('pr_id'),
    repoId: integer('repo_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountOccurredIdx: index('au_account_occurred').on(t.accountId, t.occurredAt),
  }),
);

// ---- Auto-merge intents ── the pg twin of the sqlite autoMergeRequests table. See that file
// for the full rationale (Pierre-side standing intent, `expectedHeadOid` as the consent
// anchor, `expiresAt` as the backstop, one row per (account, PR)).
export const autoMergeRequests = pgTable(
  'auto_merge_requests',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    mergeMethod: text('merge_method', {
      enum: ['merge', 'squash', 'rebase'],
    }).notNull(),
    updateStrategy: text('update_strategy', {
      enum: ['rebase', 'merge', 'none'],
    }).notNull(),
    expectedHeadOid: text('expected_head_oid').notNull(),
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
    armedAt: timestamp('armed_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    lastReason: text('last_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountPrUx: uniqueIndex('amr_account_pr').on(t.accountId, t.prId),
    accountIdx: index('amr_account_idx').on(t.accountId),
    stateIdx: index('amr_state_idx').on(t.state),
  }),
);

// ---- Default-branch commits ── the pg twin of the sqlite branchCommits table. See that file
// for the full rationale (trunk commits aren't derivable from the PR-scoped `commits` table;
// accountId denormalized for isolation; bounded recent window per repo).
export const branchCommits = pgTable(
  'branch_commits',
  {
    id: serial('id').primaryKey(),
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
    committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ciStatus: text('ci_status', {
      enum: ['success', 'failure', 'pending', 'error', 'expected', 'unknown'],
    }),
    // The FAILING checks on this commit (failures only, so null on a green commit) and the PR
    // this commit landed from (a plain number, never a FK). See schema.sqlite.ts for the full
    // rationale on both — why failing_checks is NOT lean-gated despite pullRequests.checkRuns
    // being, why it shares a column name with ci_status_events.failing_checks while carrying a
    // different shape, and why pr_number is resolved to a local id at READ time.
    failingChecks: jsonb('failing_checks').$type<BranchCheckRun[]>(),
    prNumber: integer('pr_number'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountRepoShaUx: uniqueIndex('bc_account_repo_sha').on(
      t.accountId,
      t.repoId,
      t.sha,
    ),
    accountRepoTimeIdx: index('bc_account_repo_time').on(
      t.accountId,
      t.repoId,
      t.committedAt,
    ),
    accountIdx: index('bc_account_idx').on(t.accountId),
  }),
);

export const syncState = pgTable('sync_state', {
  repoId: integer('repo_id')
    .primaryKey()
    .references(() => repos.id),
  lastFullSyncAt: timestamp('last_full_sync_at', {
    withTimezone: true,
    mode: 'date',
  }),
  lastIncrementalSyncAt: timestamp('last_incremental_sync_at', {
    withTimezone: true,
    mode: 'date',
  }),
  lastSyncStatus: text('last_sync_status'),
  lastSyncError: text('last_sync_error'),
});

export const claudeReviews = pgTable(
  'claude_reviews',
  {
    id: serial('id').primaryKey(),
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
    scope: text('scope', { enum: ['diff_only', 'worktree'] }),
    // Deterministic router decision + inputs, recorded before the agent runs. See
    // the schema.sqlite.ts twin for the full rationale.
    reviewMode: text('review_mode', { enum: ['skip', 'diff_only', 'worktree'] }),
    routeReason: jsonb('route_reason').$type<ReviewRouteReason>(),
    summary: text('summary'),
    verdict: text('verdict', {
      enum: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'],
    }),
    userBody: text('user_body'),
    userVerdict: text('user_verdict', {
      enum: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'],
    }),
    costUsd: doublePrecision('cost_usd'),
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
    diffCapped: boolean('diff_capped'),
    error: text('error'),
    excludedFiles: jsonb('excluded_files').$type<string[]>(),
    postedReviewId: text('posted_review_id'),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    prIdx: index('cr_pr_idx').on(t.prId),
    prShaIdx: index('cr_pr_sha_idx').on(t.prId, t.headSha),
    accountIdx: index('cr_account_idx').on(t.accountId),
  }),
);

export const claudeReviewFindings = pgTable(
  'claude_review_findings',
  {
    id: serial('id').primaryKey(),
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
    editedBody: text('edited_body'),
    suggestion: text('suggestion'),
    diffHunk: text('diff_hunk'),
    anchored: boolean('anchored').notNull().default(true),
    // Whether the finding's file is part of the PR diff. true ⇒ an unanchored finding
    // posts inline on the file's first change; false ⇒ outside the diff → posts as a
    // standalone PR-level comment. Defaults true (back-compat: pre-existing findings).
    fileInDiff: boolean('file_in_diff').notNull().default(true),
    included: boolean('included').notNull().default(false),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    githubCommentId: text('github_comment_id'),
    // How a posted comment was attached: 'inline' (a review comment on a diff line)
    // or 'pr_comment' (a standalone PR-level issue comment, for an unanchored
    // finding posted individually). Null until posted; drives the correct GitHub
    // permalink (#discussion_r vs #issuecomment).
    postedCommentKind: text('posted_comment_kind', {
      enum: ['inline', 'pr_comment'],
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ reviewIdx: index('crf_review_idx').on(t.reviewId) }),
);

// ---- Workspaces (CORE) ----
// A named grouping of an account's repos, and the ONE scope this app has — the pg twin of
// schema.sqlite.ts workspaces. Kept in sync BY HAND (schema-parity.test.ts, which compares
// columns but NOT indexes and NOT foreign keys — diff the FK blocks by eye). Exactly one row per
// account carries is_default: auto-created, RENAMEABLE, NOT deletable, and new repos land in it.
export const workspaces = pgTable(
  'workspaces',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Exactly one true row per account — ALSO enforced by a PARTIAL UNIQUE INDEX created in
    // migrations-pg/0031 (`… ON workspaces (account_id) WHERE is_default`), not here: drizzle
    // index predicates are DDL-only metadata nothing in this repo consumes, but the constraint
    // itself is what makes ensureDefaultWorkspace's "INSERT … ON CONFLICT DO NOTHING then
    // re-SELECT" race-safe. See the sqlite twin.
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountNameUx: uniqueIndex('workspaces_account_name').on(t.accountId, t.name),
    accountIdx: index('workspaces_account_idx').on(t.accountId),
    // NOT a lookup index — `id` is already the PK. It is the PARENT KEY of the composite FKs on
    // workspace_repos and workspace_reviewers, exactly as `repos_id_account` is for those tables'
    // repo FKs. Postgres accepts a plain unique index as a parent key (no named UNIQUE constraint
    // required; verified on 16.13). Drop it and both composite FKs become unexpressible.
    idAccountUx: uniqueIndex('workspaces_id_account').on(t.id, t.accountId),
  }),
);

// EXACTLY ONE WORKSPACE PER REPO, AS A DATABASE FACT — the pg twin of schema.sqlite.ts
// workspaceRepos. The unique on (account_id, repo_id) makes reassignment an UPSERT, i.e. a MOVE;
// no code path can produce a second membership row. See the sqlite twin for why this is a join
// table rather than a `repos.workspace_id` column, and for the two sides that close the
// "repo with no membership row is invisible" gap (upsertRepo on write, ensureRepoMemberships on
// read). The workspace cascade is a SAFETY NET, not the delete path: deleteWorkspace moves the
// repos to Default inside its transaction first.
export const workspaceRepos = pgTable(
  'workspace_repos',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // No single-column FKs: both are the COMPOSITE declarations below.
    workspaceId: integer('workspace_id').notNull(),
    repoId: integer('repo_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
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
    // belongs to account 1 — both halves individually valid. NAMED because Postgres quotes the
    // name in the violation message and the hand-written migration spells the same
    // `CONSTRAINT "workspace_repos_workspace_account_fk"`; an unnamed declaration would be
    // auto-named `workspace_repos_workspace_id_account_id_fkey` and the name here would match
    // nothing live.
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
// THE BOT OBJECT: one row per (account, WORKSPACE, actor) — the pg twin of schema.sqlite.ts
// workspaceReviewers. It replaces BOTH `repo_reviewers` (judgement, per repo) and
// `account_reviewers` (identity + price, per account): with one workspace as the only scope both
// facts are about the same key, so a second table would key on the identical three columns.
//
// ⚠ THE TWO PROVENANCE FLAGS STAY SEPARATE COLUMNS and are honoured INDEPENDENTLY. `source` owns
// automated/role/confidence/reasons; `identity_source` owns kind/label. Inside one row that is
// code discipline (a narrowed `set:` object), not a table boundary — see the sqlite twin.
//
// ⚠ `monthly_cents` is in NO derived UPDATE. One writer (`setReviewerCost`), one row, keyed on
// (account_id, workspace_id, author_user_id). Price is a PER-WORKSPACE fact like every other
// column here: no fan-out, no INSERT seed, and two workspaces may legitimately hold different
// numbers. NULL = no price set, 0 = "recorded as free"; nothing inherits. `integer` CENTS in BOTH
// dialects: `numeric` has no sqlite twin AND node-postgres hands it back as a STRING, breaking
// the shared `number` wire type; the WIRE is DOLLARS, clamped to MAX_MONTHLY_CENTS. NEVER summed
// ACROSS workspaces on one screen. Full rationale in the sqlite twin.
export const workspaceReviewers = pgTable(
  'workspace_reviewers',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // No `.references()` here on purpose: the FK is the COMPOSITE one in the table config below,
    // `(workspace_id, account_id) → workspaces(id, account_id)`. See the sqlite twin.
    workspaceId: integer('workspace_id').notNull(),
    // No cascade: `users` is GLOBAL storage shared by every account and is never deleted.
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    // ── JUDGEMENT (owned by `source`) ──
    automated: boolean('automated').notNull(),
    // ReviewerRole — 'review' | 'quality_check'. A flag on this object, orthogonal to `kind`.
    role: text('role').notNull().default('review'),
    confidence: text('confidence').notNull(), // ClassificationConfidence — 'high'|'medium'|'low'
    source: text('source').notNull(), // ClassificationSource; 'manual' is never re-derived
    reasonsJson: jsonb('reasons_json').$type<string[]>(),
    // ── IDENTITY (owned by `identity_source`) ──
    kind: text('kind'), // AutomatedReviewerKind | null
    label: text('label'), // human-set display name; null ⇒ brand name ⇒ login
    // Provenance of `kind` + `label` ONLY — a different field from `source`, sharing a row.
    identitySource: text('identity_source', { enum: ['auto', 'manual'] })
      .notNull()
      .default('auto'),
    // ── PRICE (owned by nothing derived; one writer only) ──
    monthlyCents: integer('monthly_cents'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The upsert conflict target for EVERY writer. A stale target type-checks perfectly and
    // raises "no unique or exclusion constraint matching the ON CONFLICT specification" at
    // RUNTIME, only when a row is actually written.
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
    // Tenancy as a constraint: `workspace_id` arrives in a REQUEST BODY, and a single-column FK
    // would accept (account 2, workspace 10) where workspace 10 belongs to account 1. The
    // composite FK makes the PAIR the thing that must exist, and it needs the
    // `workspaces_id_account` unique index that exists for exactly this purpose. The `name` is
    // REAL — the hand-written migration spells `CONSTRAINT
    // "workspace_reviewers_workspace_account_fk"`, and Postgres quotes it in the violation.
    workspaceAccountFk: foreignKey({
      name: 'workspace_reviewers_workspace_account_fk',
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete('cascade'),
  }),
);

// NOTE: `repo_reviewers` + `account_reviewers` were the TWO-GRAIN bot store `workspace_reviewers`
// replaces (judgement per repo; identity + price per actor). Both are DROPPED by pg migration
// 0032 after their backfill — leaving either behind would leave a second, differently-keyed
// answer to the same question in every database. No schema binding here on purpose.

// NOTE: `bot_mute_rules` backed a removed feature (Pierre-only "hide" mute + the standing
// auto-resolve cron) — dropped in favour of a strictly user-initiated, confirm-gated resolve.
// No schema binding here on purpose; the pg baseline still creates the orphan table.

// NOTE: `teams` + `team_repos` (the many-to-many grouping) are what `workspaces` +
// `workspace_repos` above replace. Both are DROPPED by pg migration 0031, which preserves the
// team IDS as workspace ids and gives every repo exactly one membership row. No schema binding
// here on purpose.

// ── Cross-org benchmark network (CORE, cloud-only, opt-in) ── the pg twin of the sqlite
// benchmarkContributions table. See that file for the full rationale (aggregate-only, no PII,
// in_house/pierre excluded, written only by the firewalled weekly rollup; serving is Phase 1).
export const benchmarkContributions = pgTable(
  'benchmark_contributions',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    vendorKind: text('vendor_kind').notNull(),
    weekStart: timestamp('week_start', { withTimezone: true, mode: 'date' }).notNull(),
    threads: integer('threads').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    actedOn: integer('acted_on').notNull().default(0),
    untouched: integer('untouched').notNull().default(0),
    humanFollow: integer('human_follow').notNull().default(0),
    oldestUntouchedDays: integer('oldest_untouched_days'),
    orgSizeBucket: text('org_size_bucket').notNull(),
    mlMetrics: text('ml_metrics'),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('bench_contrib_uniq').on(t.accountId, t.vendorKind, t.weekStart),
    accountIdx: index('bench_contrib_account_idx').on(t.accountId),
    cohortIdx: index('bench_contrib_cohort_idx').on(t.vendorKind, t.weekStart),
  }),
);

// ── Cross-workspace full-text search index (CORE, no AI) ── the pg twin of the sqlite searchIndex
// table. See that file for the full rationale (one row per searchable unit, accountId tenant anchor,
// portable substring match, per-PR rebuild, cascading FKs). The (account_id, repo_id) btree already
// bounds each search to one tenant's scoped rows; for cloud scale a `pg_trgm` GIN index on
// lower(body) is a drop-in accelerator (`CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX …
// USING gin (lower(body) gin_trgm_ops)`) — deliberately kept OUT of the migration so a permission-
// locked Postgres can't fail startup; add it manually where the extension is available.
export const searchIndex = pgTable(
  'search_index',
  {
    id: serial('id').primaryKey(),
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
    refId: integer('ref_id').notNull(),
    threadId: integer('thread_id'),
    authorId: integer('author_id').references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => ({
    accountRepoIdx: index('search_account_repo_idx').on(t.accountId, t.repoId),
    prIdx: index('search_pr_idx').on(t.prId),
  }),
);
