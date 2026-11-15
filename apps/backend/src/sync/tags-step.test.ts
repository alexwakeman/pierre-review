// THE TAGS STEP (sync/tags-step.ts; docs/RELEASES.md § Automatic candidate): the release scan for
// releasable repos only — no count caps, time-boxed runs, a quick re-run while work remains and the
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
  ANCESTRY_CHECKS_RELEASABLE: 100,
  REPO_TAGS_READ_CAP_RELEASABLE: 1000,
  syncRepoTagsSafe: (o: unknown) => tagSync(o),
  runAncestryChecks: async () => ({ checked: 0, left: 0 }),
}));
const noRanges = { computed: 0, deleted: 0, failed: 0, pending: 0, needed: 0, ready: 0, paused: false };
const ranges = vi.fn(async (_o: unknown): Promise<typeof noRanges> => noRanges);
vi.mock('./tag-ranges.js', () => ({ computeTagRanges: (o: unknown) => ranges(o) }));
const noPrs = { fetched: 0, failed: 0, left: 0, total: 0, paused: false };
const prs = vi.fn(async (_o: unknown): Promise<typeof noPrs> => noPrs);
const tickets = vi.fn(async (_o: unknown) => ({ queued: 0, waiting: 0 }));
vi.mock('./release-scan.js', () => ({ fetchMissingRangePrs: (o: unknown) => prs(o), queueRangeTickets: (o: unknown) => tickets(o) }));

const m = await import('./tags-step.js');
const opts = { owner: 'acme', name: 'web', repoId: 7, accountId: 1, token: 't' };

beforeEach(() => {
  m.__resetTagSync();
  views.mockReset();
  tagSync.mockReset();
  ranges.mockReset();
  prs.mockReset();
  tickets.mockClear();
  views.mockResolvedValue([]);
  tagSync.mockResolvedValue(null);
  ranges.mockResolvedValue(noRanges);
  prs.mockResolvedValue(noPrs);
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

describe('runTagsStep', () => {
  it('an EXTERNAL repo no workspace releases is skipped before any GitHub call', async () => {
    expect(await m.runTagsStep({ ...opts, external: true })).toEqual({ tags: null, ranges: null });
    expect(tagSync).not.toHaveBeenCalled();
  });

  it('a repo no workspace releases: tags read with NO ancestry checks', async () => {
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', ancestryLeft: 0 });
    await m.runTagsStep(opts);
    expect(tagSync).toHaveBeenCalledWith(expect.objectContaining({ ancestryCap: 0 }));
  });

  it('a repo no workspace releases gets no scan (no PR fetch, no ticket queue)', async () => {
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', ancestryLeft: 0, ancestryChecked: 0, headSha: 'h' });
    await m.runTagsStep(opts);
    expect(prs).not.toHaveBeenCalled();
    expect(tickets).not.toHaveBeenCalled();
  });

  it('a releasable repo: no ancestry cap, every tag read, ranges with a deadline, then PRs and tickets', async () => {
    views.mockResolvedValue([{ workspaceId: 3, settings: { releaseSuffix: '-rc', hotfixSuffix: '-hf' } }]);
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', ancestryLeft: 0, ancestryChecked: 0, headSha: 'h' });
    await m.runTagsStep({ ...opts, external: true });
    expect(tagSync).toHaveBeenCalledWith(expect.objectContaining({ ancestryCap: 100, readCap: 1000 }));
    expect(ranges).toHaveBeenCalledWith(expect.objectContaining({ deadline: expect.any(Number), defaultBranchName: 'main' }));
    expect(prs).toHaveBeenCalledWith(expect.objectContaining({ repoId: 7 }));
    expect(tickets).toHaveBeenCalledWith(expect.objectContaining({ repoId: 7, accountId: 1 }));
    expect(m.takeTagCatchUp(7, Date.now() + m.CATCH_UP_DELAY_MS + 1)).toBe(false);
  });

  it('ancestry still left: no ranges planned on a half-known order this run', async () => {
    views.mockResolvedValue([{ workspaceId: 3, settings: { releaseSuffix: '-rc', hotfixSuffix: '-hf' } }]);
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', ancestryLeft: 12, ancestryChecked: 30, headSha: 'h' });
    await m.runTagsStep(opts);
    const deadline = (ranges.mock.calls[0]![0] as { deadline: number }).deadline;
    expect(deadline).toBeLessThanOrEqual(Date.now());
  });

  it('work left with no progress (the budget) marks the settle sweep\'s catch-up', async () => {
    views.mockResolvedValue([{ workspaceId: 3, settings: { releaseSuffix: '-rc', hotfixSuffix: '-hf' } }]);
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', ancestryLeft: 0, ancestryChecked: 0, headSha: 'h' });
    ranges.mockResolvedValue({ ...noRanges, pending: 3, paused: true });
    await m.runTagsStep({ ...opts, external: true });
    expect(m.takeTagCatchUp(7, Date.now() + m.CATCH_UP_DELAY_MS + 1)).toBe(true);
  });
});

describe('scanNext — what one run leaves', () => {
  const base = { ancestryLeft: 0, ancestryChecked: 0, ranges: noRanges, prs: noPrs };
  it('nothing left → done', () => expect(m.scanNext(base)).toBe('done'));
  it('work left and progress → a quick re-run', () => {
    expect(m.scanNext({ ...base, ranges: { ...noRanges, pending: 5, computed: 2 } })).toBe('quick');
    expect(m.scanNext({ ...base, prs: { ...noPrs, left: 9, fetched: 3 } })).toBe('quick');
    expect(m.scanNext({ ...base, ancestryLeft: 4, ancestryChecked: 40 })).toBe('quick');
  });
  it('work left and no progress, or paused on the budget → the sweep\'s catch-up', () => {
    expect(m.scanNext({ ...base, ranges: { ...noRanges, pending: 5 } })).toBe('catch_up');
    expect(m.scanNext({ ...base, ranges: { ...noRanges, pending: 5, computed: 2, paused: true } })).toBe('catch_up');
  });
});
