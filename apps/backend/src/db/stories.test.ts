// db/stories.ts + db/story-selection.ts — Reports → Stories, on a THROWAWAY sqlite DB. Pinned:
//  • the population: a ticket on the WORKSPACE'S tracker site with a PR in the workspace's repos
//    merged in `[from, min(end, now))` — two-sided, half-open; another site, an unread row and
//    another account's rows never count;
//  • members are every PR on the ticket (any repo of this account), so counts and time span them;
//  • working hours through the workspace calendar, clock hours beside them;
//  • UNKNOWN IS NEVER ZERO: an unsized merged PR nulls the story's size and is counted;
//  • criteria: the latest SUCCEEDED review wins, else the text rule, source labelled;
//  • the two lists; no tracker → `trackerOn: false`;
//  • the story report's async selection: the window choice, the picks, the whole-window figures.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jiraApiRoot, trackerTicketIdent } from '@pierre-review/shared';

const DB_PATH = '/private/tmp/claude-501/pierre-stories-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let st: typeof import('./stories.js');
let sel: typeof import('./story-selection.js');

const at = (iso: string) => new Date(iso);
// Mon 2026-09-07 → Mon 2026-09-21; "now" is Sun 2026-09-20 00:00 UTC.
const NOW = Date.parse('2026-09-20T00:00:00Z');
const WINDOW = { fromMs: Date.parse('2026-09-07T00:00:00Z'), toMs: Date.parse('2026-09-21T00:00:00Z'), mode: 'sprint' as const };

const ACME = jiraApiRoot('https://acme.atlassian.net') as string;
const OTHER = jiraApiRoot('https://other.atlassian.net') as string;
const ident = (k: string) => trackerTicketIdent('jira', ACME, k);

let A1 = 0;
let A2 = 0;
let WS = 0;
let WS_NONE = 0;
let r1 = 0;
let r2 = 0;
let rF = 0;
const pr: Record<string, number> = {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  st = await import('./stories.js');
  sel = await import('./story-selection.js');
  const { accounts, workspaces, workspaceRepos, workspaceTrackers, repos, pullRequests, trackerTickets, ticketReviews, ticketReviewMembers } = schema;

  const mkAccount = async (login: string): Promise<number> => {
    const found = (await db.select().from(accounts).execute()).find((a: any) => a.githubLogin === login);
    if (found) return found.id;
    return (await db.insert(accounts).values({ githubUserId: `U_${login}`, githubLogin: login }).returning().execute())[0].id;
  };
  A1 = await mkAccount('mine');
  A2 = await mkAccount('theirs');
  const mkWs = async (accountId: number, name: string): Promise<number> =>
    (
      await db
        .insert(workspaces)
        .values({ accountId, name, isDefault: false, flowSettings: { timeZone: 'UTC' } })
        .returning()
        .execute()
    )[0].id;
  WS = await mkWs(A1, 'Stories');
  WS_NONE = await mkWs(A1, 'No tracker');
  const otherWs = await mkWs(A1, 'Elsewhere');
  const foreignWs = await mkWs(A2, 'Theirs');
  await db
    .insert(workspaceTrackers)
    .values([
      { accountId: A1, workspaceId: WS, provider: 'jira', baseUrl: 'https://acme.atlassian.net' },
      { accountId: A1, workspaceId: WS_NONE, provider: 'none' },
      { accountId: A2, workspaceId: foreignWs, provider: 'jira', baseUrl: 'https://acme.atlassian.net' },
    ])
    .execute();
  const mkRepo = async (accountId: number, name: string, ws: number): Promise<number> => {
    const id = (
      await db.insert(repos).values({ accountId, owner: 'acme', name, githubNodeId: `R_st_${name}` }).returning().execute()
    )[0].id;
    await db.insert(workspaceRepos).values({ accountId, workspaceId: ws, repoId: id }).execute();
    return id;
  };
  r1 = await mkRepo(A1, 'web', WS);
  r2 = await mkRepo(A1, 'engine', otherWs);
  rF = await mkRepo(A2, 'evil', foreignWs);

  let seq = 0;
  const mkPr = async (
    key: string,
    accountId: number,
    repoId: number,
    state: 'open' | 'merged' | 'closed',
    opened: string,
    merged: string | null,
    size: [number, number, number],
  ) => {
    seq += 1;
    pr[key] = (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_st_${seq}`,
          accountId,
          repoId,
          number: seq,
          title: `PR ${key}`,
          state,
          isDraft: false,
          openedAt: at(opened),
          updatedAt: at(opened),
          mergedAt: merged == null ? null : at(merged),
          additions: size[0],
          deletions: size[1],
          changedFiles: size[2],
        })
        .returning()
        .execute()
    )[0].id;
  };
  // ENG-1: two merged (one in another workspace's repo), one open, unsized open PR.
  await mkPr('a', A1, r1, 'merged', '2026-09-07T09:00:00Z', '2026-09-08T09:00:00Z', [10, 5, 2]);
  await mkPr('b', A1, r2, 'merged', '2026-09-08T09:00:00Z', '2026-09-09T09:00:00Z', [3, 0, 1]);
  await mkPr('c', A1, r1, 'open', '2026-09-10T09:00:00Z', null, [0, 0, 0]);
  // ENG-2: one merged, UNSIZED.
  await mkPr('d', A1, r1, 'merged', '2026-09-14T09:00:00Z', '2026-09-15T12:00:00Z', [0, 0, 0]);
  // ENG-3: merged before the window, and exactly at "now" (half-open) — never in the population.
  await mkPr('e', A1, r1, 'merged', '2026-09-01T09:00:00Z', '2026-09-05T09:00:00Z', [1, 1, 1]);
  await mkPr('f', A1, r1, 'merged', '2026-09-18T09:00:00Z', '2026-09-20T00:00:00Z', [1, 1, 1]);
  // ENG-4: reviewed, all met.
  await mkPr('g', A1, r1, 'merged', '2026-09-16T09:00:00Z', '2026-09-17T09:00:00Z', [4, 4, 1]);
  // Other site, unread row, foreign account.
  await mkPr('h', A1, r1, 'merged', '2026-09-16T09:00:00Z', '2026-09-17T10:00:00Z', [4, 4, 1]);
  await mkPr('i', A1, r1, 'merged', '2026-09-16T09:00:00Z', '2026-09-17T11:00:00Z', [4, 4, 1]);
  await mkPr('z', A2, rF, 'merged', '2026-09-07T09:00:00Z', '2026-09-12T09:00:00Z', [100, 100, 9]);

  let order = 0;
  const ticket = async (
    key: string,
    prKey: string,
    opts: { accountId?: number; workspaceId?: number; apiRoot?: string; state?: string; fetched?: string; ac?: string; title?: string; desc?: string } = {},
  ) => {
    order += 1;
    await db
      .insert(trackerTickets)
      .values({
        accountId: opts.accountId ?? A1,
        workspaceId: opts.workspaceId ?? WS,
        prId: pr[prKey],
        provider: 'jira',
        issueKey: key,
        detectedFrom: 'title',
        detectOrder: order,
        apiRoot: opts.apiRoot ?? ACME,
        url: `https://acme.atlassian.net/browse/${key}`,
        state: opts.state ?? 'ok',
        title: opts.title ?? `Story ${key}`,
        description: opts.desc ?? 'Do the thing {color:red}now{color}   \nplease',
        acceptanceCriteria: opts.ac ?? '',
        fetchedAt: (opts.state ?? 'ok') === 'ok' ? at(opts.fetched ?? '2026-09-10T00:00:00Z') : null,
        checkedAt: at('2026-09-10T00:00:00Z'),
        nextCheckAt: at('2026-09-10T00:00:00Z'),
      })
      .execute();
  };
  await ticket('ENG-1', 'a', { fetched: '2026-09-08T00:00:00Z', title: 'Old title' });
  await ticket('ENG-1', 'b', { workspaceId: otherWs, fetched: '2026-09-12T00:00:00Z', title: 'Fresh title' });
  await ticket('ENG-1', 'c');
  await ticket('ENG-2', 'd', { ac: '- one\n- two' });
  await ticket('ENG-3', 'e');
  await ticket('ENG-3', 'f');
  await ticket('ENG-4', 'g');
  await ticket('ENG-9', 'h', { apiRoot: OTHER });
  await ticket('ENG-5', 'i', { state: 'not_found' });
  await ticket('ENG-1', 'z', { accountId: A2, workspaceId: foreignWs });

  const review = async (key: string, status: string, createdAt: string, assessment: any, members: string[]) => {
    const id = (
      await db
        .insert(ticketReviews)
        .values({
          accountId: A1,
          workspaceId: WS,
          ticketIdent: ident(key),
          ticketKey: key,
          ticketSnapshot: { title: `Judged ${key}`, description: 'As judged {color:blue}x{color}', acceptanceCriteria: '* a\n* b\n* c', source: 'jira', key },
          status,
          model: 'claude-sonnet-5',
          createdAt: at(createdAt),
          completedAt: status === 'succeeded' ? at(createdAt) : null,
          alignment: assessment?.alignment ?? null,
          assessment,
        })
        .returning()
        .execute()
    )[0].id;
    for (const m of members) {
      await db
        .insert(ticketReviewMembers)
        .values({ ticketReviewId: id, accountId: A1, prId: pr[m], repoId: m === 'b' ? r2 : r1, headSha: 'sha', prState: 'merged' })
        .execute();
    }
  };
  const crit = (ref: string, status: string) => ({ ref, index: 0, text: `crit ${ref}`, status, explanation: `why ${ref}`, deliveredBy: [], evidence: [], expectedIn: null });
  // An older succeeded review (all met) and a newer one with a shortfall — the newer wins.
  await review('ENG-1', 'succeeded', '2026-09-09T00:00:00Z', { alignment: 'aligned', summary: 'old', criteria: [crit('AC1', 'met')], missing: [], notRequested: [] }, ['a']);
  await review(
    'ENG-1',
    'succeeded',
    '2026-09-11T00:00:00Z',
    {
      alignment: 'partly_aligned',
      summary: 'Some gaps',
      criteria: [crit('AC1', 'met'), crit('AC2', 'not_met'), crit('AC3', 'partly_met')],
      missing: [{ ref: 'M1', title: 'Export', explanation: 'none', expectedIn: null }],
      notRequested: [{ title: 'Refactor', explanation: 'extra', prId: null, path: null, line: null }],
    },
    ['b', 'a'],
  );
  // A FAILED review never counts.
  await review('ENG-2', 'failed', '2026-09-16T00:00:00Z', null, []);
  await review('ENG-4', 'succeeded', '2026-09-18T00:00:00Z', { alignment: 'aligned', summary: 'ok', criteria: [crit('AC1', 'met'), crit('AC2', 'met')], missing: [], notRequested: [] }, ['g']);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const fold = () => st.foldStories(A1, { workspaceId: WS, repoIds: [r1] }, NOW, WINDOW);

describe('foldStories — population', () => {
  it('admits a ticket on the workspace site with a workspace PR merged in [from, min(end, now))', async () => {
    const f = await fold();
    expect(f.trackerOn).toBe(true);
    expect(f.stories.map((s) => s.key).sort()).toEqual(['ENG-1', 'ENG-2', 'ENG-4']);
    expect(f.truncated).toBe(false);
  });

  it('a workspace with no reading tracker says so and lists nothing', async () => {
    const f = await st.foldStories(A1, { workspaceId: WS_NONE, repoIds: [r1] }, NOW, WINDOW);
    expect(f.trackerOn).toBe(false);
    expect(f.stories).toEqual([]);
  });

  it('an empty workspace is an empty list, never the account', async () => {
    const f = await st.foldStories(A1, { workspaceId: WS, repoIds: [] }, NOW, WINDOW);
    expect(f.stories).toEqual([]);
  });
});

describe('foldStories — one story', () => {
  it('spans every member PR of this account (never another account’s), in working and clock hours', async () => {
    const s = (await fold()).stories.find((x) => x.key === 'ENG-1')!;
    expect(s.ident).toBe(ident('ENG-1'));
    expect(s.title).toBe('Fresh title'); // the freshest stored row
    expect(s.prs).toEqual({ total: 3, open: 1, merged: 2, closed: 0, mergedInWindow: 2 });
    expect(s.pullRequests.map((p) => p.prId)).toEqual([pr.b, pr.a, pr.c]);
    expect(s.firstOpenedAt).toBe('2026-09-07T09:00:00.000Z');
    expect(s.lastMergedAt).toBe('2026-09-09T09:00:00.000Z');
    expect(s.clockHours).toBe(48);
    expect(s.workingHours).toBeCloseTo(18); // two 9-hour days, UTC
    // Size over MERGED members only: the unsized OPEN PR does not null it.
    expect(s.linesChanged).toBe(18);
    expect(s.files).toBe(3);
    expect(s.unsizedPrs).toBe(0);
  });

  it('an unsized merged PR makes the size unknown, never zero', async () => {
    const s = (await fold()).stories.find((x) => x.key === 'ENG-2')!;
    expect(s.linesChanged).toBeNull();
    expect(s.files).toBeNull();
    expect(s.unsizedPrs).toBe(1);
  });

  it('criteria: the latest succeeded review wins; else the text rule, labelled', async () => {
    const f = await fold();
    const one = f.stories.find((x) => x.key === 'ENG-1')!;
    expect(one.criteria).toEqual({ count: 3, source: 'review' });
    expect(one.review).toMatchObject({ alignment: 'partly_aligned', met: 1, notMet: 1, partlyMet: 1, missing: 1, total: 3 });
    expect(one.unmetCount).toBe(3);
    const two = f.stories.find((x) => x.key === 'ENG-2')!;
    expect(two.review).toBeNull(); // the failed run is not a review
    expect(two.criteria).toEqual({ count: 2, source: 'acceptance_criteria' });
  });

  it('lists: shortfall = reviewed and not aligned or anything unmet, unchecked = never reviewed', async () => {
    const f = await fold();
    expect(f.shortfall).toEqual([ident('ENG-1')]);
    expect(f.unchecked).toEqual([ident('ENG-2')]);
    // Newest last merge first.
    expect(f.stories.map((s) => s.key)).toEqual(['ENG-4', 'ENG-2', 'ENG-1']);
  });
});

describe('loadStorySelection — the story report’s window choice', () => {
  it("'reporting' asks the reporting window (trailing 14 days in OSS) and echoes it", async () => {
    const out = await sel.loadStorySelection(A1, { workspaceId: WS, repoIds: [r1] }, 'reporting', NOW);
    expect(out.trackerOn).toBe(true);
    expect(out.range.choice).toBe('reporting');
    expect(out.range.reporting).toMatchObject({ mode: 'rolling_14', days: 14 });
    expect(out.population.storiesInWindow).toBe(3);
    expect(out.population).toMatchObject({
      withWrittenCriteria: 1,
      criteriaOnlyInDescription: 0,
      noCriteriaFound: 0,
      checkedByTicketReview: 2,
      checkedAndFullyMet: 1,
      checkedWithGaps: 1,
      truncated: false,
    });
    const one = out.candidates.find((c) => c.key === 'ENG-1')!;
    expect(one.group).toBe('fell_short');
    expect(one.whyPicked).toContain('3 criteria unmet or missing in the review');
    expect(out.internalsByKey.get('ENG-1')?.row.ident).toBe(ident('ENG-1'));
  });

  it("a day choice is a trailing span ending now: '30' admits the story merged before the sprint", async () => {
    const out = await sel.loadStorySelection(A1, { workspaceId: WS, repoIds: [r1] }, '30', NOW);
    expect(out.range).toMatchObject({ choice: '30', days: 30, reporting: null, to: new Date(NOW).toISOString() });
    expect(out.population.storiesInWindow).toBe(4); // + ENG-3 (merged 2026-09-05; its at-now merge is excluded)
  });
});
