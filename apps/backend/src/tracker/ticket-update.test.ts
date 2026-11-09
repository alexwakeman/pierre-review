// ── THE TICKET UPDATE: the reader's press in the build tab's plan panel (./ticket-update.ts) ─────────
//
// Pinned through a real Fastify instance with an injected transport (no network):
//   1. NOT A PROXY — the status change's gate: a ticket Limn holds no row for, another account's,
//      or a non-Jira workspace is refused BEFORE Jira is called.
//   2. One PUT with the fields sent: the description as wiki markup, the criteria verbatim into the
//      field they were read from; the stored rows are marked due.
//   3. Criteria with no field of their own are refused before Jira is called.
//   4. Every refusal is a sentence Limn wrote.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TICKET_STATUS_NO_PERMISSION, TICKET_UPDATE_NO_CRITERIA_FIELD } from '@pierre-review/shared';
import { trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTicketUpdateRoutes } from './ticket-update.js';
import type { JiraTransport, RawResponse, TransportInit } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

const SITE = 'https://acme.atlassian.net';
const ident = (key: string): string => `jira:${SITE}#${key}`;
const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const workspaces = sqliteTable('workspaces', { id: integer('id').primaryKey(), accountId: integer('account_id').notNull() });
const sprintTickets = sqliteTable('sprint_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
  acFieldId: text('ac_field_id'),
  acFieldName: text('ac_field_name'),
});
const sprintRefTickets = sqliteTable('sprint_ref_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
});

let app: FastifyInstance;
let sqlite: Database.Database;
let account = 1;
const calls: Array<{ url: string; method: string; body: string | null }> = [];
let respond: (url: string, init?: TransportInit) => RawResponse = () => ({ status: 204, contentType: '', body: '' });
const transport: JiraTransport = async (url, _headers, _opts, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null });
  return respond(String(url), init);
};

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      'INSERT INTO workspaces VALUES (1,1),(2,1),(90,2);' +
      'CREATE TABLE sprint_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL, ac_field_id text, ac_field_name text);' +
      'CREATE TABLE sprint_ref_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL);',
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  sqlite.exec(migration('0144_workspace_tracker_notion.sql'));
  sqlite.exec(migration('0098_tracker_ticket_dates.sql'));
  sqlite.exec('ALTER TABLE tracker_tickets ADD blocked_by_json text; ALTER TABLE tracker_tickets ADD status_id text;');
  sqlite.exec('ALTER TABLE tracker_tickets ADD linked_at integer;'); // migration 0182
  const ctx = {
    db: drizzle(sqlite),
    host: {},
    accountIdOf: () => account,
    defaultWorkspaceId: async (a: number) => (a === 1 ? 1 : 90),
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { trackerTickets, workspaceTrackers, workspaces, sprintTickets, sprintRefTickets },
  } as unknown as TrackerContext;
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTicketUpdateRoutes(app, ctx, { transport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const ticketRow = (acct: number, ws: number, pr: number, key: string, acField: string | null): void => {
  sqlite
    .prepare(
      'INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, ' +
        "api_root, url, state, ac_field_id, ac_field_name, checked_at, next_check_at) VALUES (?,?,?,'jira',?,'title',0,?,'','ok',?,?,1700000000,1800000000)",
    )
    .run(acct, ws, pr, key, SITE, acField, acField == null ? null : 'Acceptance Criteria');
};

beforeEach(() => {
  calls.length = 0;
  account = 1;
  respond = () => ({ status: 204, contentType: '', body: '' });
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM sprint_tickets; DELETE FROM sprint_ref_tickets; DELETE FROM workspace_trackers;');
  sqlite.exec(
    "INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url, auth_email, auth_token) VALUES " +
      "(1, 2, 'jira', 'https://acme.atlassian.net', 'dev@acme.io', 'plain:secret')," +
      "(1, 1, 'github', NULL, NULL, NULL)," +
      "(2, 90, 'jira', 'https://acme.atlassian.net', 'x@other.io', 'plain:other')",
  );
  ticketRow(1, 2, 10, 'ENG-7', 'customfield_10042');
  ticketRow(1, 2, 12, 'ENG-8', null);
  ticketRow(2, 90, 91, 'ENG-99', 'customfield_1');
  sqlite.exec(`INSERT INTO sprint_tickets (account_id, workspace_id, ident, ac_field_id, ac_field_name) VALUES (1, 2, '${ident('ENG-50')}', 'customfield_7', 'DoD')`);
});

const update = (id: string, body: { description?: string | null; acceptanceCriteria?: string | null }, ws = 2) =>
  app.inject({
    method: 'POST',
    url: `/api/ticket-update?workspace=${ws}`,
    payload: { ident: id, description: body.description ?? null, acceptanceCriteria: body.acceptanceCriteria ?? null },
  });

describe('1. not a proxy', () => {
  it('refuses a ticket Limn holds no row for, another account’s, and a non-Jira workspace, before any Jira call', async () => {
    expect((await update(ident('ENG-1234'), { description: 'x' })).statusCode).toBe(404);
    expect((await update(ident('ENG-99'), { description: 'x' })).statusCode).toBe(404);
    const gh = await update(ident('ENG-7'), { description: 'x' }, 1);
    expect(gh.statusCode).toBe(400);
    expect(gh.json().message).toMatch(/works with Jira only/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty update', async () => {
    const res = await update(ident('ENG-7'), {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NothingToUpdate');
    expect(calls).toHaveLength(0);
  });
});

describe('2. one PUT with the fields sent', () => {
  it('writes the description as wiki markup and the criteria verbatim into their field, then marks the rows due', async () => {
    const res = await update(ident('ENG-7'), { description: '## Context\n- **one**', acceptanceCriteria: '# GIVEN a report' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updated: { description: true, acceptanceCriteria: true }, criteriaField: 'Acceptance Criteria' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${SITE}/rest/api/2/issue/ENG-7` });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ fields: { description: 'h2. Context\n* *one*', customfield_10042: '# GIVEN a report' } });
    const row = sqlite.prepare("SELECT next_check_at FROM tracker_tickets WHERE issue_key = 'ENG-7' AND account_id = 1").get() as { next_check_at: number };
    expect(row.next_check_at).toBe(0);
    // Another account's row is untouched.
    const other = sqlite.prepare("SELECT next_check_at FROM tracker_tickets WHERE account_id = 2").get() as { next_check_at: number };
    expect(other.next_check_at).toBe(1800000000);
  });

  it('a description alone touches no other field; a sprint row names the criteria field too', async () => {
    await update(ident('ENG-8'), { description: 'plain' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ fields: { description: 'plain' } });
    const res = await update(ident('ENG-50'), { acceptanceCriteria: 'AC' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ fields: { customfield_7: 'AC' } });
  });
});

describe('3. criteria with no field of their own', () => {
  it('are refused before Jira is called', async () => {
    const res = await update(ident('ENG-8'), { description: 'x', acceptanceCriteria: 'AC' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NoCriteriaField', message: TICKET_UPDATE_NO_CRITERIA_FIELD });
    expect(calls).toHaveLength(0);
  });
});

describe('4. refusals are Limn’s sentences', () => {
  it('403 → the token may not change it; 400 → Jira refused', async () => {
    respond = () => ({ status: 403, contentType: 'application/json', body: '{"errorMessages":["secret detail"]}' });
    const a = await update(ident('ENG-7'), { description: 'x' });
    expect(a.statusCode).toBe(502);
    expect(a.json().message).toBe(TICKET_STATUS_NO_PERMISSION);
    respond = () => ({ status: 400, contentType: 'application/json', body: '{"errors":{"customfield_10042":"bad"}}' });
    const b = await update(ident('ENG-7'), { acceptanceCriteria: 'x' });
    expect(b.json().message).toBe('Jira refused this change.');
    expect(JSON.stringify(b.json())).not.toMatch(/bad|secret/);
  });
});
