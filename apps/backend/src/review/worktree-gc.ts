import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { heldWorktrees, liveWorktrees } from './clone-hygiene.js';
import { setWorktreeLedgerHooks, withRepoLock } from './clone-manager.js';
import {
  decideLedgered,
  decideOrphan,
  fixRowStates,
  isCacheWorktreePath,
  type PrState,
  type RunState,
  type WorkState,
  type WorktreeKeepReason,
  type WorktreePolicy,
  type WorktreeRemoveReason,
} from './worktree-gc-policy.js';
import { PROCESS_INSTANCE, recordWorktreeCreated, recordWorktreeReleased } from './worktree-ledger.js';

// THE WORKTREE SWEEP (docs/BACKEND.md § Worktree cleanup).
//
// Every agentic run that reads code checks a PR out into its own worktree under
// `<cloneDir>/<owner__name>/.worktrees/` and removes it in its `finally`. A crash, a kill or a
// failed `git worktree remove` leaves the tree behind, and each one is a full checkout. This sweep
// finds them through the ledger (`worktree_ledger`, written by clone-manager.ts `addWorktree`) and
// removes the ones nothing needs, by the rules in worktree-gc-policy.ts.
//
// WHEN: once after the server listens (never awaited by the boot), and when a run makes a new
// worktree — at most once per `WORKTREE_SWEEP_MIN_GAP_MIN`, fire-and-forget. One sweep at a time.
//
// ⚠ IT NEVER TOUCHES ANYTHING OUTSIDE THE CLONE CACHE. A path is removed only when its REAL path is
// exactly `<cloneDir>/<clone>/.worktrees/<entry>` (isCacheWorktreePath) and it is not a symlink.
// Removal is `git worktree remove --force` under the repo's lock (the same lock prep and cleanup
// take), then an rm of what git left, then one `git worktree prune` per clone touched.
//
// ⚠ SEQUENTIAL ON PURPOSE — git does not scale with concurrency here (clone-hygiene.ts measured it).

const execFileAsync = promisify(execFile);

export interface WorktreeSweepReport {
  /** Ledger rows still open plus unledgered directories looked at. */
  scanned: number;
  removed: number;
  /** Of `removed`, directories with no ledger row. */
  orphansRemoved: number;
  /** Ledger rows closed because their directory was already gone. */
  forgotten: number;
  kept: Partial<Record<WorktreeKeepReason, number>>;
  removedBy: Partial<Record<WorktreeRemoveReason, number>>;
  bytesReclaimed: number;
  /** Paths that failed the inside-the-clone-cache check — never removed. */
  refused: number;
  /** Removal attempted and the directory is still there. */
  failed: number;
  /** The deadline stopped the sweep before every candidate was looked at. */
  timedOut: boolean;
}

export interface LedgerRowForSweep {
  id: number;
  path: string;
  cloneDir: string;
  owner: string;
  name: string;
  kind: string;
  prId: number | null;
  runId: number | null;
  pid: number;
  instance: string;
  pinReason: string | null;
  createdAt: number;
  lastUsedAt: number;
  releasedAt: number | null;
}

export interface RowFacts {
  runState: RunState;
  workState: WorkState;
  prState: PrState;
}

/** Everything the sweep reads or writes outside the filesystem — the DB-backed set below, or a test's. */
export interface WorktreeSweepDeps {
  cloneDir: string;
  instance: string;
  policy: WorktreePolicy;
  orphanTtlMs: number;
  openRows(): Promise<LedgerRowForSweep[]>;
  facts(rows: readonly LedgerRowForSweep[]): Promise<Map<number, RowFacts>>;
  closeRow(id: number, reason: WorktreeRemoveReason | 'missing', bytes: number, at: Date): Promise<void>;
  /** Drop rows closed before `before` (the ledger keeps 30 days of history). */
  pruneClosedRows(before: Date): Promise<void>;
  pidAlive(pid: number): boolean;
  lock<T>(owner: string, name: string, fn: () => Promise<T>): Promise<T>;
}

const emptyReport = (): WorktreeSweepReport => ({
  scanned: 0,
  removed: 0,
  orphansRemoved: 0,
  forgotten: 0,
  kept: {},
  removedBy: {},
  bytesReclaimed: 0,
  refused: 0,
  failed: 0,
  timedOut: false,
});

/** Bytes under `dir`, not following symlinks. Best-effort: an unreadable entry counts 0. */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(d, e);
      try {
        const st = await lstat(full);
        if (st.isDirectory()) stack.push(full);
        else total += st.size;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

/** The real clone-cache root, or null when there is none (nothing to sweep). */
function realCloneRoot(cloneDir: string): string | null {
  try {
    return realpathSync(cloneDir);
  } catch {
    return null;
  }
}

/** Is `path` safe to remove: a real directory, not a symlink, exactly one per-run checkout deep. */
export function isRemovableWorktree(path: string, realRoot: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
    return isCacheWorktreePath(realpathSync(path), realRoot, sep);
  } catch {
    return false;
  }
}

/** Every directory under `<cloneDir>/*\/.worktrees/`, with the clone it belongs to. */
function worktreeDirsOnDisk(cloneDir: string): { path: string; cloneDir: string; owner: string; name: string }[] {
  const out: { path: string; cloneDir: string; owner: string; name: string }[] = [];
  let clones: string[];
  try {
    clones = readdirSync(cloneDir);
  } catch {
    return out;
  }
  for (const entry of clones) {
    // `owner__name`: the FIRST `__` splits it (a GitHub login cannot hold an underscore).
    const split = entry.indexOf('__');
    if (split <= 0) continue;
    const repoDir = join(cloneDir, entry);
    let trees: string[];
    try {
      trees = readdirSync(join(repoDir, '.worktrees'));
    } catch {
      continue;
    }
    for (const t of trees) {
      out.push({ path: join(repoDir, '.worktrees', t), cloneDir: repoDir, owner: entry.slice(0, split), name: entry.slice(split + 2) });
    }
  }
  return out;
}

/**
 * One pass. `now` and `deadline` are parameters so a test can age a tree and bound a run without
 * touching the clock. Never throws: a failed step is counted and the sweep moves on.
 */
export async function runWorktreeSweep(
  deps: WorktreeSweepDeps,
  opts: { now?: number; deadline?: number } = {},
): Promise<WorktreeSweepReport> {
  const now = opts.now ?? Date.now();
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const report = emptyReport();
  const held = new Set<string>();
  const touchedClones = new Map<string, { owner: string; name: string }>();
  const realRoot = realCloneRoot(deps.cloneDir);

  const remove = async (
    target: { path: string; cloneDir: string; owner: string; name: string },
  ): Promise<{ ok: boolean; bytes: number }> => {
    if (!realRoot || !isRemovableWorktree(target.path, realRoot) || dirname(dirname(target.path)) !== target.cloneDir) {
      report.refused++;
      return { ok: false, bytes: 0 };
    }
    const bytes = await dirBytes(target.path);
    return deps.lock(target.owner, target.name, async () => {
      // Re-read under the lock: prep and cleanup take the same one, so nothing can claim it after this.
      if (liveWorktrees.has(target.path)) return { ok: false, bytes: 0 };
      await execFileAsync('git', ['-C', target.cloneDir, 'worktree', 'remove', '--force', target.path], {
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      }).catch(() => {});
      if (existsSync(target.path)) await rm(target.path, { recursive: true, force: true }).catch(() => {});
      touchedClones.set(target.cloneDir, { owner: target.owner, name: target.name });
      const ok = !existsSync(target.path);
      if (!ok) report.failed++;
      return { ok, bytes: ok ? bytes : 0 };
    });
  };

  // ⚠ No ledger, no sweep. Carrying on without it would read every ledgered tree as an orphan and
  // judge it by age alone — removing a fix the reader has not pushed.
  let rows: LedgerRowForSweep[];
  let facts: Map<number, RowFacts>;
  try {
    rows = await deps.openRows();
    facts = await deps.facts(rows);
  } catch {
    return report;
  }
  const ledgered = new Set(rows.map((r) => r.path));

  for (const row of rows) {
    if (Date.now() > deadline) {
      report.timedOut = true;
      break;
    }
    report.scanned++;
    const f = facts.get(row.id) ?? { runState: 'unknown', workState: 'none', prState: null };
    const ownedHere = row.instance === deps.instance;
    const verdict = decideLedgered(
      {
        exists: existsSync(row.path),
        liveHere: liveWorktrees.has(row.path),
        ownedHere,
        ownerAlive: ownedHere || deps.pidAlive(row.pid),
        pinReason: row.pinReason,
        releasedAt: row.releasedAt,
        runState: f.runState,
        workState: f.workState,
        prState: f.prState,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
      },
      now,
      deps.policy,
    );
    if (verdict.action === 'forget') {
      report.forgotten++;
      await deps.closeRow(row.id, 'missing', 0, new Date(now)).catch(() => {});
      continue;
    }
    if (verdict.action === 'keep') {
      report.kept[verdict.reason] = (report.kept[verdict.reason] ?? 0) + 1;
      if (verdict.reason === 'unpushed' || verdict.reason === 'other_process') held.add(row.path);
      continue;
    }
    const out = await remove(row);
    if (!out.ok) continue;
    report.removed++;
    report.removedBy[verdict.reason] = (report.removedBy[verdict.reason] ?? 0) + 1;
    report.bytesReclaimed += out.bytes;
    await deps.closeRow(row.id, verdict.reason, out.bytes, new Date(now)).catch(() => {});
  }

  if (!report.timedOut) {
    for (const dir of worktreeDirsOnDisk(deps.cloneDir)) {
      if (ledgered.has(dir.path)) continue;
      if (Date.now() > deadline) {
        report.timedOut = true;
        break;
      }
      report.scanned++;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(dir.path).mtimeMs;
      } catch {
        continue;
      }
      const verdict = decideOrphan({ liveHere: liveWorktrees.has(dir.path), mtimeMs }, now, deps.orphanTtlMs);
      if (verdict.action !== 'remove') {
        if (verdict.action === 'keep') report.kept[verdict.reason] = (report.kept[verdict.reason] ?? 0) + 1;
        continue;
      }
      const out = await remove(dir);
      if (!out.ok) continue;
      report.removed++;
      report.orphansRemoved++;
      report.removedBy.orphan = (report.removedBy.orphan ?? 0) + 1;
      report.bytesReclaimed += out.bytes;
    }
  }

  // The removals above can leave git's registry entries behind (the rm fallback); one prune per clone.
  for (const [cloneDir, repo] of touchedClones) {
    await deps
      .lock(repo.owner, repo.name, () =>
        execFileAsync('git', ['-C', cloneDir, 'worktree', 'prune'], { timeout: 60_000, maxBuffer: 1024 * 1024 }),
      )
      .catch(() => {});
  }

  // A timed-out sweep did not look at every tree, so it must not drop holds it never re-read.
  if (!report.timedOut) heldWorktrees.clear();
  for (const p of held) heldWorktrees.add(p);

  await deps.pruneClosedRows(new Date(now - LEDGER_HISTORY_MS)).catch(() => {});
  return report;
}

/** Closed ledger rows are kept this long (the Settings "freed" figure reads them), then deleted. */
const LEDGER_HISTORY_MS = 30 * 24 * 3_600_000;

/** Is a process with this pid running? EPERM means it exists under another user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const toMs = (d: Date | null): number | null => (d ? d.getTime() : null);

/** The run / PR facts for a batch of ledger rows, read in three queries. */
async function dbFacts(rows: readonly LedgerRowForSweep[]): Promise<Map<number, RowFacts>> {
  const out = new Map<number, RowFacts>();
  const prIds = [...new Set(rows.map((r) => r.prId).filter((id): id is number => id != null))];
  const fixIds = [...new Set(rows.filter((r) => (r.kind === 'fix' || r.kind === 'plan') && r.runId != null).map((r) => r.runId!))];
  const reviewIds = [...new Set(rows.filter((r) => r.kind === 'review' && r.runId != null).map((r) => r.runId!))];

  const prState = new Map<number, PrState>();
  if (prIds.length > 0) {
    const pr = schema.pullRequests;
    for (const r of await db.select({ id: pr.id, state: pr.state }).from(pr).where(inArray(pr.id, prIds)).execute()) {
      prState.set(r.id, r.state);
    }
  }
  const fixes = new Map<number, { status: string; planStatus: string | null; pushedAt: number | null; hasPatch: boolean }>();
  if (fixIds.length > 0) {
    const f = schema.aiFixes;
    const got = await db
      .select({
        id: f.id,
        status: f.status,
        planStatus: f.planStatus,
        pushedAt: f.pushedAt,
        patchLen: sql<number | null>`length(${f.patch})`,
      })
      .from(f)
      .where(inArray(f.id, fixIds))
      .execute();
    for (const r of got) {
      fixes.set(r.id, { status: r.status, planStatus: r.planStatus, pushedAt: toMs(r.pushedAt), hasPatch: (r.patchLen ?? 0) > 0 });
    }
  }
  const reviews = new Map<number, string>();
  if (reviewIds.length > 0) {
    const c = schema.claudeReviews;
    for (const r of await db.select({ id: c.id, status: c.status }).from(c).where(inArray(c.id, reviewIds)).execute()) {
      reviews.set(r.id, r.status);
    }
  }

  for (const row of rows) {
    let runState: RunState = 'unknown';
    let workState: WorkState = 'none';
    if (row.kind === 'fix' && row.runId != null) {
      ({ runState, workState } = fixRowStates(fixes.get(row.runId) ?? null));
    } else if (row.kind === 'plan' && row.runId != null) {
      // A plan is read-only: it never holds work to push. Running while its pass is.
      const fx = fixes.get(row.runId);
      runState = !fx ? 'unknown' : fx.planStatus === 'planning' || fx.status === 'running' ? 'running' : 'finished';
    } else if (row.kind === 'review' && row.runId != null) {
      const st = reviews.get(row.runId);
      runState = st == null ? 'unknown' : st === 'queued' || st === 'running' ? 'running' : 'finished';
    }
    const pr: PrState = row.prId == null ? null : (prState.get(row.prId) ?? 'gone');
    out.set(row.id, { runState, workState, prState: pr });
  }
  return out;
}

/** The sweep's real dependencies: the ledger table, the run/PR tables, the repo locks. */
export function dbSweepDeps(): WorktreeSweepDeps {
  const t = schema.worktreeLedger;
  return {
    cloneDir: config.cloneDir,
    instance: PROCESS_INSTANCE,
    policy: { idleMs: config.worktreeIdleMs, pinMaxMs: config.worktreePinMaxMs },
    orphanTtlMs: config.worktreeTtlMs,
    openRows: async () =>
      (await db.select().from(t).where(isNull(t.removedAt)).execute()).map((r) => ({
        id: r.id,
        path: r.path,
        cloneDir: r.cloneDir,
        owner: r.owner,
        name: r.name,
        kind: r.kind,
        prId: r.prId,
        runId: r.runId,
        pid: r.pid,
        instance: r.instance,
        pinReason: r.pinReason,
        createdAt: r.createdAt.getTime(),
        lastUsedAt: r.lastUsedAt.getTime(),
        releasedAt: toMs(r.releasedAt),
      })),
    facts: dbFacts,
    closeRow: async (id, reason, bytes, at) => {
      await db
        .update(t)
        .set({ removedAt: at, removeReason: reason, bytesReclaimed: bytes, pinReason: null })
        .where(and(eq(t.id, id), isNull(t.removedAt)))
        .execute();
    },
    pruneClosedRows: async (before) => {
      await db.delete(t).where(and(isNotNull(t.removedAt), lt(t.removedAt, before))).execute();
    },
    pidAlive,
    lock: (owner, name, fn) => withRepoLock(`${owner}/${name}`, fn),
  };
}

// ---- Scheduling: one sweep at a time; a run's kick is throttled ----

let inFlight: Promise<WorktreeSweepReport> | null = null;
let lastStartedAt = 0;
let lastFinishedAt: number | null = null;

const sizeText = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Start a sweep in the background unless one is running. `run_start` (a run just made a worktree)
 * is throttled to one per `config.worktreeSweepMinGapMs`; `boot` always starts one. Never throws,
 * never blocks the caller.
 */
export function kickWorktreeSweep(trigger: 'boot' | 'run_start'): void {
  const now = Date.now();
  if (inFlight) return;
  if (trigger === 'run_start' && now - lastStartedAt < config.worktreeSweepMinGapMs) return;
  lastStartedAt = now;
  inFlight = runWorktreeSweep(dbSweepDeps(), { now, deadline: now + config.worktreeSweepMaxMs })
    .then((r) => {
      lastFinishedAt = Date.now();
      if (r.removed > 0 || r.refused > 0 || r.failed > 0) {
        const why = Object.entries(r.removedBy)
          .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
          .join(', ');
        console.log(
          `worktrees: removed ${r.removed} (${why}), reclaimed ${sizeText(r.bytesReclaimed)}` +
            (r.failed > 0 ? `, ${r.failed} could not be removed` : '') +
            (r.refused > 0 ? `, ${r.refused} refused (outside the clone cache)` : '') +
            (r.timedOut ? ' — stopped at the time limit' : ''),
        );
      }
      return r;
    })
    .catch(() => emptyReport())
    .finally(() => {
      inFlight = null;
    });
}

/** Wire the ledger into clone-manager.ts. Called once at boot, before anything can make a worktree. */
export function installWorktreeLedger(): void {
  setWorktreeLedgerHooks({
    created: recordWorktreeCreated,
    released: recordWorktreeReleased,
    runStarting: () => kickWorktreeSweep('run_start'),
  });
}

// ---- Settings → AI: what the clone cache holds on disk ----

export interface WorktreeStorage {
  /** The shared clones, excluding per-run checkouts. */
  cloneBytes: number;
  checkouts: number;
  checkoutBytes: number;
  /** Bytes the sweep freed in the last 30 days (the ledger's closed rows); null when unreadable. */
  freedBytes30d: number | null;
  lastSweepAt: string | null;
}

let storageCache: { at: number; value: WorktreeStorage } | null = null;

/** Walk the clone cache once (cached for a minute — Settings may be opened repeatedly). */
export async function getWorktreeStorage(now: number = Date.now()): Promise<WorktreeStorage> {
  if (storageCache && now - storageCache.at < 60_000) {
    return { ...storageCache.value, lastSweepAt: lastFinishedAt ? new Date(lastFinishedAt).toISOString() : null };
  }
  let cloneBytes = 0;
  let checkouts = 0;
  let checkoutBytes = 0;
  let clones: string[] = [];
  try {
    clones = readdirSync(config.cloneDir);
  } catch {
    /* no cache yet */
  }
  for (const entry of clones) {
    const repoDir = join(config.cloneDir, entry);
    let children: string[];
    try {
      if (!statSync(repoDir).isDirectory()) continue;
      children = readdirSync(repoDir);
    } catch {
      continue;
    }
    for (const c of children) {
      const full = join(repoDir, c);
      if (c === '.worktrees') {
        let trees: string[] = [];
        try {
          trees = readdirSync(full);
        } catch {
          /* gone */
        }
        for (const t of trees) {
          checkouts++;
          checkoutBytes += await dirBytes(join(full, t));
        }
        continue;
      }
      try {
        const st = await lstat(full);
        cloneBytes += st.isDirectory() ? await dirBytes(full) : st.size;
      } catch {
        /* vanished */
      }
    }
  }
  let freedBytes30d: number | null = null;
  try {
    const t = schema.worktreeLedger;
    const [row] = await db
      .select({ total: sql<number | null>`sum(${t.bytesReclaimed})` })
      .from(t)
      .where(gte(t.removedAt, new Date(now - LEDGER_HISTORY_MS)))
      .execute();
    freedBytes30d = Number(row?.total ?? 0);
  } catch {
    /* unknown, not zero — the line leaves the figure out */
  }
  const value: WorktreeStorage = {
    cloneBytes,
    checkouts,
    checkoutBytes,
    freedBytes30d,
    lastSweepAt: lastFinishedAt ? new Date(lastFinishedAt).toISOString() : null,
  };
  storageCache = { at: now, value };
  return value;
}
