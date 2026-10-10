import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The sprint read's free labels (./index.ts) on a SCRATCH SQLite — never apps/backend/data. Pins:
//   • WHAT IS SENT: in-sprint, not-done tickets of THIS workspace with criteria and no CURRENT label
//     (rubric version + today's text hash), Not started before In progress.
//   • WHEN: only with AI on, a Claude credential, Reports; a busy label slot is skipped (released on
//     every path that does not start a run); nothing to label releases the slot.
//   • the hook is installed by registerSprintLabelling and fires the enqueue.

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-labels-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let mod: typeof import('./index.js');
let manager: typeof import('../story-labels/manager.js');
let wsA = 0;
let wsOther = 0;

const ROOT = 'https://acme.atlassian.net';
const ident = (k: string) => `jira:${ROOT}#${k}`;
const NOW = new Date(Date.UTC(2026, 9, 10));

async function addTicket(workspaceId: number, key: string, over: Record<string, unknown> = {}) {
  await db
    .insert(schema.sprintTickets)
    .values({
      accountId: 1,
      workspaceId,
      ident: ident(key),
      provider: 'jira',
      apiRoot: ROOT,
      issueKey: key,
      title: `Title ${key}`,
      description: 'Body',
      acceptanceCriteria: '* One\n* Two',
      statusCategory: 'new',
      inSprint: true,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      fetchedAt: NOW,
      nextCheckAt: NOW,
      ...over,
    })
    .execute();
}

const fakeCtx = (auth: 'ok' | 'none' = 'ok') =>
  ({ log: { warn: () => {}, info: () => {}, error: () => {} }, llm: { detectAuth: () => ({ status: auth }) } }) as any;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sl_a', githubLogin: 'sl-a', isLocal: true }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  const [w] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Other', isDefault: false }).returning({ id: schema.workspaces.id }).execute();
  wsOther = w.id;
  mod = await import('./index.js');
  manager = await import('../story-labels/manager.js');
  await addTicket(wsA, 'ENG-1', { statusCategory: 'indeterminate' });
  await addTicket(wsA, 'ENG-2');
  await addTicket(wsA, 'ENG-3', { statusCategory: 'done' });
  await addTicket(wsA, 'ENG-4', { acceptanceCriteria: '', description: 'No criteria here' });
  await addTicket(wsA, 'ENG-5', { inSprint: false });
  await addTicket(wsA, 'ENG-6');
  await addTicket(wsOther, 'ENG-7');
  // ENG-6 already carries a CURRENT label for today's text.
  const { storyLabelInput } = await import('../../db/story-label-input.js');
  const { STORY_RUBRIC_VERSION } = await import('@pierre-review/shared');
  const input = storyLabelInput({ title: 'Title ENG-6', description: 'Body', acceptanceCriteria: '* One\n* Two' }, 'jira')!;
  await db
    .insert(schema.storyLabels)
    .values({ accountId: 1, ident: ident('ENG-6'), textHash: input.textHash, rubricVersion: STORY_RUBRIC_VERSION, criteriaJson: [], storyJson: {}, criteriaCount: 2, model: 'm' })
    .execute();
});

afterEach(() => manager.resetStoryLabelRuns());

afterAll(async () => {
  const hooks = await import('../../tracker/sprint/hooks.js');
  hooks.setAfterSprintRead(null);
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('sprintStoriesToLabel', () => {
  it('in-sprint, not done, with criteria, no current label, this workspace only; Not started first', async () => {
    const todo = await mod.sprintStoriesToLabel(1, wsA);
    expect(todo.map((t) => t.ident)).toEqual([ident('ENG-2'), ident('ENG-1')]);
    expect(todo[0]!.input.criteria).toEqual(['One', 'Two']);
    expect(await mod.sprintStoriesToLabel(2, wsA)).toEqual([]);
  });
});

describe('enqueueSprintLabels', () => {
  it('does nothing with AI off, no credential, or no Reports — and never holds the slot', async () => {
    const start = (() => {
      throw new Error('must not start');
    }) as any;
    expect(await mod.enqueueSprintLabels(fakeCtx(), 1, wsA, { aiEnabled: false, start })).toBe('off');
    expect(await mod.enqueueSprintLabels(fakeCtx('none'), 1, wsA, { aiEnabled: true, start })).toBe('no_credential');
    expect(await mod.enqueueSprintLabels(fakeCtx(), 1, wsA, { aiEnabled: true, entitled: async () => false, start })).toBe('not_entitled');
    expect(manager.claimStoryLabelRun(1)).toBe(true);
  });

  it('a busy slot is skipped; nothing to label releases the slot', async () => {
    expect(manager.claimStoryLabelRun(1)).toBe(true);
    expect(await mod.enqueueSprintLabels(fakeCtx(), 1, wsA, { aiEnabled: true, entitled: async () => true })).toBe('busy');
    manager.releaseStoryLabelRun(1);
    expect(await mod.enqueueSprintLabels(fakeCtx(), 1, wsOther + 999, { aiEnabled: true, entitled: async () => true })).toBe('nothing');
    expect(manager.claimStoryLabelRun(1)).toBe(true);
  });

  it('starts the existing story label run with this workspace’s stories', async () => {
    const started: any[] = [];
    const res = await mod.enqueueSprintLabels(fakeCtx(), 1, wsA, {
      aiEnabled: true,
      entitled: async () => true,
      start: ((_c: unknown, a: any) => {
        started.push(a);
        return {} as any;
      }) as any,
    });
    expect(res).toBe('started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ accountId: 1, workspaceId: wsA });
    expect(started[0].stories.map((s: any) => s.ident)).toEqual([ident('ENG-2'), ident('ENG-1')]);
  });

  it('registerSprintLabelling installs the after-read hook', async () => {
    const hooks = await import('../../tracker/sprint/hooks.js');
    const calls: string[] = [];
    mod.registerSprintLabelling({ ...fakeCtx('none'), llm: { detectAuth: () => (calls.push('auth'), { status: 'none' }) } } as any);
    hooks.afterSprintRead(1, wsA);
    await new Promise((r) => setTimeout(r, 0));
    // config.aiEnabled is on locally unless LIMN_AI_DISABLED; either way the hook ran the enqueue.
    const { config } = await import('../../config.js');
    expect(calls).toEqual(config.aiEnabled ? ['auth'] : []);
  });
});
