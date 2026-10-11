import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Reports → This sprint — the status layout's DB half on a SCRATCH SQLite (never apps/backend/data):
//   • parseSprintStatusSettings: strict on a post (not the four stage keys, a non-array stage, bad /
//     long / control-character names, one name in two stages, too many), tolerant on a stored value;
//   • get/set: the default stored as NULL, account + workspace predicated (another tenant's
//     workspace → false, nothing written);
//   • loadSprintStatusEvidence: this workspace + site only, closed-unmerged PRs ignored, another
//     tenant's PRs never joined; sprintLayoutFor reads the stored override (a RETIRED
//     {order, deliveredFrom} value too) and the automatic order.

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
  const sec = (o: Partial<Record<'not_started' | 'in_progress' | 'in_review' | 'done', unknown>>) => ({
    sections: { not_started: [], in_progress: [], in_review: [], done: [], ...o },
  });

  it('accepts a clean post, trimming names; nothing named or null → automatic', () => {
    expect(strict(sec({ not_started: [' To Do '], in_review: ['In Dev'] }))).toEqual({
      sections: { not_started: ['To Do'], in_progress: [], in_review: ['In Dev'], done: [] },
    });
    expect(strict({ sections: null })).toEqual({ sections: null });
    expect(strict(sec({}))).toEqual({ sections: null });
  });

  it('refuses a malformed post', () => {
    expect(strict(null)).toBeNull();
    expect(strict([])).toBeNull();
    expect(strict({})).toBeNull();
    expect(strict({ order: ['To Do'], deliveredFrom: null })).toBeNull();
    expect(strict({ sections: [] })).toBeNull();
    expect(strict({ sections: { not_started: [], in_progress: [], in_review: [] } })).toBeNull();
    expect(strict({ sections: { not_started: [], in_progress: [], in_review: [], done: [], extra: [] } })).toBeNull();
    expect(strict(sec({ done: 'Done' }))).toBeNull();
    expect(strict(sec({ not_started: ['To Do'], done: ['to do'] }))).toBeNull();
    expect(strict(sec({ done: [''] }))).toBeNull();
    expect(strict(sec({ done: [3] }))).toBeNull();
    expect(strict(sec({ done: ['a\u0000b'] }))).toBeNull();
    expect(strict(sec({ done: ['x'.repeat(101)] }))).toBeNull();
    expect(strict(sec({ in_progress: Array.from({ length: 31 }, (_, i) => `S${i}`), in_review: Array.from({ length: 30 }, (_, i) => `R${i}`) }))).toBeNull();
  });

  it('reads a stored value tolerantly, the retired shape included', () => {
    expect(tolerant(null)).toEqual({ sections: null });
    expect(tolerant('junk')).toEqual({ sections: null });
    expect(tolerant({ sections: { done: ['A', 'a', 3, ''] } })).toEqual({ sections: { not_started: [], in_progress: [], in_review: [], done: ['A'] } });
    // No categories handed in: every retired status reads as in progress until deliveredFrom.
    expect(tolerant({ order: ['A', 'B'], deliveredFrom: 'b' })).toEqual({ sections: { not_started: [], in_progress: ['A'], in_review: ['B'], done: [] } });
  });
});

describe('get / set', () => {
  const S = { not_started: [], in_progress: ['In Development'], in_review: ['Ready for QA'], done: [] };
  it('stores overrides, the default as NULL, and refuses another tenant’s workspace', async () => {
    expect(await settings.setSprintStatusSettings(1, wsA, { sections: S })).toBe(true);
    expect(await settings.getSprintStatusSettings(1, wsA)).toEqual({ sections: S });
    expect(await settings.getSprintStatusSettings(1, wsA2)).toEqual({ sections: null });
    expect(await settings.setSprintStatusSettings(1, wsB, { sections: S })).toBe(false);
    expect(await settings.getSprintStatusSettings(2, wsB)).toEqual({ sections: null });
    expect(await settings.setSprintStatusSettings(1, wsA, { sections: null })).toBe(true);
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

  it('sprintLayoutFor: stored order + evidence → four stages; then the override wins; a retired value converts', async () => {
    const l = await layout.sprintLayoutFor(1, wsA);
    expect(l?.orderSource).toBe('jira_board');
    expect(l?.order.map((o) => `${o.name}:${o.count}:${o.stage}`)).toEqual([
      'To Do:0:not_started',
      'In Development:1:in_progress',
      'Ready for QA:1:in_review',
      'Done:1:done',
    ]);
    expect([l?.codingBegins, l?.codingEnds]).toEqual(['In Development', 'Ready for QA']);
    await settings.setSprintStatusSettings(1, wsA, { sections: { not_started: [], in_progress: [], in_review: ['In Development'], done: [] } });
    const set = await layout.sprintLayoutFor(1, wsA);
    expect(set?.orderSource).toBe('override');
    expect(set?.codingBegins).toBeNull();
    expect(set?.codingEnds).toBe('In Development');
    // A value stored before the four stages: categories come from the automatic order.
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.workspaces)
      .set({ sprintStatuses: { order: ['To Do', 'In Development', 'Ready for QA', 'Done'], deliveredFrom: 'In Development' } })
      .where(eq(schema.workspaces.id, wsA))
      .execute();
    const legacy = await layout.sprintLayoutFor(1, wsA);
    expect(legacy?.settings.sections).toEqual({ not_started: ['To Do'], in_progress: [], in_review: ['In Development', 'Ready for QA'], done: ['Done'] });
    await settings.setSprintStatusSettings(1, wsA, { sections: null });
    // Never read: no site, no layout.
    expect(await layout.sprintLayoutFor(1, wsA2)).toBeNull();
  });
});
