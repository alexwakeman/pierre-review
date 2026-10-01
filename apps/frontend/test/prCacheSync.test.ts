// The cascading sync — `hooks/prCacheSync.ts`: the ONE set of query keys every PR write refetches,
// the sweep an out-of-band server change triggers, and the fast `['repos']` poll a write opens.
//
// WHAT THIS PINS, and why each is worth a test rather than a comment:
//
//   1. THE BOARD'S THREE READS MOVE TOGETHER. attention-cards, daily-brief and work-plan are one
//      fold read three times; a write that refetched one without the others is how a count and the
//      list under it came to disagree ("5 items" over a board of 3).
//   2. TWO KEYS ARE NEVER IN THE SET. `prRefreshKey(prId)` fires a POST that walks the PR on GitHub,
//      and `['attention-liveness', …]` is a batched GitHub sweep — a write must not spend quota.
//   3. THE WORKSPACE HALF IS `ACTIVITY_QUERY_KEYS`, not a third hand-typed list, so a sync landing
//      and a write refetch the same screens.
//   4. A WRITE READS `['repos']` FIRST, and SyncStatus absorbs a stamp by ORDER, not by time: a
//      change stamped after that read is always swept.
//   5. THE WORKSPACE HALF IS THROTTLED (the `search` rate tier); a PR's own keys never are.
//   6. A server change re-reads only what nothing else keeps fresh: the PRs this tab just wrote to,
//      and open merge controls in the changed repo that no pane poll owns.
//   7. SyncStatus's decision (`decidePrChangeSweep`): baseline first, walk dedupe, absorb.
//   8. The `Repo.lastPrChangeAt` readers never throw on a malformed listing (no error boundary).
//   9. A change in ANOTHER workspace's repos refetches none of the viewed workspace's screens (the
//      stamps are account-wide; three of those screens share the `search` rate tier).
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrDetail, Repo } from '@pierre-review/shared';
import {
  FAST_POLL_WINDOW_MS,
  WORKSPACE_SWEEP_MIN_GAP_MS,
  __resetFastPollWindow,
  __resetSweepState,
  absorbedSweep,
  advancedRepoIds,
  decidePrChangeSweep,
  fastPollWindowOpen,
  invalidateAfterPrWrite,
  invalidateAfterServerPrChange,
  noteLocalPrWrite,
  prChangeMap,
  prChangeSignature,
  prWriteKeys,
  recentlyWrittenPrIds,
  repoWorkspaceMap,
} from '../src/hooks/prCacheSync.js';
import { ACTIVITY_QUERY_KEYS, workspaceKey } from '../src/hooks/useActivity.js';
import { ARMED_MERGES_KEY } from '../src/hooks/useAutoMerge.js';
import { prMlLabelsKey } from '../src/hooks/useMlLabels.js';
import { prRefreshKey } from '../src/hooks/usePrLiveRefresh.js';

const TRIO = [['attention-cards'], ['daily-brief'], ['work-plan']];
const s = (k: unknown): string => JSON.stringify(k);
const has = (keys: readonly unknown[], k: unknown): boolean => keys.some((x) => s(x) === s(k));

const clients: QueryClient[] = [];
function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  return qc;
}

afterEach(() => {
  for (const qc of clients.splice(0)) {
    __resetSweepState(qc);
    qc.clear();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetFastPollWindow();
});

/** Record every invalidation, in order, without refetching anything. */
function recordInvalidations(qc: QueryClient, onCall?: (key: QueryKey | undefined) => void) {
  const calls: Array<QueryKey | undefined> = [];
  vi.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters) => {
    calls.push(filters?.queryKey);
    onCall?.(filters?.queryKey);
  });
  return calls;
}

describe('the one write set', () => {
  const qc = new QueryClient();

  it('carries the board trio, together, for every shape of write', () => {
    for (const keys of [
      prWriteKeys(qc, 7),
      prWriteKeys(qc, null),
      prWriteKeys(qc, [7, 8]),
      prWriteKeys(qc, 7, { merged: true, armed: true }),
    ]) {
      for (const k of TRIO) expect(has(keys, k)).toBe(true);
    }
  });

  it('never walks a PR on GitHub or spends the liveness sweep', () => {
    const keys = prWriteKeys(qc, 7, { merged: true, armed: true, threadIds: [1] });
    expect(has(keys, prRefreshKey(7))).toBe(false);
    for (const k of keys) {
      expect((k as unknown[])[0]).not.toBe('pr-refresh');
      expect((k as unknown[])[0]).not.toBe('attention-liveness');
    }
  });

  it('is built from ACTIVITY_QUERY_KEYS, plus the PR-list and triage keys, and reads repos first', () => {
    const keys = prWriteKeys(qc, null);
    for (const k of ACTIVITY_QUERY_KEYS) expect(has(keys, [k])).toBe(true);
    for (const k of [['timeline'], ['open-prs'], ['my-turn'], ['me']]) expect(has(keys, k)).toBe(true);
    expect(keys[0]).toEqual(['repos']);
  });

  it("carries the PR's own keys: detail, merge control, ML labels, and its cached threads", () => {
    const local = new QueryClient();
    local.setQueryData(['pr', 7], { id: 7, repoId: 1, threads: [{ id: 31 }, { id: 32 }] });
    const keys = prWriteKeys(local, 7);
    for (const k of [['pr', 7], ['merge-options', 7], prMlLabelsKey(7), ['pr-bot-behaviour', 7], ['thread', 31], ['thread', 32]]) {
      expect(has(keys, k)).toBe(true);
    }
    // ⚠ Never the Changes tab's diff: a live GitHub read that follows the head by itself
    // (`prFilesOutdated`), so a reply must not re-read every patch.
    expect(keys.some((k) => (k as unknown[])[0] === 'pr-files')).toBe(false);
    // No PR, no PR-scoped keys.
    expect(prWriteKeys(local, null).some((k) => (k as unknown[])[0] === 'pr')).toBe(false);
  });

  it('adds the merge extras only when asked', () => {
    const plain = prWriteKeys(qc, 7);
    expect(has(plain, ['mergers'])).toBe(false);
    expect(has(plain, [...ARMED_MERGES_KEY])).toBe(false);
    const merged = prWriteKeys(qc, 7, { merged: true });
    expect(has(merged, ['mergers'])).toBe(true);
    expect(has(merged, ['branch-status'])).toBe(true);
    expect(has(prWriteKeys(qc, 7, { armed: true }), [...ARMED_MERGES_KEY])).toBe(true);
  });

  it('names each key once, so no refetch cancels and re-sends another', () => {
    const local = new QueryClient();
    local.setQueryData(['pr', 7], { id: 7, repoId: 1, threads: [{ id: 31 }] });
    const keys = prWriteKeys(local, [7, 7], { merged: true, threadIds: [31, 31] });
    expect(new Set(keys.map(s)).size).toBe(keys.length);
  });

  it('invalidates exactly that set, repos first, and opens the fast poll', async () => {
    const local = client();
    const calls = recordInvalidations(local);
    expect(fastPollWindowOpen()).toBe(false);
    await invalidateAfterPrWrite(local, 7, { armed: true });
    expect(calls).toEqual(prWriteKeys(local, 7, { armed: true }));
    expect(fastPollWindowOpen()).toBe(true);
    expect([...recentlyWrittenPrIds()]).toEqual([7]);
  });
});

describe('the ordered read: repos first, and what it absorbs', () => {
  it('records the stamps it read BEFORE any other read starts, with the PRs it covered', async () => {
    const qc = client();
    const at = '2026-09-29T10:00:00.000Z';
    let absorbedWhenBoardRead: ReturnType<typeof absorbedSweep> = null;
    const calls = recordInvalidations(qc, (key) => {
      if (s(key) === s(['repos'])) {
        qc.setQueryData(['repos'], [{ id: 10, lastPrChangeAt: at }] as unknown as Repo[]);
      } else if (s(key) === s(['attention-cards'])) {
        absorbedWhenBoardRead = absorbedSweep(qc);
      }
    });
    await invalidateAfterPrWrite(qc, 7);
    expect(calls[0]).toEqual(['repos']);
    // The board was read after the stamps were recorded, so it shows every one of them.
    expect(absorbedWhenBoardRead).not.toBeNull();
    const absorbed = absorbedSweep(qc);
    expect([...(absorbed?.stamps ?? [])]).toEqual([[10, Date.parse(at)]]);
    expect([...(absorbed?.prIds ?? [])]).toEqual([7]);
  });

  it('a server change triggered by a repos answer does not read repos again', async () => {
    const qc = client();
    const calls = recordInvalidations(qc);
    await invalidateAfterServerPrChange(qc, { repoIds: new Set([10]) });
    expect(has(calls, ['repos'])).toBe(false);
    expect(absorbedSweep(qc)).toBeNull();
  });
});

describe('the workspace throttle', () => {
  it("sweeps at once, then folds every write inside the gap into ONE trailing sweep — but each PR's own keys go at once", async () => {
    vi.useFakeTimers();
    const qc = client();
    const calls = recordInvalidations(qc);
    const boardReads = (): number => calls.filter((k) => s(k) === s(['attention-cards'])).length;

    await invalidateAfterPrWrite(qc, 1);
    expect(boardReads()).toBe(1);

    calls.length = 0;
    const second = invalidateAfterPrWrite(qc, 2);
    const third = invalidateAfterPrWrite(qc, 3, { merged: true });
    await vi.advanceTimersByTimeAsync(0);
    // Their own PRs are refetched now…
    expect(has(calls, ['pr', 2])).toBe(true);
    expect(has(calls, ['pr', 3])).toBe(true);
    // …the board is not, yet.
    expect(boardReads()).toBe(0);

    await vi.advanceTimersByTimeAsync(WORKSPACE_SWEEP_MIN_GAP_MS);
    await Promise.all([second, third]);
    expect(boardReads()).toBe(1);
    // The trailing sweep carries the union of what the writes asked for, repos first.
    const trailing = calls.slice(calls.findIndex((k) => s(k) === s(['repos'])));
    expect(trailing[0]).toEqual(['repos']);
    expect(has(trailing, ['mergers'])).toBe(true);
    for (const k of TRIO) expect(has(trailing, k)).toBe(true);
  });

  it('a server change inside the gap joins the same trailing sweep', async () => {
    vi.useFakeTimers();
    const qc = client();
    const calls = recordInvalidations(qc);
    await invalidateAfterPrWrite(qc, 1);
    calls.length = 0;
    const p = invalidateAfterServerPrChange(qc, { repoIds: new Set([10]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(has(calls, ['attention-cards'])).toBe(false);
    await vi.advanceTimersByTimeAsync(WORKSPACE_SWEEP_MIN_GAP_MS);
    await p;
    expect(calls.filter((k) => s(k) === s(['attention-cards'])).length).toBe(1);
  });
});

describe('a server-side change', () => {
  function harness() {
    const qc = client();
    const seed = (id: number, repoId: number | null): void => {
      if (repoId != null) qc.setQueryData(['pr', id], { id, repoId, threads: [] } as unknown as PrDetail);
      qc.setQueryData(['merge-options', id], { ok: true });
    };
    const staleOf = (key: unknown[]): boolean => qc.getQueryState(key)?.isInvalidated === true;
    /** Mount an enabled observer, as an open merge control or a pane's live poll would. */
    const mount = (key: unknown[]) => {
      const fn = vi.fn(async () => ({ ok: true }));
      const obs = new QueryObserver(qc, { queryKey: key, queryFn: fn, staleTime: Infinity });
      const off = obs.subscribe(() => {});
      return { fn, off };
    };
    return { qc, seed, staleOf, mount };
  }

  it("re-reads the detail and merge control of a PR this tab just wrote to, in the changed repo only", async () => {
    const { qc, seed, staleOf } = harness();
    seed(1, 10);
    seed(2, 20);
    noteLocalPrWrite(Date.now(), [1, 2]);
    await invalidateAfterServerPrChange(qc, { repoIds: new Set([10]), workspaceSwept: true });
    expect(staleOf(['pr', 1])).toBe(true);
    expect(staleOf(['merge-options', 1])).toBe(true);
    expect(staleOf(['pr', 2])).toBe(false);
    expect(staleOf(['merge-options', 2])).toBe(false);
  });

  it('a just-written PR whose repo is not known yet is re-read (the safe direction)', async () => {
    const { qc, seed, staleOf } = harness();
    seed(3, null);
    noteLocalPrWrite(Date.now(), [3]);
    await invalidateAfterServerPrChange(qc, { repoIds: new Set([10]), workspaceSwept: true });
    expect(staleOf(['merge-options', 3])).toBe(true);
  });

  it('skips the PRs an ordered write sweep already read after these stamps', async () => {
    const { qc, seed, staleOf } = harness();
    seed(1, 10);
    noteLocalPrWrite(Date.now(), [1]);
    await invalidateAfterServerPrChange(qc, {
      repoIds: new Set([10]),
      workspaceSwept: true,
      skipPrIds: new Set([1]),
    });
    expect(staleOf(['pr', 1])).toBe(false);
  });

  it('leaves every other cached PR detail alone (a Feed full of them must not each hit GitHub)', async () => {
    const { qc, seed, staleOf } = harness();
    seed(4, 10);
    await invalidateAfterServerPrChange(qc, { repoIds: new Set([10]), workspaceSwept: true });
    expect(staleOf(['pr', 4])).toBe(false);
  });

  it('re-reads an OPEN merge control in the changed repo, unless its pane polls it or its repo is unknown', async () => {
    const { qc, seed, mount } = harness();
    seed(5, 10); // open control, no pane poll → re-read
    seed(6, 10); // open control, pane polling → its own poll owns it
    seed(7, null); // open control, repo unknown → left alone
    seed(8, 20); // open control, another repo → left alone
    const c5 = mount(['merge-options', 5]);
    const c6 = mount(['merge-options', 6]);
    const c7 = mount(['merge-options', 7]);
    const c8 = mount(['merge-options', 8]);
    const poll6 = mount(prRefreshKey(6));
    await invalidateAfterServerPrChange(qc, { repoIds: new Set([10]), workspaceSwept: true });
    expect(c5.fn).toHaveBeenCalledTimes(1);
    expect(c6.fn).not.toHaveBeenCalled();
    expect(c7.fn).not.toHaveBeenCalled();
    expect(c8.fn).not.toHaveBeenCalled();
    for (const c of [c5, c6, c7, c8, poll6]) c.off();
  });

  it('sweeps the workspace set with the trio, unless it is already swept', async () => {
    const qc = client();
    const calls = recordInvalidations(qc);
    await invalidateAfterServerPrChange(qc);
    for (const k of TRIO) expect(has(calls, k)).toBe(true);
    expect(calls.some((k) => (k as unknown[] | undefined)?.[0] === 'attention-liveness')).toBe(false);
    expect(calls.some((k) => (k as unknown[] | undefined)?.[0] === 'pr-refresh')).toBe(false);
    calls.length = 0;
    await invalidateAfterServerPrChange(qc, { workspaceSwept: true });
    expect(calls).toEqual([['merge-options']]);
  });

  it("⚠ a change only in OTHER workspaces' repos refetches none of the viewed workspace's screens", async () => {
    const { qc, mount } = harness();
    // Cached first, so mounting is not itself a fetch: every call counted below is a refetch.
    const onScreen = (key: unknown[]) => {
      qc.setQueryData(key, { ok: true });
      return mount(key);
    };
    // The viewed workspace (1): its board, open and observed.
    const board = onScreen(['attention-cards', workspaceKey(1), 'x']);
    const brief = onScreen(['daily-brief', workspaceKey(1)]);
    const boardTimeline = onScreen(['timeline', workspaceKey(1), 'workspace=1&from=a']);
    // Workspace 2's board, cached from an earlier visit and not on screen.
    qc.setQueryData(['attention-cards', workspaceKey(2), 'x'], { cards: [] });
    // The two reads that name no workspace, on screen.
    const myTurn = onScreen(['my-turn']);
    const focus = onScreen(['timeline', 'prIds=42']);
    await invalidateAfterServerPrChange(qc, {
      repoIds: new Set([20]),
      workspaceSwept: false,
      otherWorkspaceIds: new Set([2]),
    });
    expect(board.fn).not.toHaveBeenCalled();
    expect(brief.fn).not.toHaveBeenCalled();
    expect(boardTimeline.fn).not.toHaveBeenCalled();
    expect(qc.getQueryState(['attention-cards', workspaceKey(1), 'x'])?.isInvalidated).toBe(false);
    // Marked stale for when the reader switches to it — and nothing fetched now.
    expect(qc.getQueryState(['attention-cards', workspaceKey(2), 'x'])?.isInvalidated).toBe(true);
    expect(myTurn.fn).toHaveBeenCalledTimes(1);
    expect(focus.fn).toHaveBeenCalledTimes(1);
    for (const c of [board, brief, boardTimeline, myTurn, focus]) c.off();
  });

  it('…and a change that touches the viewed workspace still sweeps it', async () => {
    const qc = client();
    const calls = recordInvalidations(qc);
    await invalidateAfterServerPrChange(qc, { repoIds: new Set([10]), workspaceSwept: false });
    for (const k of TRIO) expect(has(calls, k)).toBe(true);
  });

  it('never opens the fast poll (a server change must not keep itself polled)', async () => {
    const qc = client();
    recordInvalidations(qc);
    await invalidateAfterServerPrChange(qc);
    expect(fastPollWindowOpen()).toBe(false);
  });
});

describe("SyncStatus's decision", () => {
  const m = (entries: Array<[number, number]>): Map<number, number> => new Map(entries);

  it('the first observation only records', () => {
    expect(decidePrChangeSweep({ prev: null, next: m([[1, 100]]), walkSwept: false, absorbed: null })).toBeNull();
  });

  it('nothing moved, nothing to do', () => {
    const same = m([[1, 100]]);
    expect(decidePrChangeSweep({ prev: same, next: m([[1, 100]]), walkSwept: false, absorbed: null })).toBeNull();
  });

  it('a moved repo sweeps everything; a walk in the same commit already swept the workspace half', () => {
    const prev = m([[1, 100]]);
    const next = m([[1, 200]]);
    expect(decidePrChangeSweep({ prev, next, walkSwept: false, absorbed: null })).toEqual({
      repoIds: new Set([1]),
      workspaceSwept: false,
    });
    expect(decidePrChangeSweep({ prev, next, walkSwept: true, absorbed: null })?.workspaceSwept).toBe(true);
  });

  it("absorbs a move no later than a write's ordered read, and skips the PRs that read covered", () => {
    const absorbed = { stamps: m([[1, 200], [2, 300]]), prIds: new Set([7]) };
    const out = decidePrChangeSweep({
      prev: m([[1, 100], [2, 100]]),
      next: m([[1, 200], [2, 300]]),
      walkSwept: false,
      absorbed,
    });
    expect(out).toEqual({ repoIds: new Set([1, 2]), workspaceSwept: true, skipPrIds: new Set([7]) });
  });

  it('a stamp LATER than the ordered read is always swept (the old time window dropped it)', () => {
    const absorbed = { stamps: m([[1, 200]]), prIds: new Set([7]) };
    const out = decidePrChangeSweep({
      prev: m([[1, 100]]),
      next: m([[1, 250]]),
      walkSwept: false,
      absorbed,
    });
    expect(out).toEqual({ repoIds: new Set([1]), workspaceSwept: false });
  });

  it('names the other workspaces when EVERY moved repo sits outside the viewed one', () => {
    const repoWorkspaces = m([[10, 1], [20, 2], [30, 3]]);
    const base = { prev: m([[10, 100], [20, 100], [30, 100]]), walkSwept: false, absorbed: null };
    // Two other workspaces' repos moved: the viewed workspace (1) is not swept.
    expect(
      decidePrChangeSweep({
        ...base,
        next: m([[10, 100], [20, 200], [30, 200]]),
        repoWorkspaces,
        currentWorkspaceId: 1,
      }),
    ).toEqual({ repoIds: new Set([20, 30]), workspaceSwept: false, otherWorkspaceIds: new Set([2, 3]) });
    // One of the moved repos is in the viewed workspace: the full sweep.
    expect(
      decidePrChangeSweep({
        ...base,
        next: m([[10, 200], [20, 200], [30, 100]]),
        repoWorkspaces,
        currentWorkspaceId: 1,
      })?.otherWorkspaceIds,
    ).toBeUndefined();
    // A repo the listing cannot place, or no workspace resolved yet: the full sweep (safe side).
    expect(
      decidePrChangeSweep({
        ...base,
        prev: m([[40, 100]]),
        next: m([[40, 200]]),
        repoWorkspaces,
        currentWorkspaceId: 1,
      })?.otherWorkspaceIds,
    ).toBeUndefined();
    expect(
      decidePrChangeSweep({
        ...base,
        next: m([[10, 100], [20, 200], [30, 100]]),
        repoWorkspaces,
        currentWorkspaceId: null,
      })?.otherWorkspaceIds,
    ).toBeUndefined();
  });

  it('one repo beyond the read un-absorbs the whole move (a duplicate, never a loss)', () => {
    const absorbed = { stamps: m([[1, 200]]), prIds: new Set([7]) };
    const out = decidePrChangeSweep({
      prev: m([[1, 100], [2, 100]]),
      next: m([[1, 200], [2, 150]]),
      walkSwept: false,
      absorbed,
    });
    expect(out?.workspaceSwept).toBe(false);
    expect(out?.skipPrIds).toBeUndefined();
  });
});

describe('the fast poll window', () => {
  it('opens for FAST_POLL_WINDOW_MS after a local write, and a later write extends it', () => {
    noteLocalPrWrite(1_000);
    expect(fastPollWindowOpen(1_000 + FAST_POLL_WINDOW_MS - 1)).toBe(true);
    expect(fastPollWindowOpen(1_000 + FAST_POLL_WINDOW_MS)).toBe(false);
    noteLocalPrWrite(60_000);
    expect(fastPollWindowOpen(1_000 + FAST_POLL_WINDOW_MS + 1)).toBe(true);
  });

  it('a written PR counts as recent for the same window, and then drops out', () => {
    noteLocalPrWrite(1_000, [7]);
    expect(recentlyWrittenPrIds(1_000 + FAST_POLL_WINDOW_MS - 1).has(7)).toBe(true);
    expect(recentlyWrittenPrIds(1_000 + FAST_POLL_WINDOW_MS).has(7)).toBe(false);
  });
});

describe('reading Repo.lastPrChangeAt', () => {
  const repo = (id: number, lastPrChangeAt?: unknown): Repo =>
    ({ id, lastPrChangeAt }) as unknown as Repo;

  it('never throws on a malformed listing', () => {
    expect(prChangeMap(undefined).size).toBe(0);
    expect(prChangeMap(null).size).toBe(0);
    expect(prChangeMap({} as unknown as Repo[]).size).toBe(0);
    expect(prChangeMap([null, undefined, repo(1, 42), repo(2, 'not a date')] as unknown as Repo[]).size).toBe(0);
  });

  it('repoWorkspaceMap never throws either, and skips a row without both ids', () => {
    expect(repoWorkspaceMap(undefined).size).toBe(0);
    expect(repoWorkspaceMap({} as unknown as Repo[]).size).toBe(0);
    const rows = [null, { id: 1 }, { id: 2, workspaceId: 'x' }, { id: 3, workspaceId: 5 }];
    expect([...repoWorkspaceMap(rows as unknown as Repo[])]).toEqual([[3, 5]]);
  });

  it('maps each stamped repo to epoch ms, and absent is absent', () => {
    const map = prChangeMap([repo(1, '2026-09-29T10:00:00.000Z'), repo(2)]);
    expect([...map]).toEqual([[1, Date.parse('2026-09-29T10:00:00.000Z')]]);
    expect(prChangeSignature(map)).toBe(`1:${Date.parse('2026-09-29T10:00:00.000Z')}`);
  });

  it('a repo moved when its stamp went forward or appeared, never backwards', () => {
    const prev = new Map([
      [1, 100],
      [2, 100],
      [3, 100],
    ]);
    const next = new Map([
      [1, 100], // unchanged
      [2, 150], // forward
      [3, 50], // backwards (a clock step): not a change
      [4, 10], // appeared
    ]);
    expect([...advancedRepoIds(prev, next)].sort()).toEqual([2, 4]);
  });
});
