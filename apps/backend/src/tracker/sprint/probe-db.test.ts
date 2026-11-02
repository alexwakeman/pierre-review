import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SprintSource } from '@pierre-review/shared';

// THE SPRINT-SOURCE PROBE (./probe.ts; docs/TRACKERS.md § The sprint-source probe) on a SCRATCH SQLite.
// Pins:
//   • ITS BOUNDS: ≤ SPRINT_PROBE_WORKSPACES per tick, once per workspace per SPRINT_PROBE_INTERVAL_MS,
//     ≤ 20 repos each; a workspace with a sprint read, a non-GitHub tracker or an existing install is
//     never probed;
//   • ITS ANSWER FEEDS THE GATE: a dated milestone / current iteration makes `hasSprintSource` true;
//     nothing found keeps it false; a later sprint read's own source wins over the probe's;
//   • THE GITHUB HALF: milestones first, a hit stops it; a missing read:project scope ends the
//     iteration half SILENTLY (milestones only);
//   • NO VIEW TRIGGERS IT: the gate and the view stamp never call GitHub, and only the tracker worker
//     imports the probe.

const DB_PATH = join(process.env.LIMN_TEST_RUN_DIR ?? tmpdir(), 'pierre-sprint-probe-test.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: import('../context.js').TrackerContext;
let probe: typeof import('./probe.js');
let gates: typeof import('../../db/feature-gates.js');
let store: typeof import('../../db/sprint-store.js');
let eq: typeof import('drizzle-orm').eq;
let and: typeof import('drizzle-orm').and;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 12);
let ghCalls = 0;
let wsGh: number[] = [];
let wsJira = 0;
let wsExisting = 0;

const MILESTONE: SprintSource = { kind: 'milestone', provider: 'github', name: 'v2', dueOn: '2026-11-10T00:00:00Z', repos: ['acme/r0'] };

let probed: Array<{ repos: readonly string[] }> = [];
let answer: SprintSource | null = null;
const prober = async (_gh: unknown, repos: readonly string[]): Promise<SprintSource | null> => {
  probed.push({ repos });
  return answer;
};
const opts = (now: number) => ({ now: () => now, prober });

async function insertRepo(accountId: number, name: string): Promise<number> {
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId, owner: 'acme', name, githubNodeId: `R_probe_${accountId}_${name}` })
    .returning({ id: schema.repos.id })
    .execute();
  return r.id;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  ({ eq, and } = await import('drizzle-orm'));
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_pr_a', githubLogin: 'pr-a', isLocal: true }).execute();
  await db.update(schema.accounts).set({ featuresExistingInstall: false }).where(eq(schema.accounts.id, 1)).execute();
  await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_pr_b', githubLogin: 'pr-b', isLocal: false, featuresExistingInstall: true }).execute();
  // Account 1: three GitHub Issues workspaces (the first with 25 repos), one Jira workspace.
  for (let i = 0; i < 3; i++) {
    const ws = (await q.createWorkspace(1, `GH ${i}`)).id;
    wsGh.push(ws);
    const repos: number[] = [];
    for (let j = 0; j < (i === 0 ? 25 : 1); j++) repos.push(await insertRepo(1, `r${i}-${String(j).padStart(2, '0')}`));
    await q.assignReposToWorkspace(ws, 1, repos);
    await db.insert(schema.workspaceTrackers).values({ accountId: 1, workspaceId: ws, provider: 'github' }).execute();
  }
  wsJira = (await q.createWorkspace(1, 'Jira')).id;
  await q.assignReposToWorkspace(wsJira, 1, [await insertRepo(1, 'jira-repo')]);
  await db.insert(schema.workspaceTrackers).values({ accountId: 1, workspaceId: wsJira, provider: 'jira', baseUrl: 'https://acme.atlassian.net' }).execute();
  // …whose read found no sprint, so the configured tracker alone does not turn the gate on.
  await db
    .insert(schema.sprintReads)
    .values({
      accountId: 1,
      workspaceId: wsJira,
      provider: 'jira',
      readAt: new Date(T0),
      viewedAt: new Date(T0),
      nextReadAt: new Date(T0),
      sourceJson: { kind: 'status_fallback', provider: 'jira', reason: 'none_active', from: '', to: '' },
    })
    .execute();
  // Account 2: an existing install with a GitHub Issues workspace — never probed.
  wsExisting = await q.ensureDefaultWorkspace(2);
  await q.assignReposToWorkspace(wsExisting, 2, [await insertRepo(2, 'old')]);
  await db.insert(schema.workspaceTrackers).values({ accountId: 2, workspaceId: wsExisting, provider: 'github' }).execute();

  const { buildTrackerContext } = await import('../runtime.js');
  ctx = {
    ...buildTrackerContext({ warn: () => {}, info: () => {}, error: () => {} } as never),
    // ⚠ A fake GitHub: the tick itself (through the injected prober) and every view must never reach it.
    github: {
      graphql: async () => {
        ghCalls += 1;
        return { data: null as never, errors: undefined };
      },
    },
  };
  probe = await import('./probe.js');
  gates = await import('../../db/feature-gates.js');
  store = await import('../../db/sprint-store.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  probed = [];
  answer = null;
});

const row = async (accountId: number, workspaceId: number) =>
  (
    await db
      .select()
      .from(schema.sprintReads)
      .where(and(eq(schema.sprintReads.accountId, accountId), eq(schema.sprintReads.workspaceId, workspaceId)))
      .execute()
  )[0];

describe('dueProbes (pure)', () => {
  const c = (accountId: number, workspaceId: number) => ({ accountId, workspaceId });
  it('never-probed first, then the oldest; a read, a recent probe or an existing install is skipped; ≤ limit', () => {
    const rows = [
      { accountId: 1, workspaceId: 1, readAt: null, probeCheckedAt: new Date(T0 - 7 * HOUR) },
      { accountId: 1, workspaceId: 2, readAt: null, probeCheckedAt: new Date(T0 - 1 * HOUR) },
      { accountId: 1, workspaceId: 3, readAt: new Date(T0 - 100 * HOUR), probeCheckedAt: null },
    ];
    const due = probe.dueProbes([c(1, 1), c(1, 2), c(1, 3), c(1, 4), c(9, 5)], rows, new Set([9]), T0, 5);
    expect(due).toEqual([c(1, 4), c(1, 1)]);
    expect(probe.dueProbes([c(1, 1), c(1, 4)], rows, new Set(), T0, 1)).toEqual([c(1, 4)]);
  });
});

describe('runSprintProbeTick', () => {
  it('probes at most SPRINT_PROBE_WORKSPACES GitHub workspaces per tick, ≤ 20 repos each, never Jira or an existing install', async () => {
    expect(probe.SPRINT_PROBE_WORKSPACES).toBe(2);
    expect(await probe.runSprintProbeTick(ctx, opts(T0))).toBe(2);
    expect(probed).toHaveLength(2);
    expect(Math.max(...probed.map((p) => p.repos.length))).toBe(20);
    // The third GitHub workspace next tick; then nothing until the interval has passed.
    expect(await probe.runSprintProbeTick(ctx, opts(T0 + 60_000))).toBe(1);
    expect(await probe.runSprintProbeTick(ctx, opts(T0 + 2 * HOUR))).toBe(0);
    expect(probed).toHaveLength(3);
    expect((await row(1, wsJira)).probeCheckedAt).toBeNull();
    expect(await row(2, wsExisting)).toBeUndefined();
    // The probe's row is NOT a view: the demand-gated read never picks it up.
    const r = await row(1, wsGh[0]!);
    expect(r.viewedAt.getTime()).toBe(0);
    expect(r.readAt).toBeNull();
    expect(r.probeCheckedAt.getTime()).toBe(T0);
    expect(r.probeSourceJson).toBeNull();
    // The prober was injected: GitHub itself was never called.
    expect(ghCalls).toBe(0);
  });

  it('its answer feeds the This Sprint gate; nothing found keeps it off', async () => {
    expect(await gates.hasSprintSource(1)).toBe(false);
    answer = MILESTONE;
    const later = T0 + probe.SPRINT_PROBE_INTERVAL_MS + 1;
    expect(await probe.runSprintProbeTick(ctx, opts(later))).toBe(2);
    expect(await gates.hasSprintSource(1)).toBe(true);
    expect((await gates.featureFacts(1, false)).sprintSource).toBe(true);
    // An undated milestone is not a sprint source.
    await db
      .update(schema.sprintReads)
      .set({ probeSourceJson: { ...MILESTONE, dueOn: null } })
      .where(eq(schema.sprintReads.accountId, 1))
      .execute();
    expect(await gates.hasSprintSource(1)).toBe(false);
  });

  it("a sprint read's own source wins, and a read workspace is never probed again", async () => {
    await db.update(schema.sprintReads).set({ probeSourceJson: MILESTONE }).where(eq(schema.sprintReads.accountId, 1)).execute();
    expect(await gates.hasSprintSource(1)).toBe(true);
    await db
      .update(schema.sprintReads)
      .set({
        readAt: new Date(T0),
        sourceJson: { kind: 'status_fallback', provider: 'github', reason: 'none_active', from: '', to: '' },
      })
      .where(eq(schema.sprintReads.accountId, 1))
      .execute();
    expect(await gates.hasSprintSource(1)).toBe(false);
    expect(await probe.runSprintProbeTick(ctx, opts(T0 + 100 * probe.SPRINT_PROBE_INTERVAL_MS))).toBe(0);
    expect(probed).toHaveLength(0);
  });

  it('no view triggers it: the gate and the view stamp never call GitHub, and only the worker imports the probe', async () => {
    const before = ghCalls;
    await gates.hasSprintSource(1);
    await gates.featureFacts(1, false);
    await store.noteSprintViewed(1, wsGh[1]!);
    expect(ghCalls).toBe(before);
    expect(probed).toHaveLength(0);
    // Static: the probe is imported by the tracker worker's tick and nothing else (no route, no view).
    const src = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && /sprint\/probe\.js|['"]\.\/probe\.js/.test(readFileSync(p, 'utf8')))
          importers.push(relative(src, p));
      }
    };
    walk(src);
    expect(importers).toEqual(['tracker/worker.ts']);
  });
});

describe('probeGithubSprintSource (the GitHub half)', () => {
  const NOW = Date.UTC(2026, 10, 2, 12);
  const fakeGh = (answers: { milestones?: unknown[]; scan?: { data?: unknown; errors?: unknown } }) => {
    const asked: string[] = [];
    return {
      asked,
      gh: {
        accountId: 77,
        graphql: async (query: string) => {
          if (query.includes('LimnSprintMilestones')) {
            asked.push('milestones');
            return { data: { repository: { milestones: { nodes: answers.milestones ?? [] } } } as never, errors: undefined };
          }
          asked.push('scan');
          return { data: (answers.scan?.data ?? null) as never, errors: answers.scan?.errors };
        },
      },
    };
  };

  it('a dated milestone due today or later is the answer, and stops before the iteration scan', async () => {
    const f = fakeGh({ milestones: [{ title: 'v2', dueOn: '2026-11-09T00:00:00Z', number: 1 }] });
    const got = await probe.probeGithubSprintSource(f.gh, ['acme/a', 'acme/b'], NOW);
    expect(got).toMatchObject({ kind: 'milestone', name: 'v2', dueOn: '2026-11-09T00:00:00Z' });
    expect(f.asked).toEqual(['milestones']);
  });

  it('undated or overdue milestones do not count; a missing read:project scope ends it silently (milestones only)', async () => {
    const f = fakeGh({
      milestones: [
        { title: 'someday', dueOn: null, number: 1 },
        { title: 'late', dueOn: '2026-10-01T00:00:00Z', number: 2 },
      ],
      scan: { errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs read:project' }] },
    });
    expect(await probe.probeGithubSprintSource(f.gh, ['acme/a', 'acme/b'], NOW)).toBeNull();
    // Both repos' milestones, then ONE scan: the refusal stops the iteration half.
    expect(f.asked).toEqual(['milestones', 'milestones', 'scan']);
  });

  it('a current Projects iteration is the answer', async () => {
    const f = fakeGh({
      scan: {
        data: {
          repository: {
            issues: {
              nodes: [
                {
                  number: 3,
                  projectItems: {
                    nodes: [
                      {
                        project: { id: 'P1', title: 'Roadmap', closed: false },
                        fieldValues: {
                          nodes: [{ iterationId: 'I1', title: 'Sprint 14', startDate: '2026-10-27', duration: 14, field: { id: 'F1', name: 'Sprint' } }],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
    const got = await probe.probeGithubSprintSource(f.gh, ['acme/a'], NOW);
    expect(got).toMatchObject({ kind: 'iteration', name: 'Sprint 14', project: 'Roadmap', startsOn: '2026-10-27', endsOn: '2026-11-10' });
    const { isSprintSource } = gates;
    expect(isSprintSource(got)).toBe(true);
  });

  it('asks about at most 20 repos', async () => {
    const f = fakeGh({});
    await probe.probeGithubSprintSource(f.gh, Array.from({ length: 30 }, (_, i) => `acme/r${i}`), NOW);
    expect(f.asked.filter((a) => a === 'milestones')).toHaveLength(20);
  });
});
