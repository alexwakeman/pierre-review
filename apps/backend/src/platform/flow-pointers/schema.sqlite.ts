// Plugin-owned SQLite schema for the CHRONOLOGY POINTERS cache — the credit-metered Haiku
// narration beside Reports → Chronology. Migrated via ../../migrations/0034_flow_pointers.sql.
//
// ── WHAT IS AND IS NOT IN THIS ROW ──────────────────────────────────────────────────────────
// The EVIDENCE is not stored: core `getFlowPointerEvidence` folds it fresh from the same pass the
// Chronology panel renders. This table caches only what costs money: the model's pointers, each a
// kind, a digit-free sentence and the PR ids it cites. The links a reader clicks are rebuilt from
// the LIVE fold on every read, so a cited PR that has left the window renders no link rather than
// one the cache remembered.
//
// One row per (account, SCOPE). `scopeKey` is `ws:<workspaceId>|d:<windowDays>` — each window is
// its own narration, because each is a different population. The declared unique makes a
// regenerate OVERWRITE rather than accrete.
//
// `payloadHash` is the $0-on-unchanged gate (./hash.ts). It folds the evidence's per-PR figures,
// which are computed from fixed timestamps; nothing derived from `now()` enters it.
//
// A REGENERABLE scope-keyed cache (the pro_work_plans family): listed in retention.ts's
// eraseProByAccountId, absent from pruneProByPrIds (the row spans a workspace, not a PR), and
// seeded in test/isolation.test.ts.
//
// ⚠ Every `onConflictDoUpdate` on this table targets exactly [accountId, scopeKey].
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const proFlowPointers = sqliteTable(
  'pro_flow_pointers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    // The validated pointers as JSON TEXT in both dialects (one serializer owns the blob).
    output: text('output').notNull(),
    model: text('model').notNull(),
    // How many measured pull requests the pointers were written over — disclosed on screen.
    prCount: integer('pr_count').notNull(),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('pro_flow_pointers_account_scope').on(t.accountId, t.scopeKey),
  }),
);
