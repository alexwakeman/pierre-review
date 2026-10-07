// ── THE GITHUB ISSUES ADAPTER (docs/TRACKERS.md § GitHub Issues) ──────────────────────────────────
//
// Pinned here:
//   1. ACCEPTANCE CRITERIA, in preference order: sub-issues → a task list → an "Acceptance criteria"
//      section → none (the whole body is the story); code fences never count.
//   2. IDENTITY: `owner/repo#12` keys, the `github:https://github.com/owner/repo#12` ident, and the
//      round trip between a stored row and its ident; a malformed GitHub ident does not parse.
//   3. LINKING is GitHub's `closingIssuesReferences` (cross-repository included, none = []), stored
//      on the PR; a node GitHub did not answer stays "never read"; a PR whose links are unknown is
//      neither pruned nor read; a low budget makes NO call.
//   4. THE WORKER reads each linked issue once and stores it; PEERS are every PR that closes it;
//      an inaccessible issue is stored as `no_access` / `not_found` and the ticket route says "Can't
//      read this issue" — never "no story"; the Open PRs row and merged panel work with the keys.
//   5. A JIRA WORKSPACE MAKES ZERO GITHUB CALLS — the walk's cost for non-GitHub workspaces is
//      unchanged.
//   6. SETTINGS: GitHub needs no base URL or token; switching to it keeps a Jira token whose URL did
//      not move.
//
// In-memory SQLite only — this file never touches DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  GITHUB_TRACKER_ROOT,
  canonicalTicketKey,
  githubIssueKey,
  parseTicketIdent,
  ticketIdentForLink,
  trackerTicketIdent,
  trackerTicketRow,
  type ParsedTrackerIdent,
} from '@pierre-review/shared';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../../db/schema.sqlite.js';
import { __resetRateBudget, noteBudget } from '../../github/rate-budget.js';
import type { TrackerContext } from '../context.js';
import { registerTrackerRoutes } from '../routes.js';
import { readStoredTickets } from '../store.js';
import { ticketMembers, ticketStory, ticketsForPr } from '../peers.js';
import { mergeTracker, isIssueConfigured, issueOf, trackerBaseUrl } from '../settings.js';
import { prTicketRefs } from '../enricher.js';
import { enableTrackerWorker, resetTrackerWorker, runAccountPass } from '../worker.js';
import { extractGithubAcceptanceCriteria } from './ac.js';
import { githubAdapter } from './adapter.js';
import { closingKeysOf, githubLinker, LINK_TTL_MS } from './links.js';
import { githubStatus } from './reader.js';

// ---- 1. acceptance criteria ----

describe('1. acceptance criteria — sub-issues, then a task list, then a heading, then the body', () => {
  const body = [
    'As a user I want to reset my password.',
    '',
    '## Acceptance criteria',
    'Given a reset link, the form opens.',
    '',
    '## Notes',
    'n/a',
  ].join('\n');

  it('sub-issues win: one line per sub-issue, closed ones ticked; the body is left whole', () => {
    const r = extractGithubAcceptanceCriteria(
      `${body}\n- [ ] a task`,
      [
        { number: 3, title: 'Send the email', state: 'CLOSED' },
        { number: 4, title: '  Open   the form ', state: 'OPEN' },
      ],
      5,
    );
    expect(r.criteria).toEqual({
      source: 'sub_issues',
      name: 'Sub-issues',
      text: '- [x] Send the email (#3)\n- [ ] Open the form (#4)\n- … and 3 more sub-issues',
    });
    expect(r.description).toContain('## Acceptance criteria');
    expect(r.description).toContain('- [ ] a task');
  });

  it('a task list comes next — outside code fences — and leaves the description', () => {
    const r = extractGithubAcceptanceCriteria(
      ['Story text.', '', '- [ ] first', '  - [x] nested', '* [X] star', '', '```md', '- [ ] not a criterion', '```'].join('\n'),
    );
    expect(r.criteria?.source).toBe('task_list');
    expect(r.criteria?.text).toBe('- [ ] first\n  - [x] nested\n* [X] star');
    expect(r.description).toBe('Story text.\n\n```md\n- [ ] not a criterion\n```');
  });

  it('an issue form’s checkboxes about the REPORTER are not criteria', () => {
    const form = [
      '## Expected behavior',
      'It resizes.',
      '',
      '## Are you willing to contribute a fix?',
      '',
      '- [x] I am willing to open a PR for this bug.',
      '- [ ] I can try to investigate, but I will need guidance.',
    ].join('\n');
    // No other source: none, and the whole body (checkboxes included) is the story.
    expect(extractGithubAcceptanceCriteria(form).criteria).toBeNull();
    // First-person items under a neutral heading are dropped too; real work items are kept.
    const mixed = ['### Tasks', '- [ ] Add the flag', '- [ ] Document it', '', '### Checks', "- [x] I've searched existing issues"].join('\n');
    expect(extractGithubAcceptanceCriteria(mixed).criteria?.text).toBe('- [ ] Add the flag\n- [ ] Document it');
    // A form section next to a real "Acceptance criteria" section: the section wins.
    expect(extractGithubAcceptanceCriteria(`${form}\n\n## Acceptance criteria\nIt keeps x/y.`).criteria).toMatchObject({
      source: 'heading',
      text: 'It keeps x/y.',
    });
  });

  it('then an "Acceptance criteria" section, up to the next heading of the same level', () => {
    const r = extractGithubAcceptanceCriteria(body);
    expect(r.criteria).toEqual({
      source: 'heading',
      name: 'Acceptance criteria section',
      text: 'Given a reset link, the form opens.',
    });
    expect(r.description).toBe('As a user I want to reset my password.\n\n## Notes\nn/a');
  });

  it('a bold label counts as the heading; a section that is empty does not', () => {
    expect(extractGithubAcceptanceCriteria('Intro\n**Acceptance Criteria:**\nIt works.\n### Later\nx').criteria?.text).toBe(
      'It works.',
    );
    expect(extractGithubAcceptanceCriteria('## Acceptance criteria\n\n## Next\nbody').criteria).toBeNull();
  });

  it('none of these: no criteria, and the whole body is the story', () => {
    const r = extractGithubAcceptanceCriteria('Just a description.\r\nSecond line.');
    expect(r).toEqual({ description: 'Just a description.\nSecond line.', criteria: null });
    expect(extractGithubAcceptanceCriteria(null)).toEqual({ description: '', criteria: null });
  });

  it('state: open is "to do", closed is "done" with GitHub’s reason', () => {
    expect(githubStatus('OPEN', null)).toEqual({ name: 'Open', category: 'new' });
    expect(githubStatus('CLOSED', 'NOT_PLANNED')).toEqual({ name: 'Closed as not planned', category: 'done' });
    expect(githubStatus('CLOSED', 'COMPLETED')).toEqual({ name: 'Closed', category: 'done' });
  });
});

// ---- 2. identity ----

describe('2. identity — one key and one ident per issue', () => {
  it('keys are lower-cased owner/repo#number; anything else is refused', () => {
    expect(githubIssueKey('Ratatui/Ratatui', 2526)).toBe('ratatui/ratatui#2526');
    expect(githubIssueKey('acme/web', 0)).toBeNull();
    expect(canonicalTicketKey('Acme/Web#12')).toBe('acme/web#12');
    expect(canonicalTicketKey('eng-7')).toBe('ENG-7');
    expect(canonicalTicketKey('#12')).toBeNull();
  });

  it('a stored row ↔ its ident round-trips, and Jira idents are unchanged', () => {
    const ident = trackerTicketIdent('github', GITHUB_TRACKER_ROOT, 'acme/web#12');
    expect(ident).toBe('github:https://github.com/acme/web#12');
    const parsed = parseTicketIdent(ident) as ParsedTrackerIdent;
    expect(parsed).toMatchObject({ kind: 'github', root: 'https://github.com/acme/web', key: '12' });
    expect(trackerTicketRow(parsed)).toEqual({ provider: 'github', apiRoot: GITHUB_TRACKER_ROOT, issueKey: 'acme/web#12' });
    expect(trackerTicketIdent('jira', 'https://acme.atlassian.net', 'ENG-7')).toBe('jira:https://acme.atlassian.net#ENG-7');
  });

  it('a malformed GitHub ident does not parse (a request body cannot smuggle one in)', () => {
    expect(parseTicketIdent('github:https://github.com/acme/web#ENG-7')).toBeNull();
    expect(parseTicketIdent('github:https://evil.example/acme/web#12')).toBeNull();
    expect(parseTicketIdent('github:https://github.com#12')).toBeNull();
  });

  it('the SPA’s link → ident rule agrees with the server’s row → ident rule', () => {
    expect(ticketIdentForLink({ key: 'ACME/WEB#12', url: 'https://github.com/acme/web/issues/12', provider: 'github' })).toBe(
      'github:https://github.com/acme/web#12',
    );
    expect(ticketIdentForLink({ key: 'ENG-7', url: 'https://acme.atlassian.net/browse/ENG-7', provider: 'jira' })).toBe(
      'jira:https://acme.atlassian.net#ENG-7',
    );
    expect(ticketIdentForLink({ key: 'ENG-7', url: 'https://linear.app/acme/issue/ENG-7', provider: 'linear' })).toBe(
      'linear:https://linear.app/acme#ENG-7',
    );
  });

  it('the adapter: browse link, key normalisation, detection from the stored links only', () => {
    expect(githubAdapter.browseUrl('', 'acme/web#12')).toBe('https://github.com/acme/web/issues/12');
    expect(githubAdapter.normalizeKey('ACME/Web#12')).toBe('acme/web#12');
    expect(githubAdapter.normalizeKey('ENG-7')).toBeNull();
    const cfg = { provider: 'github' as const, baseUrl: GITHUB_TRACKER_ROOT, projectKeys: [], matchScope: 'title_branch' as const };
    // A "#12" in the title is NOT a ticket; only what GitHub says the PR closes.
    expect(githubAdapter.detect(cfg, { title: 'Fix #12', headRefName: 'fix-12', closingIssues: null })).toEqual([]);
    expect(
      githubAdapter.detect(cfg, { title: 'x', headRefName: null, closingIssues: ['acme/web#3', 'Other/Lib#9', 'acme/web#3'] }),
    ).toEqual([
      { key: 'acme/web#3', from: 'link', order: 0 },
      { key: 'other/lib#9', from: 'link', order: 1 },
    ]);
  });
});

// ---- harness for 3–6 ----

const A = 1;
const B = 2;
const WS_GH = 2; // account 1, GitHub Issues, repo 200
const WS_JIRA = 3; // account 1, Jira, repo 300
const WS_B = 90; // account 2, GitHub Issues, repo 900

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

// GitHub's answers. `links`: PR node id → the issues it closes (undefined = GitHub returns no node).
const links = new Map<string, Array<{ nwo: string; n: number }> | null>();
type FakeIssue = { title: string; body: string; state?: string; sub?: Array<{ number: number; title: string; state: string }> };
const issues = new Map<string, FakeIssue | 'forbidden' | 'missing'>();
const gh: Array<{ accountId: number; kind: 'links' | 'issue'; vars: Record<string, unknown> }> = [];

const fakeGithub: NonNullable<TrackerContext['github']> = {
  graphql: async <T,>(accountId: number, query: string, vars: Record<string, unknown>) => {
    const rateLimit = { cost: 1, remaining: 4000, resetAt: new Date(clock + 3600_000).toISOString() };
    if (query.includes('TrackerClosingIssues')) {
      gh.push({ accountId, kind: 'links', vars });
      const nodes = (vars.ids as string[]).map((id) => {
        if (!links.has(id)) return null;
        const refs = links.get(id);
        if (refs === null) return { id, closingIssuesReferences: null }; // the selection was nulled
        return {
          id,
          closingIssuesReferences: { nodes: (refs ?? []).map((r) => ({ number: r.n, repository: { nameWithOwner: r.nwo } })) },
        };
      });
      return { data: { nodes, rateLimit } as T };
    }
    gh.push({ accountId, kind: 'issue', vars });
    const key = `${String(vars.owner)}/${String(vars.name)}#${String(vars.number)}`;
    const i = issues.get(key);
    if (i === 'forbidden') {
      return { data: { repository: null, rateLimit } as T, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' }] };
    }
    if (i == null || i === 'missing') {
      return { data: { repository: { issue: null }, rateLimit } as T, errors: [{ type: 'NOT_FOUND', message: 'no issue' }] };
    }
    return {
      data: {
        repository: {
          issue: {
            number: Number(vars.number),
            title: i.title,
            url: `https://github.com/${key.replace('#', '/issues/')}`,
            state: i.state ?? 'OPEN',
            stateReason: null,
            body: i.body,
            issueType: { id: 'IT_1', name: 'Feature' },
            assignees: { nodes: [{ login: 'ada', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }] },
            subIssues: { totalCount: i.sub?.length ?? 0, nodes: i.sub ?? [] },
          },
        },
        rateLimit,
      } as T,
    };
  },
};

const setLinks = (prNode: string, refs: Array<{ nwo: string; n: number }> | null | undefined) => {
  if (refs === undefined) links.delete(prNode);
  else links.set(prNode, refs);
};
const rows = (accountId: number, prIds: number[]) => readStoredTickets(ctx, accountId, prIds);
// ⚠ A Jira transport that THROWS: nothing here may reach a real network.
const noJira = async (): Promise<never> => {
  throw new Error('Jira was called');
};
const pass = (accountId = A) => runAccountPass(ctx, accountId, { now, transport: noJira });

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);');
  sqlite.exec(
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, is_default integer NOT NULL DEFAULT 0);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      "INSERT INTO workspaces VALUES (1,1,'Default',1),(2,1,'GitHub Issues test',0),(3,1,'Jira team',0),(90,2,'Other',1);" +
      'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
      'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,2,200),(1,3,300),(2,90,900);' +
      'CREATE TABLE repos (id integer PRIMARY KEY, account_id integer NOT NULL, owner text NOT NULL, name text NOT NULL);' +
      "INSERT INTO repos VALUES (200,1,'acme','web'),(300,1,'acme','jira-app'),(900,2,'evil','web');" +
      'CREATE TABLE users (id integer PRIMARY KEY, github_login text NOT NULL, display_name text, avatar_url text);' +
      "INSERT INTO users VALUES (5,'ada','Ada','https://a.example/ada.png');" +
      'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, repo_id integer NOT NULL, ' +
      'number integer NOT NULL, title text NOT NULL, author_id integer, head_ref_name text, github_node_id text NOT NULL, ' +
      'state text NOT NULL, updated_at integer, merged_at integer, closing_issues text, closing_issues_checked_at integer, ' +
        'linear_links text, linear_links_root text, linear_links_checked_at integer);',
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host: { isCloud: false },
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
    github: fakeGithub,
  } as unknown as TrackerContext;
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  // A Jira transport that FAILS the test if anything calls Jira.
  registerTrackerRoutes(app, ctx, { transport: noJira });
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

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 7, 9, 0);
  gh.length = 0;
  links.clear();
  issues.clear();
  __resetRateBudget();
  resetTrackerWorker();
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM pull_requests; DELETE FROM workspace_trackers;');
  const ins = sqlite.prepare(
    'INSERT INTO pull_requests (id, account_id, repo_id, number, title, author_id, head_ref_name, github_node_id, state, updated_at, merged_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const t = Math.floor((clock - 3600_000) / 1000);
  ins.run(10, A, 200, 1, 'Fix #12 reset', 5, 'fix-12', 'PR_10', 'open', t, null);
  ins.run(11, A, 200, 2, 'Also reset', 5, null, 'PR_11', 'open', t, null);
  ins.run(12, A, 200, 3, 'Unlinked', 5, null, 'PR_12', 'open', t, null);
  ins.run(13, A, 200, 4, 'Landed earlier', 5, null, 'PR_13', 'merged', t, Math.floor((clock - 2 * 86400_000) / 1000));
  ins.run(30, A, 300, 9, 'ENG-7 jira work', 5, null, 'PR_30', 'open', t, null);
  ins.run(90, B, 900, 1, 'Foreign', 5, null, 'PR_90', 'open', t, null);
  // The settings PUT kicks the worker; keep it off while the fixture is laid out.
  enableTrackerWorker(false);
  expect((await put(A, WS_GH, { issue: { provider: 'github' } })).statusCode).toBe(200);
  expect((await put(A, WS_JIRA, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] } })).statusCode).toBe(200);
  expect((await put(B, WS_B, { issue: { provider: 'github' } })).statusCode).toBe(200);
  enableTrackerWorker(true);
  gh.length = 0;
  // PR 10 and PR 11 close the same issue (a stack); PR 10 also closes a cross-repo one; 12 closes
  // nothing; the merged PR 13 closes the same issue too.
  setLinks('PR_10', [
    { nwo: 'Acme/Web', n: 12 },
    { nwo: 'acme/lib', n: 4 },
  ]);
  setLinks('PR_11', [{ nwo: 'acme/web', n: 12 }]);
  setLinks('PR_12', []);
  setLinks('PR_13', [{ nwo: 'acme/web', n: 12 }]);
  setLinks('PR_90', [{ nwo: 'acme/web', n: 12 }]);
  issues.set('acme/web#12', {
    title: 'Reset password',
    body: 'As a user I can reset my password.\n\n- [ ] Email is sent\n- [x] Link expires',
  });
  issues.set('acme/lib#4', { title: 'Token helper', body: 'Helper.', sub: [{ number: 5, title: 'Write it', state: 'OPEN' }] });
});

// ---- 3. linking ----

describe('3. linking — GitHub’s closing references, stored on the PR', () => {
  it('closingKeysOf: cross-repo kept, duplicates dropped, none is [], a nulled selection is unknown', () => {
    expect(
      closingKeysOf({
        closingIssuesReferences: {
          nodes: [
            { number: 1, repository: { nameWithOwner: 'A/B' } },
            { number: 1, repository: { nameWithOwner: 'a/b' } },
            { number: 2, repository: { nameWithOwner: 'c/d' } },
          ],
        },
      }),
    ).toEqual(['a/b#1', 'c/d#2']);
    expect(closingKeysOf({ closingIssuesReferences: { nodes: [] } })).toEqual([]);
    expect(closingKeysOf({ closingIssuesReferences: null })).toBeNull();
  });

  it('the linker writes what GitHub stated, and only that', async () => {
    setLinks('PR_12', null); // GitHub nulled the selection for this one
    const prs = [10, 11, 12].map((id) => ({
      id,
      githubNodeId: `PR_${id}`,
      state: 'open',
      updatedAt: new Date(clock - 3600_000),
      closingIssuesCheckedAt: null,
    }));
    const r = await githubLinker.refresh(ctx, A, prs, { now: clock });
    expect(r).toEqual({ read: 2, skipped: 1 });
    expect(gh).toHaveLength(1); // ONE nodes(ids:) call for the batch
    const stored = sqlite.prepare('SELECT id, closing_issues, closing_issues_checked_at FROM pull_requests WHERE id IN (10,11,12) ORDER BY id').all();
    expect(stored).toEqual([
      { id: 10, closing_issues: '["acme/web#12","acme/lib#4"]', closing_issues_checked_at: Math.floor(clock / 1000) },
      { id: 11, closing_issues: '["acme/web#12"]', closing_issues_checked_at: Math.floor(clock / 1000) },
      { id: 12, closing_issues: null, closing_issues_checked_at: null },
    ]);
  });

  it('due: never read; edited since; open and older than the TTL — and nothing else', () => {
    const base = { id: 1, githubNodeId: 'X', state: 'open', updatedAt: new Date(clock - 3600_000) };
    expect(githubLinker.isDue({ ...base, closingIssuesCheckedAt: null }, clock)).toBe(true);
    expect(githubLinker.isDue({ ...base, closingIssuesCheckedAt: new Date(clock - 60_000) }, clock)).toBe(false);
    expect(githubLinker.isDue({ ...base, closingIssuesCheckedAt: new Date(clock - LINK_TTL_MS) }, clock)).toBe(true);
    expect(
      githubLinker.isDue(
        { ...base, state: 'merged', updatedAt: new Date(clock - 20 * LINK_TTL_MS), closingIssuesCheckedAt: new Date(clock - 10 * LINK_TTL_MS) },
        clock,
      ),
    ).toBe(false);
    expect(
      githubLinker.isDue({ ...base, updatedAt: new Date(clock), closingIssuesCheckedAt: new Date(clock - 60_000) }, clock),
    ).toBe(true);
  });

  it('a low GitHub budget makes NO call and surfaces nothing; the PRs stay due', async () => {
    noteBudget(A, { remaining: 20, resetAt: new Date(Date.now() + 3600_000) });
    const s = await pass();
    expect(gh).toEqual([]);
    expect(s.failed).toBe(0);
    expect(await rows(A, [10, 11, 12])).toEqual([]);
  });

  it('a PR whose links were never read is neither pruned nor read', async () => {
    await pass();
    expect((await rows(A, [10])).length).toBe(2);
    // GitHub stops answering for PR 10 and its stored links are forgotten (never read).
    sqlite.exec('UPDATE pull_requests SET closing_issues = NULL, closing_issues_checked_at = NULL WHERE id = 10');
    setLinks('PR_10', undefined);
    gh.length = 0;
    await pass();
    expect((await rows(A, [10])).map((r) => r.issueKey)).toEqual(['acme/web#12', 'acme/lib#4']);
    expect(gh.filter((c) => c.kind === 'issue')).toEqual([]);
  });

  it('the PR pane shows nothing (not "No ticket found") until the links are read', async () => {
    expect(await prTicketRefs(ctx, { accountId: A, prId: 12, repoId: 200, title: 'Unlinked', headRefName: null })).toBeNull();
    await pass();
    expect(await prTicketRefs(ctx, { accountId: A, prId: 12, repoId: 200, title: 'Unlinked', headRefName: null })).toEqual([]);
    expect(await prTicketRefs(ctx, { accountId: A, prId: 10, repoId: 200, title: 'x', headRefName: null })).toEqual([
      { key: 'acme/web#12', url: 'https://github.com/acme/web/issues/12', provider: 'github', canFetchDetails: true },
      { key: 'acme/lib#4', url: 'https://github.com/acme/lib/issues/4', provider: 'github', canFetchDetails: true },
    ]);
  });
});

// ---- 4. the worker, peers, the views ----

describe('4. read on receipt; peers; the views', () => {
  it('each linked issue is read ONCE per pass and stored with its criteria; a second pass reads nothing', async () => {
    const s = await pass();
    expect(gh.filter((c) => c.kind === 'links')).toHaveLength(1);
    expect(gh.filter((c) => c.kind === 'issue').map((c) => `${String(c.vars.owner)}/${String(c.vars.name)}#${String(c.vars.number)}`).sort()).toEqual([
      'acme/lib#4',
      'acme/web#12',
    ]);
    expect(s.fetched).toBe(2);
    const [r12, r4] = await rows(A, [10]);
    expect(r12).toMatchObject({
      provider: 'github',
      issueKey: 'acme/web#12',
      apiRoot: GITHUB_TRACKER_ROOT,
      url: 'https://github.com/acme/web/issues/12',
      detectedFrom: 'link',
      state: 'ok',
      title: 'Reset password',
      description: 'As a user I can reset my password.',
      acceptanceCriteria: '- [ ] Email is sent\n- [x] Link expires',
      acFieldId: 'github:task_list',
      statusName: 'Open',
      statusCategory: 'new',
      assigneeName: 'ada',
      issueTypeName: 'Feature',
    });
    expect(r4).toMatchObject({ issueKey: 'acme/lib#4', acceptanceCriteria: '- [ ] Write it (#5)', acFieldId: 'github:sub_issues' });
    // The merged PR closing the same issue copied the stored row: no second read.
    expect((await rows(A, [13])).map((r) => r.issueKey)).toEqual(['acme/web#12']);
    gh.length = 0;
    await pass();
    expect(gh).toEqual([]);
  });

  it('PEERS: every PR that closes the issue (open and merged), this account only; ONE story', async () => {
    await pass();
    await pass(B);
    const ident = 'github:https://github.com/acme/web#12';
    expect((await ticketMembers(ctx, A, ident)).map((m) => m.prId)).toEqual([10, 11, 13]);
    expect((await ticketMembers(ctx, B, ident)).map((m) => m.prId)).toEqual([90]);
    expect(await ticketStory(ctx, A, ident)).toMatchObject({
      title: 'Reset password',
      acceptanceCriteria: '- [ ] Email is sent\n- [x] Link expires',
      key: 'acme/web#12',
      url: 'https://github.com/acme/web/issues/12',
    });
    expect((await ticketsForPr(ctx, A, 10)).map((t) => t.ident)).toEqual([
      'github:https://github.com/acme/web#12',
      'github:https://github.com/acme/lib#4',
    ]);
  });

  it('an inaccessible issue is stored as such and the ticket route says "Can’t read this issue"', async () => {
    issues.set('acme/lib#4', 'forbidden');
    setLinks('PR_11', [{ nwo: 'acme/gone', n: 1 }]);
    await pass();
    const byKey = new Map((await rows(A, [10, 11])).map((r) => [r.issueKey, r]));
    expect(byKey.get('acme/lib#4')).toMatchObject({ state: 'no_access', errorCode: 'no_access', title: null });
    expect(byKey.get('acme/gone#1')).toMatchObject({ state: 'not_found', title: null });
    // One unreadable repository does not stop the workspace: the other issue was read.
    expect(byKey.get('acme/web#12')?.state).toBe('ok');
    const r = await app.inject({ method: 'GET', url: `/api/prs/10/tracker-ticket?key=${encodeURIComponent('ACME/LIB#4')}` });
    expect(r.statusCode).toBe(502);
    expect(r.json().message).toBe("Can't read this issue. Your GitHub account does not have access to its repository.");
    const ok = await app.inject({ method: 'GET', url: `/api/prs/10/tracker-ticket?key=${encodeURIComponent('acme/web#12')}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ key: 'acme/web#12', title: 'Reset password', acField: { id: 'github:task_list' } });
  });

  it('the Open PRs row and the merged panel answer GitHub keys from stored rows', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/ticket-links', payload: { prIds: [10, 12] } });
    // Links not read yet: nothing claimed, and the board asks again.
    expect(first.json()).toEqual({ prs: [], titlesComplete: false });
    await pass();
    const again = await app.inject({ method: 'POST', url: '/api/ticket-links', payload: { prIds: [10, 12] } });
    expect(again.json().titlesComplete).toBe(true);
    expect(again.json().prs).toEqual([
      {
        prId: 10,
        jiraBrowsePrefix: null,
        tickets: [
          expect.objectContaining({ key: 'acme/web#12', provider: 'github', title: 'Reset password', statusCategory: 'new' }),
          expect.objectContaining({ key: 'acme/lib#4', provider: 'github', title: 'Token helper' }),
        ],
      },
      { prId: 12, jiraBrowsePrefix: null, tickets: [] },
    ]);
    const merged = await app.inject({
      method: 'GET',
      url: `/api/ticket-merged-prs?workspace=${WS_GH}&keys=${encodeURIComponent('ACME/WEB#12,acme/lib#4')}`,
    });
    expect(merged.json()).toEqual({
      workspaceId: WS_GH,
      tickets: [
        expect.objectContaining({ key: 'acme/web#12', ident: 'github:https://github.com/acme/web#12', prs: [expect.objectContaining({ prId: 13 })] }),
      ],
    });
  });

  it('a key the PR does not close is refused — not a GitHub proxy', async () => {
    await pass();
    const r = await app.inject({ method: 'GET', url: `/api/prs/10/tracker-ticket?key=${encodeURIComponent('acme/secret#1')}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('TicketNotDetected');
    expect((await app.inject({ method: 'GET', url: `/api/prs/90/tracker-ticket?key=${encodeURIComponent('acme/web#12')}` })).statusCode).toBe(404);
  });
});

// ---- 5. cost ----

describe('5. a workspace on another tracker makes ZERO GitHub calls', () => {
  it('the Jira workspace’s PRs are never sent to GitHub', async () => {
    await pass();
    const asked = gh.filter((c) => c.kind === 'links').flatMap((c) => c.vars.ids as string[]);
    expect(asked.sort()).toEqual(['PR_10', 'PR_11', 'PR_12', 'PR_13']);
    expect(asked).not.toContain('PR_30');
  });

  it('with no GitHub Issues workspace at all, a pass calls GitHub zero times', async () => {
    enableTrackerWorker(false);
    expect((await put(A, WS_GH, { issue: { provider: null } })).statusCode).toBe(200);
    enableTrackerWorker(true);
    gh.length = 0;
    await pass();
    expect(gh).toEqual([]);
  });
});

// ---- 6. settings ----

describe('6. settings — GitHub needs nothing typed in', () => {
  it('no base URL, no token: still a configured, reading tracker', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/workspaces/${WS_GH}/tracker` });
    expect(r.json().issue).toMatchObject({ provider: 'github', baseUrl: null });
    const issue = issueOf({ provider: 'github', baseUrl: null, projectKeys: null, matchScope: null, authEmail: null, authToken: null });
    expect(isIssueConfigured(issue)).toBe(true);
    expect(trackerBaseUrl(issue)).toBe(GITHUB_TRACKER_ROOT);
  });

  it('switching to GitHub keeps a Jira token whose base URL did not move; moving the URL drops it', () => {
    const jira = {
      provider: 'jira',
      baseUrl: 'https://acme.atlassian.net',
      projectKeys: 'ENG',
      matchScope: null,
      authEmail: null,
      authToken: 'plain:t0k',
    };
    expect(mergeTracker(jira, { issue: { provider: 'github' } }).authToken).toBe('plain:t0k');
    expect(mergeTracker(jira, { issue: { provider: 'github', baseUrl: null } }).authToken).toBeNull();
  });

  it('an unknown provider is still refused by the route', async () => {
    expect((await put(A, WS_GH, { issue: { provider: 'asana' } })).statusCode).toBe(400);
  });
});
