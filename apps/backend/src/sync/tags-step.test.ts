// THE TAGS STEP (sync/tags-step.ts; docs/RELEASES.md § One history pass): the release scan for
// releasable repos only — ONE history pass then the batched ticket reads, time-boxed runs, a quick
// re-run while work remains and the
// settle sweep's catch-up when a run made no progress; an EXTERNAL repo that no workspace releases is
// skipped before any GitHub call. The DB module opens at import, so DATABASE_URL is set first.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-tags-step-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const views = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('../db/release-repos.js', () => ({ releaseRangeViews: () => views() }));
const tagSync = vi.fn(async (_o: unknown): Promise<unknown> => null);
vi.mock('./repo-tags.js', () => ({
  REPO_TAGS_READ_CAP_RELEASABLE: 1000,
  syncRepoTagsSafe: (o: unknown) => tagSync(o),
}));
const done = { pages: 0, compares: 0, walked: 0, complete: true, paused: false, restarted: false, stoppedEarly: false };
const walk = vi.fn(async (_o: unknown) => done);
const noTickets = { asked: 0, answered: 0, calls: 0, left: 0 };
const tickets = vi.fn(async (_o: unknown) => noTickets);
vi.mock('./release-history.js', () => ({ walkReleaseHistory: (o: unknown) => walk(o) }));

const m = await import('./tags-step.js');
const opts = { owner: 'acme', name: 'web', repoId: 7, accountId: 1, token: 't', deps: { tickets: (o: unknown) => tickets(o) } };

beforeEach(() => {
  m.__resetTagSync();
  views.mockReset();
  tagSync.mockReset();
  walk.mockReset();
  tickets.mockReset();
  views.mockResolvedValue([]);
  tagSync.mockResolvedValue(null);
  walk.mockResolvedValue(done);
  tickets.mockResolvedValue(noTickets);
});

afterAll(async () => {
  const client = await import('../db/client.js');
  await client.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the catch-up', () => {
  it('is taken once it is due, and only once', () => {
    m.markTagCatchUp(7, 1_000);
    expect(m.takeTagCatchUp(7, 999)).toBe(false);
    expect(m.takeTagCatchUp(7, 1_000)).toBe(true);
    expect(m.takeTagCatchUp(7, 2_000)).toBe(false);
  });
  it('an earlier mark wins', () => {
    m.markTagCatchUp(7, 5_000);
    m.markTagCatchUp(7, 1_000);
    expect(m.takeTagCatchUp(7, 1_000)).toBe(true);
  });
});

const RELEASING = [{ workspaceId: 3, settings: { releaseSuffix: '-rc', hotfixSuffix: '-hf' } }];

describe('runTagsStep', () => {
  it('an EXTERNAL repo no workspace releases is skipped before any GitHub call', async () => {
    expect(await m.runTagsStep({ ...opts, external: true })).toEqual({ tags: null });
    expect(tagSync).not.toHaveBeenCalled();
  });

  it('a repo no workspace releases: one page of tags, no history pass, no ticket read', async () => {
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', headSha: 'h' });
    await m.runTagsStep(opts);
    expect(tagSync).toHaveBeenCalledWith(expect.not.objectContaining({ readCap: expect.anything() }));
    expect(walk).not.toHaveBeenCalled();
    expect(tickets).not.toHaveBeenCalled();
  });

  it('a releasable repo: every tag read, ONE history pass with a deadline against the head, then the tickets', async () => {
    views.mockResolvedValue(RELEASING);
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', headSha: 'h' });
    await m.runTagsStep({ ...opts, external: true });
    expect(tagSync).toHaveBeenCalledWith(expect.objectContaining({ readCap: 1000 }));
    expect(walk).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'h', defaultBranch: 'main', deadline: expect.any(Number), views: RELEASING }));
    expect(tickets).toHaveBeenCalledWith(expect.objectContaining({ repoId: 7, accountId: 1 }));
    expect(m.takeTagCatchUp(7, Date.now() + m.CATCH_UP_DELAY_MS + 1)).toBe(false);
  });

  it("history left and the budget paused it: the settle sweep's catch-up", async () => {
    views.mockResolvedValue(RELEASING);
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', headSha: 'h' });
    walk.mockResolvedValue({ ...done, complete: false, paused: true, walked: 100, pages: 1 });
    await m.runTagsStep({ ...opts, external: true });
    expect(m.takeTagCatchUp(7, Date.now() + m.CATCH_UP_DELAY_MS + 1)).toBe(true);
  });
});

describe('scanNext — what one run leaves', () => {
  const base = { history: done, tickets: noTickets };
  it('nothing left → done', () => expect(m.scanNext(base)).toBe('done'));
  it('work left and progress → a quick re-run', () => {
    expect(m.scanNext({ ...base, history: { ...done, complete: false, walked: 300 } })).toBe('quick');
    expect(m.scanNext({ ...base, tickets: { ...noTickets, left: 9, answered: 40 } })).toBe('quick');
  });
  it("work left and no progress, or paused on the budget → the sweep's catch-up", () => {
    expect(m.scanNext({ ...base, history: { ...done, complete: false } })).toBe('catch_up');
    expect(m.scanNext({ ...base, history: { ...done, complete: false, walked: 100, paused: true } })).toBe('catch_up');
  });
});
