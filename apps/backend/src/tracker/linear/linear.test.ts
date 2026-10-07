// ── THE LINEAR ADAPTER (docs/TRACKERS.md § Linear) ───────────────────────────────────────────────
//
// Pinned here:
//   1. ACCEPTANCE CRITERIA, in the shared preference order: child issues → a task list → an
//      "Acceptance criteria" section → none; canceled children are not criteria; status types map.
//   2. IDENTITY: `https://linear.app/<urlKey>` roots, `ENG-123` keys, the ident round trip, the SPA's
//      link → ident rule agreeing with the server's row → ident rule.
//   3. LINKING: Linear's attachments for the PR URL, batched in one aliased request, stored on the
//      PR with the workspace root; links ∪ key detection, links first; stale-root links ignored.
//   4. READ ON RECEIPT: one GraphQL POST per issue to the fixed host, the raw key in Authorization
//      (no "Bearer"), Linear's own URL kept, the project as story context; peers by ident.
//   5. ERRORS: a refused key, a rate limit, a key for another Linear workspace — no row, a quiet
//      workspace backoff; not found / no access — stored per ticket; our sentences only.
//   6. COST: zero Linear calls for every other workspace and for a Linear workspace with no key;
//      a low Linear budget makes no call.
//   7. SETTINGS: the key is sealed, write-only (`hasToken` only), shape-checked, dropped when the
//      workspace URL moves to another Linear workspace; the connection check; isolation.
//
// In-memory SQLite only — this file never touches DATABASE_URL, and no request leaves the process
// (every Linear answer comes from the fake transport below).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  canonicalTicketKey,
  linearSiteRoot,
  parseTicketIdent,
  ticketIdentForLink,
  trackerTicketIdent,
  trackerTicketRow,
  type ParsedTrackerIdent,
} from '@pierre-review/shared';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../../db/schema.sqlite.js';
import type { TrackerContext } from '../context.js';
import type { JiraTransport, RawResponse } from '../jira/fetch.js';
import { registerTrackerRoutes } from '../routes.js';
import { readStoredTickets } from '../store.js';
import { ticketMembers, ticketStory } from '../peers.js';
import { prTicketRefs } from '../enricher.js';
import { mergeTracker, trackerPatchError } from '../settings.js';
import { enableTrackerWorker, isBackedOff, resetTrackerWorker, runAccountPass } from '../worker.js';
import { linearAdapter } from './adapter.js';
import { __resetLinearBudget, isLinearBudgetLow, linearStatus, toLinearTicket } from './client.js';
import { linearKeysOf, linearLinker, linearLinksQuery, LINEAR_LINK_TTL_MS } from './links.js';

const ROOT = 'https://linear.app/acme';
const KEY_A = 'lin_api_aaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'lin_api_bbbbbbbbbbbbbbbbbbbb';

// ---- 1. acceptance criteria ----

describe('1. acceptance criteria — children, then a task list, then a heading, then the description', () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    identifier: 'ENG-1',
    title: ' Reset password ',
    description: 'As a user I reset my password.\n\n## Acceptance criteria\nThe link expires.',
    url: `${ROOT}/issue/ENG-1/reset-password`,
    state: { name: 'In Progress', type: 'started' },
    assignee: { id: 'u1', name: 'ada', displayName: 'Ada', avatarUrl: 'https://public.linear.app/ada.png' },
    project: null,
    children: { nodes: [], pageInfo: { hasNextPage: false } },
    ...over,
  });

  it('child issues win: one line each, completed ticked, canceled left out; the description is whole', () => {
    const t = toLinearTicket(
      'ENG-1',
      issue({
        children: {
          nodes: [
            { identifier: 'eng-2', title: 'Send the email', state: { type: 'completed' } },
            { identifier: 'ENG-3', title: '  Open   the form ', state: { type: 'unstarted' } },
            { identifier: 'ENG-4', title: 'Dropped idea', state: { type: 'canceled' } },
          ],
          pageInfo: { hasNextPage: true },
        },
      }),
    );
    expect(t.candidates).toEqual([
      {
        id: 'linear:sub_issues',
        name: 'Sub-issues',
        text: '- [x] Send the email (ENG-2)\n- [ ] Open the form (ENG-3)\n- … and more sub-issues',
        match: 'strong',
      },
    ]);
    expect(t.description).toContain('## Acceptance criteria');
  });

  it('then a task list, then an "Acceptance criteria" section (the shared rule, incl. the form filter)', () => {
    const tasks = toLinearTicket('ENG-1', issue({ description: 'Story.\n\n- [ ] first\n- [x] second' }));
    expect(tasks.candidates[0]).toMatchObject({ id: 'linear:task_list', text: '- [ ] first\n- [x] second' });
    expect(tasks.description).toBe('Story.');
    const form = toLinearTicket('ENG-1', issue({ description: '## Checklist\n- [x] I have searched existing issues' }));
    expect(form.candidates).toEqual([]);
    const heading = toLinearTicket('ENG-1', issue());
    expect(heading.candidates[0]).toMatchObject({ id: 'linear:heading', text: 'The link expires.' });
    expect(heading.description).toBe('As a user I reset my password.');
  });

  it('none: no criteria; the project is one line of context; title, assignee, url, no issue type', () => {
    const t = toLinearTicket('ENG-1', issue({ description: 'Just text.', project: { name: 'Checkout' } }));
    expect(t).toMatchObject({
      key: 'ENG-1',
      title: 'Reset password',
      description: 'Just text.\n\nLinear project: Checkout',
      candidates: [],
      issueType: null,
      assignee: { name: 'Ada', accountId: 'u1', avatarUrl: 'https://public.linear.app/ada.png' },
      url: `${ROOT}/issue/ENG-1/reset-password`,
    });
    expect(toLinearTicket('ENG-1', issue({ description: null })).description).toBe('');
  });

  it('state types map onto the stored categories', () => {
    expect(linearStatus({ name: 'Backlog', type: 'backlog' })).toEqual({ name: 'Backlog', category: 'new' });
    expect(linearStatus({ name: 'Todo', type: 'unstarted' })).toEqual({ name: 'Todo', category: 'new' });
    expect(linearStatus({ name: 'In Review', type: 'started' })).toEqual({ name: 'In Review', category: 'indeterminate' });
    expect(linearStatus({ name: 'Done', type: 'completed' })).toEqual({ name: 'Done', category: 'done' });
    expect(linearStatus({ name: 'Canceled', type: 'canceled' })).toEqual({ name: 'Canceled', category: 'done' });
    expect(linearStatus(null)).toBeNull();
  });
});

// ---- 2. identity ----

describe('2. identity — one root, one key, one ident per Linear issue', () => {
  it('linearSiteRoot folds every linear.app URL onto the workspace and refuses anything else', () => {
    expect(linearSiteRoot('https://linear.app/Acme/')).toBe(ROOT);
    expect(linearSiteRoot('https://linear.app/acme/issue/ENG-1/some-slug')).toBe(ROOT);
    expect(linearSiteRoot('https://www.linear.app/acme')).toBe(ROOT);
    expect(linearSiteRoot('https://linear.app')).toBeNull();
    expect(linearSiteRoot('https://evil.example/acme')).toBeNull();
    expect(linearSiteRoot('not a url')).toBeNull();
  });

  it('a stored row ↔ its ident round-trips; a malformed Linear ident does not parse', () => {
    const ident = trackerTicketIdent('linear', ROOT, 'ENG-123');
    expect(ident).toBe('linear:https://linear.app/acme#ENG-123');
    const parsed = parseTicketIdent(ident) as ParsedTrackerIdent;
    expect(parsed).toMatchObject({ kind: 'linear', root: ROOT, key: 'ENG-123' });
    expect(trackerTicketRow(parsed)).toEqual({ provider: 'linear', apiRoot: ROOT, issueKey: 'ENG-123' });
    expect(parseTicketIdent('linear:https://evil.example/acme#ENG-1')).toBeNull();
    expect(parseTicketIdent('linear:https://linear.app/acme#eng-1')).toBeNull();
    expect(parseTicketIdent('linear:https://linear.app/acme/issue#ENG-1')).toBeNull();
  });

  it('the SPA’s link → ident rule agrees, from our browse link and from Linear’s own URL', () => {
    const ident = 'linear:https://linear.app/acme#ENG-7';
    expect(ticketIdentForLink({ key: 'eng-7', url: `${ROOT}/issue/ENG-7`, provider: 'linear' })).toBe(ident);
    expect(ticketIdentForLink({ key: 'ENG-7', url: `${ROOT}/issue/ENG-7/slug`, provider: 'linear' })).toBe(ident);
    expect(ticketIdentForLink({ key: 'ENG-7', url: 'https://example.com/issue/ENG-7', provider: 'linear' })).toBeNull();
    expect(canonicalTicketKey('eng-7')).toBe('ENG-7');
  });

  it('the adapter: root, browse link, key normalisation', () => {
    expect(linearAdapter.siteRoot('https://linear.app/ACME')).toBe(ROOT);
    expect(linearAdapter.browseUrl(ROOT, 'ENG-7')).toBe(`${ROOT}/issue/ENG-7`);
    expect(linearAdapter.normalizeKey(' eng-7 ')).toBe('ENG-7');
    expect(linearAdapter.normalizeKey('acme/web#7')).toBeNull();
  });
});

// ---- 3a. linking, pure ----

describe('3a. linking — links ∪ detection, links first', () => {
  const cfg = { provider: 'linear' as const, baseUrl: ROOT, projectKeys: ['ENG'], matchScope: 'title_branch' as const };

  it('attachments are kept in Linear’s order, deduped, this workspace’s issues only', () => {
    expect(
      linearKeysOf(
        {
          nodes: [
            { issue: { identifier: 'eng-2', url: `${ROOT}/issue/ENG-2/x` } },
            { issue: { identifier: 'ENG-2', url: `${ROOT}/issue/ENG-2/x` } },
            { issue: { identifier: 'OPS-1', url: 'https://linear.app/other/issue/OPS-1' } },
            null,
          ],
        },
        ROOT,
      ),
    ).toEqual(['ENG-2']);
    expect(linearKeysOf({ nodes: [] }, ROOT)).toEqual([]);
    expect(linearKeysOf(null, ROOT)).toBeNull();
  });

  it('detection: the linked issues, then title/branch keys the allowlist admits', () => {
    expect(
      linearAdapter.detect(cfg, {
        title: 'ENG-5 and ENG-2 and GPT-4',
        headRefName: 'alex/eng-6-thing',
        linearLinks: ['ENG-2', 'OPS-3'],
        linearLinksRoot: ROOT,
      }),
    ).toEqual([
      { key: 'ENG-2', from: 'link', order: 0 },
      { key: 'OPS-3', from: 'link', order: 1 },
      { key: 'ENG-5', from: 'title', order: 2 },
      { key: 'ENG-6', from: 'branch', order: 3 },
    ]);
  });

  it('links never read, or read against another Linear workspace, leave detection alone', () => {
    const pr = { title: 'ENG-5', headRefName: null };
    expect(linearAdapter.detect(cfg, { ...pr, linearLinks: null, linearLinksRoot: null })).toEqual([
      { key: 'ENG-5', from: 'title', order: 0 },
    ]);
    expect(linearAdapter.detect(cfg, { ...pr, linearLinks: ['ENG-9'], linearLinksRoot: 'https://linear.app/old' })).toEqual([
      { key: 'ENG-5', from: 'title', order: 0 },
    ]);
  });

  it('the batched query aliases one attachmentsForURL per PR', () => {
    const q = linearLinksQuery(2);
    expect(q).toContain('$u0: String!, $u1: String!');
    expect(q).toContain('a1: attachmentsForURL(url: $u1, first: 10)');
  });

  it('due: never read (or on another root); edited since; open past the TTL — merged read once', () => {
    const call = { apiRoot: ROOT } as never;
    const base = { id: 1, githubNodeId: 'X', state: 'open', updatedAt: new Date(1_000), closingIssuesCheckedAt: null, prUrl: 'u' };
    const at = 10 * LINEAR_LINK_TTL_MS;
    expect(linearLinker.isDue({ ...base, linearLinksCheckedAt: null }, at, call)).toBe(true);
    expect(linearLinker.isDue({ ...base, linearLinksRoot: ROOT, linearLinksCheckedAt: new Date(at - 60_000) }, at, call)).toBe(false);
    expect(linearLinker.isDue({ ...base, linearLinksRoot: 'https://linear.app/old', linearLinksCheckedAt: new Date(at) }, at, call)).toBe(true);
    expect(linearLinker.isDue({ ...base, linearLinksRoot: ROOT, linearLinksCheckedAt: new Date(at - LINEAR_LINK_TTL_MS) }, at, call)).toBe(true);
    expect(
      linearLinker.isDue({ ...base, state: 'merged', linearLinksRoot: ROOT, linearLinksCheckedAt: new Date(at - 5 * LINEAR_LINK_TTL_MS) }, at, call),
    ).toBe(false);
    expect(linearLinker.isDue({ ...base, prUrl: null, linearLinksCheckedAt: null }, at, call)).toBe(false);
  });
});

// ---- harness for 3b–7 ----

const A = 1;
const B = 2;
const WS_LIN = 2; // account 1, Linear with a key, repo 200
const WS_JIRA = 3; // account 1, Jira (no token), repo 300
const WS_GH = 4; // account 1, GitHub Issues, repo 400
const WS_NOKEY = 5; // account 1, Linear with NO key, repo 500
const WS_B = 90; // account 2, Linear (same Linear workspace), repo 900

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../db/migrations/${name}`, import.meta.url)), 'utf8');

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
const coreUsers = sqliteTable('users', {
  id: integer('id').primaryKey(),
  githubLogin: text('github_login').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
});
const corePullRequests = sqliteTable('pull_requests', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  repoId: integer('repo_id').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
  headRefName: text('head_ref_name'),
  githubNodeId: text('github_node_id').notNull(),
  state: text('state').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  mergedAt: integer('merged_at', { mode: 'timestamp' }),
  closingIssues: text('closing_issues', { mode: 'json' }),
  closingIssuesCheckedAt: integer('closing_issues_checked_at', { mode: 'timestamp' }),
  linearLinks: text('linear_links', { mode: 'json' }),
  linearLinksRoot: text('linear_links_root'),
  linearLinksCheckedAt: integer('linear_links_checked_at', { mode: 'timestamp' }),
});

let sqlite: Database.Database;
let ctx: TrackerContext;
let app: FastifyInstance;
let accountOfRequest = A;
let clock = Date.UTC(2026, 9, 7, 9, 0);
const now = () => clock;

// ---- the fake Linear ----
type FakeIssue = {
  title: string;
  description: string;
  org?: string;
  children?: Array<{ identifier: string; title: string; state: { type: string } }>;
};
const attachments = new Map<string, Array<{ identifier: string; org?: string }> | null>(); // PR url → attached issues
const linIssues = new Map<string, FakeIssue | 'missing' | 'forbidden'>();
let mode: 'ok' | 'bad_key' | 'rate_limited' | 'low_budget' = 'ok';
let viewerOrg = 'acme';
interface Call {
  host: string;
  kind: string;
  authorization: string | undefined;
  method: string;
  vars: Record<string, unknown>;
}
const calls: Call[] = [];
const linearCalls = () => calls.filter((c) => c.host === 'api.linear.app');

const json = (status: number, body: unknown, headers: Record<string, string> = {}): RawResponse => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
  headers,
});

const fakeTransport: JiraTransport = async (url, headers, _opts, init) => {
  const parsed = init != null ? (JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }) : null;
  const kind = parsed == null ? 'get' : /query (\w+)/.exec(parsed.query)?.[1] ?? '?';
  calls.push({ host: url.host, kind, authorization: headers.authorization, method: init?.method ?? 'GET', vars: parsed?.variables ?? {} });
  if (url.host !== 'api.linear.app') return json(404, { errorMessages: ['no'] });
  if (mode === 'bad_key') {
    return json(401, {
      errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR', type: 'authentication error' } }],
    });
  }
  if (mode === 'rate_limited') {
    return json(400, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] });
  }
  const budget: Record<string, string> =
    mode === 'low_budget'
      ? { 'x-ratelimit-requests-remaining': '3', 'x-ratelimit-requests-reset': String(clock + 30 * 60_000) }
      : { 'x-ratelimit-requests-remaining': '2400', 'x-ratelimit-complexity-remaining': '2900000' };
  const vars = parsed!.variables;
  if (kind === 'LimnLinearViewer') {
    return json(200, { data: { viewer: { name: 'ada', displayName: 'Ada' }, organization: { name: 'Acme Inc', urlKey: viewerOrg } } }, budget);
  }
  if (kind === 'LimnLinearPrLinks') {
    const data: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(vars)) {
      const alias = `a${name.slice(1)}`;
      const list = attachments.get(String(v));
      data[alias] =
        list === null
          ? null
          : {
              nodes: (list ?? []).map((i) => ({
                issue: { identifier: i.identifier, url: `https://linear.app/${i.org ?? 'acme'}/issue/${i.identifier}/slug` },
              })),
            };
    }
    return json(200, { data }, budget);
  }
  // LimnLinearIssue
  const id = String(vars.id);
  const i = linIssues.get(id);
  if (i == null || i === 'missing') {
    return json(200, {
      data: null,
      errors: [{ message: 'Entity not found: Issue', path: ['issue'], extensions: { code: 'INPUT_ERROR', type: 'invalid input' } }],
    }, budget);
  }
  if (i === 'forbidden') {
    return json(200, { data: null, errors: [{ message: 'Forbidden', path: ['issue'], extensions: { code: 'FORBIDDEN' } }] }, budget);
  }
  return json(
    200,
    {
      data: {
        issue: {
          identifier: id,
          title: i.title,
          description: i.description,
          url: `https://linear.app/${i.org ?? 'acme'}/issue/${id}/the-slug`,
          state: { name: 'In Progress', type: 'started' },
          assignee: { id: 'u1', name: 'ada', displayName: 'Ada', avatarUrl: 'https://public.linear.app/ada.png' },
          project: { name: 'Checkout' },
          children: { nodes: i.children ?? [], pageInfo: { hasNextPage: false } },
        },
      },
    },
    budget,
  );
};

const seal = {
  sealSecret: (p: string) => `enc(${Buffer.from(p).toString('hex')})`,
  openSecret: (s: string) => Buffer.from(s.slice(4, -1), 'hex').toString(),
};

const ghCalls: unknown[] = [];
const rows = (accountId: number, prIds: number[]) => readStoredTickets(ctx, accountId, prIds);
const pass = (accountId = A) => runAccountPass(ctx, accountId, { now, transport: fakeTransport });
const prUrl = (n: number) => `https://github.com/acme/web/pull/${n}`;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'Linear team',0),(3,1,'Jira team',0),(4,1,'GitHub team',0),(5,1,'Linear no key',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,2,200),(1,3,300),(1,4,400),(1,5,500),(2,90,900);' +
      'CREATE TABLE repos (id integer PRIMARY KEY, account_id integer NOT NULL, owner text NOT NULL, name text NOT NULL);' +
      "INSERT INTO repos VALUES (200,1,'acme','web'),(300,1,'acme','jira-app'),(400,1,'acme','gh-app'),(500,1,'acme','nokey'),(900,2,'evil','web');" +
      'CREATE TABLE users (id integer PRIMARY KEY, github_login text NOT NULL, display_name text, avatar_url text);' +
      "INSERT INTO users VALUES (5,'ada','Ada','https://a.example/ada.png');" +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, repo_id integer NOT NULL, ' +
      'number integer NOT NULL, title text NOT NULL, author_id integer, head_ref_name text, github_node_id text NOT NULL, ' +
      'state text NOT NULL, updated_at integer, merged_at integer, closing_issues text, closing_issues_checked_at integer);',
  );
  // The PR columns this adapter adds, exactly as a real install has them.
  sqlite.exec(migration('0088_issue_tracker.sql'));
  for (const stmt of migration('0090_linear_links.sql').split('--> statement-breakpoint')) sqlite.exec(stmt);
  ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host: { isCloud: false, ...seal },
    accountIdOf: () => accountOfRequest,
    defaultWorkspaceId: async (accountId: number) => (accountId === A ? 1 : 90),
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: {
      workspaces: coreWorkspaces,
      workspaceRepos: coreWorkspaceRepos,
      pullRequests: corePullRequests,
      repos: coreRepos,
      users: coreUsers,
      trackerTickets,
      jiraAcFields,
      workspaceTrackers,
    },
    github: {
      graphql: async <T,>(_a: number, query: string) => {
        ghCalls.push(query);
        return { data: { nodes: [], rateLimit: { remaining: 4000, resetAt: null } } as T };
      },
    },
  } as unknown as TrackerContext;
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTrackerRoutes(app, ctx, { transport: fakeTransport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const put = async (account: number, ws: number, body: unknown) => {
  accountOfRequest = account;
  const r = await app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/tracker`, payload: body as object });
  accountOfRequest = A;
  return r;
};
const get = async (account: number, url: string) => {
  accountOfRequest = account;
  const r = await app.inject({ method: 'GET', url });
  accountOfRequest = A;
  return r;
};

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 7, 9, 0);
  calls.length = 0;
  ghCalls.length = 0;
  attachments.clear();
  linIssues.clear();
  mode = 'ok';
  viewerOrg = 'acme';
  __resetLinearBudget();
  resetTrackerWorker();
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM pull_requests; DELETE FROM workspace_trackers;');
  const ins = sqlite.prepare(
    'INSERT INTO pull_requests (id, account_id, repo_id, number, title, author_id, head_ref_name, github_node_id, state, updated_at, merged_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const t = Math.floor((clock - 3600_000) / 1000);
  ins.run(10, A, 200, 1, 'Reset flow', 5, 'alex/eng-6-reset', 'PR_10', 'open', t, null); // attached ENG-2; branch ENG-6
  ins.run(11, A, 200, 2, 'ENG-2 follow-up', 5, null, 'PR_11', 'open', t, null); // title only (no attachment read yet)
  ins.run(12, A, 200, 3, 'Unlinked', 5, null, 'PR_12', 'open', t, null);
  ins.run(13, A, 200, 4, 'Landed earlier', 5, null, 'PR_13', 'merged', t, Math.floor((clock - 2 * 86400_000) / 1000));
  ins.run(30, A, 300, 9, 'ENG-7 jira work', 5, null, 'PR_30', 'open', t, null);
  ins.run(40, A, 400, 9, 'ENG-7 gh work', 5, null, 'PR_40', 'open', t, null);
  ins.run(50, A, 500, 9, 'ENG-2 no key', 5, null, 'PR_50', 'open', t, null);
  ins.run(90, B, 900, 1, 'Foreign', 5, null, 'PR_90', 'open', t, null);
  enableTrackerWorker(false);
  expect((await put(A, WS_LIN, { issue: { provider: 'linear', baseUrl: 'https://linear.app/Acme', projectKeys: ['ENG'] }, jira: { token: KEY_A } })).statusCode).toBe(200);
  expect((await put(A, WS_JIRA, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] } })).statusCode).toBe(200);
  expect((await put(A, WS_GH, { issue: { provider: 'github' } })).statusCode).toBe(200);
  expect((await put(A, WS_NOKEY, { issue: { provider: 'linear', baseUrl: ROOT, projectKeys: ['ENG'] } })).statusCode).toBe(200);
  expect((await put(B, WS_B, { issue: { provider: 'linear', baseUrl: ROOT }, jira: { token: KEY_B } })).statusCode).toBe(200);
  enableTrackerWorker(true);
  calls.length = 0;
  attachments.set(prUrl(1), [{ identifier: 'ENG-2' }, { identifier: 'OPS-1', org: 'other' }]);
  attachments.set(prUrl(2), []);
  attachments.set(prUrl(3), []);
  attachments.set(prUrl(4), [{ identifier: 'ENG-2' }]);
  attachments.set('https://github.com/evil/web/pull/1', [{ identifier: 'ENG-2' }]);
  linIssues.set('ENG-2', {
    title: 'Reset password',
    description: 'As a user I can reset my password.\n\n- [ ] Email is sent\n- [x] Link expires',
  });
  linIssues.set('ENG-6', {
    title: 'Branch work',
    description: 'Body.',
    children: [{ identifier: 'ENG-8', title: 'Child', state: { type: 'completed' } }],
  });
});

// ---- 3b. linking in the worker ----

describe('3b. linking — Linear’s attachments, read in one batch, stored with the workspace root', () => {
  it('ONE aliased request carries every due PR of the workspace; the stored links name this workspace only', async () => {
    await pass();
    const linkCalls = linearCalls().filter((c) => c.kind === 'LimnLinearPrLinks');
    expect(linkCalls).toHaveLength(1);
    expect(Object.values(linkCalls[0]!.vars).sort()).toEqual([prUrl(1), prUrl(2), prUrl(3), prUrl(4)]);
    const stored = sqlite
      .prepare('SELECT id, linear_links, linear_links_root FROM pull_requests WHERE repo_id = 200 ORDER BY id')
      .all();
    expect(stored).toEqual([
      { id: 10, linear_links: '["ENG-2"]', linear_links_root: ROOT },
      { id: 11, linear_links: '[]', linear_links_root: ROOT },
      { id: 12, linear_links: '[]', linear_links_root: ROOT },
      { id: 13, linear_links: '["ENG-2"]', linear_links_root: ROOT },
    ]);
  });

  it('an alias Linear did not answer stays "never read"; the PR still gets its detected keys', async () => {
    attachments.set(prUrl(2), null);
    await pass();
    expect(sqlite.prepare('SELECT linear_links FROM pull_requests WHERE id = 11').get()).toEqual({ linear_links: null });
    expect((await rows(A, [11])).map((r) => [r.issueKey, r.detectedFrom])).toEqual([['ENG-2', 'title']]);
  });

  it('the PR pane: links first, then detection; never "unknown" before a read', async () => {
    const before = await prTicketRefs(ctx, { accountId: A, prId: 10, repoId: 200, title: 'Reset flow', headRefName: 'alex/eng-6-reset' });
    expect(before).toEqual([{ key: 'ENG-6', url: `${ROOT}/issue/ENG-6`, provider: 'linear', canFetchDetails: true }]);
    await pass();
    const after = await prTicketRefs(ctx, { accountId: A, prId: 10, repoId: 200, title: 'Reset flow', headRefName: 'alex/eng-6-reset' });
    expect(after?.map((r) => r.key)).toEqual(['ENG-2', 'ENG-6']);
  });

  it('a second pass re-reads nothing until the TTL; then only the OPEN PRs', async () => {
    await pass();
    calls.length = 0;
    await pass();
    expect(linearCalls()).toEqual([]);
    clock += LINEAR_LINK_TTL_MS;
    await pass();
    const linkCalls = linearCalls().filter((c) => c.kind === 'LimnLinearPrLinks');
    expect(linkCalls).toHaveLength(1);
    expect(Object.values(linkCalls[0]!.vars)).not.toContain(prUrl(4)); // merged: read once
  });
});

// ---- 4. read on receipt ----

describe('4. read on receipt — one POST per issue, our stored row, peers by ident', () => {
  it('each issue is read ONCE, with the raw key and no "Bearer", and stored with Linear’s URL and criteria', async () => {
    const s = await pass();
    const reads = linearCalls().filter((c) => c.kind === 'LimnLinearIssue');
    expect(reads.map((c) => c.vars.id).sort()).toEqual(['ENG-2', 'ENG-6']);
    expect(new Set(linearCalls().map((c) => c.authorization))).toEqual(new Set([KEY_A]));
    expect(linearCalls().every((c) => c.method === 'POST')).toBe(true);
    expect(s.fetched).toBe(2);
    const r = (await rows(A, [10])).find((x) => x.issueKey === 'ENG-2')!;
    expect(r).toMatchObject({
      provider: 'linear',
      apiRoot: ROOT,
      url: `${ROOT}/issue/ENG-2/the-slug`,
      state: 'ok',
      title: 'Reset password',
      description: 'As a user I can reset my password.\n\nLinear project: Checkout',
      acceptanceCriteria: '- [ ] Email is sent\n- [x] Link expires',
      acFieldId: 'linear:task_list',
      statusName: 'In Progress',
      statusCategory: 'indeterminate',
      assigneeName: 'Ada',
      detectedFrom: 'link',
    });
    const child = (await rows(A, [10])).find((x) => x.issueKey === 'ENG-6')!;
    expect(child.acceptanceCriteria).toBe('- [x] Child (ENG-8)');
    // The merged PR attached to the same issue got its row from the same single read.
    expect((await rows(A, [13])).map((x) => x.issueKey)).toEqual(['ENG-2']);
    calls.length = 0;
    await pass();
    expect(linearCalls()).toEqual([]);
  });

  it('peers: every PR on the ticket (this account), ONE story, by the Linear ident', async () => {
    await pass();
    await pass(B);
    const ident = 'linear:https://linear.app/acme#ENG-2';
    expect((await ticketMembers(ctx, A, ident)).map((m) => m.prId).sort()).toEqual([10, 11, 13]);
    expect((await ticketStory(ctx, A, ident))?.title).toBe('Reset password');
    expect((await ticketMembers(ctx, B, ident)).map((m) => m.prId)).toEqual([90]);
  });

  it('the ticket route answers the stored row; a key the PR does not carry is refused', async () => {
    await pass();
    const ok = await get(A, '/api/prs/10/tracker-ticket?key=eng-2');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ key: 'ENG-2', title: 'Reset password', acceptanceCriteria: '- [ ] Email is sent\n- [x] Link expires' });
    expect((await get(A, '/api/prs/10/tracker-ticket?key=ENG-99')).json().error).toBe('TicketNotDetected');
    expect((await get(A, '/api/prs/90/tracker-ticket?key=ENG-2')).statusCode).toBe(404);
  });
});

// ---- 5. errors ----

describe('5. errors — workspace-wide refusals back off quietly; per-ticket ones are stored', () => {
  it('a refused key: no rows, the workspace backs off, the next pass makes no call; the route says why', async () => {
    mode = 'bad_key';
    const s = await pass();
    expect(s.fetched).toBe(0);
    expect(await rows(A, [10, 11])).toEqual([]);
    calls.length = 0;
    await pass();
    expect(linearCalls()).toEqual([]);
    // A person pressing Refresh bypasses the backoff and gets our sentence, never Linear's body.
    const r = await app.inject({ method: 'POST', url: '/api/prs/11/tracker-ticket/refresh', payload: { key: 'ENG-2' } });
    expect(r.statusCode).toBe(502);
    expect(r.json().message).toBe('Linear rejected this key. Save a new personal API key in Settings.');
    expect(r.body).not.toContain('Authentication required');
  });

  it('a rate limit (RATELIMITED, HTTP 400) is a 5-minute backoff with nothing written', async () => {
    mode = 'rate_limited';
    await pass();
    expect(await rows(A, [10, 11])).toEqual([]);
    mode = 'ok';
    calls.length = 0;
    await pass();
    expect(linearCalls()).toEqual([]); // still backed off (and the key's budget is spent)
    clock += 5 * 60_000 + 1;
    await pass();
    expect((await rows(A, [11])).map((r) => r.state)).toEqual(['ok']);
  });

  it('a low Linear budget makes NO call and surfaces nothing', async () => {
    mode = 'low_budget';
    await pass(); // the first answer carries the low counters
    expect(isLinearBudgetLow(KEY_A, clock)).toBe(true);
    calls.length = 0;
    clock += 60_000;
    await pass();
    expect(linearCalls()).toEqual([]);
  });

  it('not found and no access are STORED per ticket, with our sentences', async () => {
    linIssues.set('ENG-2', 'missing');
    linIssues.set('ENG-6', 'forbidden');
    await pass();
    const byKey = Object.fromEntries((await rows(A, [10])).map((r) => [r.issueKey, r.state]));
    expect(byKey).toEqual({ 'ENG-2': 'not_found', 'ENG-6': 'no_access' });
    expect((await get(A, '/api/prs/10/tracker-ticket?key=ENG-2')).json().message).toContain("Can't read this issue. It does not exist");
    expect((await get(A, '/api/prs/10/tracker-ticket?key=ENG-6')).json().message).toContain('does not have access to its team');
  });

  it('a key for ANOTHER Linear workspace: nothing stored under this one, a workspace backoff', async () => {
    linIssues.set('ENG-2', { title: 'Theirs', description: 'x', org: 'other' });
    linIssues.set('ENG-6', { title: 'Theirs', description: 'x', org: 'other' });
    await pass();
    expect((await rows(A, [10, 11])).filter((r) => r.state === 'ok')).toEqual([]);
    const fp = (await import('../worker.js')).accessFingerprint({
      provider: 'linear',
      apiRoot: ROOT,
      credentials: { email: null, token: KEY_A },
      policy: { cloud: false },
    });
    expect(isBackedOff(A, WS_LIN, fp, clock)).toBe(true);
  });
});

// ---- 6. cost ----

describe('6. cost — zero Linear calls for every other workspace', () => {
  it('Jira, GitHub Issues and a Linear workspace with no key make no Linear call', async () => {
    // Take the keyed Linear workspace out: what is left is Jira (no token), GitHub, Linear w/o a key.
    await put(A, WS_LIN, { issue: { provider: null } });
    calls.length = 0;
    await pass();
    expect(linearCalls()).toEqual([]);
    expect(calls.filter((c) => c.host !== 'api.linear.app')).toEqual([]); // Jira had no token either
    // The no-key Linear workspace still LINKS by detection (chips), with nothing to fill from.
    expect(await prTicketRefs(ctx, { accountId: A, prId: 50, repoId: 500, title: 'ENG-2 no key', headRefName: null })).toEqual([
      { key: 'ENG-2', url: `${ROOT}/issue/ENG-2`, provider: 'linear', canFetchDetails: false },
    ]);
  });

  it('a Linear pass touches only its own workspace’s PRs', async () => {
    await pass();
    const urls = linearCalls().flatMap((c) => Object.values(c.vars).map(String));
    expect(urls.every((u) => u.startsWith('https://github.com/acme/web/') || /^ENG-\d+$/.test(u))).toBe(true);
  });
});

// ---- 7. settings ----

describe('7. settings — the key is sealed, write-only, shape-checked and scoped to one Linear workspace', () => {
  it('stored sealed; never on the wire', async () => {
    const stored = sqlite.prepare('SELECT auth_token FROM workspace_trackers WHERE workspace_id = ?').get(WS_LIN) as { auth_token: string };
    expect(stored.auth_token.startsWith('sealed:v1:enc(')).toBe(true);
    expect(stored.auth_token).not.toContain(KEY_A);
    const r = await get(A, `/api/workspaces/${WS_LIN}/tracker`);
    expect(r.json()).toMatchObject({ issue: { provider: 'linear', baseUrl: 'https://linear.app/Acme' }, jira: { hasToken: true } });
    expect(r.body).not.toContain('lin_api_');
    expect(r.body).not.toContain('enc(');
  });

  it('a value that is not a Linear personal API key is refused, and nothing is saved', async () => {
    const r = await put(A, WS_LIN, { jira: { token: 'ghp_notalinearkey' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toContain('starts with lin_api_');
    expect(trackerPatchError({ provider: 'jira' } as never, { jira: { token: 'anything' } })).toBeNull();
    // The saved key is untouched.
    const stored = sqlite.prepare('SELECT auth_token FROM workspace_trackers WHERE workspace_id = ?').get(WS_LIN) as { auth_token: string };
    expect(stored.auth_token).toContain(Buffer.from(KEY_A).toString('hex'));
  });

  it('moving the URL to another Linear workspace drops the key; a trailing-slash edit does not', () => {
    const existing = { provider: 'linear', baseUrl: ROOT, projectKeys: null, matchScope: null, authEmail: null, authToken: 'plain:k' };
    expect(mergeTracker(existing, { issue: { baseUrl: 'https://linear.app/acme/' } }).authToken).toBe('plain:k');
    expect(mergeTracker(existing, { issue: { baseUrl: 'https://linear.app/other' } }).authToken).toBeNull();
  });

  it('the connection check names the key’s Linear workspace and whether it matches', async () => {
    const ok = await get(A, `/api/workspaces/${WS_LIN}/tracker/linear-check`);
    expect(ok.json()).toEqual({
      workspaceId: WS_LIN,
      viewerName: 'Ada',
      organizationName: 'Acme Inc',
      organizationUrl: ROOT,
      matchesBaseUrl: true,
    });
    viewerOrg = 'other';
    expect((await get(A, `/api/workspaces/${WS_LIN}/tracker/linear-check`)).json()).toMatchObject({
      organizationUrl: 'https://linear.app/other',
      matchesBaseUrl: false,
    });
    mode = 'bad_key';
    const bad = await get(A, `/api/workspaces/${WS_LIN}/tracker/linear-check`);
    expect(bad.statusCode).toBe(502);
    expect(bad.json().message).toBe('Linear rejected this key. Save a new personal API key in Settings.');
  });

  it('the connection check refuses a workspace without a key, a non-Linear one, and another tenant’s', async () => {
    calls.length = 0;
    expect((await get(A, `/api/workspaces/${WS_NOKEY}/tracker/linear-check`)).json()).toMatchObject({
      error: 'NoJiraToken',
      message: 'No Linear API key is saved for this workspace. Add one in Settings.',
    });
    expect((await get(A, `/api/workspaces/${WS_JIRA}/tracker/linear-check`)).json().error).toBe('NotLinear');
    expect((await get(A, `/api/workspaces/${WS_B}/tracker/linear-check`)).statusCode).toBe(404);
    expect(linearCalls()).toEqual([]);
  });
});
