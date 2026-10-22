// The plugin's typed access to ITS OWN tables over the host connection. Mirrors
// the host's client.ts trick: the active table VALUES are the runtime-correct
// dialect (sqlite-core in local, pg-core in cloud), but they are TYPED as the pg
// twin so only the portable terminals compile (`await q.execute()` /
// `.returning().execute()` / onConflictDoUpdate) — a stray .get()/.all()/.run()
// is a compile error, exactly like core.
//
// All reads/writes go through ctx.db / ctx.runTransaction with `.execute()`.
// Callers: `const pro = proSchemaFor(ctx.isPg); ctx.db.select().from(pro.repoDigests)…execute()`.
// repo_digests (the review_learnings table that shared its file moved to core, migration 0074).
import * as rdSqlite from './activity-digest/schema.sqlite.js';
import * as rdPg from './activity-digest/schema.pg.js';
// ai_pr_analyses only — ai_fixes moved to core with the agentic fixer (migration 0074).
import * as afSqlite from './ai-fix/schema.sqlite.js';
import * as afPg from './ai-fix/schema.pg.js';
import * as inSqlite from './insights/schema.sqlite.js';
import * as inPg from './insights/schema.pg.js';
// Period-over-period reporting keeps its OWN twins beside the insights ones: those four tables are
// regenerable scope_key-keyed caches (plugin 0020 deletes them wholesale), this one is a keyed
// history that has to survive exactly that kind of sweep.
import * as periodSqlite from './insights/period-schema.sqlite.js';
import * as periodPg from './insights/period-schema.pg.js';
import * as settingsSqlite from './settings/schema.sqlite.js';
import * as settingsPg from './settings/schema.pg.js';
import * as assessSqlite from './review-assess/schema.sqlite.js';
import * as assessPg from './review-assess/schema.pg.js';
import * as addrSqlite from './resolution-check/schema.sqlite.js';
import * as addrPg from './resolution-check/schema.pg.js';
import * as botThemesSqlite from './bot-themes/schema.sqlite.js';
import * as botThemesPg from './bot-themes/schema.pg.js';
import * as synthesisSqlite from './synthesis/schema.sqlite.js';
import * as synthesisPg from './synthesis/schema.pg.js';
// The work-plan narration cache — the pro_synthesis family (regenerable, scope_key-keyed, no
// pr_id grain), NOT the period keyed-history family.
import * as workPlanSqlite from './work-plan/schema.sqlite.js';
import * as workPlanPg from './work-plan/schema.pg.js';
// The Chronology pointers cache — the same regenerable scope_key family as the work plan.
import * as flowPointersSqlite from './flow-pointers/schema.sqlite.js';
import * as flowPointersPg from './flow-pointers/schema.pg.js';
// The Slack event signals' sent markers (plugin migration 0040).
import * as slackSqlite from './slack/schema.sqlite.js';
import * as slackPg from './slack/schema.pg.js';
import * as humanThemesSqlite from './human-themes/schema.sqlite.js';
import * as humanThemesPg from './human-themes/schema.pg.js';
import * as annotSqlite from './annotations/schema.sqlite.js';
import * as annotPg from './annotations/schema.pg.js';
import * as advisorSqlite from './advisor/schema.sqlite.js';
import * as advisorPg from './advisor/schema.pg.js';
// (No Jira tables: the stored tickets and the acceptance-criteria field choice moved to CORE with
// the issue tracker at apiVersion 23 — core `tracker_tickets` / `pro_jira_ac_fields`.)

// The full plugin schema is the union of every feature's tables. The pg twins define
// the TYPE surface; the active values are dialect-selected at runtime and cast to it.
const pgSchema = {
  ...rdPg,
  ...afPg,
  ...inPg,
  ...periodPg,
  ...settingsPg,
  ...assessPg,
  ...addrPg,
  ...botThemesPg,
  ...synthesisPg,
  ...workPlanPg,
  ...flowPointersPg,
  ...slackPg,
  ...humanThemesPg,
  ...annotPg,
  ...advisorPg,
};
const sqliteSchema = {
  ...rdSqlite,
  ...afSqlite,
  ...inSqlite,
  ...periodSqlite,
  ...settingsSqlite,
  ...assessSqlite,
  ...addrSqlite,
  ...botThemesSqlite,
  ...synthesisSqlite,
  ...workPlanSqlite,
  ...flowPointersSqlite,
  ...slackSqlite,
  ...humanThemesSqlite,
  ...annotSqlite,
  ...advisorSqlite,
};

export type ProSchema = typeof pgSchema;

export function proSchemaFor(isPg: boolean): ProSchema {
  return (isPg ? pgSchema : sqliteSchema) as unknown as ProSchema;
}
