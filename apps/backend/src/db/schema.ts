import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { CheckRun, Label } from '@gh-team-monitor/shared';

export const repos = sqliteTable(
  'repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    githubNodeId: text('github_node_id').notNull().unique(),
    backfillUntil: integer('backfill_until', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({ ownerNameUx: uniqueIndex('repos_owner_name').on(t.owner, t.name) }),
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
});

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull().unique(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    authorId: integer('author_id').references(() => users.id),
    state: text('state', { enum: ['open', 'merged', 'closed'] }).notNull(),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    openedAt: integer('opened_at', { mode: 'timestamp' }).notNull(),
    firstReviewAt: integer('first_review_at', { mode: 'timestamp' }),
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
    labels: text('labels', { mode: 'json' }).$type<Label[]>(),
    // Per-job CI checks on the head commit (CheckRuns + StatusContexts).
    checkRuns: text('check_runs', { mode: 'json' }).$type<CheckRun[]>(),
  },
  (t) => ({
    repoIdx: index('pr_repo_idx').on(t.repoId),
    openedIdx: index('pr_opened_idx').on(t.openedAt),
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

// Per-PR "last viewed" state for incremental review. One row per PR.
export const prViews = sqliteTable('pr_views', {
  prId: integer('pr_id')
    .primaryKey()
    .references(() => pullRequests.id),
  lastViewedSha: text('last_viewed_sha'),
  lastViewedAt: integer('last_viewed_at', { mode: 'timestamp' }).notNull(),
});

// Manual dismissals of "my turn" entries. `refId` is a PR id (review_request)
// or a review-thread id (thread). The dismissal is honoured only while no newer
// activity has happened — getMyTurn compares dismissedAt against the PR's
// updatedAt / the thread's last reply, so it auto-resurfaces.
export const myTurnDismissals = sqliteTable(
  'my_turn_dismissals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['review_request', 'thread'] }).notNull(),
    refId: integer('ref_id').notNull(),
    dismissedAt: integer('dismissed_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({ kindRefUx: uniqueIndex('mtd_kind_ref_ux').on(t.kind, t.refId) }),
);

// Singleton (id always 1): the locally-authenticated GitHub user, cached from
// `gh api user` so triage ("my turn") knows who "you" are.
export const localUser = sqliteTable('local_user', {
  id: integer('id').primaryKey(),
  githubLogin: text('github_login').notNull(),
  githubId: text('github_id').notNull(),
  avatarUrl: text('avatar_url'),
  cachedAt: integer('cached_at', { mode: 'timestamp' }).notNull(),
});

export const reviewThreads = sqliteTable(
  'review_threads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull().unique(),
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
    originalCommenterId: integer('original_commenter_id').references(
      () => users.id,
    ),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({ prIdx: index('thread_pr_idx').on(t.prId) }),
);

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull().unique(),
    threadId: integer('thread_id')
      .notNull()
      .references(() => reviewThreads.id),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    body: text('body').notNull(),
    diffHunk: text('diff_hunk'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({ threadIdx: index('rc_thread_idx').on(t.threadId) }),
);

export const prComments = sqliteTable(
  'pr_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull().unique(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({ prIdx: index('prc_pr_idx').on(t.prId) }),
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubNodeId: text('github_node_id').notNull().unique(),
    prId: integer('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    authorId: integer('author_id').references(() => users.id),
    state: text('state', {
      enum: ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'],
    }).notNull(),
    body: text('body'),
    submittedAt: integer('submitted_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({ prIdx: index('rv_pr_idx').on(t.prId) }),
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

// SHA -> string[] of changed paths. Cached forever (SHAs are immutable).
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
    dedupeKey: text('dedupe_key').notNull().unique(),
  },
  (t) => ({
    timeIdx: index('events_time_idx').on(t.occurredAt),
    repoTimeIdx: index('events_repo_time_idx').on(t.repoId, t.occurredAt),
    actorIdx: index('events_actor_idx').on(t.actorId),
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
