// ── THE BODY SCHEMAS ADMIT WHAT THE STORE CAN WRITE ────────────────────────────────────────────
//
// Both settings PUTs are `additionalProperties: false` and ajv runs with `removeAdditional`, so a
// field the schema forgets is **SILENTLY STRIPPED and the request still answers 200** — a setting
// that never saves, with no error anywhere and nothing in a log. `settings/store.ts`'s own header
// calls listing the property "step 1 of an 8-step checklist" for exactly this reason, and
// `comparisonMode`, `reportModel`, `startDate` and `matchScope` have each nearly shipped that way.
//
// Every other suite in this package calls the STORE directly, which cannot see the schema at all.
// This one goes through a real Fastify instance so the ajv pass is in the path — the only way the
// strip is observable.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/settings-route-schema.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import * as settingsSchema from '../settings/schema.sqlite.js';
import { registerSettingsRoutes } from '../settings/routes.js';
import type { ProContext } from '../contract.js';

const ACCOUNT = 1;
const WORKSPACE = 2;

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');

// The CORE table the route's scope resolver reads through `ctx.schema` — a stub for a table core
// owns, not a second definition of it (`ctx.schema` is `Record<string, any>` in the contract, so a
// missing entry is not a compile error: it is the 500 this stub exists to prevent).
const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name'),
  isDefault: integer('is_default').notNull(),
});

let app: FastifyInstance;
let sqlite: Database.Database;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces (id, account_id, name, is_default) VALUES (1,1,'Default',1);" +
      "INSERT INTO workspaces (id, account_id, name, is_default) VALUES (2,1,'Platform',0);",
  );
  sqlite.exec(
    'CREATE TABLE workspace_period_reports (id integer PRIMARY KEY AUTOINCREMENT, ' +
      'account_id integer NOT NULL, workspace_id integer NOT NULL, period_key text NOT NULL, ' +
      'model text NOT NULL, cadence_days integer NOT NULL, period_end integer);' +
      'CREATE UNIQUE INDEX wpr_account_ws_period_model ON workspace_period_reports ' +
      '(account_id, workspace_id, period_key, model);',
  );
  sqlite.exec(
    'CREATE TABLE pro_settings (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'comparison_mode text, report_model text, bot_slack_digest integer, bot_auto_resolve integer, ' +
      'bot_auto_resolve_days integer, bot_cost_json text, ' +
      // ⚠ THE STUB MUST CARRY EVERY COLUMN THE REPLAYED MIGRATIONS READ, not just the ones this
      // suite writes: 0031 SELECTs the three `issue_*` columns and 0032 SELECTs `comparison_mode`,
      // both JOINing core `workspaces`. A narrower stub throws on setup and skips the whole file.
      'issue_provider text, issue_base_url text, issue_project_keys text, ' +
      'created_at integer NOT NULL DEFAULT (unixepoch()), ' +
      'updated_at integer NOT NULL DEFAULT (unixepoch()));' +
      'CREATE UNIQUE INDEX pro_settings_account ON pro_settings (account_id);',
  );
  sqlite.exec(migration('0029_workspace_sprint_cadence.sql'));
  sqlite.exec(migration('0031_workspace_issue_tracker.sql'));
  sqlite.exec(migration('0032_workspace_comparison_mode.sql'));
  sqlite.exec(migration('0035_workspace_jira_api.sql'));
  sqlite.exec(migration('0036_workspace_auto_review.sql'));

  const ctx = {
    db: drizzle(sqlite, { schema: { ...settingsSchema } }),
    isPg: false,
    accountIdOf: () => ACCOUNT,
    queries: { defaultWorkspaceId: async () => WORKSPACE },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { workspaces: coreWorkspaces },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ProContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerSettingsRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const putWorkspace = async (body: unknown): Promise<Record<string, unknown>> => {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/pro/settings/workspace?workspace=${WORKSPACE}`,
    payload: body as object,
  });
  if (res.statusCode !== 200) throw new Error(`${res.statusCode}: ${res.body}`);
  return res.json() as Record<string, unknown>;
};

describe('PUT /api/pro/settings/workspace — the schema admits every writable field', () => {
  it('⚠ `comparisonMode` SURVIVES THE ajv PASS (plugin migration 0032)', async () => {
    // The whole point of this file. Omit it from the body schema and this PUT still answers 200
    // with the mode unchanged — indistinguishable, from the client, from a save that worked.
    const body = await putWorkspace({ comparisonMode: 'sprint' });
    expect(body.comparisonMode).toBe('sprint');
    // …and it round-trips on the GET, so the write reached storage rather than being echoed.
    const get = await app.inject({
      method: 'GET',
      url: `/api/pro/settings/workspace?workspace=${WORKSPACE}`,
    });
    expect((get.json() as { comparisonMode: string }).comparisonMode).toBe('sprint');
  });

  it('a mode-only patch is EXPRESSIBLE — the reason it is not inside `sprint`', async () => {
    // `sprint` declares `cadenceDays` REQUIRED so that clearing a cadence is always an explicit
    // ask. A mode nested in there could not be sent without also restating the cadence, and a
    // client that restated it wrongly would re-grid every stored period.
    await putWorkspace({ sprint: { cadenceDays: 14, startDate: '2026-08-03' } });
    const after = await putWorkspace({ comparisonMode: 'rolling_7' });
    expect(after.comparisonMode).toBe('rolling_7');
    expect(after.cadenceDays).toBe(14);
  });

  it('a cadence patch does not disturb the mode, and vice versa', async () => {
    await putWorkspace({ comparisonMode: 'sprint' });
    const after = await putWorkspace({ sprint: { cadenceDays: 7 } });
    expect(after.cadenceDays).toBe(7);
    expect(after.comparisonMode).toBe('sprint');
  });

  it('an invalid mode is REFUSED by the enum rather than stored', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/pro/settings/workspace?workspace=${WORKSPACE}`,
      payload: { comparisonMode: 'rolling_3' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/pro/settings/workspace — the retired auto-review section', () => {
  // Auto Claude review moved to core (`PUT /api/workspaces/:id/auto-review`). A stale client's
  // `autoReview` key is STRIPPED (additionalProperties: false) and the PUT still answers 200 with
  // no `autoReview` on the reply — never stored here as a promise nobody keeps.
  it('a stale `autoReview` is stripped, not stored, and the PUT still 200s', async () => {
    const body = await putWorkspace({ autoReview: { enabled: true } });
    expect(body.autoReview).toBeUndefined();
  });
});

describe('PUT /api/pro/settings — the retired account fields are stripped, not honoured', () => {
  it('⚠ A STALE `sprint` SECTION IS INERT AND STILL 200s', async () => {
    // Every field of that section is retired (0031 took the pair, 0032 the mode). ajv's
    // `removeAdditional` empties it; the request must succeed with nothing changed, and the read
    // must report nulls rather than the product default — a dormant grain must not answer.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/pro/settings',
      payload: { sprint: { comparisonMode: 'sprint', cadenceDays: 21 }, bots: { slackDigest: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sprint: Record<string, unknown>; bots: Record<string, unknown> };
    expect(body.sprint).toEqual({ cadenceDays: null, startDate: null, comparisonMode: null });
    expect(body.bots.slackDigest).toBe(false);
  });

  it('the LIVE account field still saves — so the assertion above is not vacuous', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/pro/settings',
      payload: { bots: { autoResolveDays: 21 } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bots: { autoResolveDays: number } }).bots.autoResolveDays).toBe(21);
  });
});
