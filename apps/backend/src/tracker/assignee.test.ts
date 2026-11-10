// ── A TRACKER WRITE: the assignee the reader picks (./assignee.ts) ──────────────────────────────────
//
// Pinned through a real Fastify instance with an injected transport and a fake GitHub (no network):
//   1. NOT A PROXY — a ticket Limn holds no row for, an ident on another site, another account's
//      ticket, and a Notion workspace are refused BEFORE the tracker is called.
//   2. The list: Jira's assignable users (people only), GitHub's assignable users, Linear's active
//      team members — sorted, and kept per workspace so reopening the picker makes no call.
//   3. A pick writes ONLY a person from that list (or nobody), reads the assignee back and settles
//      every stored row of the ticket in THIS account (and no other).
//   4. Every refusal is a sentence Limn wrote, never the tracker's body.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import {
  ASSIGNABLES_TTL_MS,
  __resetAssignablesCache,
  githubAssignMutation,
  jiraAssigneeBody,
  registerTicketAssigneeRoutes,
  toJiraAssignable,
} from './assignee.js';
import type { JiraTransport, RawResponse, TransportInit } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

const SITE = 'https://acme.atlassian.net';
const LINEAR = 'https://linear.app/acme';
const jira = (key: string, site = SITE): string => `jira:${site}#${key}`;
const GH_IDENT = 'github:https://github.com/acme/web#12';
const LINEAR_IDENT = `linear:${LINEAR}#ENG-5`;

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
});
const sprintTickets = sqliteTable('sprint_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
  assigneeName: text('assignee_name'),
  assigneeAvatarUrl: text('assignee_avatar_url'),
});
const sprintRefTickets = sqliteTable('sprint_ref_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
  assigneeName: text('assignee_name'),
  assigneeAvatarUrl: text('assignee_avatar_url'),
});

let app: FastifyInstance;
let sqlite: Database.Database;
let account = 1;
let clock = 1_000_000;
const calls: Array<{ url: string; method: string; body: string | null; auth: string | undefined }> = [];
let respond: (url: string, init?: TransportInit) => RawResponse = () => json({});
const transport: JiraTransport = async (url, headers, _opts, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null, auth: headers.authorization });
  return respond(String(url), init);
};
function json(body: unknown, status = 200): RawResponse {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}
const ghCalls: Array<{ accountId: number; query: string; variables: Record<string, unknown> }> = [];
let ghRespond: (query: string, variables: Record<string, unknown>) => { data: unknown; errors?: unknown } = () => ({ data: null });

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      'INSERT INTO workspaces VALUES (1,1),(2,1),(3,1),(4,1),(90,2);' +
      'CREATE TABLE sprint_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL, assignee_name text, assignee_avatar_url text);' +
      'CREATE TABLE sprint_ref_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL, assignee_name text, assignee_avatar_url text);',
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
    github: {
      graphql: async (accountId: number, query: string, variables: Record<string, unknown>) => {
        ghCalls.push({ accountId, query, variables });
        return ghRespond(query, variables);
      },
    },
  } as unknown as TrackerContext;
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTicketAssigneeRoutes(app, ctx, { transport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
  __resetAssignablesCache();
});

const ticketRow = (acct: number, ws: number, pr: number, provider: string, key: string, site: string): void => {
  sqlite
    .prepare(
      'INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, ' +
        "api_root, url, state, assignee_name, assignee_account_id, checked_at, next_check_at) VALUES (?,?,?,?,?,'title',0,?,'','ok'," +
        "'Old Owner','old',1700000000,1800000000)",
    )
    .run(acct, ws, pr, provider, key, site);
};

beforeEach(() => {
  calls.length = 0;
  ghCalls.length = 0;
  account = 1;
  clock = 1_000_000;
  __resetAssignablesCache(() => clock);
  respond = () => json({});
  ghRespond = () => ({ data: null });
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM sprint_tickets; DELETE FROM sprint_ref_tickets; DELETE FROM workspace_trackers;');
  sqlite.exec(
    'INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url, auth_email, auth_token) VALUES ' +
      "(1, 1, 'github', NULL, NULL, NULL)," +
      "(1, 2, 'jira', 'https://acme.atlassian.net', 'dev@acme.io', 'plain:secret')," +
      "(1, 3, 'linear', 'https://linear.app/acme', NULL, 'plain:lin_api_abcdefgh123')," +
      "(1, 4, 'notion', 'https://www.notion.so/0123456789abcdef0123456789abcdef', NULL, 'plain:ntn')," +
      "(2, 90, 'jira', 'https://acme.atlassian.net', 'x@other.io', 'plain:other')",
  );
  ticketRow(1, 2, 10, 'jira', 'ENG-7', SITE);
  ticketRow(1, 1, 11, 'jira', 'ENG-7', SITE); // the same ticket on a PR in another of this account's workspaces
  ticketRow(2, 90, 90, 'jira', 'ENG-7', SITE); // another account holds the same key
  ticketRow(2, 90, 91, 'jira', 'ENG-99', SITE);
  ticketRow(1, 1, 12, 'github', 'acme/web#12', 'https://github.com');
  ticketRow(1, 3, 13, 'linear', 'ENG-5', LINEAR);
  sqlite.exec(
    'INSERT INTO sprint_tickets (account_id, workspace_id, ident, assignee_name) VALUES ' +
      `(1, 2, '${jira('ENG-7')}', 'Old Owner'), (1, 2, '${jira('ENG-50')}', NULL), (2, 90, '${jira('ENG-7')}', 'Old Owner')`,
  );
  sqlite.exec(`INSERT INTO sprint_ref_tickets (account_id, workspace_id, ident, assignee_name) VALUES (1, 2, '${jira('ENG-7')}', 'Old Owner')`);
});

const JIRA_USERS = [
  { accountId: 'u-2', displayName: 'Zoe Ng', active: true, accountType: 'atlassian', avatarUrls: { '48x48': 'https://a.example/z.png' } },
  { accountId: 'u-1', displayName: 'Ada Lovelace', active: true, accountType: 'atlassian', emailAddress: 'ada@acme.io' },
  { accountId: 'bot', displayName: 'Automation for Jira', active: true, accountType: 'app' },
  { accountId: 'gone', displayName: 'Left Company', active: false, accountType: 'atlassian' },
];
/** Jira: one page of users, then an empty one. */
const jiraUsers = (url: string): RawResponse => json(url.includes('startAt=0') ? JIRA_USERS : []);

const listFor = (id: string, ws = 2) =>
  app.inject({ method: 'GET', url: `/api/ticket-assignees?workspace=${ws}&ident=${encodeURIComponent(id)}` });
const pick = (id: string, assigneeId: string | null, ws = 2) =>
  app.inject({ method: 'POST', url: `/api/ticket-assignee?workspace=${ws}`, payload: { ident: id, assigneeId } });
const rows = (table: string, where = ''): Array<Record<string, unknown>> =>
  sqlite.prepare(`SELECT * FROM ${table} ${where} ORDER BY id`).all() as Array<Record<string, unknown>>;

describe('pure pieces', () => {
  it('a Jira user is a person with a display name; Cloud by account id, Server by name', () => {
    expect(toJiraAssignable(JIRA_USERS[0])).toEqual({ id: 'acc:u-2', name: 'Zoe Ng', detail: null, avatarUrl: 'https://a.example/z.png' });
    expect(toJiraAssignable({ name: 'jdoe', key: 'JIRAUSER1', displayName: 'J Doe' })?.id).toBe('name:jdoe');
    expect(toJiraAssignable(JIRA_USERS[2])).toBeNull();
    expect(toJiraAssignable(JIRA_USERS[3])).toBeNull();
    expect(toJiraAssignable({ accountId: 'x' })).toBeNull();
  });

  it('the Jira PUT body follows the site; null unassigns', () => {
    expect(jiraAssigneeBody(SITE, 'acc:u-1')).toEqual({ accountId: 'u-1' });
    expect(jiraAssigneeBody('https://jira.corp.example', 'name:jdoe')).toEqual({ name: 'jdoe' });
    expect(jiraAssigneeBody(SITE, null)).toEqual({ accountId: null });
    expect(jiraAssigneeBody('https://jira.corp.example', null)).toEqual({ name: null });
  });

  it('the GitHub mutation removes the others and adds the one, in one request', () => {
    expect(githubAssignMutation([], null)).toBeNull();
    const both = githubAssignMutation(['U_old'], 'U_new')!;
    expect(both).toContain('removeAssigneesFromAssignable');
    expect(both).toContain('addAssigneesToAssignable');
    expect(githubAssignMutation(['U_old'], null)).not.toContain('addAssignees');
    expect(githubAssignMutation([], 'U_new')).not.toContain('removeAssignees');
  });
});

describe('1. not a proxy', () => {
  it('refuses a ticket Limn holds no row for, and another account’s, before any call', async () => {
    expect((await listFor(jira('ENG-1234'))).statusCode).toBe(404);
    expect((await pick(jira('ENG-99'), null)).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('refuses an ident on another site, or of another tracker than the workspace’s', async () => {
    expect((await listFor(jira('ENG-7', 'https://evil.example'))).statusCode).toBe(404);
    expect((await listFor('not an ident')).statusCode).toBe(404);
    expect((await listFor(GH_IDENT, 2)).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
    expect(ghCalls).toHaveLength(0);
  });

  it('a Notion workspace cannot assign, and says why', async () => {
    const res = await listFor('notion:https://www.notion.so/0123456789abcdef0123456789abcdef#ENG-1', 4);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CannotAssign', message: 'Limn does not change Notion pages, so it cannot assign this ticket.' });
  });

  it('a sprint-only ticket in this workspace is held', async () => {
    respond = jiraUsers;
    expect((await listFor(jira('ENG-50'))).statusCode).toBe(200);
  });
});

describe('2. the list', () => {
  it('Jira: the project’s assignable people, sorted, with the saved credential — then from memory', async () => {
    respond = jiraUsers;
    const res = await listFor(jira('ENG-7'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspaceId: 2,
      ident: jira('ENG-7'),
      truncated: false,
      users: [
        { id: 'acc:u-1', name: 'Ada Lovelace', detail: 'ada@acme.io', avatarUrl: null },
        { id: 'acc:u-2', name: 'Zoe Ng', detail: null, avatarUrl: 'https://a.example/z.png' },
      ],
    });
    expect(calls[0]?.url).toBe(`${SITE}/rest/api/2/user/assignable/search?project=ENG&startAt=0&maxResults=100`);
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('dev@acme.io:secret').toString('base64')}`);
    expect(calls).toHaveLength(2);
    // Reopening the picker within the TTL makes no call; past it, the list is read again.
    await listFor(jira('ENG-7'));
    expect(calls).toHaveLength(2);
    clock += ASSIGNABLES_TTL_MS;
    await listFor(jira('ENG-7'));
    expect(calls).toHaveLength(4);
  });

  it('GitHub Issues: the repository’s assignable users, by login', async () => {
    ghRespond = () => ({
      data: {
        repository: {
          assignableUsers: {
            nodes: [
              { id: 'U_b', login: 'bob', name: 'Bob Stone', avatarUrl: 'https://avatars.example/b' },
              { id: 'U_a', login: 'alice', name: null, avatarUrl: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const res = await listFor(GH_IDENT, 1);
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toEqual([
      { id: 'U_a', name: 'alice', detail: null, avatarUrl: null },
      { id: 'U_b', name: 'bob', detail: 'Bob Stone', avatarUrl: 'https://avatars.example/b' },
    ]);
    expect(ghCalls[0]).toMatchObject({ accountId: 1, variables: { owner: 'acme', name: 'web', after: null } });
  });

  it('Linear: the team’s active members, with the saved key', async () => {
    respond = () =>
      json({
        data: {
          issue: {
            team: {
              members: {
                nodes: [
                  { id: 'l-1', name: 'Ann Smith', displayName: 'ann', avatarUrl: null, active: true },
                  { id: 'l-2', name: 'Old Timer', displayName: 'old', avatarUrl: null, active: false },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    const res = await listFor(LINEAR_IDENT, 3);
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toEqual([{ id: 'l-1', name: 'ann', detail: 'Ann Smith', avatarUrl: null }]);
    expect(calls[0]?.auth).toBe('lin_api_abcdefgh123');
  });

  it('a 403 reads as the credential’s permission, in our own words', async () => {
    respond = () => ({ status: 403, contentType: 'application/json', body: '{"errorMessages":["leak me"]}' });
    const res = await listFor(jira('ENG-7'));
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('Your Jira token cannot assign this issue.');
    expect(res.body).not.toContain('leak me');
  });
});

describe('3. the pick', () => {
  it('Jira: PUTs the assignee, re-reads it and settles every stored row of this account', async () => {
    respond = (url, init) => {
      if (url.includes('/user/assignable/')) return jiraUsers(url);
      if (init?.method === 'PUT') return { status: 204, contentType: '', body: '' };
      return json({ fields: { assignee: { accountId: 'u-1', displayName: 'Ada Lovelace' } } });
    };
    const res = await pick(jira('ENG-7'), 'acc:u-1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: 2, ident: jira('ENG-7'), assignee: { name: 'Ada Lovelace', avatarUrl: null } });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ url: `${SITE}/rest/api/2/issue/ENG-7/assignee`, body: '{"accountId":"u-1"}' });
    expect(calls.at(-1)?.url).toBe(`${SITE}/rest/api/2/issue/ENG-7?fields=assignee`);

    expect(rows('tracker_tickets', "WHERE account_id = 1 AND provider = 'jira'").map((r) => [r.assignee_name, r.assignee_account_id])).toEqual([
      ['Ada Lovelace', 'u-1'],
      ['Ada Lovelace', 'u-1'],
    ]);
    expect(rows('tracker_tickets', 'WHERE account_id = 2').every((r) => r.assignee_name === 'Old Owner')).toBe(true);
    expect(rows('sprint_tickets').map((r) => [r.account_id, r.ident, r.assignee_name])).toEqual([
      [1, jira('ENG-7'), 'Ada Lovelace'],
      [1, jira('ENG-50'), null],
      [2, jira('ENG-7'), 'Old Owner'],
    ]);
    expect(rows('sprint_ref_tickets')[0]?.assignee_name).toBe('Ada Lovelace');
  });

  it('Unassigned clears the assignee without asking for the list', async () => {
    respond = (_url, init) => (init?.method === 'PUT' ? { status: 204, contentType: '', body: '' } : json({ fields: { assignee: null } }));
    const res = await pick(jira('ENG-7'), null);
    expect(res.json().assignee).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
    expect(calls[0]?.body).toBe('{"accountId":null}');
    expect(rows('sprint_tickets', 'WHERE account_id = 1')[0]?.assignee_name).toBeNull();
  });

  it('refuses a person not on the tracker’s list, before any write', async () => {
    respond = jiraUsers;
    const res = await pick(jira('ENG-7'), 'acc:stranger');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('UnknownAssignee');
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a failed re-read stores who was picked and marks the PR rows due', async () => {
    respond = (url, init) => {
      if (url.includes('/user/assignable/')) return jiraUsers(url);
      if (init?.method === 'PUT') return { status: 204, contentType: '', body: '' };
      return { status: 500, contentType: 'text/html', body: '' };
    };
    const res = await pick(jira('ENG-7'), 'acc:u-2');
    expect(res.json().assignee).toEqual({ name: 'Zoe Ng', avatarUrl: 'https://a.example/z.png' });
    const mine = rows('tracker_tickets', "WHERE account_id = 1 AND provider = 'jira'");
    expect(mine.every((r) => r.assignee_name === 'Zoe Ng' && r.assignee_account_id === 'u-2' && r.next_check_at === 0)).toBe(true);
  });

  it('a refusal stores nothing and says so in one line', async () => {
    respond = (url, init) =>
      url.includes('/user/assignable/') ? jiraUsers(url) : init?.method === 'PUT' ? { status: 400, contentType: 'application/json', body: '{}' } : json({});
    const res = await pick(jira('ENG-7'), 'acc:u-1');
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('Jira refused this change.');
    expect(rows('tracker_tickets').every((r) => r.assignee_name === 'Old Owner')).toBe(true);
  });

  it('GitHub Issues: replaces the assignees in one mutation and stores the login', async () => {
    ghRespond = (query) => {
      if (query.includes('assignableUsers')) {
        return { data: { repository: { assignableUsers: { nodes: [{ id: 'U_a', login: 'alice' }], pageInfo: { hasNextPage: false } } } } };
      }
      if (query.includes('LimnIssueAssignees')) return { data: { repository: { issue: { id: 'I_1', assignees: { nodes: [{ id: 'U_old' }] } } } } };
      return { data: { r: { clientMutationId: null }, a: { assignable: { assignees: { nodes: [{ login: 'alice', avatarUrl: null }] } } } } };
    };
    const res = await pick(GH_IDENT, 'U_a', 1);
    expect(res.statusCode).toBe(200);
    expect(res.json().assignee).toEqual({ name: 'alice', avatarUrl: null });
    expect(ghCalls.at(-1)?.variables).toEqual({ id: 'I_1', remove: ['U_old'], add: ['U_a'] });
    expect(rows('tracker_tickets', "WHERE provider = 'github'")[0]).toMatchObject({ assignee_name: 'alice', assignee_account_id: 'alice' });
  });

  it('Linear: one issueUpdate with the member id', async () => {
    respond = (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { query: string; variables: Record<string, unknown> };
      if (body.query.includes('members')) {
        return json({ data: { issue: { team: { members: { nodes: [{ id: 'l-1', name: 'Ann Smith', displayName: 'ann', active: true }] } } } } });
      }
      return json({ data: { issueUpdate: { success: true, issue: { assignee: { id: 'l-1', name: 'Ann Smith', displayName: 'ann' } } } } });
    };
    const res = await pick(LINEAR_IDENT, 'l-1', 3);
    expect(res.statusCode).toBe(200);
    expect(res.json().assignee).toEqual({ name: 'ann', avatarUrl: null });
    const last = JSON.parse(calls.at(-1)?.body ?? '{}') as { variables: Record<string, unknown> };
    expect(last.variables).toEqual({ id: 'ENG-5', assigneeId: 'l-1' });
    expect(rows('tracker_tickets', "WHERE provider = 'linear'")[0]).toMatchObject({ assignee_name: 'ann', assignee_account_id: 'l-1' });
  });

  it('the body schema refuses a missing assignee and a control character', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/ticket-assignee?workspace=2', payload: { ident: jira('ENG-7') } })).statusCode).toBe(400);
    expect((await pick(jira('ENG-7'), 'acc:\u0001')).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
