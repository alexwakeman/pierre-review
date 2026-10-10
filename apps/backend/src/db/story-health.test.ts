// db/story-health.ts + GET /api/story-health — on a THROWAWAY sqlite DB. The fold is pinned in
// story-health-fold.test.ts; this pins the READS and the ROUTE:
//  • created date = the freshest-read non-null `issue_created_at` across a ticket's rows; none →
//    the first-PR fallback, counted;
//  • a label counts only when its rubric version AND text hash match today's text;
//  • `labels: false` omits the label series and the to-do count;
//  • the route: 402 without periodReports, another tenant's workspace → the caller's Default.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { jiraApiRoot, STORY_RUBRIC_VERSION, trackerTicketIdent } from '@pierre-review/shared';

const DB_PATH = '/private/tmp/claude-501/pierre-story-health-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let sh: typeof import('./story-health.js');
let app: FastifyInstance;
let setCaps: ((c: any) => void) | undefined;
let emptyCaps: any;
let WS = 0;
let FOREIGN_WS = 0;
let A1 = 0;

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-07T12:00:00Z'); // a Wednesday
const ACME = jiraApiRoot('https://acme.atlassian.net') as string;
const ident = (k: string) => trackerTicketIdent('jira', ACME, k);
const AC = '- one\n- two';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  sh = await import('./story-health.js');
  const { accounts, workspaces, workspaceRepos, workspaceTrackers, repos, pullRequests, trackerTickets, storyLabels } = schema;
  A1 = (await db.insert(accounts).values({ githubUserId: 'U_sh_a', githubLogin: 'sh-a' }).returning().execute())[0].id;
  const A2 = (await db.insert(accounts).values({ githubUserId: 'U_sh_b', githubLogin: 'sh-b' }).returning().execute())[0].id;
  WS = (await db.insert(workspaces).values({ accountId: A1, name: 'S', isDefault: true, flowSettings: { timeZone: 'UTC' } }).returning().execute())[0].id;
  FOREIGN_WS = (await db.insert(workspaces).values({ accountId: A2, name: 'T', isDefault: true }).returning().execute())[0].id;
  await db.insert(workspaceTrackers).values({ accountId: A1, workspaceId: WS, provider: 'jira', baseUrl: 'https://acme.atlassian.net' }).execute();
  const repo = (await db.insert(repos).values({ accountId: A1, owner: 'acme', name: 'web', githubNodeId: 'R_sh' }).returning().execute())[0].id;
  await db.insert(workspaceRepos).values({ accountId: A1, workspaceId: WS, repoId: repo }).execute();

  let seq = 0;
  const story = async (key: string, opened: number, merged: number | null, rowsSpec: Array<{ created: number | null; fetched: number }>, ac = AC) => {
    seq += 1;
    const prId = (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_sh_${seq}`,
          accountId: A1,
          repoId: repo,
          number: seq,
          title: key,
          state: merged == null ? 'open' : 'merged',
          isDraft: false,
          openedAt: new Date(opened),
          updatedAt: new Date(merged ?? opened),
          mergedAt: merged == null ? null : new Date(merged),
          additions: 50,
          deletions: 10,
          changedFiles: 2,
        })
        .returning()
        .execute()
    )[0].id;
    for (const [i, r] of rowsSpec.entries()) {
      await db
        .insert(trackerTickets)
        .values({
          accountId: A1,
          workspaceId: WS,
          prId: i === 0 ? prId : prId + 100_000 + i, // extra rows: another PR's row of the same ticket
          provider: 'jira',
          issueKey: key,
          detectedFrom: 'title',
          detectOrder: 0,
          apiRoot: ACME,
          url: `https://acme.atlassian.net/browse/${key}`,
          state: 'ok',
          title: `Story ${key}`,
          description: 'As a user I want X so that I save time',
          acceptanceCriteria: ac,
          fetchedAt: new Date(r.fetched),
          checkedAt: new Date(r.fetched),
          nextCheckAt: new Date(r.fetched),
          issueCreatedAt: r.created == null ? null : new Date(r.created),
        })
        .execute();
    }
  };
  // ENG-1: two rows; the FRESHER one's created date wins.
  await story('ENG-1', NOW - 20 * DAY, NOW - 15 * DAY, [
    { created: NOW - 40 * DAY, fetched: NOW - 10 * DAY },
    { created: NOW - 30 * DAY, fetched: NOW - 2 * DAY },
  ]);
  // ENG-2: no created date → first-PR fallback.
  await story('ENG-2', NOW - 9 * DAY, NOW - 8 * DAY, [{ created: null, fetched: NOW - DAY }]);
  // ENG-3: has a current label. ENG-4: a label for OLD text (stale).
  await story('ENG-3', NOW - 9 * DAY, NOW - 8 * DAY, [{ created: NOW - 9 * DAY, fetched: NOW - DAY }]);
  await story('ENG-4', NOW - 9 * DAY, NOW - 8 * DAY, [{ created: NOW - 9 * DAY, fetched: NOW - DAY }], '- edited');
  // ENG-5: written in the span, its pull request still OPEN — refinement only, never delivery.
  await story('ENG-5', NOW - 3 * DAY, null, [{ created: NOW - 4 * DAY, fetched: NOW - DAY }]);
  // ENG-6: open, but written long before the span — in neither population.
  await story('ENG-6', NOW - 200 * DAY, null, [{ created: NOW - 200 * DAY, fetched: NOW - DAY }]);
  const { storyLabelInput } = await import('./story-label-input.js');
  const current = storyLabelInput({ title: 'Story ENG-3', description: 'As a user I want X so that I save time', acceptanceCriteria: AC }, 'jira')!;
  const label = (key: string, textHash: string, rubricVersion = STORY_RUBRIC_VERSION) =>
    db
      .insert(storyLabels)
      .values({
        accountId: A1,
        ident: ident(key),
        textHash,
        rubricVersion,
        criteriaJson: [
          { n: 1, testable: true, bundled: false, dependsOnOtherWork: false },
          { n: 2, testable: false, bundled: true, dependsOnOtherWork: false },
        ],
        storyJson: { outOfScopeStated: true, dependencyNamed: false, nonCodeWork: false },
        criteriaCount: 2,
        model: 'claude-haiku-5-5',
      })
      .execute();
  await label('ENG-3', current.textHash);
  await label('ENG-3', current.textHash, STORY_RUBRIC_VERSION + 1); // another rubric: ignored
  await label('ENG-4', 'old-hash');

  const contract = await import('../pro/contract.js');
  contract.setProCapabilities({ ...contract.EMPTY_CAPABILITIES, periodReports: true });
  setCaps = contract.setProCapabilities;
  emptyCaps = contract.EMPTY_CAPABILITIES;
  const { storyHealthRoutes } = await import('../api/routes/story-health.js');
  const { registerAccountContext } = await import('../api/plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(storyHealthRoutes);
  await app.ready();
});

afterAll(async () => {
  setCaps?.(emptyCaps);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('loadStoryHealthInputs', () => {
  it('takes the freshest created date, attaches only CURRENT labels, and counts the criteria', async () => {
    const q = await import('./queries.js');
    const s = await q.resolveWorkspaceScope(A1, WS);
    const inputs = await sh.loadStoryHealthInputs(A1, s, NOW);
    expect(inputs.trackerOn).toBe(true);
    expect(inputs.weeks).toHaveLength(13);
    const by = new Map(inputs.stories.map((x) => [x.key, x]));
    expect(by.get('ENG-1')!.createdMs).toBe(NOW - 30 * DAY);
    expect(by.get('ENG-2')!.createdMs).toBeNull();
    expect(by.get('ENG-3')!.label?.story.outOfScopeStated).toBe(true);
    expect(by.get('ENG-4')!.label).toBeNull();
    expect(by.get('ENG-3')).toMatchObject({ labellable: true, criteriaCount: 2, ticketKnown: true });
    // ⚠ The refinement population is not only what has merged: an open story written in the span is in.
    expect(by.get('ENG-5')).toMatchObject({ createdMs: NOW - 4 * DAY, lastMergedMs: null, ticketKnown: true, labellable: true });
    expect(by.has('ENG-6')).toBe(false);
  });
});

describe('getStoryHealth', () => {
  it('counts the fallback and the unlabelled stories; labels off omits the label half', async () => {
    const q = await import('./queries.js');
    const s = await q.resolveWorkspaceScope(A1, WS);
    const on = await sh.getStoryHealth(A1, s, NOW, { labels: true, labelRun: null });
    expect(on.createdFallbackTotal).toBe(1);
    // ENG-1, ENG-2, ENG-4 and the open ENG-5 are labellable with no current label.
    expect(on.unlabelled).toBe(4);
    // ENG-5 is written (refinement) but not merged (delivery).
    expect(on.weeks.reduce((n, w) => n + w.storiesMerged, 0)).toBe(4);
    expect(on.weeks.reduce((n, w) => n + w.storiesCreated, 0)).toBe(5);
    expect(on.weeks.reduce((n, w) => n + w.labelled, 0)).toBe(1);
    expect(on.series.map((x) => x.id)).toContain('unclearDone');
    expect(on.span.label).toBe('Last 90 days');
    const off = await sh.getStoryHealth(A1, s, NOW, { labels: false, labelRun: null });
    expect(off.series.map((x) => x.id)).not.toContain('unclearDone');
    expect(off.series.map((x) => x.id)).toContain('workingTimeS');
    expect(off).toMatchObject({ labels: false, unlabelled: 0, labelRun: null });
  });
});

describe('GET /api/story-health', () => {
  it("echoes the resolved workspace; another tenant's id falls to the caller's Default", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/story-health?workspace=${FOREIGN_WS}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(typeof body.workspaceId).toBe('number');
    expect(body.workspaceId).not.toBe(FOREIGN_WS);
    expect(body.weeks).toHaveLength(13);
  });

  it('402s without periodReports', async () => {
    setCaps?.(emptyCaps);
    const res = await app.inject({ method: 'GET', url: '/api/story-health' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'pro required' });
    setCaps?.({ ...emptyCaps, periodReports: true });
  });
});
