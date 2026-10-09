// THE AUTOMATIC DEFAULT TRACKER (migration 0094; docs/TRACKERS.md § Automatic default). Pinned:
//   1. RESOLUTION, in ONE place (tracker/settings.ts): no stored choice + a repo that uses GitHub
//      Issues → GitHub Issues for every reader; no such repo → none; a chosen None is STORED and
//      wins; a chosen Jira wins; a patch that names no provider leaves the workspace automatic.
//   2. THE MIGRATION turns only an ALL-NULL row (the row a None save alone writes) into the stored
//      'none'; a NULL provider beside any other value (a legacy-moved match scope) stays unchosen.
//   3. THE WORKER'S POPULATION includes an auto-detected workspace, this account's only.
//   4. DETECTION (tracker/github/issues-usage.ts): writes only on a POSITIVE answer, stamps every
//      completed attempt, stamps nothing on a rate limit, asks only repos of unchosen workspaces and
//      at most once a day.
//
//   DATABASE_URL=/private/tmp/x.sqlite ./node_modules/.bin/vitest run src/tracker/auto-default.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { repos, workspaceTrackers } from '../db/schema.sqlite.js';
import type { TrackerContext } from './context.js';
import {
  autoDetectedWorkspaces,
  readStoredTrackerRow,
  readWorkspaceTracker,
  readWorkspaceTrackerAccess,
  writeWorkspaceTracker,
} from './settings.js';
import { checkReposGithubIssuesUsage, refreshGithubIssuesUsage, usageOf, usageSearchQuery, USAGE_RECHECK_MS } from './github/issues-usage.js';
import { __resetRateBudget, noteBudget } from '../github/rate-budget.js';

const mig = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

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

// Account 1: workspaces 1, 2, 3. Repo 100 (acme/web) in ws 1, repo 200 (acme/api) in ws 2, repo 300
// (acme/ops) in ws 3. Account 2: ws 90 with repo 900 (acme/web too — another tenant's row).
const SETUP =
  'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
  'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
  'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
  'INSERT INTO workspaces VALUES (1,1),(2,1),(3,1),(90,2);' +
  'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
  'workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
  'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,1,100),(1,2,200),(1,3,300),(2,90,900);' +
  'CREATE TABLE repos (id integer PRIMARY KEY, account_id integer NOT NULL, owner text NOT NULL, name text NOT NULL);' +
  "INSERT INTO repos VALUES (100,1,'acme','web'),(200,1,'acme','api'),(300,1,'acme','ops'),(900,2,'acme','web');";

let sqlite: Database.Database;
let ctx: TrackerContext;
let calls: Array<{ accountId: number; variables: Record<string, unknown> }>;
let answer: (vars: Record<string, unknown>) => { data: unknown; errors?: unknown } | Error;

function build(): TrackerContext {
  return {
    db: drizzle(sqlite),
    isPg: false,
    host: { isCloud: false },
    accountIdOf: () => 1,
    defaultWorkspaceId: async () => 1,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { workspaces: coreWorkspaces, workspaceRepos: coreWorkspaceRepos, workspaceTrackers, repos },
    github: {
      graphql: async <T,>(accountId: number, _q: string, variables: Record<string, unknown>) => {
        calls.push({ accountId, variables });
        const a = answer(variables);
        if (a instanceof Error) throw a;
        return { data: a.data as T, errors: a.errors };
      },
    },
  } as unknown as TrackerContext;
}

const setUses = (repoId: number, v: 0 | 1 | null): void => {
  sqlite.prepare('UPDATE repos SET uses_github_issues = ? WHERE id = ?').run(v, repoId);
};
const repoRow = (id: number) =>
  sqlite.prepare('SELECT uses_github_issues AS u, github_issues_checked_at AS c FROM repos WHERE id = ?').get(id) as {
    u: number | null;
    c: number | null;
  };

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(SETUP);
  sqlite.exec(mig('0088_issue_tracker.sql'));
  sqlite.exec(mig('0094_repo_uses_github_issues.sql'));
  calls = [];
  answer = () => ({ data: { repository: { hasIssuesEnabled: true }, search: { issueCount: 3 } } });
  __resetRateBudget();
  ctx = build();
});

describe('1. resolution', () => {
  it('no stored choice + a repo that uses GitHub Issues → GitHub Issues, for every reader', async () => {
    setUses(100, 1);
    const s = await readWorkspaceTracker(ctx, 1, 1);
    expect(s.issue.provider).toBe('github');
    expect(s.providerChosen).toBe(false);
    expect(s.githubIssuesRepos).toEqual(['acme/web']);
    expect((await readWorkspaceTrackerAccess(ctx, 1, 1)).issue.provider).toBe('github');
    // Nothing was stored by reading.
    expect(await readStoredTrackerRow(ctx, 1, 1)).toBeNull();
  });

  it('no stored choice and no such repo → none (false and never-answered alike)', async () => {
    setUses(100, 0);
    expect((await readWorkspaceTracker(ctx, 1, 1)).issue.provider).toBeNull();
    expect((await readWorkspaceTracker(ctx, 1, 2)).issue.provider).toBeNull();
  });

  it('another tenant’s repo never decides this workspace', async () => {
    setUses(900, 1);
    expect((await readWorkspaceTracker(ctx, 1, 1)).issue.provider).toBeNull();
  });

  it('a chosen None is stored and wins over detection', async () => {
    setUses(100, 1);
    const s = await writeWorkspaceTracker(ctx, 1, 1, { issue: { provider: null } });
    expect(s.issue.provider).toBeNull();
    expect(s.providerChosen).toBe(true);
    expect(s.githubIssuesRepos).toEqual(['acme/web']);
    expect((await readStoredTrackerRow(ctx, 1, 1))?.provider).toBe('none');
    expect((await readWorkspaceTrackerAccess(ctx, 1, 1)).issue.provider).toBeNull();
  });

  it('a chosen Jira wins over detection', async () => {
    setUses(100, 1);
    await writeWorkspaceTracker(ctx, 1, 1, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net' } });
    const s = await readWorkspaceTracker(ctx, 1, 1);
    expect(s.issue.provider).toBe('jira');
    expect(s.providerChosen).toBe(true);
  });

  it('a patch that names no provider leaves the workspace automatic', async () => {
    await writeWorkspaceTracker(ctx, 1, 1, { issue: { matchScope: 'title' } });
    expect((await readStoredTrackerRow(ctx, 1, 1))?.provider).toBeNull();
    setUses(100, 1);
    const s = await readWorkspaceTracker(ctx, 1, 1);
    expect(s.issue.provider).toBe('github');
    expect(s.providerChosen).toBe(false);
  });
});

describe('2. the migration', () => {
  it('turns an ALL-NULL row (a chosen None) into the stored none, and leaves a partial row unchosen', () => {
    const db2 = new Database(':memory:');
    db2.exec(SETUP);
    db2.exec(mig('0088_issue_tracker.sql'));
    db2.exec("INSERT INTO workspace_trackers (account_id, workspace_id, provider) VALUES (1,1,NULL),(1,2,'jira')");
    db2.exec("INSERT INTO workspace_trackers (account_id, workspace_id, provider, match_scope) VALUES (1,3,NULL,'title')");
    db2.exec(mig('0094_repo_uses_github_issues.sql'));
    const rows = db2.prepare('SELECT workspace_id AS w, provider AS p FROM workspace_trackers ORDER BY w').all();
    expect(rows).toEqual([
      { w: 1, p: 'none' },
      { w: 2, p: 'jira' },
      { w: 3, p: null },
    ]);
  });
});

describe('3. the worker population', () => {
  it('lists an auto-detected workspace, never a chosen one, scoped by account', async () => {
    setUses(100, 1);
    setUses(200, 1);
    setUses(900, 1);
    await writeWorkspaceTracker(ctx, 1, 2, { issue: { provider: null } });
    expect(await autoDetectedWorkspaces(ctx, 1)).toEqual([{ accountId: 1, workspaceId: 1 }]);
    const all = await autoDetectedWorkspaces(ctx, null);
    expect(all.map((w) => w.workspaceId).sort()).toEqual([1, 90]);
  });
});

describe('4. detection', () => {
  const NOW = Date.UTC(2026, 9, 9);

  it('reads a positive answer only', () => {
    expect(usageOf({ repository: { hasIssuesEnabled: false }, search: null })).toBe(false);
    expect(usageOf({ repository: { hasIssuesEnabled: true }, search: { issueCount: 0 } })).toBe(false);
    expect(usageOf({ repository: { hasIssuesEnabled: true }, search: { issueCount: 2 } })).toBe(true);
    expect(usageOf({ repository: { hasIssuesEnabled: true }, search: null })).toBeNull();
    expect(usageOf({ repository: null })).toBeNull();
    expect(usageOf(null)).toBeNull();
    expect(usageSearchQuery('acme', 'web', NOW)).toBe('repo:acme/web is:issue linked:pr updated:>=2026-07-11');
  });

  it('asks only repos of unchosen workspaces, once a day, and writes the answer', async () => {
    await writeWorkspaceTracker(ctx, 1, 3, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net' } });
    const r = await refreshGithubIssuesUsage(ctx, { now: () => NOW });
    const asked = calls.map((c) => `${c.accountId}:${c.variables.owner}/${c.variables.name}`).sort();
    expect(asked).toEqual(['1:acme/api', '1:acme/web', '2:acme/web']); // never acme/ops (Jira chosen)
    expect(r.switchedOn).toEqual(new Set([1, 2]));
    expect(repoRow(100).u).toBe(1);
    expect(repoRow(100).c).not.toBeNull();
    expect((await readWorkspaceTracker(ctx, 1, 1)).issue.provider).toBe('github');

    calls = [];
    await refreshGithubIssuesUsage(ctx, { now: () => NOW + 60_000 });
    expect(calls).toEqual([]);
    await refreshGithubIssuesUsage(ctx, { now: () => NOW + USAGE_RECHECK_MS + 1000 });
    expect(calls.length).toBe(3);
  });

  it('a nulled selection keeps the stored answer but stamps the attempt', async () => {
    setUses(100, 1);
    answer = () => ({ data: { repository: { hasIssuesEnabled: true }, search: null }, errors: [{ type: 'FORBIDDEN' }] });
    await refreshGithubIssuesUsage(ctx, { now: () => NOW });
    expect(repoRow(100).u).toBe(1);
    expect(repoRow(100).c).not.toBeNull();
  });

  it('a low budget stamps nothing and asks nothing', async () => {
    noteBudget(1, { remaining: 0, resetAt: new Date(Date.now() + 3_600_000) });
    await refreshGithubIssuesUsage(ctx, { now: () => NOW });
    expect(calls.filter((c) => c.accountId === 1)).toEqual([]);
    expect(repoRow(100)).toEqual({ u: null, c: null });
    expect(repoRow(900).u).toBe(1); // the other account is unaffected
  });

  it('on a workspace add: asks those repos now, even if answered today and even under a chosen tracker', async () => {
    await writeWorkspaceTracker(ctx, 1, 3, { issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net' } });
    await refreshGithubIssuesUsage(ctx, { now: () => NOW }); // acme/web answered just now
    calls = [];
    const r = await checkReposGithubIssuesUsage(ctx, 1, [100, 300, 900], { now: () => NOW + 60_000 });
    // 900 is another tenant's repo — never asked under account 1.
    expect(calls.map((c) => `${c.accountId}:${c.variables.name}`).sort()).toEqual(['1:ops', '1:web']);
    expect(r.asked).toBe(2);
    expect(r.switchedOn).toBe(true); // acme/ops was never answered before
  });

  it('after a first walk (onlyUnasked): asks a never-answered repo once, then never again', async () => {
    let r = await checkReposGithubIssuesUsage(ctx, 1, [100], { now: () => NOW, onlyUnasked: true });
    expect(r.asked).toBe(1);
    calls = [];
    r = await checkReposGithubIssuesUsage(ctx, 1, [100], { now: () => NOW + 1000, onlyUnasked: true });
    expect(calls).toEqual([]);
  });

  it('on a workspace add with a low budget: asks and stamps nothing', async () => {
    noteBudget(1, { remaining: 0, resetAt: new Date(Date.now() + 3_600_000) });
    const r = await checkReposGithubIssuesUsage(ctx, 1, [100], { now: () => NOW });
    expect(r.asked).toBe(0);
    expect(calls).toEqual([]);
    expect(repoRow(100)).toEqual({ u: null, c: null });
  });
});
