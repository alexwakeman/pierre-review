// ── THE ONE TRACKER WRITE: the Jira status transition the reader picks (./status-change.ts) ─────
//
// Pinned through a real Fastify instance with an injected transport (no network):
//   1. NOT A PROXY — a ticket Limn holds no row for, an ident on another site, another account's
//      ticket, or a non-Jira workspace is refused BEFORE Jira is called.
//   2. The transitions list keeps only what can be made without Jira's own form, and an empty list
//      asks the permission question once.
//   3. A pick POSTs the transition, re-reads the status and writes it to every stored row of the
//      ticket in THIS account (and no other); a failed re-read marks the PR rows due instead.
//   4. Every refusal is a sentence Limn wrote: 403 → "Your Jira token cannot change this issue."
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TICKET_STATUS_NO_PERMISSION } from '@pierre-review/shared';
import { trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTicketStatusRoutes, toTransitions } from './status-change.js';
import type { JiraTransport, RawResponse, TransportInit } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

const SITE = 'https://acme.atlassian.net';
const ident = (key: string, site = SITE): string => `jira:${site}#${key}`;

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
});
// Structural subsets of the sprint tables: only the columns the module reads and writes.
const sprintTickets = sqliteTable('sprint_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
  statusName: text('status_name'),
  statusCategory: text('status_category'),
  statusId: text('status_id'),
});
const sprintRefTickets = sqliteTable('sprint_ref_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
  statusName: text('status_name'),
  statusCategory: text('status_category'),
});

let app: FastifyInstance;
let sqlite: Database.Database;
let account = 1;
const calls: Array<{ url: string; method: string; body: string | null; auth: string | undefined }> = [];
let respond: (url: string, init?: TransportInit) => RawResponse = () => json({});
const transport: JiraTransport = async (url, headers, _opts, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null, auth: headers.authorization });
  return respond(String(url), init);
};
function json(body: unknown, status = 200): RawResponse {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      'INSERT INTO workspaces VALUES (1,1),(2,1),(90,2);' +
      'CREATE TABLE sprint_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL, status_name text, status_category text, status_id text);' +
      'CREATE TABLE sprint_ref_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL, status_name text, status_category text);',
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  sqlite.exec(migration('0144_workspace_tracker_notion.sql'));
  sqlite.exec(migration('0098_tracker_ticket_dates.sql'));
  sqlite.exec('ALTER TABLE tracker_tickets ADD blocked_by_json text; ALTER TABLE tracker_tickets ADD status_id text;');
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
  registerTicketStatusRoutes(app, ctx, { transport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const ticketRow = (acct: number, ws: number, pr: number, key: string, site = SITE): void => {
  sqlite
    .prepare(
      'INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, ' +
        "api_root, url, state, status_name, status_category, status_id, checked_at, next_check_at) VALUES (?,?,?,'jira',?,'title',0,?,'',?," +
        "'To Do','new','1',1700000000,1800000000)",
    )
    .run(acct, ws, pr, key, site, 'ok');
};

beforeEach(() => {
  calls.length = 0;
  account = 1;
  respond = () => json({});
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM sprint_tickets; DELETE FROM sprint_ref_tickets; DELETE FROM workspace_trackers;');
  sqlite.exec(
    "INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url, auth_email, auth_token) VALUES " +
      "(1, 2, 'jira', 'https://acme.atlassian.net', 'dev@acme.io', 'plain:secret')," +
      "(1, 1, 'github', NULL, NULL, NULL)," +
      "(2, 90, 'jira', 'https://acme.atlassian.net', 'x@other.io', 'plain:other')",
  );
  ticketRow(1, 2, 10, 'ENG-7');
  ticketRow(1, 1, 11, 'ENG-7'); // the same ticket on a PR in another of this account's workspaces
  ticketRow(2, 90, 90, 'ENG-7'); // another account holds the same key
  ticketRow(2, 90, 91, 'ENG-99');
  sqlite.exec(
    `INSERT INTO sprint_tickets (account_id, workspace_id, ident, status_name, status_category, status_id) VALUES ` +
      `(1, 2, '${ident('ENG-7')}', 'To Do', 'new', '1'), (1, 2, '${ident('ENG-50')}', 'To Do', 'new', '1'), ` +
      `(2, 90, '${ident('ENG-7')}', 'To Do', 'new', '1')`,
  );
  sqlite.exec(`INSERT INTO sprint_ref_tickets (account_id, workspace_id, ident, status_name, status_category) VALUES (1, 2, '${ident('ENG-7')}', 'To Do', 'new')`);
});

const TRANSITIONS = {
  transitions: [
    { id: '21', name: 'Start progress', to: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Done', to: { id: '10001', name: 'Done', statusCategory: { key: 'done' } } },
    {
      id: '41',
      name: 'Won’t do',
      to: { id: '10002', name: 'Won’t do', statusCategory: { key: 'done' } },
      fields: { resolution: { required: true, hasDefaultValue: false } },
    },
    { id: '51', name: 'Blocked', isAvailable: false, to: { id: '7', name: 'Blocked', statusCategory: { key: 'indeterminate' } } },
  ],
};

const listFor = (id: string, ws = 2) =>
  app.inject({ method: 'GET', url: `/api/ticket-status/transitions?workspace=${ws}&ident=${encodeURIComponent(id)}` });
const change = (id: string, transitionId: string, ws = 2) =>
  app.inject({ method: 'POST', url: `/api/ticket-status?workspace=${ws}`, payload: { ident: id, transitionId } });
const statuses = (table: string, where = ''): Array<Record<string, unknown>> =>
  sqlite.prepare(`SELECT * FROM ${table} ${where} ORDER BY id`).all() as Array<Record<string, unknown>>;

describe('toTransitions', () => {
  it('keeps what can be made without Jira’s form, in Jira’s order', () => {
    expect(toTransitions(TRANSITIONS)).toEqual([
      { id: '21', name: 'Start progress', to: { name: 'In Progress', category: 'indeterminate' } },
      { id: '31', name: 'Done', to: { name: 'Done', category: 'done' } },
    ]);
    expect(toTransitions(null)).toEqual([]);
    expect(toTransitions({ transitions: [{ id: 'x y', to: { name: 'A' } }, { id: '1' }] })).toEqual([]);
  });
});

describe('1. not a proxy', () => {
  it('refuses a ticket Limn holds no row for, before any Jira call', async () => {
    const res = await listFor(ident('ENG-1234'));
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
    // Another account's ticket is not held here either.
    expect((await change(ident('ENG-99'), '21')).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('refuses an ident on another site, and a workspace whose tracker is not Jira', async () => {
    expect((await listFor(ident('ENG-7', 'https://evil.example'))).statusCode).toBe(404);
    expect((await listFor('not an ident')).statusCode).toBe(404);
    expect((await listFor(ident('ENG-7'), 1)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('a sprint-only ticket in this workspace is held', async () => {
    respond = () => json(TRANSITIONS);
    expect((await listFor(ident('ENG-50'))).statusCode).toBe(200);
    expect(calls[0]?.url).toBe(`${SITE}/rest/api/2/issue/ENG-50/transitions?expand=transitions.fields`);
  });
});

describe('2. the transitions list', () => {
  it('answers Jira’s allowed transitions with the saved credential', async () => {
    respond = () => json(TRANSITIONS);
    const res = await listFor(ident('ENG-7'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspaceId: 2, ident: ident('ENG-7'), canTransition: null });
    expect(res.json().transitions.map((t: { id: string }) => t.id)).toEqual(['21', '31']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('dev@acme.io:secret').toString('base64')}`);
    expect(res.body).not.toContain('secret');
  });

  it('an empty list asks the permission question once', async () => {
    respond = (url) =>
      url.includes('mypermissions') ? json({ permissions: { TRANSITION_ISSUES: { havePermission: false } } }) : json({ transitions: [] });
    const res = await listFor(ident('ENG-7'));
    expect(res.json()).toMatchObject({ transitions: [], canTransition: false });
    expect(calls.map((c) => c.url)).toEqual([
      `${SITE}/rest/api/2/issue/ENG-7/transitions?expand=transitions.fields`,
      `${SITE}/rest/api/2/mypermissions?issueKey=ENG-7&permissions=TRANSITION_ISSUES`,
    ]);
  });

  it('a 403 reads as the token’s permission, in our own words', async () => {
    respond = () => ({ status: 403, contentType: 'application/json', body: '{"errorMessages":["leak me"]}' });
    const res = await listFor(ident('ENG-7'));
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe(TICKET_STATUS_NO_PERMISSION);
    expect(res.body).not.toContain('leak me');
  });
});

describe('3. the change', () => {
  it('POSTs the transition, re-reads the status and settles every stored row of this account', async () => {
    respond = (_url, init) =>
      init?.method === 'POST'
        ? { status: 204, contentType: '', body: '' }
        : json({ fields: { status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } } } });
    const res = await change(ident('ENG-7'), '21');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: 2, ident: ident('ENG-7'), status: { name: 'In Progress', category: 'indeterminate' } });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${SITE}/rest/api/2/issue/ENG-7/transitions`, body: '{"transition":{"id":"21"}}' });
    expect(calls[1]?.url).toBe(`${SITE}/rest/api/2/issue/ENG-7?fields=status`);

    const mine = statuses('tracker_tickets', 'WHERE account_id = 1');
    expect(mine.map((r) => [r.status_name, r.status_category, r.status_id])).toEqual([
      ['In Progress', 'indeterminate', '3'],
      ['In Progress', 'indeterminate', '3'],
    ]);
    // Another account's rows are untouched.
    expect(statuses('tracker_tickets', 'WHERE account_id = 2').every((r) => r.status_name === 'To Do')).toBe(true);
    expect(statuses('sprint_tickets').map((r) => [r.account_id, r.ident, r.status_name])).toEqual([
      [1, ident('ENG-7'), 'In Progress'],
      [1, ident('ENG-50'), 'To Do'],
      [2, ident('ENG-7'), 'To Do'],
    ]);
    expect(statuses('sprint_ref_tickets')[0]?.status_name).toBe('In Progress');
  });

  it('a failed re-read answers status null and marks the PR rows due', async () => {
    respond = (_url, init) =>
      init?.method === 'POST' ? { status: 204, contentType: '', body: '' } : { status: 500, contentType: 'text/html', body: '' };
    const res = await change(ident('ENG-7'), '21');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBeNull();
    const mine = statuses('tracker_tickets', 'WHERE account_id = 1');
    expect(mine.every((r) => r.status_name === 'To Do' && r.next_check_at === 0)).toBe(true);
    expect(statuses('tracker_tickets', 'WHERE account_id = 2').every((r) => r.next_check_at !== 0)).toBe(true);
  });

  it('a refusal stores nothing and says so in one line', async () => {
    respond = () => ({ status: 400, contentType: 'application/json', body: '{"errorMessages":["x"]}' });
    const refused = await change(ident('ENG-7'), '41');
    expect(refused.statusCode).toBe(502);
    expect(refused.json().message).toBe('Jira refused this change.');
    respond = () => ({ status: 403, contentType: 'application/json', body: '{}' });
    expect((await change(ident('ENG-7'), '21')).json().message).toBe(TICKET_STATUS_NO_PERMISSION);
    expect(calls).toHaveLength(2);
    expect(statuses('tracker_tickets').every((r) => r.status_name === 'To Do')).toBe(true);
  });

  it('refuses a malformed transition id at the schema', async () => {
    expect((await change(ident('ENG-7'), '../x')).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
