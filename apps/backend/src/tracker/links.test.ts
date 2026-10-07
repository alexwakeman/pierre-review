// ── THE OPEN PRs TICKET ROW: POST /api/ticket-links ─────────────────────────────────────────
//
// Pinned through a real Fastify instance:
//   1. ONE request answers every listed PR, with the SAME detection the PR-detail chips use
//      (allowlist, title + branch), in the order asked; another tenant's PR is simply absent.
//   2. THE ROUTE MAKES NO JIRA CALL. Title, status, assignee and issue type come from the STORED
//      rows (core 0088); a detected ticket with no row answers `titlesComplete: false` and KICKS
//      the background worker for those PRs, and the next request reads what it stored.
//   3. No token → links with nothing from Jira and no call. A Jira 401 backs the workspace off and
//      the row counts as complete (asking again would not change it); the route never fails.
//   4. The worker's per-kick bound: over it → `titlesComplete: false` until the next kick reads
//      the rest.
//   5. Over the id cap is a 400.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/tracker/ticket-links.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TICKET_LINKS_MAX_PRS } from '@pierre-review/shared';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTrackerRoutes } from './routes.js';
import { enableTrackerWorker, PER_ACCOUNT_PASS, resetTrackerWorker } from './worker.js';
import type { JiraTransport, RawResponse } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

const ACCOUNT = 1;
const WS = 2; // repo 200, Jira + token
const WS_NO_TOKEN = 1; // repo 100
const WS_LINEAR = 3; // repo 300
const TOKEN = 'ATATT3xFfGF0-super-secret-token';

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

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
  title: text('title').notNull(),
  headRefName: text('head_ref_name'),
  githubNodeId: text('github_node_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  closingIssues: text('closing_issues', { mode: 'json' }),
  closingIssuesCheckedAt: integer('closing_issues_checked_at', { mode: 'timestamp' }),
  number: integer('number'),
  linearLinks: text('linear_links', { mode: 'json' }),
  linearLinksRoot: text('linear_links_root'),
  linearLinksCheckedAt: integer('linear_links_checked_at', { mode: 'timestamp' }),
  state: text('state'),
});
const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name'),
  isDefault: integer('is_default').notNull(),
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
const calls: string[] = [];
const issueBody = (key: string): string =>
  JSON.stringify({
    key,
    fields: {
      summary: `Title of ${key}`,
      issuetype: { id: '10001', name: 'Story' },
      status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
      assignee: { displayName: 'Ada Lovelace', accountId: 'acc-ada', avatarUrls: { '48x48': 'https://a.example/ada.png' } },
    },
  });
const okIssue = (url: string): RawResponse => {
  const key = /issue\/([^?]+)/.exec(url)?.[1] ?? '';
  return { status: 200, contentType: 'application/json', body: issueBody(key) };
};
let respond: (url: string) => RawResponse = okIssue;
const transport: JiraTransport = async (url) => {
  calls.push(String(url));
  return respond(String(url));
};

const MANY_FIRST_ID = 1000;
const MANY = PER_ACCOUNT_PASS + 5;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  // better-sqlite3 enforces foreign keys: `workspace_trackers` references accounts + workspaces.
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  const manyRows = Array.from(
    { length: MANY },
    (_, i) => `(${MANY_FIRST_ID + i},1,200,'ENG-${5000 + i} bulk',null)`,
  ).join(',');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(3,1,'Linear',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,1,100),(1,2,200),(1,3,300),(2,90,900);' +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, ' +
      'repo_id integer NOT NULL, title text NOT NULL, head_ref_name text);' +
      "INSERT INTO pull_requests VALUES (10,1,200,'ENG-7 reset password','feature/ENG-8-extra');" +
      "INSERT INTO pull_requests VALUES (11,1,100,'ENG-9 other team',null);" +
      "INSERT INTO pull_requests VALUES (12,1,200,'No ticket here',null);" +
      "INSERT INTO pull_requests VALUES (13,1,300,'ENG-11 on linear',null);" +
      "INSERT INTO pull_requests VALUES (14,1,400,'ENG-12 in no workspace',null);" +
      "INSERT INTO pull_requests VALUES (15,1,200,'ENG-7 again',null);" +
      "INSERT INTO pull_requests VALUES (90,2,900,'ENG-7 foreign',null);" +
      `INSERT INTO pull_requests VALUES ${manyRows};`,
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
  for (const col of ["state text DEFAULT 'open'", 'github_node_id text', 'updated_at integer', 'closing_issues text', 'closing_issues_checked_at integer', 'linear_links text', 'linear_links_root text', 'linear_links_checked_at integer', 'number integer']) {
    try {
      sqlite.exec(`ALTER TABLE pull_requests ADD ${col}`);
    } catch {
      /* the stub already has it */
    }
  }

  const ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host,
    accountIdOf: () => ACCOUNT,
    defaultWorkspaceId: async () => WS_NO_TOKEN,
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
  registerTrackerRoutes(app, ctx, { transport });
  await app.ready();

  const put = (ws: number, body: unknown) =>
    app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
  for (const ws of [WS, WS_NO_TOKEN]) {
    const res = await put(ws, {
      issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] },
    });
    expect(res.statusCode).toBe(200);
  }
  expect((await put(WS, { jira: { token: TOKEN } })).statusCode).toBe(200);
  expect(
    (await put(WS_LINEAR, { issue: { provider: 'linear', baseUrl: 'https://linear.app/acme', projectKeys: ['ENG'] } }))
      .statusCode,
  ).toBe(200);
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

beforeEach(() => {
  calls.length = 0;
  resetTrackerWorker();
  enableTrackerWorker(true);
  sqlite.exec('DELETE FROM tracker_tickets;');
  respond = okIssue;
});

const links = (prIds: number[]) => app.inject({ method: 'POST', url: '/api/ticket-links', payload: { prIds } });
/** Ask until the worker the route kicked has stored everything (or the budget of tries runs out). */
const linksSettled = async (prIds: number[]) => {
  let body = (await links(prIds)).json();
  await vi.waitFor(
    async () => {
      body = (await links(prIds)).json();
      expect(body.titlesComplete).toBe(true);
    },
    { timeout: 2000, interval: 10 },
  );
  return body;
};

const ada = { name: 'Ada Lovelace', avatarUrl: 'https://a.example/ada.png' };
const read = (key: string, url = `https://acme.atlassian.net/browse/${key}`) => ({
  key,
  url,
  provider: 'jira',
  title: `Title of ${key}`,
  status: 'In Review',
  statusCategory: 'indeterminate',
  assignee: ada,
  issueType: 'Story',
});
const unread = { title: null, status: null, statusCategory: null, assignee: null, issueType: null };

describe('1. one request, the same detection, every listed PR', () => {
  it('detects per PR, in the order asked; absent when no ticket source applies', async () => {
    const body = await linksSettled([12, 10, 90, 14, 11, 13]);
    // 12: tracker configured, nothing detected → present with [] (the browse prefix still helps).
    // 90: another tenant's PR → absent. 14: repo in no workspace → absent.
    expect(body.prs.map((p: { prId: number }) => p.prId)).toEqual([12, 10, 11, 13]);
    expect(body.prs[0]).toEqual({ prId: 12, tickets: [], jiraBrowsePrefix: 'https://acme.atlassian.net/browse/' });
    expect(body.prs[1]).toEqual({
      prId: 10,
      tickets: [read('ENG-7'), read('ENG-8')],
      jiraBrowsePrefix: 'https://acme.atlassian.net/browse/',
    });
    // No token in that workspace: the link, nothing from Jira, never a call for it.
    expect(body.prs[2].tickets).toEqual([
      { key: 'ENG-9', url: 'https://acme.atlassian.net/browse/ENG-9', provider: 'jira', ...unread },
    ]);
    // Linear: a link with no Jira browse prefix and nothing from Jira.
    expect(body.prs[3]).toEqual({
      prId: 13,
      tickets: [{ key: 'ENG-11', url: 'https://linear.app/acme/issue/ENG-11', provider: 'linear', ...unread }],
      jiraBrowsePrefix: null,
    });
    expect([...calls].sort()).toEqual([
      'https://acme.atlassian.net/rest/api/2/issue/ENG-7?fields=*all&expand=names,schema',
      'https://acme.atlassian.net/rest/api/2/issue/ENG-8?fields=*all&expand=names,schema',
    ]);
  });

  it('a key two PRs share is read from Jira once', async () => {
    const body = await linksSettled([10, 15]);
    expect(body.prs[1].tickets[0].title).toBe('Title of ENG-7');
    expect(calls.filter((u) => u.includes('ENG-7'))).toHaveLength(1);
  });
});

describe('2. the route reads stored rows and makes no Jira call', () => {
  it('a first request answers what is stored (nothing yet) and kicks the worker; later ones read rows', async () => {
    const first = (await links([10])).json();
    expect(first.titlesComplete).toBe(false);
    expect(first.prs[0].tickets.map((t: { title: string | null }) => t.title)).toEqual([null, null]);
    await linksSettled([10]);
    const n = calls.length;
    expect(n).toBe(2);
    for (let i = 0; i < 3; i += 1) {
      const again = (await links([10])).json();
      expect(again.titlesComplete).toBe(true);
      expect(again.prs[0].tickets).toEqual([read('ENG-7'), read('ENG-8')]);
    }
    expect(calls.length).toBe(n);
  });

  it('a long title is cut, and an empty summary is no title', async () => {
    respond = (url) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: { summary: url.includes('ENG-7') ? 'x'.repeat(500) : '' } }),
    });
    const body = await linksSettled([10]);
    expect(body.prs[0].tickets[0].title.length).toBeLessThanOrEqual(201);
    expect(body.prs[0].tickets[1].title).toBeNull();
  });
});

describe('3. Jira refusing never fails the route', () => {
  it('a 401 backs the workspace off; the links still come back, and it is not asked again', async () => {
    respond = () => ({ status: 401, contentType: 'application/json', body: '{"errorMessages":["nope"]}' });
    const body = await linksSettled([10]);
    expect(body.prs[0].tickets.map((t: { title: string | null }) => t.title)).toEqual([null, null]);
    expect(JSON.stringify(body)).not.toContain('nope');
    // At most the reads already in flight (the pass runs a few at a time); then the backoff holds.
    const n = calls.length;
    expect(n).toBeLessThanOrEqual(2);
    await links([10]);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(n);
  });

  it('a 404 is remembered as a refusal: complete, no title, not asked again', async () => {
    respond = () => ({ status: 404, contentType: 'application/json', body: '{}' });
    await linksSettled([10]);
    const n = calls.length;
    expect((await links([10])).json().titlesComplete).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(n);
  });
});

describe('4. the worker bound', () => {
  it('over the per-kick bound → titlesComplete false; later kicks read the rest', async () => {
    const ids = Array.from({ length: MANY }, (_, i) => MANY_FIRST_ID + i);
    const first = (await links(ids)).json();
    expect(first.titlesComplete).toBe(false);
    await vi.waitFor(() => expect(calls.length).toBe(PER_ACCOUNT_PASS), { timeout: 2000, interval: 10 });
    const settled = await linksSettled(ids);
    expect(calls).toHaveLength(MANY);
    expect(settled.prs.every((p: { tickets: Array<{ title: string | null }> }) => p.tickets[0]?.title != null)).toBe(true);
  });
});

describe('5. bounds', () => {
  it('over the id cap is a 400, never a truncation', async () => {
    const ids = Array.from({ length: TICKET_LINKS_MAX_PRS + 1 }, (_, i) => i + 1);
    const res = await links(ids);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TooManyIds');
    expect(calls).toHaveLength(0);
  });

  it('an empty list answers nothing', async () => {
    expect((await links([])).json()).toEqual({ prs: [], titlesComplete: true });
  });
});
