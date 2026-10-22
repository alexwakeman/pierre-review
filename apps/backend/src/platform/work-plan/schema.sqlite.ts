// Plugin-owned SQLite schema (local mode) for the WORK PLAN cache — the credit-metered Haiku
// narration of the Activity feed's prioritised worklist ("what should I work on today", the panel
// directly under the daily-brief strip). Migrated by
// the host via ctx.registerMigrations (../../migrations/0028_work_plan.sql); this module is ONLY
// the typed query surface.
//
// ── WHAT IS AND IS NOT IN THIS ROW, WHICH IS THE FEATURE'S SAFETY PROPERTY ────────────────────
// The WORKLIST is not stored here and never will be. `getWorkPlan` (core, db/work-plan.ts) folds
// it fresh from the same `/api/attention` cards the daily brief counts, so the panel and the strip
// above it are ONE population by construction rather than by hope. What this table caches is the
// only part that costs money and cannot be recomputed: the model's NARRATION of that worklist —
// a headline, one `why` sentence per foregrounded item, and a `parked` line.
//
// That division is why `output` holds no figures, ids or links of its own: every number, prId,
// repoId, threadId, githubUrl and rank on screen comes from the live fold, and the stored steps
// join to it by `WorkPlanItem.id` (`wp:<kind>:<prId|repoId[:threadId]>` — namespaced, stable
// across ticks, and deliberately time-free so it survives as a join key). A step whose id no
// longer exists in the evidence simply renders nothing; nothing stored here can put an item, or a
// figure, on the board by itself.
//
// One row per (account, SCOPE). `scopeKey` is `ws:<workspaceId>`, plus a `|r:<sorted csv>` tail
// ONLY when the request narrowed to a subset of the workspace's repos — the same "absent slot is
// absent, not spelled" discipline the other scope-keyed caches use, so the unnarrowed workspace
// and a narrowing that happens to cover every repo do not mint two spellings of one plan. The
// declared unique below makes a regenerate OVERWRITE rather than accrete.
//
// `payloadHash` is the $0-on-unchanged gate (../work-plan/hash.ts): computed over the evidence's
// stable, code-derived shape. ⚠ TWO FIELDS OF `WorkPlanEvidence` MUST NEVER ENTER IT —
// `generatedAt` (an ISO stamp of the fold itself) and every `facts.ageHours` (derived from `now`),
// because either one moves on a timer and would re-bill a dormant workspace on every poll. That
// is the standing "a hydrated or derived value must never enter a payload hash" rule, and this
// feature is unusually exposed to it: the free GET recomputes the hash from a FRESH fold to report
// `stale`, so a clock-derived field makes the GET and the POST disagree forever — every plan
// permanently stale, re-billed on every click.
//
// `itemCount` is a REAL COLUMN rather than a fact buried in the blob, for the same reason
// pro_synthesis stores its coverage counts: the panel discloses "narrated N of M", and a capped
// list that cannot say what it left out is the defect the disclosure exists to prevent. It is the
// count of items the plan was generated AGAINST (the capped evidence list, WORK_PLAN_ITEM_CAP),
// not the number of steps the model chose to write.
//
// No cost columns: spend goes to the shared ai_usage ledger via ctx.recordAiUsage, the same place
// every other summary feature records it.
//
// A REGENERABLE scope-keyed cache (the pro_synthesis / bot_theme_reports family, NOT the
// workspace_period_reports keyed-history family): listed in retention.ts's eraseProByAccountId,
// deliberately absent from pruneProByPrIds (there is no pr_id grain to prune by — the row spans a
// whole workspace, and staleness via the payload hash, not deletion, is how it ages), and seeded
// in test/isolation.test.ts.
//
// ⚠ Every `onConflictDoUpdate` on this table must target exactly [accountId, scopeKey] — the
// declared unique below. A stale conflict target TYPE-CHECKS perfectly and raises "no unique or
// exclusion constraint matching the ON CONFLICT specification" at runtime, in both dialects, only
// when a row is actually written (the 0042/0045 lesson).
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const proWorkPlans = sqliteTable(
  'pro_work_plans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    // The validated StoredWorkPlan as JSON TEXT — TEXT in BOTH dialects, never jsonb, never
    // drizzle mode:'json', so the twins stay structurally identical and one serializer owns the
    // blob. Model-authored prose only: headline, steps[{id, why}], parked, droppedIds.
    output: text('output').notNull(),
    model: text('model').notNull(),
    itemCount: integer('item_count').notNull(),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('pro_work_plans_account_scope').on(t.accountId, t.scopeKey),
  }),
);
