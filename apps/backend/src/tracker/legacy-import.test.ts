// THE ONE-TIME MOVE of the plugin-era tracker data into core (tracker/legacy-import.ts), over the
// REAL core client and the real migration chain. What this pins:
//   1. With NO plugin tables (a fresh or plugin-less install) the move is a no-op and never throws.
//   2. The per-workspace tracker settings + the token MOVE in their stored form (`plain:` / `sealed:`)
//      and still open through core — nobody re-enters a token — and the sprint cadence on the same
//      plugin row is untouched while the tracker columns are NULLed.
//   3. The stored tickets MOVE with provider 'jira' and keep their ident, so a ticket review keyed
//      `jira:<root>#<KEY>` still finds its members and story.
//   4. It is a MOVE: a second run copies nothing; a value already in core is never overwritten, and a
//      value later CLEARED in core is never resurrected.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/tracker/legacy-import
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-tracker-legacy-import.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let raw: any;
let move: typeof import('./legacy-import.js').moveLegacyTrackerData;
let ts: typeof import('./settings.js');
let peers: typeof import('./peers.js');
let tctx: import('./context.js').TrackerContext;
let wsA = 0;
let wsB = 0;
let prId = 0;
const SITE = 'https://eaflood.atlassian.net';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  raw = (db as any).$client;
  await runMigrations();
  move = (await import('./legacy-import.js')).moveLegacyTrackerData;
  ts = await import('./settings.js');
  peers = await import('./peers.js');
  tctx = (await import('./runtime.js')).buildTrackerContext({ warn() {}, info() {}, error() {} });

  const [a] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'BNG', isDefault: false }).returning().execute();
  const [b] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'NRF', isDefault: false }).returning().execute();
  wsA = a.id;
  wsB = b.id;
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'DEFRA', name: 'bng-metric-backend', githubNodeId: 'R_legacy' })
    .returning()
    .execute();
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: wsA, repoId: repo.id }).execute();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_legacy',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'BMD-1036 export the metric',
      state: 'open',
      isDraft: false,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  prId = pr.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the legacy tracker move', () => {
  it('1. no plugin tables → nothing to move, no throw', async () => {
    await expect(move()).resolves.toEqual({ trackers: 0, tickets: 0 });
  });

  it('2-3. moves the settings (token in its stored form) and the tickets; clears the source', async () => {
    // The plugin's tables as plugin 0029/0031/0035/0038/0039 left them (the columns that matter).
    raw.exec(`
      CREATE TABLE pro_workspace_settings (
        id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, workspace_id integer NOT NULL,
        sprint_cadence_days integer, issue_provider text, issue_base_url text, issue_project_keys text,
        issue_match_scope text, jira_email text, jira_token text, jira_ac_field_id text);
      CREATE TABLE pro_pr_jira_tickets (
        id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, workspace_id integer NOT NULL,
        pr_id integer NOT NULL, issue_key text NOT NULL, detected_from text NOT NULL, detect_order integer NOT NULL,
        api_root text NOT NULL, url text NOT NULL, state text NOT NULL, error_code text, title text,
        description text, acceptance_criteria text, ac_field_id text, ac_field_name text, ac_field_source text,
        issue_type_id text, issue_type_name text, status_name text, status_category text, assignee_name text,
        assignee_account_id text, assignee_avatar_url text, candidates_json text,
        omitted_candidates integer NOT NULL DEFAULT 0, fetched_at integer, checked_at integer NOT NULL,
        next_check_at integer NOT NULL, changed_at integer);
    `);
    raw
      .prepare(
        `INSERT INTO pro_workspace_settings (account_id, workspace_id, sprint_cadence_days, issue_provider,
           issue_base_url, issue_project_keys, issue_match_scope, jira_email, jira_token)
         VALUES (1, ?, 14, 'jira', ?, 'BMD', 'title_branch', 'dev@esynergy.co.uk', 'plain:ATATT-secret'),
                (1, ?, NULL, 'jira', ?, 'BMD,NFR2', NULL, NULL, NULL)`,
      )
      .run(wsA, SITE, wsB, SITE);
    const t = Math.floor(Date.now() / 1000);
    raw
      .prepare(
        `INSERT INTO pro_pr_jira_tickets (account_id, workspace_id, pr_id, issue_key, detected_from, detect_order,
           api_root, url, state, title, description, acceptance_criteria, fetched_at, checked_at, next_check_at, changed_at)
         VALUES (1, ?, ?, 'BMD-1036', 'title', 0, ?, ?, 'ok', 'Export the metric', 'As a user…', '- CSV', ?, ?, ?, ?)`,
      )
      .run(wsA, prId, SITE, `${SITE}/browse/BMD-1036`, t, t, t + 1800, t);

    await expect(move()).resolves.toEqual({ trackers: 2, tickets: 1 });

    // The settings, and the token opens through core as it did through the plugin.
    const a = await ts.readWorkspaceTracker(tctx, 1, wsA);
    expect(a.issue).toEqual({ provider: 'jira', baseUrl: SITE, projectKeys: ['BMD'], matchScope: 'title_branch' });
    expect(a.jira).toEqual({ email: 'dev@esynergy.co.uk', hasToken: true });
    const access = await ts.readWorkspaceTrackerAccess(tctx, 1, wsA);
    expect(access.token).toEqual({ state: 'ok', token: 'ATATT-secret' });
    expect((await ts.readWorkspaceTracker(tctx, 1, wsB)).issue.projectKeys).toEqual(['BMD', 'NFR2']);

    // The source: tracker columns NULLed, the cadence untouched, the ticket rows gone.
    expect(raw.prepare('SELECT sprint_cadence_days, issue_provider, jira_token FROM pro_workspace_settings WHERE workspace_id = ?').get(wsA)).toEqual({
      sprint_cadence_days: 14,
      issue_provider: null,
      jira_token: null,
    });
    expect(raw.prepare('SELECT count(*) AS n FROM pro_pr_jira_tickets').get()).toEqual({ n: 0 });

    // The ticket keeps its ident: the ticket review's members and story find it.
    const ident = `jira:${SITE}#BMD-1036`;
    expect(await peers.ticketMembers(tctx, 1, ident)).toEqual([{ prId, workspaceId: wsA }]);
    expect((await peers.ticketStory(tctx, 1, ident))?.title).toBe('Export the metric');
    expect((await peers.ticketsForPr(tctx, 1, prId)).map((x) => x.ident)).toEqual([ident]);
  });

  it('4. a MOVE: a second run copies nothing, and a value cleared in core is never resurrected', async () => {
    await ts.writeWorkspaceTracker(tctx, 1, wsA, { jira: { clearToken: true } });
    // An old row reappearing in the plugin table (a restored backup) loses to core's row.
    raw.prepare("UPDATE pro_workspace_settings SET issue_provider = 'jira', jira_token = 'plain:old' WHERE workspace_id = ?").run(wsA);
    await expect(move()).resolves.toEqual({ trackers: 0, tickets: 0 });
    expect((await ts.readWorkspaceTracker(tctx, 1, wsA)).jira.hasToken).toBe(false);
    // …and the stale copy is cleared from the source all the same.
    expect(raw.prepare('SELECT jira_token FROM pro_workspace_settings WHERE workspace_id = ?').get(wsA)).toEqual({ jira_token: null });
    await expect(move()).resolves.toEqual({ trackers: 0, tickets: 0 });
  });
});
