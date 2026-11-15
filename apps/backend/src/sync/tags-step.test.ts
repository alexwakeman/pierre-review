// THE TAGS STEP (sync/tags-step.ts; docs/RELEASES.md § Releasable repos and start tag): releasable repos
// first — the catch-up the settle sweep takes, and an EXTERNAL repo that no workspace releases skipped
// before any GitHub call. The DB module opens at import, so DATABASE_URL is set first.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-tags-step-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const views = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('../db/release-repos.js', () => ({ releaseRangeViews: () => views() }));
const tagSync = vi.fn(async (_o: unknown): Promise<unknown> => null);
vi.mock('./repo-tags.js', () => ({ ANCESTRY_CHECKS_RELEASABLE: 100, syncRepoTagsSafe: (o: unknown) => tagSync(o) }));
const ranges = vi.fn(async (_o: unknown) => ({ computed: 0, deleted: 0, failed: 0, pending: 0 }));
vi.mock('./tag-ranges.js', () => ({ computeTagRanges: (o: unknown) => ranges(o) }));

const m = await import('./tags-step.js');
const opts = { owner: 'acme', name: 'web', repoId: 7, accountId: 1, token: 't' };

beforeEach(() => {
  m.__resetTagSync();
  views.mockReset();
  tagSync.mockReset();
  ranges.mockReset();
  views.mockResolvedValue([]);
  tagSync.mockResolvedValue(null);
  ranges.mockResolvedValue({ computed: 0, deleted: 0, failed: 0, pending: 0 });
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

  it('a releasable repo: raised ancestry cap, and work left marks a catch-up', async () => {
    views.mockResolvedValue([{ settings: { releaseSuffix: '-rc', hotfixSuffix: '-hf' }, startTag: null }]);
    tagSync.mockResolvedValue({ read: true, defaultBranchName: 'main', ancestryLeft: 0 });
    ranges.mockResolvedValue({ computed: 40, deleted: 0, failed: 0, pending: 3 });
    await m.runTagsStep({ ...opts, external: true });
    expect(tagSync).toHaveBeenCalledWith(expect.objectContaining({ ancestryCap: 100 }));
    expect(m.takeTagCatchUp(7, Date.now() + m.CATCH_UP_DELAY_MS + 1)).toBe(true);
  });
});
