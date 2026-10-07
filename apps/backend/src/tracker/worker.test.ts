// ── THE JIRA TICKET WORKER + THE STORED TICKETS (core migration 0088) ─────────────────────────
//
// Jira is read when a pull request is RECEIVED, never when it is viewed. Pinned here:
//   1. SELECTION: a new PR's tickets are read; a second pass reads nothing; a changed key set
//      deletes the stale row and reads only the new key; a row past its TTL is read again; a
//      CLOSED PR is not walked; the pass is BOUNDED (new tickets first).
//   2. STORAGE ROUND TRIP: title, description (markdown), criteria + field, issue type, status +
//      category, assignee, where it was detected, and the read state.
//   3. REFUSALS ARE REMEMBERED: 404 → `not_found` for 6 h; a transient error keeps the content; a
//      401 backs the WORKSPACE off until the token changes. The worker is off without `issueLinks`.
//   4. THE FIELD SETTING: `PUT …/ac-field` stores the choice per (workspace, site, issue type),
//      re-derives every stored ticket of that type with no Jira call, and re-reads only the named
//      ticket; "Reset to default" clears it. Refresh re-reads a fresh ticket.
//   5. CONSUMERS MAKE ZERO JIRA CALLS on stored rows (the ticket route, the auto review fill).
//   6. ISOLATION: another account's rows are never read, re-derived, pruned or erased.
//   8. MERGED PRs: a PR open when seen keeps its rows after it merges (never refreshed or pruned);
//      a PR that merged before the worker saw it gets its rows ONCE (90-day window, never a
//      closed-unmerged PR), one Jira read per ticket — copied from a stored row when one exists —
//      bounded, behind new open tickets; the repo window is one-time until a repo walk re-opens it.
//   7. TICKET PEERS (core 0088) for core's ticket review: every PR on one ticket (same site, this
//      account), and `changed_at` moving on membership / story text only — never on a TTL re-read
//      that changed nothing.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/tracker/tracker-ticket-sync.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTrackerRoutes } from './routes.js';
import { resolvePrTickets } from './stories.js';
import { readStoredTickets } from './store.js';
import { listChangedTicketIdents, ticketMembers, ticketsForPr, ticketStory } from './peers.js';
import {
  enableTrackerWorker,
  FAILED_TTL_MS,
  FULL_RESCAN_MS,
  kickTrackerSync,
  MERGED_WINDOW_MS,
  OK_TTL_MS,
  REFUSED_TTL_MS,
  resetTrackerWorker,
  runAccountPass,
  runTrackerTick,
} from './worker.js';
import type { JiraTransport, RawResponse } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

// The plugin's AUTO-review story fill, spelled over the SAME shared body core kept
// (`resolvePrTickets`); core itself no longer calls a fill (the ticket review reads stories).
const resolveAutoReviewTicket = async (
  c: Parameters<typeof resolvePrTickets>[0],
  accountId: number,
  prId: number,
  opts: Parameters<typeof resolvePrTickets>[3] = {},
) => {
  const r = await resolvePrTickets(c, accountId, prId, { logLabel: 'auto claude review', ...opts });
  if (r == null) return { ticket: null, key: null, tickets: [] as Array<import('@pierre-review/shared').ClaudeReviewTicket> };
  const tickets = r.tickets.map((t) => t.ticket);
  return { ticket: tickets[0] ?? null, key: tickets[0]?.key ?? r.first, tickets };
};


const A = 1;
const B = 2;
const WS_A = 2; // account 1, Jira + token, repo 200
const WS_A_LINEAR = 3; // account 1, Linear, repo 300
const WS_B = 90; // account 2, Jira + token, repo 900
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
  state: text('state').notNull(),
  mergedAt: integer('merged_at', { mode: 'timestamp' }),
  githubNodeId: text('github_node_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  closingIssues: text('closing_issues', { mode: 'json' }),
  closingIssuesCheckedAt: integer('closing_issues_checked_at', { mode: 'timestamp' }),
  number: integer('number'),
  linearLinks: text('linear_links', { mode: 'json' }),
  linearLinksRoot: text('linear_links_root'),
  linearLinksCheckedAt: integer('linear_links_checked_at', { mode: 'timestamp' }),
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

let sqlite: Database.Database;
let ctx: TrackerContext;
let app: FastifyInstance;
let accountOfRequest = A;
let clock = Date.UTC(2026, 9, 3, 9, 0);
const now = () => clock;
const calls: string[] = [];

// Jira's answers, per key. `status` / `assignee` / the criteria fields move between tests.
const jira = new Map<string, { status?: number; summary?: string; statusName?: string; category?: string; type?: string }>();
const issueJson = (key: string): string => {
  const j = jira.get(key) ?? {};
  return JSON.stringify({
    key,
    names: { customfield_1: 'Acceptance Criteria', customfield_2: 'Definition of Done', customfield_3: 'Notes' },
    fields: {
      summary: j.summary ?? `Title of ${key}`,
      description: 'h1. Story\r\nAs a *user*',
      issuetype: { id: j.type ?? '10001', name: j.type === '10004' ? 'Bug' : 'Story' },
      status: { name: j.statusName ?? 'In Review', statusCategory: { key: j.category ?? 'indeterminate' } },
      assignee: { displayName: 'Ada Lovelace', accountId: 'acc-ada', avatarUrls: { '48x48': 'https://a.example/ada.png' } },
      customfield_1: `AC of ${key}`,
      customfield_2: `DoD of ${key}`,
      customfield_3: `Notes of ${key}`,
    },
  });
};
const transport: JiraTransport = async (url) => {
  const u = String(url);
  calls.push(u);
  const key = /issue\/([^?]+)/.exec(u)?.[1] ?? '';
  const status = jira.get(key)?.status ?? 200;
  if (status !== 200) return { status, contentType: 'application/json', body: '{"errorMessages":["upstream secret"]}' } as RawResponse;
  return { status: 200, contentType: 'application/json', body: issueJson(key) };
};

const setPr = (id: number, title: string, branch: string | null = null, state = 'open') =>
  sqlite
    .prepare('UPDATE pull_requests SET title = ?, head_ref_name = ?, state = ? WHERE id = ?')
    .run(title, branch, state, id);
const rows = (accountId: number, prIds: number[]) => readStoredTickets(ctx, accountId, prIds);
const pass = (accountId = A, budget?: number) =>
  runAccountPass(ctx, accountId, { transport, now, ...(budget != null ? { budget } : {}) });

beforeAll(async () => {
  sqlite = new Database(':memory:');
  // better-sqlite3 enforces foreign keys: `workspace_trackers` references accounts + workspaces.
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(3,1,'Linear',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,2,200),(1,3,300),(2,90,900);' +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, ' +
      'repo_id integer NOT NULL, title text NOT NULL, head_ref_name text, state text NOT NULL, merged_at integer);' +
      "INSERT INTO pull_requests VALUES (10,1,200,'x',null,'open',null),(11,1,200,'x',null,'open',null),(12,1,200,'x',null,'open',null)," +
      "(13,1,300,'ENG-50 linear',null,'open',null),(90,2,900,'x',null,'open',null)," +
      "(20,1,200,'x',null,'closed',null),(21,1,200,'x',null,'closed',null),(22,1,200,'x',null,'closed',null);",
  );
  sqlite.exec(
    'CREATE TABLE workspace_period_reports (id integer PRIMARY KEY AUTOINCREMENT, ' +
      'account_id integer NOT NULL, workspace_id integer NOT NULL, period_key text NOT NULL, ' +
      'model text NOT NULL, cadence_days integer NOT NULL, period_end integer);' +
      'CREATE TABLE pro_settings (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'comparison_mode text, report_model text, bot_slack_digest integer, bot_auto_resolve integer, ' +
      'bot_auto_resolve_days integer, bot_cost_json text, ' +
      'issue_provider text, issue_base_url text, issue_project_keys text, ' +
      'created_at integer NOT NULL DEFAULT (unixepoch()), ' +
      'updated_at integer NOT NULL DEFAULT (unixepoch()));' +
      'CREATE UNIQUE INDEX pro_settings_account ON pro_settings (account_id);' +
      // The other per-PR tables pruneProByPrIds clears first (stubs: only the predicate column).
      'CREATE TABLE ai_pr_analyses (id integer PRIMARY KEY, account_id integer, pr_id integer);' +
      'CREATE TABLE comment_assessments (id integer PRIMARY KEY, account_id integer, pr_id integer);' +
      'CREATE TABLE pr_comment_annotations (id integer PRIMARY KEY, account_id integer, pr_id integer);',
  );
  // The core tracker tables (migration 0088), exactly as a real install has them.
  sqlite.exec(migration('0088_issue_tracker.sql'));
  // The PR columns the GitHub Issues linker reads (migration 0089).
  for (const col of ['github_node_id text', 'updated_at integer', 'closing_issues text', 'closing_issues_checked_at integer', 'linear_links text', 'linear_links_root text', 'linear_links_checked_at integer', 'number integer']) {
    try {
      sqlite.exec(`ALTER TABLE pull_requests ADD ${col}`);
    } catch {
      /* the stub already has it */
    }
  }

  ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host,
    accountIdOf: () => accountOfRequest,
    defaultWorkspaceId: async () => 1,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { workspaces: coreWorkspaces, workspaceRepos: coreWorkspaceRepos, pullRequests: corePullRequests , trackerTickets, jiraAcFields, workspaceTrackers },
  } as unknown as TrackerContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx, { transport });
  await app.ready();

  const put = async (account: number, ws: number, body: unknown) => {
    accountOfRequest = account;
    const r = await app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
    expect(r.statusCode).toBe(200);
  };
  for (const [acct, ws] of [
    [A, WS_A],
    [B, WS_B],
  ] as const) {
    await put(acct, ws, {
      issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] },
      jira: { token: TOKEN },
    });
  }
  await put(A, WS_A_LINEAR, { issue: { provider: 'linear', baseUrl: 'https://linear.app/acme', projectKeys: ['ENG'] } });
  accountOfRequest = A;
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

beforeEach(() => {
  calls.length = 0;
  jira.clear();
  resetTrackerWorker();
  enableTrackerWorker(true);
  accountOfRequest = A;
  clock = Date.UTC(2026, 9, 3, 9, 0);
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM pro_jira_ac_fields;');
  setPr(10, 'ENG-7 reset password', 'feature/ENG-8-extra');
  setPr(11, 'No ticket', null);
  setPr(12, 'No ticket', null);
  for (const id of [20, 21, 22]) setPr(id, 'No ticket', null, 'closed');
  sqlite.exec('UPDATE pull_requests SET merged_at = NULL');
  sqlite.prepare("UPDATE pull_requests SET title = 'ENG-7 foreign', state = 'open' WHERE id = 90").run();
});

describe('1. selection', () => {
  it('a new PR: its tickets are read once and stored; a second pass reads nothing', async () => {
    const s = await pass();
    expect(s.fetched).toBe(2);
    expect(calls.map((u) => /issue\/([^?]+)/.exec(u)?.[1])).toEqual(['ENG-7', 'ENG-8']);
    expect((await rows(A, [10])).map((r) => [r.issueKey, r.detectedFrom, r.detectOrder, r.state])).toEqual([
      ['ENG-7', 'title', 0, 'ok'],
      ['ENG-8', 'branch', 1, 'ok'],
    ]);
    calls.length = 0;
    expect((await pass()).fetched).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a title edit that changes the keys deletes the stale row and reads only the new key', async () => {
    await pass();
    calls.length = 0;
    setPr(10, 'ENG-20 reset password', 'feature/ENG-8-extra');
    const s = await pass();
    expect(s.deleted).toBe(1);
    expect(calls.map((u) => /issue\/([^?]+)/.exec(u)?.[1])).toEqual(['ENG-20']);
    expect((await rows(A, [10])).map((r) => r.issueKey).sort()).toEqual(['ENG-20', 'ENG-8']);
  });

  it('a key that MOVES (branch → title) is re-labelled without a Jira call', async () => {
    await pass();
    calls.length = 0;
    setPr(10, 'ENG-8 and ENG-7', null);
    await pass();
    expect(calls).toHaveLength(0);
    expect((await rows(A, [10])).map((r) => [r.issueKey, r.detectedFrom, r.detectOrder])).toEqual([
      ['ENG-8', 'title', 0],
      ['ENG-7', 'title', 1],
    ]);
  });

  it('past the TTL a row is read again, so status and title stay fresh', async () => {
    await pass();
    calls.length = 0;
    jira.set('ENG-7', { statusName: 'Done', category: 'done', summary: 'Renamed' });
    clock += OK_TTL_MS - 1000;
    expect((await pass()).fetched).toBe(0);
    clock += 2000;
    expect((await pass()).fetched).toBe(2);
    const r = (await rows(A, [10])).find((x) => x.issueKey === 'ENG-7')!;
    expect([r.title, r.statusName, r.statusCategory]).toEqual(['Renamed', 'Done', 'done']);
  });

  it('a CLOSED PR is not walked', async () => {
    setPr(10, 'ENG-7 reset password', null, 'merged');
    expect((await pass()).fetched).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('BOUNDED: over budget the rest waits for the next pass, new tickets first', async () => {
    await pass(A, 1);
    expect(calls).toHaveLength(1);
    // ENG-7 is now stored; make it due, and give PR 11 a NEW ticket: the new one goes first.
    clock += OK_TTL_MS + 1;
    setPr(11, 'ENG-30 new', null);
    calls.length = 0;
    const s = await pass(A, 1);
    expect(calls.map((u) => /issue\/([^?]+)/.exec(u)?.[1])).toEqual(['ENG-30']);
    expect(s.pending).toBeGreaterThan(0);
  });

  it('the tick covers every account with a Jira workspace; a Linear workspace is never read', async () => {
    await runTrackerTick(ctx, { transport, now });
    expect((await rows(A, [10])).length).toBe(2);
    expect((await rows(B, [90])).length).toBe(1);
    expect(await rows(A, [13])).toEqual([]);
    expect(calls.some((u) => u.includes('ENG-50'))).toBe(false);
  });

  it('the worker is OFF without issueLinks: a kick and a tick read nothing', async () => {
    enableTrackerWorker(false);
    await kickTrackerSync(ctx, A, { transport });
    await runTrackerTick(ctx, { transport, now });
    expect(calls).toHaveLength(0);
  });
});

describe('2. the stored row', () => {
  it('round-trips every field the consumers read', async () => {
    await pass();
    const r = (await rows(A, [10]))[0]!;
    expect(r).toMatchObject({
      accountId: A,
      workspaceId: WS_A,
      prId: 10,
      issueKey: 'ENG-7',
      apiRoot: 'https://acme.atlassian.net',
      url: 'https://acme.atlassian.net/browse/ENG-7',
      state: 'ok',
      errorCode: null,
      title: 'Title of ENG-7',
      description: '# Story\nAs a **user**',
      acceptanceCriteria: 'AC of ENG-7',
      acFieldId: 'customfield_1',
      acFieldName: 'Acceptance Criteria',
      acFieldSource: 'default',
      issueTypeId: '10001',
      issueTypeName: 'Story',
      statusName: 'In Review',
      statusCategory: 'indeterminate',
      assigneeName: 'Ada Lovelace',
      assigneeAccountId: 'acc-ada',
      assigneeAvatarUrl: 'https://a.example/ada.png',
      omittedCandidates: 0,
    });
    expect(JSON.parse(r.candidatesJson!).map((c: { id: string }) => c.id)).toEqual([
      'customfield_1',
      'customfield_2',
      'customfield_3',
    ]);
    expect(new Date(r.fetchedAt!).getTime()).toBe(clock);
    expect(new Date(r.nextCheckAt).getTime()).toBe(clock + OK_TTL_MS);
  });
});

describe('3. refusals are remembered', () => {
  it('404 → not_found, content empty, not asked again for 6 h', async () => {
    jira.set('ENG-7', { status: 404 });
    await pass();
    const r = (await rows(A, [10])).find((x) => x.issueKey === 'ENG-7')!;
    expect([r.state, r.errorCode, r.title]).toEqual(['not_found', 'not_found', null]);
    expect(new Date(r.nextCheckAt).getTime()).toBe(clock + REFUSED_TTL_MS);
    calls.length = 0;
    clock += OK_TTL_MS + 1;
    await pass();
    expect(calls.filter((u) => u.includes('ENG-7'))).toHaveLength(0);
  });

  it('a transient error on a row that once read keeps its content', async () => {
    await pass();
    clock += OK_TTL_MS + 1;
    jira.set('ENG-7', { status: 500 });
    await pass();
    const r = (await rows(A, [10])).find((x) => x.issueKey === 'ENG-7')!;
    expect([r.state, r.errorCode, r.title]).toEqual(['ok', 'http', 'Title of ENG-7']);
  });

  it('a 401 backs the WORKSPACE off — no rows, no further calls — until the token changes', async () => {
    jira.set('ENG-7', { status: 401 });
    jira.set('ENG-8', { status: 401 });
    await pass();
    expect(await rows(A, [10])).toEqual([]);
    const n = calls.length;
    expect(n).toBeGreaterThan(0);
    await pass();
    expect(calls.length).toBe(n);
    // A new token is a new fingerprint: the backoff no longer applies.
    jira.clear();
    accountOfRequest = A;
    await app.inject({ method: 'PUT', url: `/api/workspaces/${WS_A}/tracker`, payload: { jira: { token: 'new-token' } } });
    await pass();
    expect((await rows(A, [10])).length).toBe(2);
    await app.inject({ method: 'PUT', url: `/api/workspaces/${WS_A}/tracker`, payload: { jira: { token: TOKEN } } });
  });
});

const acField = (prId: number, key: string, fieldId: string | null) =>
  app.inject({ method: 'PUT', url: `/api/prs/${prId}/tracker-ticket/ac-field`, payload: { key, fieldId } });

describe('4. the acceptance-criteria field setting', () => {
  it('stores the choice per issue type, re-derives every stored ticket of the type, re-reads only this one', async () => {
    setPr(11, 'ENG-31 other story', null);
    await pass();
    calls.length = 0;
    const res = await acField(10, 'ENG-7', 'customfield_2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      key: 'ENG-7',
      acceptanceCriteria: 'DoD of ENG-7',
      acField: { id: 'customfield_2', name: 'Definition of Done' },
      acFieldSource: 'setting',
    });
    expect(calls.map((u) => /issue\/([^?]+)/.exec(u)?.[1])).toEqual(['ENG-7']);
    // The other Story on another PR moved with it — with no Jira call — and is due for a re-read.
    const other = (await rows(A, [11]))[0]!;
    expect([other.acceptanceCriteria, other.acFieldSource]).toEqual(['DoD of ENG-31', 'setting']);
    expect(new Date(other.nextCheckAt).getTime()).toBe(0);
    expect(sqlite.prepare('SELECT account_id, workspace_id, api_root, issue_type_id, field_id FROM pro_jira_ac_fields').all()).toEqual([
      { account_id: A, workspace_id: WS_A, api_root: 'https://acme.atlassian.net', issue_type_id: '10001', field_id: 'customfield_2' },
    ]);
    // The worker applies it on its next read of a NEW ticket of the type.
    setPr(12, 'ENG-32 third story', null);
    await pass();
    expect((await rows(A, [12]))[0]!.acceptanceCriteria).toBe('DoD of ENG-32');
  });

  it('a different issue type keeps the default; "Reset to default" clears the choice', async () => {
    jira.set('ENG-8', { type: '10004' });
    await pass();
    await acField(10, 'ENG-7', 'customfield_3');
    expect((await rows(A, [10])).find((r) => r.issueKey === 'ENG-8')!.acceptanceCriteria).toBe('AC of ENG-8');
    const reset = await acField(10, 'ENG-7', null);
    expect(reset.json()).toMatchObject({ acceptanceCriteria: 'AC of ENG-7', acFieldSource: 'default' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM pro_jira_ac_fields').get()).toEqual({ n: 0 });
  });

  it('refuses a field the ticket does not have, and a key the PR does not carry', async () => {
    await pass();
    expect((await acField(10, 'ENG-7', 'customfield_999')).statusCode).toBe(400);
    expect((await acField(10, 'ENG-999', 'customfield_1')).json().error).toBe('TicketNotDetected');
  });

  it('Refresh re-reads a FRESH ticket now', async () => {
    await pass();
    calls.length = 0;
    jira.set('ENG-7', { statusName: 'Done', category: 'done' });
    const res = await app.inject({ method: 'POST', url: '/api/prs/10/tracker-ticket/refresh', payload: { key: 'ENG-7' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'Done', statusCategory: 'done' });
    expect(calls).toHaveLength(1);
  });
});

describe('5. consumers read stored rows with ZERO Jira calls', () => {
  it('the ticket route and the auto review fill', async () => {
    await pass();
    calls.length = 0;
    const res = await app.inject({ method: 'GET', url: '/api/prs/10/tracker-ticket?key=ENG-8' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      key: 'ENG-8',
      title: 'Title of ENG-8',
      status: 'In Review',
      assignee: { name: 'Ada Lovelace', avatarUrl: 'https://a.example/ada.png' },
    });
    const auto = await resolveAutoReviewTicket(ctx, A, 10, { transport });
    expect(auto.tickets.map((t) => [t.key, t.acceptanceCriteria])).toEqual([
      ['ENG-7', 'AC of ENG-7'],
      ['ENG-8', 'AC of ENG-8'],
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe('6. isolation', () => {
  it('another account’s rows are never read or re-derived', async () => {
    await runTrackerTick(ctx, { transport, now });
    // Account 1 asking for account 2's PR id finds nothing.
    expect(await rows(A, [90])).toEqual([]);
    expect((await rows(B, [90])).map((r) => r.issueKey)).toEqual(['ENG-7']);
    // Account 2's PR through account 1's routes: 404, and no field write leaks across.
    expect((await app.inject({ method: 'GET', url: '/api/prs/90/tracker-ticket?key=ENG-7' })).statusCode).toBe(404);
    await acField(10, 'ENG-7', 'customfield_2');
    expect((await rows(B, [90]))[0]!.acceptanceCriteria).toBe('AC of ENG-7');
    // (Pruning and erasure are core's delete paths now — db/delete-repo.test.ts, db/retention.test.ts
    // and db/erase-account.test.ts pin `tracker_tickets` / `pro_jira_ac_fields` in each.)
  });
});

describe('7. ticket peers', () => {
  it('members: every PR on one ticket in this account, on the same site', async () => {
    setPr(12, 'ENG-7 also');
    await pass();
    await pass(B);
    const apiRoot = (await rows(A, [10]))[0]!.apiRoot;
    const ident = `jira:${apiRoot}#ENG-7`;
    expect(await ticketMembers(ctx, A, ident)).toEqual([
      { prId: 10, workspaceId: WS_A },
      { prId: 12, workspaceId: WS_A },
    ]);
    expect(await ticketMembers(ctx, B, ident)).toEqual([{ prId: 90, workspaceId: WS_B }]);
    expect(await ticketMembers(ctx, A, 'jira:https://other.example#ENG-7')).toEqual([]);
    expect(await ticketMembers(ctx, A, 'manual:10:abcdef12')).toEqual([]);
    const forPr = await ticketsForPr(ctx, A, 10);
    expect(forPr.map((t) => t.ident)).toEqual([ident, `jira:${apiRoot}#ENG-8`]);
    expect(forPr[0]!.ticket.key).toBe('ENG-7');
    expect(forPr[0]!.ticketHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changed_at moves on membership and story text only', async () => {
    setPr(12, 'ENG-7 also');
    await pass();
    const apiRoot = (await rows(A, [10]))[0]!.apiRoot;
    const at0 = clock;
    expect(await listChangedTicketIdents(ctx, A, at0)).toEqual([
      `jira:${apiRoot}#ENG-7`,
      `jira:${apiRoot}#ENG-8`,
    ]);
    // A TTL re-read that changes only the status: nothing moved.
    clock += OK_TTL_MS + 1000;
    jira.set('ENG-7', { statusName: 'Done', category: 'done' });
    await pass();
    const at1 = clock;
    expect(await listChangedTicketIdents(ctx, A, at1)).toEqual([]);
    // The title is edited in Jira: the story moved.
    clock += OK_TTL_MS + 1000;
    jira.set('ENG-7', { summary: 'Renamed' });
    await pass();
    expect(await listChangedTicketIdents(ctx, A, clock)).toEqual([`jira:${apiRoot}#ENG-7`]);
    // PR 12 drops the key: its row goes, and the ticket is still found through PR 10's row.
    clock += 60_000;
    const at3 = clock;
    setPr(12, 'No ticket');
    await pass();
    expect(await listChangedTicketIdents(ctx, A, at3)).toEqual([`jira:${apiRoot}#ENG-7`]);
    expect((await ticketMembers(ctx, A, `jira:${apiRoot}#ENG-7`)).map((m) => m.prId)).toEqual([10]);
    expect(await listChangedTicketIdents(ctx, B, at0)).toEqual([]);
  });

  it('⚠ the story is the FRESHEST stored row: a merged PR keeps the text it merged with', async () => {
    setPr(12, 'ENG-7 also');
    await pass();
    const apiRoot = (await rows(A, [10]))[0]!.apiRoot;
    const ident = `jira:${apiRoot}#ENG-7`;
    // PR 12 merges; the worker reads open PRs only, so only PR 10's row sees the edit.
    setPr(12, 'ENG-7 also', null, 'merged');
    clock += OK_TTL_MS + 1000;
    jira.set('ENG-7', { summary: 'Edited after the merge' });
    await pass();
    const byPr = new Map((await rows(A, [10, 12])).filter((r) => r.issueKey === 'ENG-7').map((r) => [r.prId, r.title]));
    expect(byPr.get(12)).not.toBe('Edited after the merge');
    expect(byPr.get(10)).toBe('Edited after the merge');
    expect((await ticketStory(ctx, A, ident))?.title).toBe('Edited after the merge');
    expect(await ticketStory(ctx, B, `jira:${apiRoot}#ENG-404`)).toBeNull();
    expect(await ticketStory(ctx, A, 'manual:10:abcdef12')).toBeNull();
  });

  it('⚠ ticketsForPr reads stored rows only: a key the worker has not reached costs no Jira call', async () => {
    setPr(11, 'ENG-55 brand new');
    calls.length = 0;
    const got = await ticketsForPr(ctx, A, 11);
    expect(got.map((t) => t.ticket.key)).not.toContain('ENG-55');
    expect(calls).toHaveLength(0);
  });
});

describe('8. merged pull requests', () => {
  const DAY = 24 * 60 * 60_000;
  const merge = (id: number, title: string, agoMs: number) => {
    setPr(id, title, null, 'merged');
    sqlite.prepare('UPDATE pull_requests SET merged_at = ? WHERE id = ?').run(Math.floor((clock - agoMs) / 1000), id);
  };
  const keysRead = () => calls.map((u) => /issue\/([^?]+)/.exec(u)?.[1]);

  it('a PR merged before the worker saw it gets its row once; core sees it as a member', async () => {
    setPr(10, 'No ticket', null);
    merge(20, 'ENG-40 engine fix', 30 * DAY);
    const at = clock;
    const s = await pass();
    expect(keysRead()).toEqual(['ENG-40']);
    expect(s.fetched).toBe(1);
    const [r] = await rows(A, [20]);
    expect([r?.issueKey, r?.state, r?.title]).toEqual(['ENG-40', 'ok', 'Title of ENG-40']);
    const ident = `jira:${r!.apiRoot}#ENG-40`;
    expect(await ticketMembers(ctx, A, ident)).toEqual([{ prId: 20, workspaceId: WS_A }]);
    expect(await listChangedTicketIdents(ctx, A, at)).toContain(ident);
    calls.length = 0;
    clock += OK_TTL_MS + 1000; // a merged PR's row is never TTL-refreshed
    await pass();
    expect(calls).toHaveLength(0);
  });

  it('never a closed-unmerged PR, never one merged outside the 90-day window', async () => {
    setPr(10, 'No ticket', null);
    setPr(20, 'ENG-41 abandoned', null, 'closed');
    merge(21, 'ENG-42 ancient', MERGED_WINDOW_MS + DAY);
    await pass();
    expect(calls).toHaveLength(0);
    expect(await rows(A, [20, 21])).toEqual([]);
  });

  it('ONE read per ticket: merged PRs share the pass read, or copy a stored row with no call', async () => {
    setPr(10, 'ENG-7 reset password', null); // open, ENG-7
    merge(20, 'ENG-7 part two', 10 * DAY); // merged, same ticket: rides the open read
    merge(21, 'ENG-43 one', 10 * DAY);
    merge(22, 'ENG-43 two', 11 * DAY); // two merged PRs, one ticket: one read
    await pass();
    expect(keysRead().sort()).toEqual(['ENG-43', 'ENG-7']);
    expect((await rows(A, [20, 21, 22])).map((r) => [r.prId, r.issueKey, r.state])).toEqual([
      [20, 'ENG-7', 'ok'],
      [21, 'ENG-43', 'ok'],
      [22, 'ENG-43', 'ok'],
    ]);
    // After a restart, a merged PR with no row on a ticket already stored: copied, no Jira call.
    sqlite.exec('DELETE FROM tracker_tickets WHERE pr_id = 22');
    resetTrackerWorker();
    enableTrackerWorker(true);
    calls.length = 0;
    const at = clock + 1000;
    clock = at;
    merge(22, 'ENG-7 three', 60 * 60_000);
    const s = await pass();
    expect(calls).toHaveLength(0);
    expect(s.copied).toBe(1);
    const [copy] = await rows(A, [22]);
    expect(copy).toMatchObject({ issueKey: 'ENG-7', state: 'ok', title: 'Title of ENG-7', acceptanceCriteria: 'AC of ENG-7' });
    expect(new Date(copy!.checkedAt).getTime()).toBe(at);
    expect(await listChangedTicketIdents(ctx, A, at)).toEqual([`jira:${copy!.apiRoot}#ENG-7`]);
  });

  it('another account\'s stored row is never copied', async () => {
    await pass(B); // account 2 stores ENG-7
    calls.length = 0;
    setPr(10, 'No ticket', null);
    merge(20, 'ENG-7 merged', DAY);
    await pass();
    expect(keysRead()).toEqual(['ENG-7']);
  });

  it('a PR open when seen keeps its rows after it merges — never refreshed, never pruned', async () => {
    await pass();
    calls.length = 0;
    merge(10, 'No ticket', 60_000); // merged, and its title no longer names a ticket
    clock += OK_TTL_MS + 1000;
    await pass();
    expect(calls).toHaveLength(0);
    expect((await rows(A, [10])).map((r) => r.issueKey)).toEqual(['ENG-7', 'ENG-8']);
    const apiRoot = (await rows(A, [10]))[0]!.apiRoot;
    expect((await ticketMembers(ctx, A, `jira:${apiRoot}#ENG-7`)).map((m) => m.prId)).toEqual([10]);
  });

  it('bounded: new open tickets go first, the backfill waits for the next pass', async () => {
    setPr(10, 'ENG-7 open', null);
    merge(20, 'ENG-44 merged', 5 * DAY);
    const s = await pass(A, 1);
    expect(keysRead()).toEqual(['ENG-7']);
    expect(s.pending).toBe(1);
    expect(s.mergedUnsettled.has(20)).toBe(true);
    calls.length = 0;
    await pass(A, 1);
    expect(keysRead()).toEqual(['ENG-44']);
  });

  it('one-time per repo: a settled window is rescanned only by a walk, at most every FULL_RESCAN_MS', async () => {
    setPr(10, 'No ticket', null);
    merge(20, 'ENG-45 first', 20 * DAY);
    await pass();
    expect(keysRead()).toEqual(['ENG-45']);
    calls.length = 0;
    // An existing row merges with an old date: the plain tick does not look at it…
    merge(21, 'ENG-46 deep', 40 * DAY);
    await pass();
    expect(calls).toHaveLength(0);
    // …a repo walk asks to re-open the window, honoured once FULL_RESCAN_MS has passed.
    await kickTrackerSync(ctx, A, { repoId: 200, transport, now });
    expect(calls).toHaveLength(0);
    clock += FULL_RESCAN_MS + 1000;
    await pass();
    expect(keysRead()).toEqual(['ENG-46']);
    expect((await rows(A, [21])).map((r) => r.issueKey)).toEqual(['ENG-46']);
  });

  it('a row NEWER than the scan (the deep backfill) is read by the plain tick', async () => {
    setPr(10, 'No ticket', null);
    await pass();
    sqlite
      .prepare(
        "INSERT INTO pull_requests (id, account_id, repo_id, title, head_ref_name, state, merged_at) VALUES (23,1,200,'ENG-49 backfilled',null,'merged',?)",
      )
      .run(Math.floor((clock - 50 * DAY) / 1000));
    try {
      await pass();
      expect(keysRead()).toEqual(['ENG-49']);
    } finally {
      sqlite.exec('DELETE FROM pull_requests WHERE id = 23');
    }
  });

  it('a PR still owed a row is revisited by id; its repo window is not rescanned', async () => {
    setPr(10, 'No ticket', null);
    merge(20, 'ENG-44 merged', 5 * DAY);
    jira.set('ENG-44', { status: 500 });
    const s = await pass();
    expect(s.mergedUnsettled.has(20)).toBe(true);
    calls.length = 0;
    jira.delete('ENG-44');
    clock += FAILED_TTL_MS + 1000;
    await pass();
    expect(keysRead()).toEqual(['ENG-44']);
  });

  it('a settings kick after a Jira site move reads merged PRs again on the new site', async () => {
    setPr(10, 'No ticket', null);
    merge(20, 'ENG-45 first', 20 * DAY);
    await pass();
    sqlite.exec("UPDATE tracker_tickets SET api_root = 'https://old.example/rest/api/3' WHERE pr_id = 20");
    calls.length = 0;
    await pass();
    expect(calls).toHaveLength(0); // settled this process
    await kickTrackerSync(ctx, A, { transport, now });
    expect(keysRead()).toEqual(['ENG-45']);
    expect((await rows(A, [20]))[0]?.apiRoot).not.toBe('https://old.example/rest/api/3');
  });

  it('a transient failure is retried on its TTL; a 404 is an answer', async () => {
    setPr(10, 'No ticket', null);
    merge(20, 'ENG-47 flaky', DAY);
    merge(21, 'ENG-48 gone', DAY);
    jira.set('ENG-47', { status: 500 });
    jira.set('ENG-48', { status: 404 });
    const s = await pass();
    expect(s.mergedUnsettled.has(20)).toBe(true);
    expect(s.mergedUnsettled.has(21)).toBe(false);
    calls.length = 0;
    jira.delete('ENG-47');
    clock += FAILED_TTL_MS + 1000;
    await pass();
    expect(keysRead()).toEqual(['ENG-47']);
    expect((await rows(A, [20]))[0]?.state).toBe('ok');
    expect((await rows(A, [21]))[0]?.state).toBe('not_found');
  });
});
