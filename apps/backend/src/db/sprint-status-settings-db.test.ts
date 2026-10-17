import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Activity → This Sprint — the status layout's DB half on a SCRATCH SQLite (never apps/backend/data):
//   • parseSprintStatusSettings: strict on a post (each refusal's plain message: no buckets, too many,
//     ids, names, meanings going backwards, a status in two buckets, bad / long / control-character
//     names, too many), tolerant on a stored value (the retired {sections} and {order, deliveredFrom});
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

type Stage = 'not_started' | 'in_progress' | 'in_review' | 'done';
const B = (id: string, name: string, meaning: Stage, statuses: unknown[] = []) => ({ id, name, meaning, statuses });
const sec = (s: { buckets: Array<{ id: string; statuses: string[] }> | null } | null) =>
  s?.buckets == null ? null : Object.fromEntries(s.buckets.map((b) => [b.id, b.statuses]));

describe('parseSprintStatusSettings', () => {
  const strict = (v: unknown) => settings.parseSprintStatusSettings(v, true);
  const why = (v: unknown) => {
    const p = settings.parseSprintStatusSettingsStrict(v);
    return p.ok ? null : p.message;
  };
  const tolerant = (v: unknown) => settings.parseSprintStatusSettings(v, false);

  it('accepts a clean post, trimming names; buckets null → automatic; mergedColumn defaults on', () => {
    expect(strict({ buckets: [B('a', ' To do ', 'not_started', [' To Do ']), B('b', 'QA', 'in_review', ['In Dev'])], mergedColumn: false })).toEqual({
      buckets: [B('a', 'To do', 'not_started', ['To Do']), B('b', 'QA', 'in_review', ['In Dev'])],
      mergedColumn: false,
    });
    expect(strict({ buckets: null })).toEqual({ buckets: null, mergedColumn: true });
    // Two review buckets; no bucket of some meaning is fine.
    expect(strict({ buckets: [B('r1', 'QA', 'in_review'), B('r2', 'PO review', 'in_review')], mergedColumn: true })).not.toBeNull();
  });

  it('refuses a malformed post, saying what is wrong in plain words', () => {
    expect(strict(null)).toBeNull();
    expect(strict([])).toBeNull();
    expect(strict({})).toBeNull();
    expect(strict({ order: ['To Do'], deliveredFrom: null })).toBeNull();
    expect(strict({ sections: null })).toBeNull();
    expect(why({ buckets: {} })).toBe('Send the buckets as a list.');
    expect(why({ buckets: [] })).toBe('Keep at least one bucket.');
    expect(why({ buckets: Array.from({ length: 11 }, (_, i) => B(`b${i}`, `B${i}`, 'done')) })).toBe('Use at most 10 buckets.');
    expect(why({ buckets: [B('a', 'A', 'done'), B('a', 'B', 'done')] })).toBe('Each bucket needs its own id.');
    expect(why({ buckets: [B('merged', 'A', 'done')] })).toBe('Each bucket needs its own id.');
    expect(why({ buckets: [B('a', '  ', 'done')] })).toBe('Give every bucket a name.');
    expect(why({ buckets: [B('a', 'x'.repeat(25), 'done')] })).toBe('Keep bucket names to 24 characters.');
    expect(why({ buckets: [B('a', 'Same', 'done'), B('b', 'same', 'done')] })).toBe('Two buckets are called “same”.');
    expect(why({ buckets: [B('a', 'A', 'nope' as Stage)] })).toBe('Choose what “A” means.');
    expect(why({ buckets: [B('a', 'Done', 'done'), B('b', 'To do', 'not_started')] })).toBe(
      '“To do” means Not started, so it cannot come after a bucket that means Complete.',
    );
    expect(why({ buckets: [B('a', 'A', 'done', ['To Do']), B('b', 'B', 'done', ['to do'])] })).toBe('“to do” is in two buckets.');
    expect(why({ buckets: [B('a', 'A', 'done', [''])] })).toBe('A status name is not valid.');
    expect(why({ buckets: [B('a', 'A', 'done', [3])] })).toBe('A status name is not valid.');
    expect(why({ buckets: [B('a', 'A', 'done', ['a\u0000b'])] })).toBe('A status name is not valid.');
    expect(why({ buckets: [B('a', 'A', 'done', ['x'.repeat(101)])] })).toBe('A status name is not valid.');
    expect(why({ buckets: [B('a', 'A', 'done', Array.from({ length: 61 }, (_, i) => `S${i}`))] })).toBe('Place at most 60 statuses.');
    expect(why({ buckets: null, mergedColumn: 'yes' })).toBe('Say whether to show the merged column.');
  });

  it('reads a stored value tolerantly, the retired shapes included', () => {
    expect(tolerant(null)).toEqual({ buckets: null, mergedColumn: true });
    expect(tolerant('junk')).toEqual({ buckets: null, mergedColumn: true });
    expect(sec(tolerant({ sections: { done: ['A', 'a', 3, ''] } }))).toEqual({ not_started: [], in_progress: [], in_review: [], done: ['A'] });
    // No categories handed in: every retired status reads as in progress until deliveredFrom.
    expect(sec(tolerant({ order: ['A', 'B'], deliveredFrom: 'b' }))).toEqual({ not_started: [], in_progress: ['A'], in_review: ['B'], done: [] });
    // Bad buckets dropped, good ones kept.
    expect(tolerant({ buckets: [B('a', 'A', 'in_progress', ['X', 'x']), { id: 'B!', name: 'B', meaning: 'done', statuses: [] }], mergedColumn: false })).toEqual({
      buckets: [B('a', 'A', 'in_progress', ['X'])],
      mergedColumn: false,
    });
  });
});

describe('get / set', () => {
  const S = { buckets: [B('dev', 'Building', 'in_progress', ['In Development']), B('qa', 'QA', 'in_review', ['Ready for QA'])], mergedColumn: true };
  it('stores overrides, the default as NULL, and refuses another tenant’s workspace', async () => {
    expect(await settings.setSprintStatusSettings(1, wsA, S as any)).toBe(true);
    expect(await settings.getSprintStatusSettings(1, wsA)).toEqual(S);
    expect(await settings.getSprintStatusSettings(1, wsA2)).toEqual({ buckets: null, mergedColumn: true });
    expect(await settings.setSprintStatusSettings(1, wsB, S as any)).toBe(false);
    expect(await settings.getSprintStatusSettings(2, wsB)).toEqual({ buckets: null, mergedColumn: true });
    // Automatic buckets with the merged column off is NOT the default: it is stored.
    expect(await settings.setSprintStatusSettings(1, wsA, { buckets: null, mergedColumn: false })).toBe(true);
    expect(await settings.getSprintStatusSettings(1, wsA)).toEqual({ buckets: null, mergedColumn: false });
    expect(await settings.setSprintStatusSettings(1, wsA, { buckets: null, mergedColumn: true })).toBe(true);
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
    await settings.setSprintStatusSettings(1, wsA, {
      buckets: settings.sectionsToBuckets({ not_started: [], in_progress: [], in_review: ['In Development'], done: [] }),
      mergedColumn: true,
    });
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
    expect(sec(legacy?.settings ?? null)).toEqual({ not_started: ['To Do'], in_progress: [], in_review: ['In Development', 'Ready for QA'], done: ['Done'] });
    await settings.setSprintStatusSettings(1, wsA, { buckets: null, mergedColumn: true });
    // Never read: no site, no layout.
    expect(await layout.sprintLayoutFor(1, wsA2)).toBeNull();
  });
});
