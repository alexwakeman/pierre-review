// The platform's typed access to ITS OWN tables over the host connection.
//
// All reads/writes go through ctx.db / ctx.runTransaction with `.execute()`.
// Callers: `const pro = proSchemaFor(); ctx.db.select().from(pro.repoDigests)…execute()`.
import * as rdSqlite from './activity-digest/schema.sqlite.js';
// ai_pr_analyses only — ai_fixes moved to core with the agentic fixer (migration 0074).
import * as afSqlite from './ai-fix/schema.sqlite.js';
import * as inSqlite from './insights/schema.sqlite.js';
// Period-over-period reporting keeps its OWN twins beside the insights ones: those four tables are
// regenerable scope_key-keyed caches (plugin 0020 deletes them wholesale), this one is a keyed
// history that has to survive exactly that kind of sweep.
import * as periodSqlite from './insights/period-schema.sqlite.js';
import * as settingsSqlite from './settings/schema.sqlite.js';
import * as assessSqlite from './review-assess/schema.sqlite.js';
import * as addrSqlite from './resolution-check/schema.sqlite.js';
import * as botThemesSqlite from './bot-themes/schema.sqlite.js';
import * as synthesisSqlite from './synthesis/schema.sqlite.js';
// The work-plan narration cache — the pro_synthesis family (regenerable, scope_key-keyed, no
// pr_id grain), NOT the period keyed-history family.
import * as workPlanSqlite from './work-plan/schema.sqlite.js';
// The Chronology pointers cache — the same regenerable scope_key family as the work plan.
import * as flowPointersSqlite from './flow-pointers/schema.sqlite.js';
// The Slack event signals' sent markers (plugin migration 0040).
import * as slackSqlite from './slack/schema.sqlite.js';
import * as humanThemesSqlite from './human-themes/schema.sqlite.js';
import * as annotSqlite from './annotations/schema.sqlite.js';
import * as advisorSqlite from './advisor/schema.sqlite.js';
// (No Jira tables: the stored tickets and the acceptance-criteria field choice moved to CORE with
// the issue tracker at apiVersion 23 — core `tracker_tickets` / `pro_jira_ac_fields`.)

// The full platform schema is the union of every feature's tables.
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

export type ProSchema = typeof sqliteSchema;

export function proSchemaFor(): ProSchema {
  return sqliteSchema;
}
