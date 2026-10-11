import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Reports → This sprint: the ACCEPTED candidate repos (db/sprint-ticket-repos.ts) on a SCRATCH SQLite
// — never apps/backend/data. Pins: replace semantics, `via`, bad_repo for another WORKSPACE's repo and
// another TENANT's repo (nothing written), too_many, no_ticket, tenant-scoped reads, membership filter.

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-ticket-repos-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let mod: typeof import('./sprint-ticket-repos.js');
let q: typeof import('./queries.js');
let wsA = 0;
let wsA2 = 0;
let wsB = 0;
const repo: Record<string, number> = {};
const IDENT = 'jira:https://acme.atlassian.net#ENG-1';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  q = await import('./queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_str_a', githubLogin: 'str-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_str_b', githubLogin: 'str-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  wsA2 = (await q.createWorkspace(1, 'Other')).id;
  const add = async (accountId: number, owner: string, name: string, ws: number) => {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId, githubNodeId: `R_str_${owner}_${name}`, owner, name, defaultBranchHeadSha: `sha-${name}` })
      .returning({ id: schema.repos.id })
      .execute();
    await q.assignReposToWorkspace(ws, accountId, [r.id]);
    repo[`${owner}/${name}`] = r.id;
  };
  await add(1, 'acme', 'web', wsA);
  await add(1, 'acme', 'api', wsA);
  await add(1, 'acme', 'docs', wsA2);
  await add(2, 'other', 'api', wsB);
  const ticket = (accountId: number, workspaceId: number, ident: string) => ({
    accountId,
    workspaceId,
    ident,
    provider: 'jira',
    apiRoot: 'https://acme.atlassian.net',
    issueKey: ident.split('#')[1],
    title: 'T',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    fetchedAt: new Date(),
    nextCheckAt: new Date(),
  });
  await db.insert(schema.sprintTickets).values(ticket(1, wsA, IDENT)).execute();
  await db.insert(schema.sprintTickets).values(ticket(2, wsB, IDENT)).execute();
  mod = await import('./sprint-ticket-repos.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('setSprintRepos / acceptedSprintRepos', () => {
  it('replaces the accepted set and records via', async () => {
    const first = await mod.setSprintRepos(1, wsA, IDENT, [repo['acme/web']!, repo['acme/api']!], (id) =>
      id === repo['acme/web'] ? 'suggested' : 'manual',
    );
    expect(first).toEqual({
      ok: true,
      accepted: [
        { repoId: repo['acme/api'], fullName: 'acme/api' },
        { repoId: repo['acme/web'], fullName: 'acme/web' },
      ],
    });
    const rows = await db.select().from(schema.sprintTicketRepos).execute();
    expect(rows.find((r: any) => r.repoId === repo['acme/web']).via).toBe('suggested');
    const second = await mod.setSprintRepos(1, wsA, IDENT, [repo['acme/api']!], () => 'manual');
    expect(second.ok && second.accepted.map((r) => r.fullName)).toEqual(['acme/api']);
    const cleared = await mod.setSprintRepos(1, wsA, IDENT, [], () => 'manual');
    expect(cleared).toEqual({ ok: true, accepted: [] });
  });

  it('refuses another workspace’s repo and another tenant’s repo, writing nothing', async () => {
    await mod.setSprintRepos(1, wsA, IDENT, [repo['acme/web']!], () => 'manual');
    expect(await mod.setSprintRepos(1, wsA, IDENT, [repo['acme/docs']!], () => 'manual')).toEqual({ ok: false, error: 'bad_repo' });
    expect(await mod.setSprintRepos(1, wsA, IDENT, [repo['acme/api']!, repo['other/api']!], () => 'manual')).toEqual({ ok: false, error: 'bad_repo' });
    expect((await mod.acceptedSprintRepos(1, wsA, [IDENT])).get(IDENT)?.map((r) => r.fullName)).toEqual(['acme/web']);
  });

  it('too_many and no_ticket', async () => {
    expect(await mod.setSprintRepos(1, wsA, IDENT, [1, 2, 3, 4, 5, 6, 7], () => 'manual')).toEqual({ ok: false, error: 'too_many' });
    expect(await mod.setSprintRepos(1, wsA, 'jira:https://acme.atlassian.net#NOPE-1', [], () => 'manual')).toEqual({ ok: false, error: 'no_ticket' });
    // Account 2 cannot address account 1's ticket through account 1's workspace id.
    expect(await mod.setSprintRepos(2, wsA, IDENT, [], () => 'manual')).toEqual({ ok: false, error: 'no_ticket' });
  });

  it('reads are tenant-scoped, detailed, and membership-filtered', async () => {
    await mod.setSprintRepos(1, wsA, IDENT, [repo['acme/web']!], () => 'manual');
    expect((await mod.acceptedSprintRepos(2, wsA, [IDENT])).size).toBe(0);
    expect((await mod.acceptedSprintRepos(2, wsB, [IDENT])).size).toBe(0);
    const detail = (await mod.acceptedSprintRepoDetails(1, wsA, [IDENT])).get(IDENT)!;
    expect(detail[0]).toMatchObject({ owner: 'acme', name: 'web', syncedSha: 'sha-web' });
    // Moving the repo to another workspace drops it from this ticket's accepted set.
    await q.assignReposToWorkspace(wsA2, 1, [repo['acme/web']!]);
    expect((await mod.acceptedSprintRepos(1, wsA, [IDENT])).get(IDENT)).toBeUndefined();
    await q.assignReposToWorkspace(wsA, 1, [repo['acme/web']!]);
  });
});

describe('effectiveSprintRepos (the default set)', () => {
  const IDENT2 = 'jira:https://acme.atlassian.net#ENG-2';
  it('never saved → the confident suggestions, defaulted; a saved EMPTY set wins from then on', async () => {
    await db
      .insert(schema.sprintTickets)
      .values({
        accountId: 1,
        workspaceId: wsA,
        ident: IDENT2,
        provider: 'jira',
        apiRoot: 'https://acme.atlassian.net',
        issueKey: 'ENG-2',
        title: 'Rate-limit the api endpoints',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        fetchedAt: new Date(),
        nextCheckAt: new Date(),
      })
      .execute();
    const before = (await mod.effectiveSprintRepos(1, wsA, [IDENT2])).get(IDENT2)!;
    expect(before.defaulted).toBe(true);
    expect(before.accepted.map((r) => r.fullName)).toEqual(['acme/api']);
    expect(before.accepted[0]).toMatchObject({ syncedSha: 'sha-api' });
    expect(before.suggested).toEqual([]);
    // The assessment reads the same effective set.
    expect((await mod.acceptedSprintRepoDetails(1, wsA, [IDENT2])).get(IDENT2)?.map((r) => r.fullName)).toEqual(['acme/api']);
    // Another tenant sees nothing of it.
    expect((await mod.effectiveSprintRepos(2, wsA, [IDENT2])).size).toBe(0);

    expect(await mod.setSprintRepos(1, wsA, IDENT2, [], () => 'manual')).toEqual({ ok: true, accepted: [] });
    const after = (await mod.effectiveSprintRepos(1, wsA, [IDENT2])).get(IDENT2)!;
    expect(after.defaulted).toBe(false);
    expect(after.accepted).toEqual([]);
    expect(after.suggested.map((s) => [s.fullName, s.confident])).toEqual([['acme/api', true]]);
    expect((await mod.acceptedSprintRepoDetails(1, wsA, [IDENT2])).has(IDENT2)).toBe(false);
  });
});
