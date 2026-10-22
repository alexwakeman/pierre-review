// db/story-health.ts — the label run's POPULATION reads, on a THROWAWAY sqlite DB:
//  • created date = the freshest-read non-null `issue_created_at` across a ticket's rows; none →
//    the first-PR fallback;
//  • a label counts only when its rubric version AND text hash match today's text;
//  • `storiesToLabel` picks the labellable stories with no current label, open ones included.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jiraApiRoot, STORY_RUBRIC_VERSION, trackerTicketIdent } from '@pierre-review/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), 'pierre-story-health-test.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let sh: typeof import('./story-health.js');
let WS = 0;
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
  // Another tenant's workspace (it must stay out of every read).
  void (await db.insert(workspaces).values({ accountId: A2, name: 'T', isDefault: true }).returning().execute())[0].id;
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
          { n: 1, testable: true, reason: null },
          { n: 2, testable: false, reason: 'no expected result' },
        ],
        storyJson: {
          dependencies: [{ kind: 'ticket', what: 'login', owner: null, ticketKey: 'ENG-1' }],
          gaps: [{ type: 'rule', text: 'No rule for duplicate exports' }],
        },
        criteriaCount: 2,
        model: 'claude-haiku-5-5',
      })
      .execute();
  await label('ENG-3', current.textHash);
  await label('ENG-3', current.textHash, STORY_RUBRIC_VERSION + 1); // another rubric: ignored
  await label('ENG-4', 'old-hash');
  // ENG-3 also carries a FINISHED tracker link: still counted as Blocked (how it was written).
  {
    const { and, eq } = await import('drizzle-orm');
    await db
      .update(trackerTickets)
      .set({ blockedByJson: [{ key: 'ENG-90', title: 'Old spike', status: 'Done', category: 'done', relation: 'is blocked by', url: null }] })
      .where(and(eq(trackerTickets.accountId, A1), eq(trackerTickets.issueKey, 'ENG-3')))
      .execute();
  }

});

afterAll(async () => {
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
    expect(by.get('ENG-3')!.label?.story.gaps).toEqual([{ type: 'rule', text: 'No rule for duplicate exports' }]);
    expect(by.get('ENG-3')!.links?.map((l) => l.key)).toEqual(['ENG-90']);
    expect(by.get('ENG-3')!.title).toBe('Story ENG-3');
    // The named key ENG-1 is a stored ticket on the same site: resolved for its title.
    expect(by.get('ENG-3')!.knownTickets?.get('ENG-1')?.title).toBe('Story ENG-1');
    expect(by.get('ENG-4')!.label).toBeNull();
    expect(by.get('ENG-3')).toMatchObject({ labellable: true, criteriaCount: 2, ticketKnown: true });
    // ⚠ The refinement population is not only what has merged: an open story written in the span is in.
    expect(by.get('ENG-5')).toMatchObject({ createdMs: NOW - 4 * DAY, lastMergedMs: null, ticketKnown: true, labellable: true });
    expect(by.has('ENG-6')).toBe(false);
  });
});

describe('storiesToLabel', () => {
  it('picks every labellable story with no CURRENT label, the open one included', async () => {
    const q = await import('./queries.js');
    const { storiesToLabel } = await import('./story-health-fold.js');
    const s = await q.resolveWorkspaceScope(A1, WS);
    const inputs = await sh.loadStoryHealthInputs(A1, s, NOW);
    // ENG-1, ENG-2, ENG-4 and the open ENG-5 are labellable with no current label; ENG-3 is labelled.
    expect(storiesToLabel(inputs.stories, inputs.weeks).map((x) => x.key).sort()).toEqual(['ENG-1', 'ENG-2', 'ENG-4', 'ENG-5']);
  });
});
