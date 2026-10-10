import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Reports → This sprint: candidate repo SUGGESTIONS (db/sprint-repo-suggest.ts) on a SCRATCH SQLite —
// never apps/backend/data. Pins every evidence kind, the ranking, the workspace-only rule, the
// accepted exclusion, the 180-day project lookback, and that another tenant's history never counts.

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-repo-suggest-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let mod: typeof import('./sprint-repo-suggest.js');
let wsA = 0;
let wsA2 = 0;
let wsB = 0;
const repo: Record<string, number> = {};
const ROOT = 'https://acme.atlassian.net';
const DAY = 86_400_000;
const NOW = Date.now();
let seq = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('./queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_srs_a', githubLogin: 'srs-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_srs_b', githubLogin: 'srs-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  wsA2 = (await q.createWorkspace(1, 'Docs')).id;
  const add = async (accountId: number, owner: string, name: string, ws: number) => {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId, githubNodeId: `R_srs_${accountId}_${name}`, owner, name })
      .returning({ id: schema.repos.id })
      .execute();
    await q.assignReposToWorkspace(ws, accountId, [r.id]);
    repo[`${accountId}:${owner}/${name}`] = r.id;
  };
  await add(1, 'acme', 'web', wsA);
  await add(1, 'acme', 'api', wsA);
  await add(1, 'acme', 'mobile', wsA);
  await add(1, 'acme', 'docs', wsA2);
  await add(2, 'acme', 'web', wsB);

  const pr = async (accountId: number, repoKey: string, key: string, state: string, mergedDaysAgo: number | null) => {
    seq += 1;
    const [p] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_srs_${seq}`,
        accountId,
        repoId: repo[repoKey],
        number: seq,
        title: `PR ${seq}`,
        state,
        isDraft: false,
        openedAt: new Date(NOW - 400 * DAY),
        updatedAt: new Date(NOW - DAY),
        mergedAt: mergedDaysAgo == null ? null : new Date(NOW - mergedDaysAgo * DAY),
      })
      .returning({ id: schema.pullRequests.id })
      .execute();
    await db
      .insert(schema.trackerTickets)
      .values({
        accountId,
        workspaceId: accountId === 1 ? wsA : wsB,
        prId: p.id,
        provider: 'jira',
        issueKey: key,
        detectedFrom: 'title',
        detectOrder: 0,
        apiRoot: ROOT,
        url: `${ROOT}/browse/${key}`,
        state: 'ok',
        checkedAt: new Date(),
        nextCheckAt: new Date(),
      })
      .execute();
  };
  await pr(1, '1:acme/api', 'ENG-1', 'open', null); // ticket_pr
  await pr(1, '1:acme/docs', 'ENG-1', 'merged', 5); // another workspace's repo: never suggested
  await pr(1, '1:acme/web', 'ENG-5', 'merged', 400); // epic mate (old, still counts for the epic)
  await pr(1, '1:acme/mobile', 'ENG-6', 'merged', 400); // component mate
  await pr(1, '1:acme/web', 'ENG-9', 'merged', 10); // same project, recent
  await pr(1, '1:acme/web', 'ENG-11', 'merged', 20); // same project, recent
  await pr(1, '1:acme/api', 'ENG-10', 'merged', 300); // same project, too old
  await pr(2, '2:acme/web', 'ENG-1', 'merged', 2); // another tenant: never counts

  const st = (ident: string, key: string, o: Record<string, unknown>) => ({
    accountId: 1,
    workspaceId: wsA,
    ident,
    provider: 'jira',
    apiRoot: ROOT,
    issueKey: key,
    title: key,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    fetchedAt: new Date(),
    nextCheckAt: new Date(),
    projectKey: 'ENG',
    ...o,
  });
  await db.insert(schema.sprintTickets).values(st(`jira:${ROOT}#ENG-5`, 'ENG-5', { epicKey: 'ENG-100' })).execute();
  await db.insert(schema.sprintTickets).values(st(`jira:${ROOT}#ENG-6`, 'ENG-6', { componentsJson: JSON.stringify(['Checkout']) })).execute();
  mod = await import('./sprint-repo-suggest.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const ticket = (o: Partial<import('./sprint-repo-suggest.js').SuggestTicket> = {}) => ({
  ident: `jira:${ROOT}#ENG-1`,
  provider: 'jira' as const,
  apiRoot: ROOT,
  issueKey: 'ENG-1',
  projectKey: 'ENG',
  epicKey: 'ENG-100',
  components: ['Checkout'],
  text: 'Save the basket',
  ...o,
});

describe('suggestSprintRepos', () => {
  it('folds every history reason, ranked best reason first; never another workspace’s repo', async () => {
    const out = await mod.suggestSprintRepos(1, wsA, [ticket()], new Map(), NOW);
    const rows = out.get(ticket().ident)!;
    expect(rows.map((r) => [r.fullName, r.reasons])).toEqual([
      ['acme/api', ['ticket_pr']],
      ['acme/web', ['same_epic', 'same_project']],
      ['acme/mobile', ['same_component']],
    ]);
    expect(rows.find((r) => r.fullName === 'acme/web')!.prCount).toBe(3); // ENG-5 + ENG-9 + ENG-11
    expect(rows.some((r) => r.fullName === 'acme/docs')).toBe(false);
  });

  it('names in the text, the issue repo, and the accepted exclusion', async () => {
    const named = await mod.suggestSprintRepos(1, wsA, [ticket({ epicKey: null, components: [], issueKey: 'OPS-1', ident: 'x', projectKey: 'OPS', text: 'Change the Mobile app and the docs' })], new Map(), NOW);
    expect(named.get('x')!.map((r) => [r.fullName, r.reasons, r.prCount])).toEqual([['acme/mobile', ['named_in_ticket'], 0]]);
    const gh = await mod.suggestSprintRepos(
      1,
      wsA,
      [{ ident: 'gh', provider: 'github', apiRoot: 'https://github.com', issueKey: 'acme/api#4', projectKey: 'acme/api', epicKey: null, components: [], text: '' }],
      new Map(),
      NOW,
    );
    expect(gh.get('gh')!.map((r) => [r.fullName, r.reasons])).toEqual([['acme/api', ['issue_repo']]]);
    const excluded = await mod.suggestSprintRepos(1, wsA, [ticket()], new Map([[ticket().ident, [repo['1:acme/api']!]]]), NOW);
    expect(excluded.get(ticket().ident)!.map((r) => r.fullName)).toEqual(['acme/web', 'acme/mobile']);
  });

  it('another tenant sees only its own history', async () => {
    const out = await mod.suggestSprintRepos(2, wsB, [ticket({ epicKey: null, components: [] })], new Map(), NOW);
    expect(out.get(ticket().ident)!.map((r) => [r.fullName, r.reasons])).toEqual([['acme/web', ['ticket_pr', 'same_project']]]);
  });

  it('namedInText needs a whole word of 3+ characters', () => {
    expect(mod.namedInText('web', 'Update the web client')).toBe(true);
    expect(mod.namedInText('web', 'Update the webhooks')).toBe(false);
    expect(mod.namedInText('ui', 'ui change')).toBe(false);
    expect(mod.keyPrefix('jira', 'ENG-12')).toBe('ENG');
    expect(mod.keyPrefix('github', 'Acme/Web#3')).toBe('acme/web');
  });
});
