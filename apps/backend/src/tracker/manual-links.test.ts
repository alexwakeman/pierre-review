// ── ADDING A TICKET BY HAND (docs/TRACKERS.md § Adding a ticket by hand) ─────────────────────────
//
// The shared parser (`parseTicketRef` / `splitTicketRefs`), and `POST /api/prs/:id/tracker-ticket/
// resolve` through a real Fastify instance over an in-memory SQLite (never the real database):
//   • ownership → 404; the reference cap → 400; no usable tracker → 400;
//   • a link or key for ANOTHER tracker or ANOTHER site is refused BEFORE any tracker call;
//   • `link: false` reads and stores nothing; `link: true` stores a 'manual' row that detection then
//     carries everywhere, and that the worker's prune keeps;
//   • an unreadable ticket is not kept.
//
//   ./node_modules/.bin/vitest run src/tracker/manual-links.test.ts   (from apps/backend)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { parseTicketRef, splitTicketRefs, TICKET_REFS_MAX } from '@pierre-review/shared';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTrackerRoutes } from './routes.js';
import { prTicketRefs } from './enricher.js';
import { resolvePrTickets } from './stories.js';
import { resetTrackerWorker, syncOnePrNow } from './worker.js';
import { decideRef } from './manual-links.js';
import type { JiraTransport, RawResponse } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

describe('parseTicketRef', () => {
  it.each([
    ['PROJ-123', { kind: 'key', shape: 'prefix', key: 'PROJ-123' }],
    ['proj-123', { kind: 'key', shape: 'prefix', key: 'PROJ-123' }],
    ['Owner/Repo#12', { kind: 'key', shape: 'github', key: 'owner/repo#12' }],
    ['#12', { kind: 'issue_number', number: 12 }],
    [
      'https://acme.atlassian.net/browse/PROJ-123',
      { kind: 'url', provider: 'jira', root: 'https://acme.atlassian.net', key: 'PROJ-123', loose: false },
    ],
    [
      'https://jira.acme.io/jira/browse/proj-9?focused=1',
      { kind: 'url', provider: 'jira', root: 'https://jira.acme.io/jira', key: 'PROJ-9', loose: false },
    ],
    [
      'https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-5',
      { kind: 'url', provider: 'jira', root: 'https://acme.atlassian.net', key: 'PROJ-5', loose: true },
    ],
    [
      'https://acme.atlassian.net/jira/software/projects/PROJ/issues/PROJ-123',
      { kind: 'url', provider: 'jira', root: 'https://acme.atlassian.net', key: 'PROJ-123', loose: true },
    ],
    [
      'https://acme.atlassian.net/jira/software/c/projects/PROJ/issues/proj-7?filter=allissues',
      { kind: 'url', provider: 'jira', root: 'https://acme.atlassian.net', key: 'PROJ-7', loose: true },
    ],
    [
      'https://acme.atlassian.net/jira/software/c/projects/PROJ/issues/?jql=x&selectedIssue=PROJ-8',
      { kind: 'url', provider: 'jira', root: 'https://acme.atlassian.net', key: 'PROJ-8', loose: true },
    ],
    [
      'https://github.com/Acme/Web/issues/12',
      { kind: 'url', provider: 'github', root: 'https://github.com', key: 'acme/web#12', loose: false },
    ],
    [
      'https://linear.app/Acme/issue/eng-4/some-slug',
      { kind: 'url', provider: 'linear', root: 'https://linear.app/acme', key: 'ENG-4', loose: false },
    ],
  ])('%s', (raw, want) => {
    expect(parseTicketRef(raw)).toEqual(want);
  });

  it.each([
    '',
    'hello',
    'https://github.com/acme/web/pull/12', // a pull request is not an issue
    'https://example.com/some/page',
    'javascript:alert(1)',
    'https://linear.app/acme/project/x',
    'https://gitlab.com/acme/web/-/issues/12', // an issue number is not a Jira key
    'x'.repeat(2001),
  ])('invalid: %s', (raw) => {
    expect(parseTicketRef(raw)).toEqual({ kind: 'invalid' });
  });

  it('splits on commas, semicolons and whitespace, and drops duplicates', () => {
    expect(splitTicketRefs('PROJ-1, proj-1\nPROJ-2;  https://x.atlassian.net/browse/PROJ-3/ (PROJ-4)')).toEqual([
      'PROJ-1',
      'PROJ-2',
      'https://x.atlassian.net/browse/PROJ-3/',
      'PROJ-4',
    ]);
  });
});

describe('decideRef against a workspace tracker', () => {
  const jira = { provider: 'jira' as const, apiRoot: 'https://acme.atlassian.net' };
  const gh = { provider: 'github' as const, apiRoot: 'https://github.com' };
  const linear = { provider: 'linear' as const, apiRoot: 'https://linear.app/acme' };
  const repo = { owner: 'acme', name: 'web' };

  it('keys and links for the workspace’s own tracker', () => {
    expect(decideRef('eng-7', jira, null)).toEqual({ key: 'ENG-7' });
    expect(decideRef('https://acme.atlassian.net/browse/ENG-7', jira, null)).toEqual({ key: 'ENG-7' });
    expect(decideRef('https://acme.atlassian.net/jira/x?selectedIssue=ENG-7', jira, null)).toEqual({ key: 'ENG-7' });
    expect(decideRef('https://acme.atlassian.net/jira/software/projects/ENG/issues/ENG-7', jira, null)).toEqual({ key: 'ENG-7' });
    expect(decideRef('#12', gh, repo)).toEqual({ key: 'acme/web#12' });
    expect(decideRef('https://github.com/other/lib/issues/3', gh, repo)).toEqual({ key: 'other/lib#3' });
    expect(decideRef('https://linear.app/acme/issue/ENG-4/slug', linear, null)).toEqual({ key: 'ENG-4' });
  });

  it.each([
    ['https://linear.app/acme/issue/ENG-4', jira],
    ['https://other.atlassian.net/browse/ENG-7', jira],
    ['acme/web#12', jira],
    ['#12', linear],
    ['ENG-7', gh],
    ['https://linear.app/someone-else/issue/ENG-4', linear],
  ])('refuses %s as another tracker', (raw, call) => {
    expect(decideRef(raw, call, repo)).toMatchObject({ status: 'other_tracker' });
  });
});

// ---- the route ----

const ACCOUNT = 1;
const WS = 2; // Platform — repo 200, Jira with a token
const WS_NO_TOKEN = 1; // Default — repo 100, Jira without a token
const TOKEN = 'ATATT3xFfGF0-secret';

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
const coreRepos = sqliteTable('repos', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
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

const host = { version: 'test', deploymentMode: 'local' as const, isCloud: false };

let app: FastifyInstance;
let sqlite: Database.Database;
let ctx: TrackerContext;
const calls: string[] = [];
// key → Jira's answer; anything else is a 404.
let issues: Record<string, string> = {};
const transport: JiraTransport = async (url) => {
  calls.push(String(url));
  const key = /\/issue\/([^?/]+)/.exec(String(url))?.[1] ?? '';
  const title = issues[decodeURIComponent(key)];
  const res: RawResponse =
    title != null
      ? {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ key, names: {}, fields: { summary: title, description: 'Story text', issuetype: { id: '1', name: 'Story' } } }),
        }
      : { status: 404, contentType: 'application/json', body: '{}' };
  return res;
};

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,1,100),(1,2,200),(2,90,900);' +
      'CREATE TABLE repos (id integer PRIMARY KEY, account_id integer NOT NULL, owner text NOT NULL, name text NOT NULL);' +
      "INSERT INTO repos VALUES (100,1,'acme','api'),(200,1,'acme','web'),(900,2,'evil','x');" +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, ' +
      "repo_id integer NOT NULL, title text NOT NULL, head_ref_name text, state text DEFAULT 'open', " +
      'github_node_id text, updated_at integer, closing_issues text, closing_issues_checked_at integer, ' +
      'linear_links text, linear_links_root text, linear_links_checked_at integer, number integer);' +
      "INSERT INTO pull_requests (id, account_id, repo_id, title) VALUES (10,1,200,'ENG-7 reset password');" +
      "INSERT INTO pull_requests (id, account_id, repo_id, title) VALUES (11,1,100,'no ticket here');" +
      "INSERT INTO pull_requests (id, account_id, repo_id, title) VALUES (90,2,900,'foreign');",
  );
  sqlite.exec(
    'CREATE TABLE pro_settings (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'issue_provider text, issue_base_url text, issue_project_keys text);',
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));

  ctx = {
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
      repos: coreRepos,
      pullRequests: corePullRequests,
    },
  } as unknown as TrackerContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx, { transport });
  await app.ready();
  for (const ws of [WS, WS_NO_TOKEN]) {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws}/tracker`,
      payload: {
        issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] },
        ...(ws === WS ? { jira: { token: TOKEN } } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

beforeEach(() => {
  calls.length = 0;
  issues = { 'ENG-7': 'Reset password', 'OPS-3': 'Rotate keys', 'ENG-20': 'Audit log' };
  resetTrackerWorker();
  sqlite.exec('DELETE FROM tracker_tickets;');
});

const resolve = (prId: number, refs: string[], link: boolean) =>
  app.inject({ method: 'POST', url: `/api/prs/${prId}/tracker-ticket/resolve`, payload: { refs, link } });
const manualRows = (): Array<{ issue_key: string; detected_from: string; state: string }> =>
  sqlite.prepare("SELECT issue_key, detected_from, state FROM tracker_tickets WHERE detected_from = 'manual'").all() as Array<{
    issue_key: string;
    detected_from: string;
    state: string;
  }>;

describe('POST /api/prs/:id/tracker-ticket/resolve', () => {
  it('another account’s PR → 404, before any tracker call', async () => {
    expect((await resolve(90, ['ENG-7'], true)).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it(`more than ${TICKET_REFS_MAX} references → 400 with our own sentence`, async () => {
    const refs = Array.from({ length: TICKET_REFS_MAX + 1 }, (_, i) => `OPS-${i + 1}`);
    const res = await resolve(10, refs, false);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TooManyRefs');
    expect(calls).toEqual([]);
  });

  it('a workspace with no token → 400, no call', async () => {
    const res = await resolve(11, ['OPS-3'], false);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NoJiraToken');
    expect(calls).toEqual([]);
  });

  it('refuses other trackers, other sites and junk without calling Jira', async () => {
    const res = await resolve(
      10,
      ['https://linear.app/acme/issue/ENG-4', 'https://evil.example/browse/OPS-3', 'acme/web#12', 'not a ticket'],
      true,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual([
      'other_tracker',
      'other_tracker',
      'other_tracker',
      'invalid',
    ]);
    expect(calls).toEqual([]);
    expect(manualRows()).toEqual([]);
  });

  it('link: false reads and stores nothing', async () => {
    const res = await resolve(10, ['https://acme.atlassian.net/browse/OPS-3'], false);
    expect(res.json().results[0]).toMatchObject({
      status: 'found',
      key: 'OPS-3',
      title: 'Rotate keys',
      ident: 'jira:https://acme.atlassian.net#OPS-3',
      url: 'https://acme.atlassian.net/browse/OPS-3',
    });
    expect(calls).toHaveLength(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM tracker_tickets').get()).toEqual({ n: 0 });
  });

  it('a key the PR already names → already, never a manual row', async () => {
    const res = await resolve(10, ['eng-7'], true);
    expect(res.json().results[0]).toMatchObject({ status: 'already', key: 'ENG-7', title: 'Reset password' });
    expect(manualRows()).toEqual([]);
  });

  it('link: true stores a manual row that detection carries and the worker keeps', async () => {
    // OPS is not on the workspace's ENG allowlist: a person named it, so it is kept anyway.
    const res = await resolve(10, ['OPS-3', 'ops-3'], true);
    expect(res.json().results).toHaveLength(1); // two spellings, one reference
    expect(res.json().results[0]).toMatchObject({ status: 'linked', key: 'OPS-3', title: 'Rotate keys' });
    expect(manualRows()).toEqual([{ issue_key: 'OPS-3', detected_from: 'manual', state: 'ok' }]);

    // The PR-detail chips and the ticket review's stories carry it after the detected ENG-7.
    const refs = await prTicketRefs(ctx, { accountId: ACCOUNT, prId: 10, repoId: 200, title: 'ENG-7 reset password', headRefName: null });
    expect(refs?.map((r) => r.key)).toEqual(['ENG-7', 'OPS-3']);
    const stories = await resolvePrTickets(ctx, ACCOUNT, 10, { transport });
    expect(stories?.tickets.map((t) => t.key)).toEqual(['ENG-7', 'OPS-3']);

    // A worker pass (a forced re-read of ENG-7) does not prune it.
    await syncOnePrNow(ctx, ACCOUNT, 10, ['ENG-7'], { force: true, transport });
    expect(manualRows()).toEqual([{ issue_key: 'OPS-3', detected_from: 'manual', state: 'ok' }]);

    // Pasting it again answers "already".
    expect((await resolve(10, ['OPS-3'], true)).json().results[0].status).toBe('already');

    // Only the hand-added ticket is marked removable.
    expect(refs?.map((r) => r.manual === true)).toEqual([false, true]);
    // Another account cannot remove it; a detected ticket has no manual row to remove.
    expect((await app.inject({ method: 'DELETE', url: '/api/prs/90/tracker-ticket/manual?key=OPS-3' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/prs/10/tracker-ticket/manual?key=ENG-7' })).json()).toEqual({ removed: 0 });
    // Removing it drops it from the PR's tickets.
    const del = await app.inject({ method: 'DELETE', url: '/api/prs/10/tracker-ticket/manual?key=ops-3' });
    expect(del.json()).toEqual({ removed: 1 });
    expect(manualRows()).toEqual([]);
    const after = await prTicketRefs(ctx, { accountId: ACCOUNT, prId: 10, repoId: 200, title: 'ENG-7 reset password', headRefName: null });
    expect(after?.map((r) => r.key)).toEqual(['ENG-7']);
  });

  it('a ticket the tracker does not have is not kept', async () => {
    const res = await resolve(10, ['OPS-404'], true);
    expect(res.json().results[0]).toMatchObject({ status: 'not_found', key: 'OPS-404' });
    expect(res.json().results[0].message).toContain('OPS-404');
    expect(manualRows()).toEqual([]);
  });

  it('a manual row on another site is not one of the PR’s tickets, and the worker prunes it', async () => {
    sqlite.exec(
      "INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, api_root, url, state, checked_at, next_check_at) " +
        "VALUES (1, 2, 10, 'jira', 'OPS-9', 'manual', 1000, 'https://old.atlassian.net', '', 'ok', 0, 0)",
    );
    const refs = await prTicketRefs(ctx, { accountId: ACCOUNT, prId: 10, repoId: 200, title: 'ENG-7 reset password', headRefName: null });
    expect(refs?.map((r) => r.key)).toEqual(['ENG-7']);
    await syncOnePrNow(ctx, ACCOUNT, 10, ['ENG-7'], { force: true, transport });
    expect(manualRows()).toEqual([]);
  });
});
