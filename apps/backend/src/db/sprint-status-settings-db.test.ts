import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Reports → This sprint — the status layout's DB half on a SCRATCH SQLite (never apps/backend/data):
//   • parseSprintStatusSettings: strict on a post (non-array order, bad / long / control-character /
//     duplicate names, too many, a non-string deliveredFrom), tolerant on a stored value;
//   • get/set: the default stored as NULL, account + workspace predicated (another tenant's
//     workspace → false, nothing written);
//   • loadSprintStatusEvidence: this workspace + site only, closed-unmerged PRs ignored, another
//     tenant's PRs never joined; sprintLayoutFor reads the stored override and the automatic order.

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-status-settings-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let settings: typeof import('./sprint-status-settings.js');
let layout: typeof import('./sprint-status-layout.js');
let wsA = 0;
let wsA2 = 0;
let wsB = 0;
const ROOT = 'https://acme.atlassian.net';
const NOW = new Date(Date.UTC(2026, 9, 10));

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
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sss_a', githubLogin: 'sss-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sss_b', githubLogin: 'sss-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  wsA2 = (await q.createWorkspace(1, 'Other')).id;

  const repoOf = async (accountId: number, name: string) =>
    (
      await db
        .insert(schema.repos)
        .values({ accountId, githubNodeId: `R_sss_${name}`, owner: 'acme', name })
        .returning({ id: schema.repos.id })
        .execute()
    )[0].id as number;
  const rA = await repoOf(1, 'web');
  const rB = await repoOf(2, 'api');
  let n = 0;
  const pr = async (accountId: number, repoId: number, state: string) =>
    (
      await db
        .insert(schema.pullRequests)
        .values({ accountId, repoId, githubNodeId: `PR_sss_${++n}`, number: n, title: `PR ${n}`, state, openedAt: NOW, updatedAt: NOW })
        .returning({ id: schema.pullRequests.id })
        .execute()
    )[0].id as number;
  const row = (accountId: number, workspaceId: number, prId: number, issueKey: string, statusName: string, apiRoot = ROOT) => ({
    accountId,
    workspaceId,
    prId,
    provider: 'jira',
    issueKey,
    detectedFrom: 'title',
    detectOrder: 0,
    apiRoot,
    url: `${apiRoot}/browse/${issueKey}`,
    state: 'ok',
    statusName,
    fetchedAt: NOW,
    checkedAt: NOW,
    nextCheckAt: NOW,
  });
  const tt = schema.trackerTickets;
  // ENG-1, ENG-2: merged only → fully merged. ENG-3: merged + open. ENG-4: closed only → ignored.
  await db.insert(tt).values(row(1, wsA, await pr(1, rA, 'merged'), 'ENG-1', 'Ready for QA')).execute();
  await db.insert(tt).values(row(1, wsA, await pr(1, rA, 'merged'), 'ENG-2', 'Ready for QA')).execute();
  await db.insert(tt).values(row(1, wsA, await pr(1, rA, 'merged'), 'ENG-3', 'Ready for QA')).execute();
  await db.insert(tt).values(row(1, wsA, await pr(1, rA, 'open'), 'ENG-3', 'Ready for QA')).execute();
  await db.insert(tt).values(row(1, wsA, await pr(1, rA, 'closed'), 'ENG-4', 'Ready for QA')).execute();
  // Another workspace, another site, another tenant: never counted.
  await db.insert(tt).values(row(1, wsA2, await pr(1, rA, 'merged'), 'ENG-5', 'Ready for QA')).execute();
  await db.insert(tt).values(row(1, wsA, await pr(1, rA, 'merged'), 'ENG-6', 'Ready for QA', 'https://other.atlassian.net')).execute();
  await db.insert(tt).values(row(2, wsB, await pr(2, rB, 'merged'), 'ENG-7', 'Ready for QA')).execute();

  await db
    .insert(schema.sprintReads)
    .values({
      accountId: 1,
      workspaceId: wsA,
      provider: 'jira',
      apiRoot: ROOT,
      viewedAt: NOW,
      nextReadAt: NOW,
      statusOrderJson: {
        source: 'jira_board',
        readAt: NOW.toISOString(),
        statuses: [
          { id: '1', name: 'To Do', category: 'new' },
          { id: '3', name: 'In Development', category: 'indeterminate' },
          { id: '4', name: 'Ready for QA', category: 'indeterminate' },
          { id: '6', name: 'Done', category: 'done' },
        ],
      },
    })
    .execute();
  const ticket = (key: string, statusName: string, statusCategory: string) => ({
    accountId: 1,
    workspaceId: wsA,
    ident: `jira:${ROOT}#${key}`,
    provider: 'jira',
    apiRoot: ROOT,
    issueKey: key,
    title: key,
    statusName,
    statusCategory,
    inSprint: true,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    fetchedAt: NOW,
    nextCheckAt: NOW,
  });
  await db.insert(schema.sprintTickets).values(ticket('ENG-3', 'Ready for QA', 'indeterminate')).execute();
  await db.insert(schema.sprintTickets).values(ticket('ENG-8', 'In Development', 'indeterminate')).execute();
  await db.insert(schema.sprintTickets).values(ticket('ENG-9', 'Done', 'done')).execute();
  settings = await import('./sprint-status-settings.js');
  layout = await import('./sprint-status-layout.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('parseSprintStatusSettings', () => {
  const strict = (v: unknown) => settings.parseSprintStatusSettings(v, true);
  const tolerant = (v: unknown) => settings.parseSprintStatusSettings(v, false);

  it('accepts a clean post, trimming names; empty order → null', () => {
    expect(strict({ order: [' To Do ', 'In Dev'], deliveredFrom: 'In Dev' })).toEqual({ order: ['To Do', 'In Dev'], deliveredFrom: 'In Dev' });
    expect(strict({ order: null, deliveredFrom: null })).toEqual({ order: null, deliveredFrom: null });
    expect(strict({ order: [] })).toEqual({ order: null, deliveredFrom: null });
  });

  it('refuses a malformed post', () => {
    expect(strict(null)).toBeNull();
    expect(strict([])).toBeNull();
    expect(strict({ order: 'To Do' })).toBeNull();
    expect(strict({ order: ['To Do', 'to do'] })).toBeNull();
    expect(strict({ order: [''] })).toBeNull();
    expect(strict({ order: [3] })).toBeNull();
    expect(strict({ order: ['a\u0000b'] })).toBeNull();
    expect(strict({ order: ['x'.repeat(101)] })).toBeNull();
    expect(strict({ order: Array.from({ length: 61 }, (_, i) => `S${i}`) })).toBeNull();
    expect(strict({ deliveredFrom: 7 })).toBeNull();
  });

  it('reads a stored value tolerantly', () => {
    expect(tolerant(null)).toEqual({ order: null, deliveredFrom: null });
    expect(tolerant('junk')).toEqual({ order: null, deliveredFrom: null });
    expect(tolerant({ order: ['A', 'a', 3, ''], deliveredFrom: 5 })).toEqual({ order: ['A'], deliveredFrom: null });
  });
});

describe('get / set', () => {
  it('stores overrides, the default as NULL, and refuses another tenant’s workspace', async () => {
    expect(await settings.setSprintStatusSettings(1, wsA, { order: ['Ready for QA', 'In Development'], deliveredFrom: 'ready for qa' })).toBe(true);
    expect(await settings.getSprintStatusSettings(1, wsA)).toEqual({ order: ['Ready for QA', 'In Development'], deliveredFrom: 'ready for qa' });
    expect(await settings.getSprintStatusSettings(1, wsA2)).toEqual({ order: null, deliveredFrom: null });
    expect(await settings.setSprintStatusSettings(1, wsB, { order: ['X'], deliveredFrom: null })).toBe(false);
    expect(await settings.getSprintStatusSettings(2, wsB)).toEqual({ order: null, deliveredFrom: null });
    expect(await settings.setSprintStatusSettings(1, wsA, { order: null, deliveredFrom: null })).toBe(true);
    const [r] = await db.select({ v: schema.workspaces.sprintStatuses }).from(schema.workspaces).where((await import('drizzle-orm')).eq(schema.workspaces.id, wsA)).execute();
    expect(r.v).toBeNull();
  });
});

describe('evidence and the layout', () => {
  it('counts this workspace + site only, ignores closed-unmerged PRs and other tenants', async () => {
    const ev = await layout.loadSprintStatusEvidence(1, wsA, { provider: 'jira', apiRoot: ROOT, tickets: [], autoOrder: null });
    expect([...ev.entries()]).toEqual([['Ready for QA', { withPrs: 3, allMerged: 2 }]]);
    expect([...(await layout.loadSprintStatusEvidence(2, wsA, { provider: 'jira', apiRoot: ROOT, tickets: [], autoOrder: null })).entries()]).toEqual([]);
  });

  it('sprintLayoutFor: stored order + evidence → delivered from Ready for QA; then the override wins', async () => {
    const l = await layout.sprintLayoutFor(1, wsA);
    expect(l?.orderSource).toBe('jira_board');
    expect(l?.deliveredFromAuto).toBe('Ready for QA');
    expect(l?.order.map((o) => `${o.name}:${o.count}:${o.stage}`)).toEqual([
      'To Do:0:not_started',
      'In Development:1:writing',
      'Ready for QA:1:delivered',
      'Done:0:done',
    ]);
    await settings.setSprintStatusSettings(1, wsA, { order: null, deliveredFrom: 'In Development' });
    const set = await layout.sprintLayoutFor(1, wsA);
    expect(set?.deliveredFrom).toBe('In Development');
    expect(set?.deliveredFromAuto).toBe('Ready for QA');
    await settings.setSprintStatusSettings(1, wsA, { order: null, deliveredFrom: null });
    // Never read: no site, no layout.
    expect(await layout.sprintLayoutFor(1, wsA2)).toBeNull();
  });
});
