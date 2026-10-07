// ── THE OPEN PRs TICKET STACKS' MERGED PANEL: GET /api/ticket-merged-prs ───────────────────
//
// Pinned through a real Fastify instance:
//   1. ONE request answers every asked key: each ticket's MERGED PRs (any repo of the account, any
//      workspace, on the workspace's Jira site), newest merge first, with repo name and author.
//      Open and closed-unmerged PRs are not listed; a key with no merged PR is absent.
//   2. Tenancy + site: another account's rows, another Jira site's rows and unread rows are never
//      answered. A workspace whose tracker is not Jira answers `tickets: []`. The resolved
//      workspace is echoed.
//   3. Over the key cap is a 400; malformed keys are dropped.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/tracker/ticket-merged-prs.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TICKET_MERGED_PRS_MAX_KEYS } from '@pierre-review/shared';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { parseKeys } from './merged.js';
import { registerTrackerRoutes } from './routes.js';
import { jiraApiRoot } from '@pierre-review/shared';
import type { TrackerContext } from './context.js';

const WS = 2; // Jira, acme
const WS_LINEAR = 3;
const WS_DEFAULT = 1; // Jira, acme (the second workspace on the same site)

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name'),
  isDefault: integer('is_default').notNull(),
});
const corePullRequests = sqliteTable('pull_requests', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  repoId: integer('repo_id').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
  state: text('state').notNull(),
  mergedAt: integer('merged_at', { mode: 'timestamp' }),
  githubNodeId: text('github_node_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  closingIssues: text('closing_issues', { mode: 'json' }),
  closingIssuesCheckedAt: integer('closing_issues_checked_at', { mode: 'timestamp' }),
  linearLinks: text('linear_links', { mode: 'json' }),
  linearLinksRoot: text('linear_links_root'),
  linearLinksCheckedAt: integer('linear_links_checked_at', { mode: 'timestamp' }),
});
const coreRepos = sqliteTable('repos', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
});
const coreUsers = sqliteTable('users', {
  id: integer('id').primaryKey(),
  githubLogin: text('github_login').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
});

const host = {
  version: 'test',
  deploymentMode: 'local' as const,
  isCloud: false,
  sealSecret: (p: string) => `enc(${Buffer.from(p).toString('hex')})`,
  openSecret: (s: string) => Buffer.from(/^enc\((.*)\)$/.exec(s)?.[1] ?? '', 'hex').toString('utf8'),
};

let app: FastifyInstance;
let sqlite: Database.Database;
let accountId = 1;
const ACME = jiraApiRoot('https://acme.atlassian.net') as string;
const OTHER_SITE = 'https://other.atlassian.net';

// epoch seconds
const D1 = Date.UTC(2026, 8, 20) / 1000;
const D2 = Date.UTC(2026, 8, 30) / 1000;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  // better-sqlite3 enforces foreign keys: `workspace_trackers` references accounts + workspaces.
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(3,1,'Linear',0),(90,2,'Other',1);" +
      'CREATE TABLE repos (id integer PRIMARY KEY, account_id integer NOT NULL, owner text NOT NULL, name text NOT NULL);' +
      "INSERT INTO repos VALUES (100,1,'acme','web'),(200,1,'acme','engine'),(900,2,'evil','repo');" +
      'CREATE TABLE users (id integer PRIMARY KEY, github_login text NOT NULL, display_name text, avatar_url text);' +
      "INSERT INTO users VALUES (5,'ada','Ada Lovelace','https://a.example/ada.png');" +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, repo_id integer NOT NULL, ' +
      'number integer NOT NULL, title text NOT NULL, author_id integer, state text NOT NULL, merged_at integer);' +
      `INSERT INTO pull_requests VALUES (10,1,200,66,'Engine fix',5,'merged',${D2});` +
      `INSERT INTO pull_requests VALUES (11,1,100,12,'Web half',null,'merged',${D1});` +
      "INSERT INTO pull_requests VALUES (12,1,200,70,'Still open',5,'open',null);" +
      "INSERT INTO pull_requests VALUES (13,1,200,71,'Abandoned',5,'closed',null);" +
      `INSERT INTO pull_requests VALUES (14,1,200,72,'Other site',5,'merged',${D2});` +
      `INSERT INTO pull_requests VALUES (15,1,200,73,'Unread ticket',5,'merged',${D2});` +
      `INSERT INTO pull_requests VALUES (16,1,200,74,'Second ticket',5,'merged',${D1});` +
      `INSERT INTO pull_requests VALUES (90,2,900,1,'Foreign',null,'merged',${D2});`,
  );
  sqlite.exec(
    'CREATE TABLE workspace_period_reports (id integer PRIMARY KEY AUTOINCREMENT, ' +
      'account_id integer NOT NULL, workspace_id integer NOT NULL, period_key text NOT NULL, ' +
      'model text NOT NULL, cadence_days integer NOT NULL, period_end integer);' +
      'CREATE UNIQUE INDEX wpr_account_ws_period_model ON workspace_period_reports ' +
      '(account_id, workspace_id, period_key, model);' +
      'CREATE TABLE pro_settings (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'comparison_mode text, report_model text, bot_slack_digest integer, bot_auto_resolve integer, ' +
      'bot_auto_resolve_days integer, bot_cost_json text, ' +
      'issue_provider text, issue_base_url text, issue_project_keys text, ' +
      'created_at integer NOT NULL DEFAULT (unixepoch()), ' +
      'updated_at integer NOT NULL DEFAULT (unixepoch()));' +
      'CREATE UNIQUE INDEX pro_settings_account ON pro_settings (account_id);',
  );
  // The core tracker tables (migration 0088), exactly as a real install has them.
  sqlite.exec(migration('0088_issue_tracker.sql'));
  // The PR columns the GitHub Issues linker reads (migration 0089).
  for (const col of ['github_node_id text', 'updated_at integer', 'closing_issues text', 'closing_issues_checked_at integer', 'linear_links text', 'linear_links_root text', 'linear_links_checked_at integer']) {
    try {
      sqlite.exec(`ALTER TABLE pull_requests ADD ${col}`);
    } catch {
      /* the stub already has it */
    }
  }

  const row = (acct: number, ws: number, prId: number, key: string, apiRoot: string, state = 'ok'): string =>
    `(${acct},${ws},${prId},'${key}','title',0,'${apiRoot}','${apiRoot}/browse/${key}','${state}',0,0)`;
  sqlite.exec(
    'INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, issue_key, detected_from, ' +
      'detect_order, api_root, url, state, checked_at, next_check_at) VALUES ' +
      [
        row(1, WS, 10, 'ENG-7', ACME),
        row(1, WS_DEFAULT, 11, 'ENG-7', ACME), // another workspace, same site: still the ticket
        row(1, WS, 12, 'ENG-7', ACME), // open
        row(1, WS, 13, 'ENG-7', ACME), // closed-unmerged
        row(1, WS, 14, 'ENG-7', OTHER_SITE), // another Jira site
        row(1, WS, 15, 'ENG-7', ACME, 'not_found'), // unread
        row(1, WS, 16, 'ENG-8', ACME),
        row(1, WS, 10, 'ENG-8', ACME), // a PR on two tickets lists under both
        row(2, 90, 90, 'ENG-7', ACME), // another tenant
        row(1, WS, 12, 'ENG-9', ACME), // only an open PR: absent
      ].join(','),
  );

  const ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host,
    accountIdOf: () => accountId,
    defaultWorkspaceId: async () => WS_DEFAULT,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: {
      trackerTickets,
      jiraAcFields,
      workspaceTrackers,
      workspaces: coreWorkspaces,
      pullRequests: corePullRequests,
      repos: coreRepos,
      users: coreUsers,
    },
  } as unknown as TrackerContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx);
  await app.ready();

  const put = (ws: number, body: unknown) =>
    app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
  for (const ws of [WS, WS_DEFAULT]) {
    const res = await put(ws, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] } });
    expect(res.statusCode).toBe(200);
  }
  const lin = await put(WS_LINEAR, {
    issue: { provider: 'linear', baseUrl: 'https://linear.app/acme', projectKeys: ['ENG'] },
  });
  expect(lin.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const ask = (q: string) => app.inject({ method: 'GET', url: `/api/ticket-merged-prs?${q}` });

describe('1. every merged PR on each asked ticket, in one request', () => {
  it('lists merged PRs across repos and workspaces, newest first; open / closed / unread / other site excluded', async () => {
    const res = await ask(`workspace=${WS}&keys=ENG-7,eng-8,ENG-9`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceId).toBe(WS);
    expect(body.tickets.map((t: { key: string }) => t.key)).toEqual(['ENG-7', 'ENG-8']);
    const eng7 = body.tickets[0];
    expect(eng7.ident).toBe(`jira:${ACME}#ENG-7`);
    expect(eng7.prs).toEqual([
      {
        prId: 10,
        repoId: 200,
        repoFullName: 'acme/engine',
        number: 66,
        title: 'Engine fix',
        authorLogin: 'ada',
        authorDisplayName: 'Ada Lovelace',
        authorAvatarUrl: 'https://a.example/ada.png',
        mergedAt: new Date(D2 * 1000).toISOString(),
      },
      {
        prId: 11,
        repoId: 100,
        repoFullName: 'acme/web',
        number: 12,
        title: 'Web half',
        authorLogin: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
        mergedAt: new Date(D1 * 1000).toISOString(),
      },
    ]);
    expect(body.tickets[1].prs.map((p: { prId: number }) => p.prId)).toEqual([10, 16]);
  });
});

describe('2. tenancy, site and scope', () => {
  it('never answers another account’s rows', async () => {
    accountId = 2;
    try {
      // Account 2's workspace 90 has no tracker: nothing, and its own id is echoed (the asked WS is
      // another tenant's, so it resolves to this account's Default).
      const res = await ask(`workspace=${WS}&keys=ENG-7`);
      expect(res.statusCode).toBe(200);
      expect(res.json().tickets).toEqual([]);
    } finally {
      accountId = 1;
    }
  });

  it('a non-Jira workspace answers nothing', async () => {
    const res = await ask(`workspace=${WS_LINEAR}&keys=ENG-7`);
    expect(res.json()).toEqual({ workspaceId: WS_LINEAR, tickets: [] });
  });

  it('an unknown workspace resolves to the Default and is echoed', async () => {
    const res = await ask('workspace=9999&keys=ENG-7');
    const body = res.json();
    expect(body.workspaceId).toBe(WS_DEFAULT);
    expect(body.tickets[0].prs.map((p: { prId: number }) => p.prId)).toEqual([10, 11]);
  });

  it('no keys is an empty answer, not an error', async () => {
    const res = await ask(`workspace=${WS}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: WS, tickets: [] });
  });
});

describe('3. the key list', () => {
  it('drops malformed and duplicate keys, upper-cases the rest', () => {
    expect(parseKeys(' eng-7,ENG-7,,not a key,ENG-x,ENG-8 ')).toEqual(['ENG-7', 'ENG-8']);
    expect(parseKeys(undefined)).toEqual([]);
  });

  it('over the cap is a 400', async () => {
    const keys = Array.from({ length: TICKET_MERGED_PRS_MAX_KEYS + 1 }, (_, i) => `ENG-${i + 1}`).join(',');
    const res = await ask(`workspace=${WS}&keys=${keys}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TooManyKeys');
  });
});
