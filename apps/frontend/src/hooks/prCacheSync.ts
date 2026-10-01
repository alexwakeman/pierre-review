import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type { PrDetail, Repo } from '@pierre-review/shared';
import { ACTIVITY_QUERY_KEYS, workspaceKey } from './useActivity.js';
import { ARMED_MERGES_KEY } from './queryKeys.js';
import { prMlLabelsKey } from './useMlLabels.js';
import { prRefreshKey } from './usePrLiveRefresh.js';

// ── THE CASCADING SYNC: ONE SET OF KEYS FOR "A PULL REQUEST CHANGED" ─────────────────────────
//
// Every write that changes a pull request (a reply, a resolve, an approve, a merge, a push from the
// conflict resolver or AI Fix, a CI re-run, arming auto-merge…) used to pick its own list of query
// keys to refetch. There were thirteen lists and no two agreed, so a write could land on GitHub
// and leave a screen showing the old state. The resolver was the worst case: it pushed, and the
// Pending card went on saying "conflicts" until something unrelated refetched the board.
//
// Now there is ONE set, built here, and every write goes through `invalidateAfterPrWrite`.
//
// ⚠ THE WORKSPACE HALF IS `ACTIVITY_QUERY_KEYS`, NOT A THIRD HAND-TYPED LIST. SyncStatus sweeps
// that list when a walk lands; a write sweeping a different list is how the two drift apart.
//
// ⚠ `['attention-cards']`, `['daily-brief']` AND `['work-plan']` ALWAYS MOVE TOGETHER. They are
// one fold read three times (the board, its counts, the ranked plan). Invalidate, never splice:
// a local edit kills `capFor`'s `shown === count` guard and the "50 of 148" line with it. They
// arrive together through `ACTIVITY_QUERY_KEYS`, and the test pins that.
//
// ⚠ TWO KEYS ARE NEVER IN THIS SET:
//   - `prRefreshKey(prId)` (`['pr-refresh', id]`): invalidating it fires a POST that WALKS the PR
//     on GitHub. The open pane's own ~5s poll owns that.
//   - `['attention-liveness', …]`: the board's batched GitHub sweep. It spends GitHub quota.
// Only ACTIVE queries refetch — an unmounted screen is merely marked stale and costs nothing until
// it is opened. Two members can reach GitHub, both bounded: `['pr', id]` hydrates its lean fields
// on demand (cached server-side), and `['merge-options', id]` is the merge control's live read,
// enabled only while that control is open.
//
// ⚠ THE WORKSPACE HALF IS THROTTLED: AT MOST ONE SWEEP PER `WORKSPACE_SWEEP_MIN_GAP_MS`. Three of
// its reads (`/api/attention`, `/api/daily-brief`, `/api/pro/work-plan`) share the 60/min `search`
// rate tier, and a run of replies or resolves used to cost three of them per click. The first
// write sweeps at once; writes inside the gap refetch their OWN PR at once and share ONE trailing
// sweep at the end of it. The PR's own keys are never throttled.
//
// ⚠ THE SERVER KEEPS WORKING AFTER THE WRITE ANSWERS. GitHub attaches a push and recomputes
// mergeability and CI a few seconds later, and the server re-reads the PR on a short settle
// ladder. Each time a board-visible column moves it stamps `Repo.lastPrChangeAt`.
// `noteLocalPrWrite` makes SyncStatus poll `['repos']` every 5s for 150s after a write, and
// SyncStatus calls `invalidateAfterServerPrChange` when a stamp moves. That is what clears the
// conflicts card once GitHub has finished, with nothing fetched per card.

/** Extra keys a write can move. */
export interface PrWriteOpts {
  /** The PR merged: merge rights (the maintainer shield) and the trunk strip move too. */
  merged?: boolean;
  /** The write armed, disarmed or disturbed a "merge when ready" intent. */
  armed?: boolean;
  /** Threads the write touched, for when the PR's detail is not cached (so its thread list is
   *  unknown). Merged into the same de-duplicated set: invalidating one key twice cancels the
   *  first refetch and sends the request again. */
  threadIds?: readonly number[];
}

/** The poll window a local write opens. Long enough to cover the server's settle ladder
 *  (~5s, 15s, 45s, 120s), short enough that an idle tab goes back to its 30s cadence. */
export const FAST_POLL_WINDOW_MS = 150_000;
/** `['repos']` cadence inside that window. */
export const FAST_POLL_INTERVAL_MS = 5_000;
/** The shortest gap between two sweeps of the workspace keys. One per fast-poll tick at most:
 *  twelve a minute is 36 of the `search` tier's 60, which leaves room for everything else on it. */
export const WORKSPACE_SWEEP_MIN_GAP_MS = 5_000;

/** Workspace-level keys: the Activity console list plus the four that live outside it. */
function workspaceKeys(): QueryKey[] {
  return [
    ...ACTIVITY_QUERY_KEYS.map((k) => [k]),
    ['timeline'],
    ['open-prs'],
    ['my-turn'],
    ['me'],
  ];
}

/** One PR's own keys: its detail, the threads the cached detail lists, the merge control's live
 *  read (which `['pr', id]` does not cover), its ML-label index and its Bot activity tab
 *  (`['pr-bot-behaviour', id]`, `usePrBotBehaviour`: its per-bot "acted on" count moves on a resolve
 *  or a reply; DB-only, and refetched only while the tab is open).
 *
 *  ⚠ NOT `['pr-files', id]`: the Changes tab's diff is a live GitHub read that follows the PR's
 *  head on its own (`usePrFiles` / `prFilesOutdated`), so a reply does not re-read every patch. */
function prScopedKeys(qc: QueryClient, prId: number): QueryKey[] {
  const keys: QueryKey[] = [['pr', prId]];
  const cached = qc.getQueryData<PrDetail>(['pr', prId]);
  const threads = Array.isArray(cached?.threads) ? cached.threads : [];
  for (const t of threads) {
    if (typeof t?.id === 'number') keys.push(['thread', t.id]);
  }
  keys.push(['merge-options', prId], prMlLabelsKey(prId), ['pr-bot-behaviour', prId]);
  return keys;
}

function idsOf(prId: number | readonly number[] | null): number[] {
  if (prId == null) return [];
  return typeof prId === 'number' ? [prId] : [...prId];
}

/** The PR-scoped half of a write: each PR's own keys plus any named threads. */
function writePrKeys(qc: QueryClient, ids: readonly number[], opts: PrWriteOpts): QueryKey[] {
  const keys: QueryKey[] = [];
  for (const id of ids) keys.push(...prScopedKeys(qc, id));
  for (const t of opts.threadIds ?? []) keys.push(['thread', t]);
  return keys;
}

/** What a write adds to the workspace half. */
function writeExtras(opts: PrWriteOpts): QueryKey[] {
  const keys: QueryKey[] = [];
  if (opts.merged) keys.push(['mergers'], ['branch-status']);
  if (opts.armed) keys.push([...ARMED_MERGES_KEY]);
  return keys;
}

/**
 * THE key set for a write, in the order an unthrottled sweep reads it. Exported for the test;
 * callers use `invalidateAfterPrWrite`.
 *
 * `['repos']` comes FIRST, and the rest are read only after it answers — see `AbsorbedSweep`.
 *
 * `prId` is null for a write with no one PR (a workspace-wide bot-thread resolve), or a list when
 * one write touched several — the workspace half is then swept ONCE, not once per PR, because
 * each extra sweep cancels the refetch before it and sends the request again.
 */
export function prWriteKeys(
  qc: QueryClient,
  prId: number | readonly number[] | null,
  opts: PrWriteOpts = {},
): QueryKey[] {
  return dedupeKeys([
    ['repos'],
    ...writePrKeys(qc, idsOf(prId), opts),
    ...workspaceKeys(),
    ...writeExtras(opts),
  ]);
}

function dedupeKeys(keys: readonly QueryKey[]): QueryKey[] {
  const seen = new Set<string>();
  const out: QueryKey[] = [];
  for (const k of keys) {
    const s = JSON.stringify(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

function invalidateAll(qc: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  return Promise.all(dedupeKeys(keys).map((queryKey) => qc.invalidateQueries({ queryKey }))).then(
    () => undefined,
  );
}

/**
 * Refetch everything a write to `prId` can have moved, and open the fast `['repos']` poll so the
 * server's follow-up re-reads reach the screen within seconds.
 *
 * Call it from a mutation's HOOK-LEVEL `onSuccess` (never a `mutate()` callback, which is lost
 * when the card remounts mid-request), with `void` unless the caller means to hold `isPending`
 * open across every refetch — including, inside the throttle gap, the trailing workspace sweep.
 */
export function invalidateAfterPrWrite(
  qc: QueryClient,
  prId: number | readonly number[] | null,
  opts: PrWriteOpts = {},
): Promise<void> {
  const ids = idsOf(prId);
  noteLocalPrWrite(Date.now(), ids);
  return requestSweep(qc, {
    prKeys: writePrKeys(qc, ids, opts),
    prIds: ids,
    extras: writeExtras(opts),
    readRepos: true,
  });
}

// ── The workspace sweep: ordered, then throttled ─────────────────────────────────────────────

/**
 * The stamps a write's own sweep has already covered.
 *
 * ⚠ AN ORDER, NOT A TIME WINDOW. The sweep reads `['repos']` first and starts every other read only
 * after it answers, so each `lastPrChangeAt` in that answer was stamped BEFORE the board was read,
 * and the board already shows it. SyncStatus then skips the workspace half for a move no later than
 * these stamps, and the PR-scoped half for `prIds` (read after the same answer). A change stamped
 * after that answer is later than these stamps and is swept as usual. The old 3-second window
 * dropped any change that landed between the write's board read and its `['repos']` read.
 *
 * If SyncStatus happens to see the answer before this is recorded, it sweeps again: a duplicate,
 * never a lost change.
 */
export interface AbsorbedSweep {
  stamps: ReadonlyMap<number, number>;
  prIds: ReadonlySet<number>;
}

interface PendingSweep {
  extras: QueryKey[];
  readRepos: boolean;
  done: Promise<void>;
  resolve: () => void;
}

interface SweepState {
  lastStartAt: number;
  running: Promise<void> | null;
  pending: PendingSweep | null;
  timer: ReturnType<typeof setTimeout> | null;
  absorbed: AbsorbedSweep | null;
}

// Per QueryClient: the app has one, and each test builds its own.
const sweepStates = new WeakMap<QueryClient, SweepState>();

function sweepState(qc: QueryClient): SweepState {
  let st = sweepStates.get(qc);
  if (st == null) {
    st = { lastStartAt: 0, running: null, pending: null, timer: null, absorbed: null };
    sweepStates.set(qc, st);
  }
  return st;
}

/** What the most recent ordered sweep covered, for SyncStatus. */
export function absorbedSweep(qc: QueryClient): AbsorbedSweep | null {
  return sweepStates.get(qc)?.absorbed ?? null;
}

interface SweepRequest {
  /** This request's PR-scoped keys. Never throttled. */
  prKeys: QueryKey[];
  /** The PRs those keys belong to (recorded as covered when the sweep is ordered). */
  prIds: number[];
  /** Extra workspace-level keys (merged / armed). */
  extras: QueryKey[];
  /** Read `['repos']` first and record what it covered. A local write does; a server change
   *  was itself triggered by a `['repos']` answer, so it does not. */
  readRepos: boolean;
}

function requestSweep(qc: QueryClient, req: SweepRequest): Promise<void> {
  const st = sweepState(qc);
  if (
    st.running == null &&
    st.pending == null &&
    Date.now() - st.lastStartAt >= WORKSPACE_SWEEP_MIN_GAP_MS
  ) {
    return startSweep(qc, st, req);
  }
  // Inside the gap. The PR's own keys go now; the workspace half joins the one trailing sweep.
  const own = invalidateAll(qc, req.prKeys);
  let pending = st.pending;
  if (pending == null) {
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    pending = { extras: [], readRepos: false, done, resolve };
    st.pending = pending;
  }
  pending.extras.push(...req.extras);
  pending.readRepos = pending.readRepos || req.readRepos;
  scheduleTrailing(qc, st);
  return Promise.all([own, pending.done]).then(() => undefined);
}

function scheduleTrailing(qc: QueryClient, st: SweepState): void {
  if (st.timer != null) return;
  const wait = Math.max(0, st.lastStartAt + WORKSPACE_SWEEP_MIN_GAP_MS - Date.now());
  st.timer = setTimeout(() => {
    st.timer = null;
    const fire = (): void => {
      const p = st.pending;
      if (p == null) return;
      st.pending = null;
      void startSweep(qc, st, {
        prKeys: [],
        prIds: [],
        extras: p.extras,
        readRepos: p.readRepos,
      }).then(p.resolve);
    };
    // One sweep at a time: a slow one finishes before the next starts.
    if (st.running != null) void st.running.then(fire);
    else fire();
  }, wait);
}

function startSweep(qc: QueryClient, st: SweepState, req: SweepRequest): Promise<void> {
  st.lastStartAt = Date.now();
  const run = (async () => {
    if (req.readRepos) {
      await qc.invalidateQueries({ queryKey: ['repos'] });
      st.absorbed = {
        stamps: prChangeMap(qc.getQueryData<Repo[]>(['repos'])),
        prIds: new Set(req.prIds),
      };
    }
    await invalidateAll(qc, [...req.prKeys, ...workspaceKeys(), ...req.extras]);
  })().catch(() => undefined);
  st.running = run;
  void run.then(() => {
    if (st.running === run) st.running = null;
  });
  return run;
}

/** Test-only: forget a client's throttle and what it absorbed. */
export function __resetSweepState(qc: QueryClient): void {
  const st = sweepStates.get(qc);
  if (st?.timer != null) clearTimeout(st.timer);
  st?.pending?.resolve();
  sweepStates.delete(qc);
}

// ── A server-side change ─────────────────────────────────────────────────────────────────────

/** Where an out-of-band server change should reach. */
export interface ServerPrChangeOpts {
  /** Repos whose `lastPrChangeAt` moved. Absent = every repo. */
  repoIds?: ReadonlySet<number>;
  /** The workspace keys already reflect this change: a walk landed in the same commit (SyncStatus
   *  swept them) or a local write's ordered sweep read them after these stamps. */
  workspaceSwept?: boolean;
  /** PRs whose own keys that same ordered sweep already read after these stamps. */
  skipPrIds?: ReadonlySet<number>;
  /**
   * Every moved repo sits in one of THESE workspaces, and none is the one on screen. The workspace
   * half then fetches nothing: those workspaces' screens are only marked stale for when they are
   * opened, and only the two account-wide reads refetch (`sweepOutsideWorkspace`). Absent = at
   * least one moved repo is in the viewed workspace, or cannot be placed, and the full half runs.
   */
  otherWorkspaceIds?: ReadonlySet<number>;
}

/** Is this PR's pane polling it right now (`usePrLiveRefresh`, enabled)? */
function hasLivePoll(qc: QueryClient, prId: number): boolean {
  const q = qc.getQueryCache().find({ queryKey: prRefreshKey(prId), exact: true });
  return q?.isActive() === true;
}

/**
 * Refetch after the SERVER changed a PR outside the SPA's own writes (a webhook sync, a settle
 * re-read, the backstop, the liveness sweep). The workspace half is the write set's, through the
 * same throttle. The PR-scoped half is deliberately narrow, because `['pr', id]` can hydrate from
 * GitHub and `['merge-options', id]` IS a GitHub read (~3 calls), and a repo's stamp moves on any
 * of its PRs:
 *
 *   - A PR this tab wrote to inside the fast-poll window: its detail and merge control, active or
 *     not, in a moved repo or a repo not known yet. This is the settle ladder the window exists for
 *     (after a push or a branch update GitHub recomputes mergeability, and `updatedAt` does not
 *     move, so nothing else would re-read it).
 *   - Any other OPEN merge control in a moved repo, when nothing polls its PR. A repo we cannot
 *     place (its detail is not cached) is left alone: re-reading it on every repo's change is the
 *     cost, and its own click re-reads it.
 *   - Nothing else. A PR whose pane is open is polled by `usePrLiveRefresh`, which re-reads its
 *     detail and merge control on its own `changed` (the 30s floor at worst); a detail cached
 *     behind the Feed, Search or a theme fold does not render merge state, and re-reading dozens of
 *     them on every change in their repo would be a GitHub call each.
 *
 * ⚠ Never `noteLocalPrWrite` here. A server change that re-armed the fast poll would keep the
 * 5s cadence alive for as long as the server kept changing things.
 */
export function invalidateAfterServerPrChange(
  qc: QueryClient,
  opts: ServerPrChangeOpts = {},
): Promise<void> {
  const { repoIds, skipPrIds } = opts;
  const repoOf = (prId: number): number | null => {
    const r = qc.getQueryData<PrDetail>(['pr', prId])?.repoId;
    return typeof r === 'number' ? r : null;
  };
  const jobs: Promise<unknown>[] = [];

  const recent = recentlyWrittenPrIds();
  for (const id of recent) {
    if (skipPrIds?.has(id)) continue;
    const repoId = repoOf(id);
    if (repoIds != null && repoId != null && !repoIds.has(repoId)) continue;
    jobs.push(
      qc.invalidateQueries({ queryKey: ['pr', id] }),
      qc.invalidateQueries({ queryKey: ['merge-options', id] }),
    );
  }

  jobs.push(
    qc.invalidateQueries({
      queryKey: ['merge-options'],
      type: 'active',
      predicate: (q: Query) => {
        const id = q.queryKey[1];
        if (typeof id !== 'number' || recent.has(id) || skipPrIds?.has(id)) return false;
        const repoId = repoOf(id);
        if (repoId == null || (repoIds != null && !repoIds.has(repoId))) return false;
        return !hasLivePoll(qc, id);
      },
    }),
  );

  if (!opts.workspaceSwept) {
    jobs.push(
      opts.otherWorkspaceIds != null
        ? sweepOutsideWorkspace(qc, opts.otherWorkspaceIds)
        : requestSweep(qc, { prKeys: [], prIds: [], extras: [], readRepos: false }),
    );
  }
  return Promise.all(jobs).then(() => undefined);
}

/**
 * A change in repos that all belong to OTHER workspaces than the one on screen.
 *
 * ⚠ THE WORKSPACE HALF IS NOT FOR THEM. It refetches the viewed workspace's screens (three of them
 * on the 60/min `search` tier), and a stamp in another workspace's repo cannot have moved any of
 * them. `lastPrChangeAt` is account-wide, so sweeping on it spent the viewed board's budget on
 * every other workspace's activity. Instead:
 *   - those workspaces' cached screens are MARKED stale and fetch nothing (`refetchType: 'none'`),
 *     so they refetch when the reader switches to one;
 *   - the two reads that name no workspace refetch if on screen: `['my-turn']` (the notification
 *     watcher's unscoped GET /api/my-turn) and a PR Focus tab's timeline (`prIds=…`, which may be a
 *     PR from any workspace). Both are DB-only.
 */
function sweepOutsideWorkspace(
  qc: QueryClient,
  workspaceIds: ReadonlySet<number>,
): Promise<void> {
  const segments = new Set([...workspaceIds].map((w) => workspaceKey(w)));
  return Promise.all([
    qc.invalidateQueries({
      predicate: (q: Query) => q.queryKey.some((k) => typeof k === 'string' && segments.has(k)),
      refetchType: 'none',
    }),
    qc.invalidateQueries({ queryKey: ['my-turn'] }),
    qc.invalidateQueries({
      queryKey: ['timeline'],
      predicate: (q: Query) =>
        typeof q.queryKey[1] === 'string' && q.queryKey[1].startsWith('prIds='),
    }),
  ]).then(() => undefined);
}

/**
 * SyncStatus's decision, pure so it can be tested: given the stamps it saw last time and the ones
 * it sees now, what (if anything) to refetch.
 *
 * - The FIRST observation after mount (`prev == null`) only records: it is the baseline, not news.
 * - A repo moved when its stamp went forward or appeared (`advancedRepoIds`).
 * - `walkSwept`: a sync timestamp moved in the same commit, and SyncStatus's walk effect has
 *   already swept the workspace keys.
 * - Every moved stamp no later than what a local write's ordered sweep read (`absorbed`): that
 *   sweep read the workspace keys, and those PRs' own keys, after it. Everything else still runs.
 * - Every moved repo in ANOTHER workspace than the viewed one (`repoWorkspaces` from the same
 *   listing, `currentWorkspaceId` from the store): `otherWorkspaceIds`, so the viewed workspace's
 *   screens are not refetched for it. A repo the listing cannot place, or no workspace resolved
 *   yet, keeps the full sweep.
 */
export function decidePrChangeSweep(input: {
  prev: ReadonlyMap<number, number> | null;
  next: ReadonlyMap<number, number>;
  walkSwept: boolean;
  absorbed: AbsorbedSweep | null;
  repoWorkspaces?: ReadonlyMap<number, number> | null;
  currentWorkspaceId?: number | null;
}): ServerPrChangeOpts | null {
  if (input.prev == null) return null;
  const moved = advancedRepoIds(input.prev, input.next);
  if (moved.size === 0) return null;
  const { absorbed } = input;
  const covered =
    absorbed != null &&
    [...moved].every((id) => {
      const seen = absorbed.stamps.get(id);
      const now = input.next.get(id);
      return seen != null && now != null && now <= seen;
    });
  const others = otherWorkspacesOf(moved, input.repoWorkspaces ?? null, input.currentWorkspaceId ?? null);
  return {
    repoIds: moved,
    workspaceSwept: input.walkSwept || covered,
    ...(covered ? { skipPrIds: absorbed.prIds } : {}),
    ...(others != null ? { otherWorkspaceIds: others } : {}),
  };
}

/** The workspaces the moved repos sit in, when NONE is the viewed one; null when any moved repo is
 *  in the viewed workspace or cannot be placed, or no workspace is resolved yet. */
function otherWorkspacesOf(
  moved: ReadonlySet<number>,
  repoWorkspaces: ReadonlyMap<number, number> | null,
  currentWorkspaceId: number | null,
): Set<number> | null {
  if (currentWorkspaceId == null || repoWorkspaces == null) return null;
  const out = new Set<number>();
  for (const id of moved) {
    const w = repoWorkspaces.get(id);
    if (w == null || w === currentWorkspaceId) return null;
    out.add(w);
  }
  return out;
}

/** repoId → its workspace, from the `['repos']` listing. Guarded like `prChangeMap`: it runs off a
 *  poll inside SyncStatus, and the SPA has no error boundary. */
export function repoWorkspaceMap(repos: readonly Repo[] | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(repos)) return out;
  for (const r of repos) {
    const id = (r as Partial<Repo> | null | undefined)?.id;
    const ws = (r as Partial<Repo> | null | undefined)?.workspaceId;
    if (typeof id === 'number' && typeof ws === 'number') out.set(id, ws);
  }
  return out;
}

// ── The fast-poll window ─────────────────────────────────────────────────────────────────────
//
// Module state, read by SyncStatus through `useSyncExternalStore`. Nothing persists it: a reload
// after a write simply polls at the normal cadence.

let fastPollUntil = 0;
/** prId → when this tab's write to it stops counting as recent (the window's end). */
const recentWrites = new Map<number, number>();
const fastPollListeners = new Set<() => void>();

/** A local write just landed: poll `['repos']` fast for the next `FAST_POLL_WINDOW_MS`, and let a
 *  server change in that window re-read the written PRs' own detail and merge control. */
export function noteLocalPrWrite(now: number = Date.now(), prIds: readonly number[] = []): void {
  const until = now + FAST_POLL_WINDOW_MS;
  for (const id of prIds) recentWrites.set(id, until);
  if (until <= fastPollUntil) return;
  fastPollUntil = until;
  for (const l of fastPollListeners) l();
}

/** The PRs this tab wrote to inside the fast-poll window. */
export function recentlyWrittenPrIds(now: number = Date.now()): Set<number> {
  const out = new Set<number>();
  for (const [id, until] of recentWrites) {
    if (until <= now) recentWrites.delete(id);
    else out.add(id);
  }
  return out;
}

export function fastPollWindowOpen(now: number = Date.now()): boolean {
  return now < fastPollUntil;
}

/** The `useSyncExternalStore` snapshot: changes exactly when the window is (re)armed. */
export function fastPollUntilMs(): number {
  return fastPollUntil;
}

export function subscribeFastPollWindow(listener: () => void): () => void {
  fastPollListeners.add(listener);
  return () => {
    fastPollListeners.delete(listener);
  };
}

/** Test-only: forget the window and the recent writes. */
export function __resetFastPollWindow(): void {
  fastPollUntil = 0;
  recentWrites.clear();
}

// ── Reading `Repo.lastPrChangeAt` ────────────────────────────────────────────────────────────
//
// ⚠ EVERY READ IS GUARDED. These run inside SyncStatus's render and effects, off a poll, and the
// SPA has no error boundary: a throw here blanks the whole app.

/** repoId → epoch ms of its last server-side PR change. Repos with no stamp are absent. */
export function prChangeMap(repos: readonly Repo[] | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(repos)) return out;
  for (const r of repos) {
    const at = (r as Partial<Repo> | null | undefined)?.lastPrChangeAt;
    const id = (r as Partial<Repo> | null | undefined)?.id;
    if (typeof at !== 'string' || typeof id !== 'number') continue;
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) out.set(id, ms);
  }
  return out;
}

/** A stable string for an effect's dependency list, so a refetch that changed nothing does not
 *  re-run the effect. */
export function prChangeSignature(map: ReadonlyMap<number, number>): string {
  return [...map].map(([id, ms]) => `${id}:${ms}`).join(',');
}

/** Repos whose stamp moved forward, or appeared, since `prev`. A stamp that went BACKWARDS (the
 *  server restarted and lost its memory) is not a change. */
export function advancedRepoIds(
  prev: ReadonlyMap<number, number>,
  next: ReadonlyMap<number, number>,
): Set<number> {
  const out = new Set<number>();
  for (const [id, ms] of next) {
    const before = prev.get(id);
    if (before == null || ms > before) out.add(id);
  }
  return out;
}
