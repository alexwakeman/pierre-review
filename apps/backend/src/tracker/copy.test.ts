// "Copy from another workspace" (tracker/copy.ts; docs/TRACKERS.md § Copying a tracker), through a
// real Fastify instance:
//
//   1. Only the account's OTHER workspaces with a tracker SET UP are offered.
//   2. The copy carries the whole setup, the token in its STORED (sealed) form — never on the wire.
//   3. Another account's workspace id is a 404, in the path AND in the body.
//   4. Replacing a set-up tracker needs `replace: true`.
//   5. The per-issue-type field choices (criteria and open points) replace the target's, and its
//      stored tickets re-derive.
//
//   ./apps/backend/node_modules/.bin/vitest run apps/backend/src/tracker/copy.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jiraAcFields, trackerOpenPointsFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTrackerRoutes } from './routes.js';
import { resetTrackerWorker } from './worker.js';
import type { TrackerContext } from './context.js';

const ACCOUNT = 1;
const SRC = 2; // Platform — Jira, token
const DST = 3; // Mobile — nothing yet
const BARE = 4; // Web — a provider with no base URL: not set up
const FOREIGN = 90; // account 2
const TOKEN = 'ATATT3xFfGF0-super-secret-token';
const SITE = 'https://acme.atlassian.net';

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name'),
  isDefault: integer('is_default').notNull(),
});

const host = {
  version: 'test',
  sealSecret: (p: string) => `enc(${Buffer.from(p).toString('hex')})`,
  openSecret: (s: string) => Buffer.from(/^enc\((.*)\)$/.exec(s)?.[1] ?? '', 'hex').toString('utf8'),
};

let app: FastifyInstance;
let sqlite: Database.Database;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(3,1,'Mobile',0),(4,1,'Web',0),(90,2,'Other',1);",
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  sqlite.exec(migration('0144_workspace_tracker_notion.sql'));
  sqlite.exec(migration('0098_tracker_ticket_dates.sql'));
  sqlite.exec('ALTER TABLE tracker_tickets ADD blocked_by_json text; ALTER TABLE tracker_tickets ADD status_id text;');
  // The open-points choices table (migration 0171's first two statements; the third alters claude_reviews).
  for (const stmt of migration('0171_open_points.sql').split('--> statement-breakpoint').slice(0, 2)) sqlite.exec(stmt);

  const ctx = {
    db: drizzle(sqlite),
    host,
    accountIdOf: () => ACCOUNT,
    defaultWorkspaceId: async () => 1,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { trackerTickets, jiraAcFields, trackerOpenPointsFields, workspaceTrackers, workspaces: coreWorkspaces },
  } as unknown as TrackerContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const put = (ws: number, body: unknown) =>
  app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
const sources = (ws: number) => app.inject({ method: 'GET', url: `/api/workspaces/${ws}/tracker/copy-sources` });
const copy = (ws: number, body: unknown) =>
  app.inject({ method: 'POST', url: `/api/workspaces/${ws}/tracker/copy`, payload: body as object });
const storedToken = (ws: number): string | null =>
  (sqlite.prepare('SELECT auth_token FROM workspace_trackers WHERE account_id = ? AND workspace_id = ?').get(ACCOUNT, ws) as
    | { auth_token: string | null }
    | undefined)?.auth_token ?? null;

beforeEach(async () => {
  resetTrackerWorker();
  sqlite.exec(
    'DELETE FROM workspace_trackers; DELETE FROM pro_jira_ac_fields; DELETE FROM tracker_tickets; DELETE FROM tracker_open_points_fields;',
  );
  // The source: Jira, ENG + OPS keys, title only, email + token.
  const src = await put(SRC, {
    issue: { provider: 'jira', baseUrl: SITE, projectKeys: ['ENG', 'OPS'], matchScope: 'title' },
    jira: { email: 'dev@acme.io', token: TOKEN },
  });
  expect(src.statusCode).toBe(200);
  // A provider saved with no base URL is not set up, so it is never offered.
  expect((await put(BARE, { issue: { provider: 'jira', baseUrl: null } })).statusCode).toBe(200);
  // Another account's workspace, set up — must never be listed or copied.
  sqlite
    .prepare("INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url, auth_token) VALUES (2, 90, 'jira', ?, 'plain:x')")
    .run(SITE);
});

describe('copy-sources', () => {
  it('lists only the account’s OTHER workspaces with a tracker set up, and never the token', async () => {
    const res = await sources(DST);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspaceId: DST,
      sources: [{ workspaceId: SRC, name: 'Platform', provider: 'jira', baseUrl: SITE, hasToken: true }],
    });
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain('enc(');
    // The current workspace is never its own source.
    expect((await sources(SRC)).json().sources).toEqual([]);
  });

  it('a foreign workspace id is a 404', async () => {
    expect((await sources(FOREIGN)).statusCode).toBe(404);
  });
});

describe('copy', () => {
  it('copies the whole setup and the token in its stored form; the token never reaches the wire', async () => {
    const res = await copy(DST, { fromWorkspaceId: SRC });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain('enc(');
    const body = res.json();
    expect(body.workspaceId).toBe(DST);
    expect(body.issue).toEqual({ provider: 'jira', baseUrl: SITE, projectKeys: ['ENG', 'OPS'], matchScope: 'title' });
    expect(body.jira).toEqual({ email: 'dev@acme.io', hasToken: true });
    expect(body.providerChosen).toBe(true);
    // Sealed stays sealed: the very same stored value, never opened and re-typed.
    expect(storedToken(DST)).toBe(storedToken(SRC));
    expect(storedToken(DST)?.startsWith('sealed:v1:')).toBe(true);
    // The source is untouched.
    expect(storedToken(SRC)).not.toBeNull();
  });

  it('refuses another account’s workspace, in the path and in the body', async () => {
    expect((await copy(FOREIGN, { fromWorkspaceId: SRC })).statusCode).toBe(404);
    const res = await copy(DST, { fromWorkspaceId: FOREIGN });
    expect(res.statusCode).toBe(404);
    expect(storedToken(DST)).toBeNull();
    // Nothing of account 2's row was written for account 1.
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_trackers WHERE account_id = 1 AND workspace_id = 3').get(),
    ).toEqual({ n: 0 });
  });

  it('refuses a source with no tracker set up, and the same workspace', async () => {
    expect((await copy(DST, { fromWorkspaceId: BARE })).json().error).toBe('NoTracker');
    expect((await copy(DST, { fromWorkspaceId: 1 })).json().error).toBe('NoTracker');
    expect((await copy(SRC, { fromWorkspaceId: SRC })).json().error).toBe('SameWorkspace');
  });

  it('replacing a set-up tracker needs replace: true', async () => {
    await put(DST, { issue: { provider: 'linear', baseUrl: 'https://linear.app/acme' } });
    const refused = await copy(DST, { fromWorkspaceId: SRC });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('TrackerExists');
    const done = await copy(DST, { fromWorkspaceId: SRC, replace: true });
    expect(done.statusCode).toBe(200);
    expect(done.json().issue.provider).toBe('jira');
  });

  it('the field choices per issue type replace the target’s, and its stored tickets re-derive', async () => {
    const now = Math.floor(Date.now() / 1000);
    const ins = sqlite.prepare(
      'INSERT INTO pro_jira_ac_fields (account_id, workspace_id, api_root, issue_type_id, field_id, field_name, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
    );
    ins.run(SRC, SITE, '10001', 'customfield_100', 'Acceptance', now);
    ins.run(DST, SITE, '10002', 'customfield_200', 'Old choice', now);
    // A stored Story ticket in the target, with both candidate fields.
    sqlite
      .prepare(
        "INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, issue_key, detected_from, detect_order, api_root, url, state, issue_type_id, candidates_json, checked_at, next_check_at) VALUES (1, 3, 1, 'ENG-1', 'title', 0, ?, 'u', 'ok', '10001', ?, ?, ?)",
      )
      .run(
        SITE,
        JSON.stringify([
          { id: 'customfield_100', name: 'Acceptance', text: 'Given a user' },
          { id: 'customfield_300', name: 'Notes', text: 'Other' },
        ]),
        now,
        now + 3600,
      );
    expect((await copy(DST, { fromWorkspaceId: SRC })).statusCode).toBe(200);
    expect(
      sqlite.prepare('SELECT issue_type_id, field_id FROM pro_jira_ac_fields WHERE workspace_id = 3 ORDER BY issue_type_id').all(),
    ).toEqual([{ issue_type_id: '10001', field_id: 'customfield_100' }]);
    const t = sqlite.prepare("SELECT ac_field_id, next_check_at FROM tracker_tickets WHERE issue_key = 'ENG-1'").get() as {
      ac_field_id: string;
      next_check_at: number;
    };
    expect(t.ac_field_id).toBe('customfield_100');
    expect(t.next_check_at).toBe(0); // due again
  });

  it('the open-points choices per issue type replace the target’s', async () => {
    const now = Math.floor(Date.now() / 1000);
    const ins = sqlite.prepare(
      'INSERT INTO tracker_open_points_fields (account_id, workspace_id, api_root, issue_type_id, mode, field_id, field_name, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
    );
    ins.run(SRC, SITE, '10001', 'field', 'customfield_400', 'Open Points', now);
    ins.run(SRC, SITE, '10003', 'none', null, null, now);
    ins.run(DST, SITE, '10002', 'none', null, null, now);
    expect((await copy(DST, { fromWorkspaceId: SRC })).statusCode).toBe(200);
    expect(
      sqlite
        .prepare('SELECT issue_type_id, mode, field_id, field_name FROM tracker_open_points_fields WHERE workspace_id = 3 ORDER BY issue_type_id')
        .all(),
    ).toEqual([
      { issue_type_id: '10001', mode: 'field', field_id: 'customfield_400', field_name: 'Open Points' },
      { issue_type_id: '10003', mode: 'none', field_id: null, field_name: null },
    ]);
    // The source keeps its own.
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM tracker_open_points_fields WHERE workspace_id = 2').get()).toEqual({ n: 2 });
  });
});
