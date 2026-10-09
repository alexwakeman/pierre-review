// THE WORKSPACE'S TRACKER (core `workspace_trackers`) and THE PR THAT FINDS ITS OWN WORKSPACE —
// ported from the plugin's workspace-settings test when the tracker moved to core (apiVersion 23).
// Pinned:
//   1. The writer validates and normalises (base URL trimmed, project keys uppercased/deduped/
//      shape-checked), an UNSET match scope reads as title+branch (the behaviour before the setting
//      existed) and is stored NULL, and a patch to one field never clobbers a neighbour — the token
//      above all.
//   2. A provider with no adapter (GitHub until its adapter ships) is REFUSED by the writer and reads
//      as "no tracker" if one is ever stored.
//   3. The enricher resolves the PR's OWN workspace; a repo with NO membership row, another tenant's
//      repo, a workspace with no tracker or a provider with no base URL all render NOTHING (null) —
//      never a neighbour's tracker. The match scope reaches detection.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/tracker/settings
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { jiraAcFields, trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import type { TrackerContext } from './context.js';
import { mergeTracker, readWorkspaceTracker, readWorkspaceTrackerAccess, writeWorkspaceTracker } from './settings.js';
import { prTicketRefs } from './enricher.js';

const migration = readFileSync(fileURLToPath(new URL('../db/migrations/0088_issue_tracker.sql', import.meta.url)), 'utf8');

const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
});
const coreWorkspaceRepos = sqliteTable('workspace_repos', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  repoId: integer('repo_id').notNull(),
});

// Account 1 owns Default(1) + Platform(2); account 2 owns 90. Repo 100 is in workspace 1, repo 200
// in workspace 2, repo 300 has NO membership row, repo 900 belongs to the other tenant.
const SETUP =
  'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
  'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
  'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
  'INSERT INTO workspaces VALUES (1,1),(2,1),(90,2);' +
  'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
  'workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
  'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,1,100),(1,2,200),(2,90,900);';

let sqlite: Database.Database;
let ctx: TrackerContext;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(SETUP);
  sqlite.exec(migration);
  ctx = {
    db: drizzle(sqlite),
    isPg: false,
    host: { isCloud: false },
    accountIdOf: () => 1,
    defaultWorkspaceId: async () => 1,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { workspaces: coreWorkspaces, workspaceRepos: coreWorkspaceRepos, trackerTickets, jiraAcFields, workspaceTrackers },
  } as unknown as TrackerContext;
});

describe('1. the writer', () => {
  it('validates and normalises the tracker fields', async () => {
    await writeWorkspaceTracker(ctx, 1, 2, {
      issue: {
        provider: 'jira',
        baseUrl: '  https://acme.atlassian.net/  ',
        // `parseProjectKeys` splits on whitespace as well as commas; what is DROPPED is a token
        // failing the prefix shape (leading digit, one character, over ten characters).
        projectKeys: ['eng', 'ENG', '1bad', 'x', 'waytoolongprefix', 'ops'],
        matchScope: 'title',
      },
    });
    const s = await readWorkspaceTracker(ctx, 1, 2);
    expect(s.issue.baseUrl).toBe('https://acme.atlassian.net');
    expect(s.issue.projectKeys).toEqual(['ENG', 'OPS']);
    // A non-absolute URL is REJECTED to null rather than stored.
    await writeWorkspaceTracker(ctx, 1, 2, { issue: { baseUrl: 'acme.atlassian.net' } });
    expect((await readWorkspaceTracker(ctx, 1, 2)).issue.baseUrl).toBeNull();
  });

  it('⚠ an UNSET match scope reads as title+branch, and is stored NULL', async () => {
    await writeWorkspaceTracker(ctx, 1, 2, { issue: { provider: 'jira' } });
    expect((await readWorkspaceTracker(ctx, 1, 2)).issue.matchScope).toBe('title_branch');
    expect(sqlite.prepare('SELECT match_scope m FROM workspace_trackers').get()).toEqual({ m: null });
  });

  it('⚠ a patch to one field never clobbers a neighbour — the token above all', async () => {
    await writeWorkspaceTracker(ctx, 1, 2, {
      issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'], matchScope: 'title' },
      jira: { email: 'dev@acme.io', token: 'secret' },
    });
    await writeWorkspaceTracker(ctx, 1, 2, { issue: { projectKeys: ['OPS', 'ENG'] } });
    const s = await readWorkspaceTracker(ctx, 1, 2);
    expect(s.issue).toEqual({ provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['OPS', 'ENG'], matchScope: 'title' });
    expect(s.jira).toEqual({ email: 'dev@acme.io', hasToken: true });
    expect((await readWorkspaceTrackerAccess(ctx, 1, 2)).token).toEqual({ state: 'ok', token: 'secret' });
  });

  it('clearing the tracker writes NULLs — the row (and so nothing to resurrect) stays', async () => {
    await writeWorkspaceTracker(ctx, 1, 2, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net' } });
    await writeWorkspaceTracker(ctx, 1, 2, { issue: { provider: null } });
    expect((await readWorkspaceTracker(ctx, 1, 2)).issue.provider).toBeNull();
    expect(sqlite.prepare('SELECT count(*) c FROM workspace_trackers').get()).toEqual({ c: 1 });
  });
});

describe('2. only implemented providers', () => {
  it('the writer refuses a provider with no adapter (stored as a chosen None)', () => {
    // GitHub Issues has an adapter since phase 2; a provider name nobody implements is refused —
    // stored as the explicit 'none' (0094), never NULL, which would mean "follow the automatic default".
    const cols = mergeTracker(null, { issue: { provider: 'asana' as never, baseUrl: 'https://app.asana.com' } });
    expect(cols.provider).toBe('none');
  });

  it('a stored provider with no adapter reads as "no tracker"', async () => {
    sqlite.exec("INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url) VALUES (1, 1, 'asana', 'https://app.asana.com')");
    expect((await readWorkspaceTracker(ctx, 1, 1)).issue.provider).toBeNull();
    expect(await prTicketRefs(ctx, { accountId: 1, repoId: 100, title: 'Fix ENG-1', headRefName: null })).toBeNull();
  });
});

describe('3. the PR finds its own workspace', () => {
  const pr = (over: Partial<{ accountId: number; repoId: number; title: string; headRefName: string | null }>) => ({
    accountId: 1,
    repoId: 100,
    title: 'no key here',
    headRefName: null,
    ...over,
  });

  beforeEach(async () => {
    // Workspace 1 tracks Jira/ENG; workspace 2 tracks Linear/OPS (link-only).
    await writeWorkspaceTracker(ctx, 1, 1, {
      issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ENG'] },
    });
    await writeWorkspaceTracker(ctx, 1, 2, {
      issue: { provider: 'linear', baseUrl: 'https://linear.app/acme', projectKeys: ['OPS'] },
    });
  });

  it('⚠ USES THE WORKSPACE THAT OWNS THE PR’S REPO', async () => {
    expect(await prTicketRefs(ctx, pr({ repoId: 100, title: 'Fix ENG-1' }))).toEqual([
      // A reading provider's tickets carry `canFetchDetails` — false here, no token saved.
      { key: 'ENG-1', url: 'https://acme.atlassian.net/browse/ENG-1', provider: 'jira', canFetchDetails: false },
    ]);
    // The SAME title against a repo in the other workspace resolves against the OTHER tracker.
    expect(await prTicketRefs(ctx, pr({ repoId: 200, title: 'Fix ENG-1' }))).toEqual([]);
    // Linear reads too (phase 3): a link, and `canFetchDetails` false until an API key is saved.
    expect(await prTicketRefs(ctx, pr({ repoId: 200, title: 'Fix OPS-9' }))).toEqual([
      { key: 'OPS-9', url: 'https://linear.app/acme/issue/OPS-9', provider: 'linear', canFetchDetails: false },
    ]);
  });

  it('⚠ a repo with NO membership row, and another tenant’s repo, render nothing', async () => {
    expect(await prTicketRefs(ctx, pr({ repoId: 300, title: 'Fix ENG-1' }))).toBeNull();
    expect(await prTicketRefs(ctx, pr({ accountId: 1, repoId: 900, title: 'Fix ENG-1' }))).toBeNull();
  });

  it('no tracker, or a provider with no base URL, is NOT configured — one liveness test', async () => {
    await writeWorkspaceTracker(ctx, 1, 1, { issue: { baseUrl: null } });
    expect(await prTicketRefs(ctx, pr({ repoId: 100, title: 'Fix ENG-1' }))).toBeNull();
    await writeWorkspaceTracker(ctx, 1, 1, { issue: { provider: null, baseUrl: 'https://acme.atlassian.net' } });
    expect(await prTicketRefs(ctx, pr({ repoId: 100, title: 'Fix ENG-1' }))).toBeNull();
  });

  it('⚠ THE MATCH SCOPE REACHES DETECTION', async () => {
    const branchOnly = pr({ repoId: 100, title: 'no key here', headRefName: 'alex/eng-7-fix' });
    expect((await prTicketRefs(ctx, branchOnly))!.map((t) => t.key)).toEqual(['ENG-7']);
    await writeWorkspaceTracker(ctx, 1, 1, { issue: { matchScope: 'title' } });
    expect(await prTicketRefs(ctx, branchOnly)).toEqual([]);
    expect(
      (await prTicketRefs(ctx, pr({ repoId: 100, title: 'Fix ENG-7', headRefName: 'alex/eng-9-fix' })))!.map((t) => t.key),
    ).toEqual(['ENG-7']);
  });

  it('canFetchDetails follows the token', async () => {
    await writeWorkspaceTracker(ctx, 1, 1, { jira: { token: 'secret' } });
    expect((await prTicketRefs(ctx, pr({ repoId: 100, title: 'Fix ENG-1' })))?.[0]?.canFetchDetails).toBe(true);
  });
});
