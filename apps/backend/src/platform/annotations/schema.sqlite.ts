// Platform-owned SQLite schema for the comment-ANNOTATIONS platform. Migrated by the host's
// runPluginMigrations via ../migrations/0017_pr_comment_annotations.sql; this module is ONLY the
// typed query surface. accountId is denormalized onto every row (the plugin's verify:isolation
// guarantee); every query filters it.
//
// This GENERALISES `comment_assessments` (0011) and sits alongside `addressed_checks` (0012):
// one table for any AI judgement ABOUT a review comment, discriminated by (kind, targetKind)
// rather than one table + route + hook per judgement type. The 0017 migration backfills the
// existing comment_assessments rows in as kind='validity'/targetKind='review_comment';
// comment_assessments is deliberately LEFT IN PLACE (readable, no longer written).
// ⚠ LIVE FOR ONE KIND ONLY: `impact` (the blast-radius impact note, targetKind 'pull_request').
// The comment kinds 'addressed' | 'validity' | 'simplify' (the removed "Check review") are DORMANT
// rows: never written, skipped on read, still erased with the account. Never drop them.
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// One stored judgement about one comment/thread.
//   kind        — shared AnnotationKind: 'addressed' | 'validity' | 'simplify'
//   targetKind  — shared AnnotationTargetKind: 'thread' | 'review_comment' | 'pr_comment'
//   targetId    — that entity's own primary key (reviewThreads.id / reviewComments.id /
//                 prComments.id). NOT globally unique on its own, which is why the unique
//                 index carries targetKind.
// One row per (accountId, kind, targetKind, targetId); upserted on regenerate, $0-on-unchanged
// via payloadHash. `verdict` is kind-specific free text; `confidence` is 0-100 or null when the
// kind produces none. Staleness is computed on READ (compare against the target's latest
// activity), never stored — a stored flag would need invalidating from the sync path.
export const prCommentAnnotations = sqliteTable(
  'pr_comment_annotations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    kind: text('kind').notNull(), // AnnotationKind
    targetKind: text('target_kind').notNull(), // AnnotationTargetKind
    targetId: integer('target_id').notNull(),
    verdict: text('verdict'),
    confidence: integer('confidence'), // 0-100, nullable
    body: text('body').notNull(), // Markdown rationale
    payloadHash: text('payload_hash').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // The grounding diff the judgement was based on, as JSON (written only by the removed `addressed` kind; DORMANT):
    // {v, baseSha, headSha, path, outcome, patch, previousPath, note}. `addressed` thread rows
    // only — every other kind stores null. Stored rather than re-derived because the panel is a
    // CACHED read: re-fetching the compare to render a stored verdict would put a GitHub call on
    // every PR open, which is the exact trap the payload hash is designed to avoid.
    // Migration 0022.
    evidence: text('evidence'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    targetUx: uniqueIndex('pca_account_kind_target').on(
      t.accountId,
      t.kind,
      t.targetKind,
      t.targetId,
    ),
    // The PR-detail read: every annotation of a kind for one PR.
    prKindIdx: index('pca_account_pr_kind').on(t.accountId, t.prId, t.kind),
  }),
);
