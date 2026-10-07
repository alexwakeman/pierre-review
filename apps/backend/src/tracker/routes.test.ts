// ── JIRA API ACCESS through the real routes (plugin migration 0035) ─────────────────────────────
//
// Pinned here, through a real Fastify instance so ajv's `removeAdditional` is in the path:
//
//   1. THE TOKEN NEVER LEAVES. No GET or PUT response carries it (in any form); the row holds the
//      SEALED form when the host can seal; saving without a token keeps it; `clearToken` removes
//      it; pointing the base URL at another Jira site removes it.
//   2. THE SCHEMA KEEPS EVERY NEW KEY (a stripped `token` would answer 200 and store nothing).
//   3. LIMN IS NOT A JIRA PROXY. The ticket route is ownership-scoped (foreign PR → 404) and answers
//      only for a key detection found on that PR — any other key is refused BEFORE Jira is called.
//   4. The enricher's `canFetchDetails` follows the saved token.
//   5. The account export (core) cannot reach this table at all.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/tracker/jira-routes.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTrackerRoutes } from './routes.js';
import { prTicketRefs } from './enricher.js';
import { clipTicketField, resolvePrTickets } from './stories.js';
import { resetTrackerWorker } from './worker.js';
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


const ACCOUNT = 1;
const WS = 2; // Platform — repo 200, Jira
const WS_NO_TOKEN = 1; // Default — repo 100
const TOKEN = 'ATATT3xFfGF0-super-secret-token';

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

// A reversible fake of core's AES-GCM seam — enough to prove the row holds the SEALED form.
const host = {
  version: 'test',
  deploymentMode: 'local' as const,
  isCloud: false,
  sealSecret: (p: string) => `enc(${Buffer.from(p).toString('hex')})`,
  openSecret: (s: string) => Buffer.from(/^enc\((.*)\)$/.exec(s)?.[1] ?? '', 'hex').toString('utf8'),
};

let app: FastifyInstance;
let sqlite: Database.Database;
let ctx: TrackerContext;
const calls: Array<{ url: string; auth: string | undefined }> = [];
let nextResponse: RawResponse = { status: 200, contentType: 'application/json', body: '{}' };
let transportImpl: ((url: unknown) => Promise<RawResponse>) | null = null;
const transport: JiraTransport = async (url, headers) => {
  calls.push({ url: String(url), auth: headers.authorization });
  return transportImpl ? transportImpl(url) : nextResponse;
};

beforeAll(async () => {
  sqlite = new Database(':memory:');
  // better-sqlite3 enforces foreign keys: `workspace_trackers` references accounts + workspaces.
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Platform',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,1,100),(1,2,200),(2,90,900);' +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, ' +
      'repo_id integer NOT NULL, title text NOT NULL, head_ref_name text);' +
      "INSERT INTO pull_requests VALUES (10,1,200,'ENG-7 reset password','feature/ENG-8-extra');" +
      "INSERT INTO pull_requests VALUES (11,1,100,'ENG-9 other team',null);" +
      "INSERT INTO pull_requests VALUES (90,2,900,'ENG-7 foreign',null);",
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
      pullRequests: corePullRequests,
    },
  } as unknown as TrackerContext;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx, { transport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const put = (ws: number, body: unknown) =>
  app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
const get = (ws: number) => app.inject({ method: 'GET', url: `/api/workspaces/${ws}/tracker` });
const storedToken = (ws: number): string | null =>
  (sqlite
    .prepare('SELECT auth_token FROM workspace_trackers WHERE account_id = ? AND workspace_id = ?')
    .get(ACCOUNT, ws) as { auth_token: string | null } | undefined)?.auth_token ?? null;

beforeEach(async () => {
  calls.length = 0;
  nextResponse = { status: 200, contentType: 'application/json', body: '{}' };
  // The worker's backoff and the stored tickets are per test.
  resetTrackerWorker();
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM pro_jira_ac_fields;');
  // A clean slate for both workspaces: Jira tracker, ENG allowlist, no token.
  for (const ws of [WS, WS_NO_TOKEN]) {
    const res = await put(ws, {
      issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] },
      jira: { email: null, clearToken: true },
    });
    expect(res.statusCode).toBe(200);
  }
});

describe('1. the token never leaves', () => {
  it('a saved token is sealed at rest and absent from every response', async () => {
    const saved = await put(WS, { jira: { email: 'dev@acme.io', token: TOKEN } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(TOKEN);
    expect(saved.json().jira).toEqual({ email: 'dev@acme.io', hasToken: true });
    const read = await get(WS);
    expect(read.body).not.toContain(TOKEN);
    expect(read.body).not.toContain('enc(');
    expect(read.body).not.toContain('sealed:');
    expect(read.json().jira.hasToken).toBe(true);
    const row = storedToken(WS);
    expect(row?.startsWith('sealed:v1:')).toBe(true);
    expect(row).not.toContain(TOKEN);
  });

  it('without the seal seam it is stored plain, prefixed', async () => {
    const { sealSecret, openSecret } = host;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (host as any).sealSecret;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (host as any).openSecret;
    try {
      await put(WS, { jira: { token: TOKEN } });
      expect(storedToken(WS)).toBe(`plain:${TOKEN}`);
    } finally {
      Object.assign(host, { sealSecret, openSecret });
    }
  });

  it('WRITE-ONLY: a save without a token keeps it; clearToken removes it', async () => {
    await put(WS, { jira: { token: TOKEN } });
    const before = storedToken(WS);
    await put(WS, { jira: { email: 'x@acme.io' } });
    await put(WS, { issue: { matchScope: 'title_branch' } });
    await put(WS, { issue: { projectKeys: ['ENG', 'OPS'] } });
    expect(storedToken(WS)).toBe(before);
    const cleared = await put(WS, { jira: { clearToken: true } });
    expect(cleared.json().jira.hasToken).toBe(false);
    expect(storedToken(WS)).toBeNull();
  });

  it('⚠ pointing the base URL at a different Jira site removes the token', async () => {
    await put(WS, { jira: { token: TOKEN } });
    // Same site, different spelling: kept.
    await put(WS, { issue: { baseUrl: 'https://acme.atlassian.net/browse' } });
    expect(storedToken(WS)).not.toBeNull();
    // Another host: removed, so the token is never sent there.
    const moved = await put(WS, { issue: { baseUrl: 'https://attacker.example' } });
    expect(moved.json().jira.hasToken).toBe(false);
    // A new token typed in the SAME patch as the move is kept — it was typed for the new site.
    await put(WS, {
      issue: { baseUrl: 'https://acme.atlassian.net' },
      jira: { token: TOKEN },
    });
    expect(storedToken(WS)).not.toBeNull();
  });
});

describe('2. the PUT schema keeps every new key and refuses bad ones', () => {
  it('email round-trips and clears', async () => {
    const res = await put(WS, { jira: { email: 'dev@acme.io' } });
    expect(res.json().jira).toEqual({ email: 'dev@acme.io', hasToken: false });
    const cleared = await put(WS, { jira: { email: '' } });
    expect(cleared.json().jira.email).toBeNull();
  });

  it('⚠ the RETIRED acceptance-criteria keys are stripped (200), never stored or echoed', async () => {
    // The field moved to the Claude Review panel, per ticket. A stale client still sending the
    // old keys must neither fail nor write the now-dormant columns.
    const res = await put(WS, {
      jira: { acceptanceCriteriaFieldId: 'customfield_10400', acceptanceCriteriaFieldName: 'AC' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jira).toEqual({ email: null, hasToken: false });
    // The core row has no criteria-field column at all; nothing was written for the stale keys.
    const cols = (sqlite.prepare("SELECT name FROM pragma_table_info('workspace_trackers')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.some((c) => /ac_field/.test(c))).toBe(false);
  });

  it.each([
    [{ email: 'a:b@acme.io' }], // a colon would split HTTP Basic
    [{ email: 'no-at-sign' }],
    [{ token: 'has space' }],
  ])('400s %j', async (jira) => {
    expect((await put(WS, { jira })).statusCode).toBe(400);
  });
});

const ticket = (prId: number, key: string) =>
  app.inject({ method: 'GET', url: `/api/prs/${prId}/tracker-ticket?key=${encodeURIComponent(key)}` });

describe('3. the ticket route is not a Jira proxy', () => {
  beforeEach(async () => {
    await put(WS, { jira: { token: TOKEN } });
  });

  it('a detected key → title, description, issue type and the ranked candidates', async () => {
    nextResponse = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key: 'ENG-7',
        names: {
          customfield_10400: 'Acceptance Criteria',
          customfield_10401: 'Acceptance Criteria',
          customfield_10019: 'Rank',
          customfield_10600: 'Notes',
        },
        schema: { customfield_10019: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
        fields: {
          summary: 'Reset password',
          description: 'As a user\r\nI want a reset link',
          issuetype: { id: '10001', name: 'Story' },
          customfield_10400: '* Link is emailed\n* Link expires',
          customfield_10401: null, // the Bug type's criteria field — empty on a Story
          customfield_10019: '0|i0001:',
          customfield_10600: 'Talk to ops',
        },
      }),
    };
    const res = await ticket(10, 'eng-7');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      prId: 10,
      key: 'ENG-7',
      title: 'Reset password',
      description: 'As a user\nI want a reset link',
      issueType: { id: '10001', name: 'Story' },
      candidates: [
        {
          id: 'customfield_10400',
          name: 'Acceptance Criteria',
          text: '- Link is emailed\n- Link expires',
          match: 'strong',
        },
        { id: 'customfield_10600', name: 'Notes', text: 'Talk to ops', match: null },
      ],
      omittedCandidates: 0,
      // The stored-row extras (core 0088): the criteria the SERVER picked, and the status /
      // assignee (none on this mock).
      acceptanceCriteria: '- Link is emailed\n- Link expires',
      acField: { id: 'customfield_10400', name: 'Acceptance Criteria' },
      acFieldSource: 'default',
      status: null,
      statusCategory: null,
      assignee: null,
      fetchedAt: expect.any(String),
    });
    expect(calls).toHaveLength(1);
    // ⚠ READ ONCE, THEN STORED: the second view makes no Jira call.
    expect((await ticket(10, 'ENG-7')).json().title).toBe('Reset password');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://acme.atlassian.net/rest/api/2/issue/ENG-7?fields=*all&expand=names,schema',
    );
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(res.body).not.toContain(TOKEN);
  });

  it('a key found in the head branch counts (title_branch scope)', async () => {
    nextResponse = { status: 200, contentType: 'application/json', body: '{"fields":{"summary":"S"}}' };
    expect((await ticket(10, 'ENG-8')).statusCode).toBe(200);
  });

  it('⚠ a key the PR does not carry is refused BEFORE Jira is called', async () => {
    const res = await ticket(10, 'ENG-999');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TicketNotDetected');
    expect(calls).toHaveLength(0);
  });

  it('⚠ another tenant’s PR is a 404, and Jira is never called', async () => {
    const res = await ticket(90, 'ENG-7');
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('a PR whose workspace has no token → 400 NoJiraToken', async () => {
    const res = await ticket(11, 'ENG-9');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NoJiraToken');
  });

  it('a Linear workspace with no API key → 400, naming the Linear key (Linear reads since phase 3)', async () => {
    await put(WS, { issue: { provider: 'linear', baseUrl: 'https://linear.app/acme' } });
    const res = await ticket(10, 'ENG-7');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NoJiraToken', message: expect.stringContaining('No Linear API key') });
  });

  it('a workspace with no tracker → 400 NotJira', async () => {
    await put(WS, { issue: { provider: null } });
    const res = await ticket(10, 'ENG-7');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NotJira');
  });

  it('a Jira 401 is a 502 with our sentence, never Jira’s body', async () => {
    nextResponse = { status: 401, contentType: 'text/html', body: '<p>internal-hostname-leak</p>' };
    const res = await ticket(10, 'ENG-7');
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('did not accept the saved token');
    expect(res.body).not.toContain('internal-hostname-leak');
  });

  it('CLOUD mode refuses an http base URL before any request', async () => {
    await put(WS, { issue: { baseUrl: 'http://acme.atlassian.net' }, jira: { token: TOKEN } });
    host.isCloud = true;
    try {
      const res = await ticket(10, 'ENG-7');
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('blocked');
      expect(calls).toHaveLength(0);
    } finally {
      host.isCloud = false;
    }
  });
});

describe('4. auto review fetches the ticket on the server (resolveAutoReviewTicket)', () => {
  const NOW = Date.UTC(2026, 9, 2, 9, 0);
  const resolve = (prId: number) => resolveAutoReviewTicket(ctx, ACCOUNT, prId, { transport, nowMs: NOW });
  const issue = (fields: Record<string, unknown>, names: Record<string, string> = {}, key = 'ENG-7') => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ key, names, fields }),
  });

  it('the first detected key, criteria from the STRONG-named field', async () => {
    await put(WS, { jira: { token: TOKEN } });
    nextResponse = issue(
      {
        summary: 'Reset password',
        description: 'As a user',
        customfield_10500: 'Definition of done text',
        customfield_10400: '* Link is emailed',
      },
      { customfield_10500: 'Definition of Done', customfield_10400: 'Acceptance Criteria' },
    );
    const r = await resolve(10);
    const jira = {
      title: 'Reset password',
      description: 'As a user',
      acceptanceCriteria: '- Link is emailed',
      source: 'jira',
      key: 'ENG-7',
      url: expect.stringContaining('/browse/ENG-7'),
      fetchedAt: new Date(NOW).toISOString(),
    };
    // PR 10 names ENG-7 (title) and ENG-8 (branch): both are read. This mock answers ENG-7 for
    // both — a moved key — so it is kept once.
    expect(r).toEqual({ key: 'ENG-7', ticket: jira, tickets: [jira] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/rest/api/2/issue/ENG-7?');
    expect(calls[1]?.url).toContain('/rest/api/2/issue/ENG-8?');
  });

  it('several detected keys → one ticket each, in detection order; one failing skips only it', async () => {
    await put(WS, { jira: { token: TOKEN } });
    const prev = transportImpl;
    transportImpl = async (url) =>
      String(url).includes('ENG-8')
        ? { status: 404, contentType: 'application/json', body: '{}' }
        : issue({ summary: 'Seven' });
    try {
      const r = await resolve(10);
      expect(r.tickets.map((t) => [t.key, t.title])).toEqual([['ENG-7', 'Seven']]);
      // The 404 is REMEMBERED (a stored refusal), so the next auto review does not ask again.
      const before = calls.length;
      transportImpl = async (url) =>
        issue({ summary: String(url).includes('ENG-8') ? 'Eight' : 'Seven' }, {}, String(url).includes('ENG-8') ? 'ENG-8' : 'ENG-7');
      expect((await resolve(10)).tickets.map((t) => t.key)).toEqual(['ENG-7']);
      expect(calls.length).toBe(before);
      // Once the refusal ages out (a fresh store here), both are read, in detection order.
      sqlite.exec('DELETE FROM tracker_tickets;');
      const both = await resolve(10);
      expect(both.tickets.map((t) => [t.key, t.title])).toEqual([
        ['ENG-7', 'Seven'],
        ['ENG-8', 'Eight'],
      ]);
    } finally {
      transportImpl = prev;
    }
  });

  it('only a weak match → no criteria (never preselected)', async () => {
    await put(WS, { jira: { token: TOKEN } });
    nextResponse = issue(
      { summary: 'S', customfield_10500: 'DoD' },
      { customfield_10500: 'Definition of Done' },
    );
    expect((await resolve(10)).ticket).toMatchObject({ title: 'S', description: null, acceptanceCriteria: null });
  });

  it('an over-cap field is CUT to its cap, not dropped', async () => {
    await put(WS, { jira: { token: TOKEN } });
    nextResponse = issue({ summary: 'T'.repeat(500), description: 'd'.repeat(9000) });
    const r = await resolve(10);
    expect(r.ticket?.title).toHaveLength(300);
    expect(r.ticket?.description).toHaveLength(8000);
  });

  it('no token → no ticket, no Jira call, no throw', async () => {
    expect(await resolve(10)).toEqual({ ticket: null, key: 'ENG-7', tickets: [] });
    expect(calls).toHaveLength(0);
  });

  it('a Jira error → no ticket, no throw, and the log carries the code only', async () => {
    await put(WS, { jira: { token: TOKEN } });
    nextResponse = { status: 502, contentType: 'text/html', body: '<p>internal-hostname-leak</p>' };
    const logged: unknown[] = [];
    const warn = ctx.log.warn;
    (ctx.log as { warn: unknown }).warn = (o: unknown) => logged.push(o);
    try {
      expect(await resolve(10)).toEqual({ ticket: null, key: 'ENG-7', tickets: [] });
    } finally {
      (ctx.log as { warn: unknown }).warn = warn;
    }
    const text = JSON.stringify(logged);
    expect(text).not.toContain('internal-hostname-leak');
    expect(text).not.toContain(TOKEN);
    expect(logged[0]).toMatchObject({ accountId: ACCOUNT, workspaceId: WS, prId: 10 });
  });

  it('another tenant’s PR, or a workspace not on Jira → no ticket, no call', async () => {
    await put(WS, { jira: { token: TOKEN } });
    expect((await resolve(90)).ticket).toBeNull();
    await put(WS, { issue: { provider: 'linear', baseUrl: 'https://linear.app/acme' } });
    expect((await resolve(10)).ticket).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('clipTicketField never leaves half a surrogate pair or a control character', () => {
    expect(clipTicketField('ab\u0000c', 10)).toBe('abc');
    expect(clipTicketField('a\uD83D\uDE00', 2)).toBe('a');
    expect(clipTicketField('x\uD83D', 10)).toBe('x');
  });
});

describe('the field list', () => {
  it('the connection check uses the saved token (Basic with an email)', async () => {
    await put(WS, { jira: { email: 'dev@acme.io', token: TOKEN } });
    nextResponse = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'summary', name: 'Summary', custom: false },
        { id: 'customfield_10400', name: 'Acceptance Criteria', custom: true, schema: { type: 'string' } },
      ]),
    };
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${WS}/tracker/jira-fields` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspaceId: WS,
      fields: [{ id: 'customfield_10400', name: 'Acceptance Criteria', custom: true, type: 'string' }],
    });
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/2/field');
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from(`dev@acme.io:${TOKEN}`).toString('base64')}`);
  });

  it('no token → 400, no call', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${WS}/tracker/jira-fields` });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('4. the enricher tells the SPA when the button may show', () => {
  const pr = { accountId: ACCOUNT, prId: 10, repoId: 200, repoFullName: 'acme/web', title: 'ENG-7 x', headRefName: null };

  it('canFetchDetails follows the saved token', async () => {
    const enrich = (p: typeof pr) => prTicketRefs(ctx, p);
    expect((await enrich(pr))?.[0]?.canFetchDetails).toBe(false);
    await put(WS, { jira: { token: TOKEN } });
    expect((await enrich(pr))?.[0]?.canFetchDetails).toBe(true);
    expect(JSON.stringify(await enrich(pr))).not.toContain(TOKEN);
  });
});

// (5. "the account export cannot reach the token" moved to core's own export test: the tracker row
// IS exported now — the user typed it — with the token reduced to `hasToken`; see
// db/erase-account.test.ts "NEVER includes the stored GitHub token".)

