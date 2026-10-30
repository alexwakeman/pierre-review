import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LedgerRowForSweep, RowFacts, WorktreeSweepDeps } from './worktree-gc.js';

// THE WORKTREE SWEEP against REAL git repositories (docs/BACKEND.md § Worktree cleanup). The policy's
// rules are worktree-gc-policy.test.ts; this file pins what the sweep DOES with a verdict: git's own
// removal, the registry prune, the reclaimed bytes, the refusal outside the clone cache, and the
// ledger rows clone-manager.ts writes.
//
// ⚠ Every path is redirected to a temp tree BEFORE config.js / db/client.js load (the dynamic
// imports in beforeAll), or the sweep would run over the developer's own ~/.limn.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'limn-worktree-gc-')));
const CLONE_DIR = join(ROOT, 'clones');
process.env.CLONE_DIR = CLONE_DIR;
process.env.LIMN_DATA_DIR = join(ROOT, 'data');
process.env.DATABASE_URL = join(ROOT, 'data', 'test.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let gc: typeof import('./worktree-gc.js');
let manager: typeof import('./clone-manager.js');
let hygiene: typeof import('./clone-hygiene.js');
let ownerMod: typeof import('./worktree-owner.js');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeClone(entry: string): string {
  const dir = join(CLONE_DIR, entry);
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'a.txt'), 'x'.repeat(4096));
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  return dir;
}

function addTree(repo: string, name: string): string {
  const path = join(repo, '.worktrees', name);
  git(['worktree', 'add', '--detach', '--force', path, 'HEAD'], repo);
  return path;
}

function backdate(path: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
}

/** In-memory deps: the rows and facts a test names, closes recorded. */
function fakeDeps(rows: LedgerRowForSweep[], facts: Record<number, RowFacts> = {}) {
  const closed: { id: number; reason: string; bytes: number }[] = [];
  const deps: WorktreeSweepDeps = {
    cloneDir: CLONE_DIR,
    instance: 'this-process',
    policy: { idleMs: 3 * DAY, pinMaxMs: 14 * DAY },
    orphanTtlMs: 6 * HOUR,
    openRows: async () => rows,
    facts: async () => new Map(Object.entries(facts).map(([k, v]) => [Number(k), v])),
    closeRow: async (id, reason, bytes) => {
      closed.push({ id, reason, bytes });
    },
    pruneClosedRows: async () => {},
    pidAlive: () => false,
    lock: (_o, _n, fn) => fn(),
  };
  return { deps, closed };
}

function row(over: Partial<LedgerRowForSweep> & { id: number; path: string; cloneDir: string }): LedgerRowForSweep {
  return {
    owner: 'acme',
    name: 'api',
    kind: 'review',
    prId: null,
    runId: null,
    pid: 999_999,
    instance: 'a-dead-process',
    pinReason: null,
    createdAt: Date.now() - HOUR,
    lastUsedAt: Date.now() - HOUR,
    releasedAt: null,
    ...over,
  };
}

beforeAll(async () => {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  await runMigrations();
  gc = await import('./worktree-gc.js');
  manager = await import('./clone-manager.js');
  hygiene = await import('./clone-hygiene.js');
  ownerMod = await import('./worktree-owner.js');
});

beforeEach(() => {
  rmSync(CLONE_DIR, { recursive: true, force: true });
  mkdirSync(CLONE_DIR, { recursive: true });
  hygiene.liveWorktrees.clear();
  hygiene.heldWorktrees.clear();
});

afterAll(async () => {
  manager.setWorktreeLedgerHooks(null);
  const { closeDb } = await import('../db/client.js');
  await closeDb?.();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('runWorktreeSweep', () => {
  it('removes a crashed run\'s tree with git, prunes the record, and counts the bytes', async () => {
    const repo = makeClone('acme__api');
    const dead = addTree(repo, 'dead');
    const { deps, closed } = fakeDeps([row({ id: 1, path: dead, cloneDir: repo, prId: 7 })], {
      1: { runState: 'running', workState: 'none', prState: 'open' },
    });

    const r = await gc.runWorktreeSweep(deps);
    expect(r.removed).toBe(1);
    expect(r.removedBy).toEqual({ owner_exited: 1 });
    expect(r.bytesReclaimed).toBeGreaterThanOrEqual(4096);
    expect(existsSync(dead)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'], repo)).not.toContain('dead');
    expect(closed).toEqual([{ id: 1, reason: 'owner_exited', bytes: r.bytesReclaimed }]);
  });

  it('keeps a tree a job here is using and one holding unpushed work — and HOLDS the latter for the LRU', async () => {
    const repo = makeClone('acme__api');
    const busy = addTree(repo, 'busy');
    const fix = addTree(repo, 'fix');
    hygiene.liveWorktrees.set(busy, Date.now());
    const { deps, closed } = fakeDeps(
      [row({ id: 1, path: busy, cloneDir: repo, instance: 'this-process' }), row({ id: 2, path: fix, cloneDir: repo, kind: 'fix', runId: 5 })],
      { 2: { runState: 'finished', workState: 'unpushed', prState: 'closed' } },
    );

    const r = await gc.runWorktreeSweep(deps);
    expect(r.removed).toBe(0);
    expect(r.kept).toEqual({ in_use: 1, unpushed: 1 });
    expect(existsSync(busy) && existsSync(fix)).toBe(true);
    expect(closed).toEqual([]);
    expect(hygiene.heldWorktrees.has(fix)).toBe(true);
    expect(hygiene.hasFreshWorktrees(repo, Date.now() + 30 * DAY)).toBe(true);
  });

  it('closes the row of a tree that is already gone', async () => {
    const repo = makeClone('acme__api');
    const { deps, closed } = fakeDeps([row({ id: 3, path: join(repo, '.worktrees', 'vanished'), cloneDir: repo })]);
    const r = await gc.runWorktreeSweep(deps);
    expect(r.forgotten).toBe(1);
    expect(closed).toEqual([{ id: 3, reason: 'missing', bytes: 0 }]);
  });

  it('removes an UNLEDGERED tree past the orphan TTL and keeps a young one', async () => {
    const repo = makeClone('acme__api');
    const old = addTree(repo, 'old');
    const young = addTree(repo, 'young');
    backdate(old, 7 * HOUR);
    const { deps } = fakeDeps([]);
    const r = await gc.runWorktreeSweep(deps);
    expect(r.orphansRemoved).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  it('refuses a ledger path outside the clone cache, and a symlink inside it', async () => {
    const outside = join(ROOT, 'precious');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'mine');
    const repo = makeClone('acme__api');
    mkdirSync(join(repo, '.worktrees'), { recursive: true });
    const link = join(repo, '.worktrees', 'link');
    symlinkSync(outside, link);
    const { deps, closed } = fakeDeps(
      [
        row({ id: 1, path: outside, cloneDir: ROOT }),
        row({ id: 2, path: link, cloneDir: repo }),
      ],
      { 1: { runState: 'finished', workState: 'none', prState: 'merged' }, 2: { runState: 'finished', workState: 'none', prState: 'merged' } },
    );
    const r = await gc.runWorktreeSweep(deps);
    expect(r.refused).toBe(2);
    expect(r.removed).toBe(0);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(closed).toEqual([]);
  });

  it('does nothing at all when the ledger cannot be read', async () => {
    const repo = makeClone('acme__api');
    const old = addTree(repo, 'old');
    backdate(old, 30 * DAY);
    const { deps } = fakeDeps([]);
    deps.openRows = async () => {
      throw new Error('db locked');
    };
    const r = await gc.runWorktreeSweep(deps);
    expect(r.scanned).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  it('stops at the deadline', async () => {
    const repo = makeClone('acme__api');
    const a = addTree(repo, 'a');
    const { deps } = fakeDeps([row({ id: 1, path: a, cloneDir: repo })]);
    const r = await gc.runWorktreeSweep(deps, { deadline: Date.now() - 1 });
    expect(r.timedOut).toBe(true);
    expect(existsSync(a)).toBe(true);
  });
});

describe('the ledger, end to end (clone-manager → worktree_ledger → the DB-backed sweep)', () => {
  it('records the owner on add, closes the row on the run\'s own removal', async () => {
    const { db, schema } = await import('../db/client.js');
    const { eq } = await import('drizzle-orm');
    gc.installWorktreeLedger();
    const repo = makeClone('acme__web');
    const sha = git(['rev-parse', 'HEAD'], repo).trim();

    const path = await ownerMod.withWorktreeOwner({ kind: 'diagram', accountId: 1, ticket: 'ACME-12' }, () =>
      manager.addWorktree(repo, sha, { owner: 'acme', name: 'web' }),
    );
    const [open] = await db.select().from(schema.worktreeLedger).where(eq(schema.worktreeLedger.path, path)).execute();
    expect(open).toMatchObject({ kind: 'diagram', ticket: 'ACME-12', accountId: 1, owner: 'acme', name: 'web', pinReason: 'running', removedAt: null });

    // While the run holds it, the DB-backed sweep keeps it.
    const kept = await gc.runWorktreeSweep(gc.dbSweepDeps());
    expect(kept.kept.in_use).toBe(1);
    expect(existsSync(path)).toBe(true);

    await manager.removeWorktree(repo, path);
    const [closed] = await db.select().from(schema.worktreeLedger).where(eq(schema.worktreeLedger.path, path)).execute();
    expect(closed?.removeReason).toBe('run_finished');
    expect(closed?.removedAt).not.toBeNull();
    expect(closed?.pinReason).toBeNull();
  });

  it('the DB-backed sweep removes a tree left by a process that is gone, and reports it in storage', async () => {
    const { db, schema } = await import('../db/client.js');
    const repo = makeClone('acme__web');
    const path = addTree(repo, 'leftover');
    await db
      .insert(schema.worktreeLedger)
      .values({
        path,
        cloneDir: repo,
        owner: 'acme',
        name: 'web',
        kind: 'review',
        pid: 999_999_999,
        instance: 'a-previous-boot',
        pinReason: 'running',
        createdAt: new Date(Date.now() - HOUR),
        lastUsedAt: new Date(Date.now() - HOUR),
      })
      .execute();

    const r = await gc.runWorktreeSweep(gc.dbSweepDeps());
    expect(r.removedBy.owner_exited).toBe(1);
    expect(existsSync(path)).toBe(false);
    const storage = await gc.getWorktreeStorage(Date.now() + 120_000);
    expect(storage.checkouts).toBe(0);
    expect(storage.freedBytes30d).toBeGreaterThanOrEqual(r.bytesReclaimed);
    expect(storage.cloneBytes).toBeGreaterThan(0);
  });
});
