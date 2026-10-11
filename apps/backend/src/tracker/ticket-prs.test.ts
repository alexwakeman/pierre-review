// ── THE TICKET TAB: GET /api/ticket-prs ─────────────────────────────────────────────────────────
//
// Pinned over an in-memory SQLite with the real tracker migration:
//   1. The ticket's PRs in THIS workspace's repos are listed, split open / merged / closed and sorted;
//      PRs in other workspaces' repos are COUNTED (`outsideWorkspace`), never listed.
//   2. Another account's rows and PRs never appear; an unread row is not a member.
//   3. An ident for another site or provider, or one that does not parse, answers 200 `found: false`.
//   4. The ticket's facts come from the freshest read row.
//
// The TimelinePr builder is injected (a stub), so nothing here loads db/queries.ts or the real DB.
//
//   ./node_modules/.bin/vitest run src/tracker/ticket-prs.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jiraApiRoot, jiraTicketIdent, type TimelinePr } from '@pierre-review/shared';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTrackerRoutes } from './routes.js';
import { ticketPrs, type BuildTimelinePrs } from './ticket-prs.js';
import type { TrackerContext } from './context.js';

const WS = 2; // Jira, acme — repos 100 + 200
const WS_OTHER = 1; // Jira, acme — repo 300
const WS_LINEAR = 3;

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name'),
  isDefault: integer('is_default').notNull(),
});
const coreWorkspaceRepos = sqliteTable('workspace_repos', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  repoId: integer('repo_id').notNull(),
});
const corePullRequests = sqliteTable('pull_requests', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  repoId: integer('repo_id').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  mergedAt: integer('merged_at', { mode: 'timestamp' }),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
});

const host = {
  version: 'test',
  deploymentMode: 'local' as const,
  isCloud: false,
  sealSecret: (p: string) => `enc(${Buffer.from(p).toString('hex')})`,
  openSecret: (s: string) => Buffer.from(/^enc\((.*)\)$/.exec(s)?.[1] ?? '', 'hex').toString('utf8'),
};

const ACME = jiraApiRoot('https://acme.atlassian.net') as string;
const OTHER_SITE = 'https://other.atlassian.net';
const ENG7 = jiraTicketIdent(ACME, 'ENG-7');

let app: FastifyInstance;
let sqlite: Database.Database;
let ctx: TrackerContext;
let builtWith: number[][] = [];

// A stub builder: just enough of a TimelinePr for the split to be checked.
const build: BuildTimelinePrs = async (rows) => {
  builtWith.push(rows.map((r: { id: number }) => r.id));
  return rows.map((r: { id: number; state: string }) => ({ id: r.id, state: r.state }) as unknown as TimelinePr);
};

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(3,1,'Linear',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY, account_id integer NOT NULL, workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,2,100),(1,2,200),(1,1,300),(2,90,900);' +
      'CREATE TABLE repos (id integer PRIMARY KEY, account_id integer NOT NULL, owner text NOT NULL, name text NOT NULL);' +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, repo_id integer NOT NULL, ' +
      'number integer NOT NULL, title text NOT NULL, state text NOT NULL, updated_at integer, merged_at integer, closed_at integer);' +
      // open: 10 (older activity), 11 (newer); merged: 12 (older), 13 (newer); closed: 14
      "INSERT INTO pull_requests VALUES (10,1,100,1,'a','open',1000,null,null);" +
      "INSERT INTO pull_requests VALUES (11,1,200,2,'b','open',2000,null,null);" +
      "INSERT INTO pull_requests VALUES (12,1,100,3,'c','merged',3000,3000,3000);" +
      "INSERT INTO pull_requests VALUES (13,1,200,4,'d','merged',4000,4000,4000);" +
      "INSERT INTO pull_requests VALUES (14,1,200,5,'e','closed',5000,null,5000);" +
      "INSERT INTO pull_requests VALUES (15,1,300,6,'other ws','merged',6000,6000,6000);" +
      "INSERT INTO pull_requests VALUES (16,1,200,7,'unread','open',7000,null,null);" +
      "INSERT INTO pull_requests VALUES (17,1,200,8,'other site','open',8000,null,null);" +
      "INSERT INTO pull_requests VALUES (90,2,900,1,'foreign','open',9000,null,null);",
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  sqlite.exec(migration('0098_tracker_ticket_dates.sql'));

  const row = (acct: number, ws: number, prId: number, apiRoot: string, fetched: number | null, title = 'Cookie banner', state = 'ok'): string =>
    `(${acct},${ws},${prId},'ENG-7','title',0,'${apiRoot}','${apiRoot}/browse/ENG-7','${state}',0,0,${fetched ?? 'null'},'${title}','In Progress','indeterminate')`;
  sqlite.exec(
    'INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, issue_key, detected_from, ' +
      'detect_order, api_root, url, state, checked_at, next_check_at, fetched_at, title, status_name, status_category) VALUES ' +
      [
        row(1, WS, 10, ACME, 100, 'Old title'),
        row(1, WS, 11, ACME, 200, 'Cookie banner'), // the freshest read row
        row(1, WS, 12, ACME, 100),
        row(1, WS, 13, ACME, 100),
        row(1, WS, 14, ACME, 100),
        row(1, WS_OTHER, 15, ACME, 100), // another workspace's repo: counted
        row(1, WS, 16, ACME, null), // never read: not a member
        row(1, WS, 17, OTHER_SITE, 100), // another site
        row(2, 90, 90, ACME, 300, 'Foreign title'), // another tenant
      ].join(','),
  );

  ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host,
    accountIdOf: () => 1,
    defaultWorkspaceId: async () => WS_OTHER,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: {
      trackerTickets,
      jiraAcFields,
      workspaceTrackers,
      workspaces: coreWorkspaces,
      workspaceRepos: coreWorkspaceRepos,
      pullRequests: corePullRequests,
    },
  } as unknown as TrackerContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx);
  await app.ready();
  const put = (ws: number, body: unknown) =>
    app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
  for (const ws of [WS, WS_OTHER]) {
    const res = await put(ws, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] } });
    expect(res.statusCode).toBe(200);
  }
  const lin = await put(WS_LINEAR, { issue: { provider: 'linear', baseUrl: 'https://linear.app/acme', projectKeys: ['ENG'] } });
  expect(lin.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

describe('the ticket tab read', () => {
  it('lists this workspace’s PRs split by state, sorted, and counts the rest', async () => {
    builtWith = [];
    const r = await ticketPrs(ctx, 1, WS, ENG7, build);
    expect(r.found).toBe(true);
    expect(r.workspaceId).toBe(WS);
    expect(r.ident).toBe(ENG7);
    expect(r.open.map((p) => p.id)).toEqual([11, 10]);
    expect(r.merged.map((p) => p.id)).toEqual([13, 12]);
    expect(r.closed.map((p) => p.id)).toEqual([14]);
    expect(r.outsideWorkspace).toBe(1);
    expect(r.truncated).toBe(false);
    // One build over every listed row; the foreign, unread and other-site PRs never reach it.
    expect(builtWith).toHaveLength(1);
    expect(builtWith[0]!.sort()).toEqual([10, 11, 12, 13, 14]);
  });

  it('takes the ticket facts from the freshest read row of THIS account', async () => {
    const r = await ticketPrs(ctx, 1, WS, ENG7, build);
    expect(r.ticket).toEqual({
      key: 'ENG-7',
      title: 'Cookie banner',
      url: `${ACME}/browse/ENG-7`,
      provider: 'jira',
      status: { name: 'In Progress', category: 'indeterminate' },
    });
  });

  it('another workspace lists its own PR and counts the others', async () => {
    const r = await ticketPrs(ctx, 1, WS_OTHER, ENG7, build);
    expect([...r.open, ...r.merged, ...r.closed].map((p) => p.id)).toEqual([15]);
    expect(r.outsideWorkspace).toBe(5);
  });

  it('another account never sees this account’s PRs', async () => {
    const r = await ticketPrs(ctx, 2, 90, ENG7, build);
    // Account 2 has no tracker configured on workspace 90 → not found, nothing listed.
    expect(r.found).toBe(false);
    expect(r.open).toEqual([]);
  });

  it('another site, another provider or a bad ident → 200 found:false', async () => {
    const ask = (q: string) => app.inject({ method: 'GET', url: `/api/ticket-prs?${q}` });
    for (const q of [
      `workspace=${WS}&ident=${encodeURIComponent(jiraTicketIdent(OTHER_SITE, 'ENG-7'))}`,
      `workspace=${WS_LINEAR}&ident=${encodeURIComponent(ENG7)}`,
      `workspace=${WS}&ident=not-an-ident`,
      `workspace=${WS}`,
    ]) {
      const res = await ask(q);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.found).toBe(false);
      expect(body.ticket).toBeNull();
      expect(body.open).toEqual([]);
      expect(body.outsideWorkspace).toBe(0);
    }
  });

  it('an unknown workspace resolves to the Default and is echoed', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/ticket-prs?workspace=999&ident=not-an-ident` });
    expect(res.json().workspaceId).toBe(WS_OTHER);
  });
});
