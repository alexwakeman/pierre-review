// ONE BACKEND PER DATA DIRECTORY (instance-lock.ts): a live holder refuses the start, a dead one's
// lock is taken over, and release only removes our own lock.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireInstanceLock,
  INSTANCE_LOCK_FILE,
  InstanceLockedError,
  isLiveNodeProcess,
  pidExists,
  type InstanceLockDeps,
} from './instance-lock.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'limn-lock-'));
const deps = (pid: number, alive: Set<number>): InstanceLockDeps => ({
  pid,
  isAlive: (p) => alive.has(p),
  now: () => Date.now(),
});

describe('acquireInstanceLock', () => {
  it('takes a free data dir and writes who holds it', () => {
    const d = dir();
    const lock = acquireInstanceLock(d, { port: 4200, dbPath: '/x.sqlite' }, deps(100, new Set()));
    const body = JSON.parse(readFileSync(join(d, INSTANCE_LOCK_FILE), 'utf8'));
    expect(body).toMatchObject({ pid: 100, port: 4200, dbPath: '/x.sqlite' });
    expect(lock.tookOverFrom).toBeNull();
  });

  it('refuses while another LIVE backend holds it, naming the holder', () => {
    const d = dir();
    acquireInstanceLock(d, { port: 4000, dbPath: '/real.sqlite' }, deps(100, new Set()));
    expect(() => acquireInstanceLock(d, { port: 4200, dbPath: '/b.sqlite' }, deps(200, new Set([100])))).toThrow(
      InstanceLockedError,
    );
    try {
      acquireInstanceLock(d, { port: 4200, dbPath: '/b.sqlite' }, deps(200, new Set([100])));
    } catch (err) {
      expect((err as Error).message).toContain('process 100, port 4000');
      expect((err as InstanceLockedError).holder?.pid).toBe(100);
    }
    // The holder's lock is untouched.
    expect(JSON.parse(readFileSync(join(d, INSTANCE_LOCK_FILE), 'utf8')).pid).toBe(100);
  });

  it('takes over a STALE lock (dead pid), so a crash never bricks the next boot', () => {
    const d = dir();
    acquireInstanceLock(d, { port: 4000, dbPath: '/a.sqlite' }, deps(100, new Set()));
    const lock = acquireInstanceLock(d, { port: 4000, dbPath: '/a.sqlite' }, deps(200, new Set()));
    expect(lock.tookOverFrom?.pid).toBe(100);
    expect(JSON.parse(readFileSync(join(d, INSTANCE_LOCK_FILE), 'utf8')).pid).toBe(200);
  });

  it('keeps its own lock when the same process starts twice', () => {
    const d = dir();
    acquireInstanceLock(d, { port: 4000, dbPath: '/a.sqlite' }, deps(100, new Set([100])));
    expect(() => acquireInstanceLock(d, { port: 4000, dbPath: '/a.sqlite' }, deps(100, new Set([100])))).not.toThrow();
  });

  it('an unreadable lock refuses while fresh (a start mid-write) and is taken over once old', () => {
    const d = dir();
    const path = join(d, INSTANCE_LOCK_FILE);
    writeFileSync(path, '');
    expect(() => acquireInstanceLock(d, { port: 1, dbPath: '' }, deps(200, new Set()))).toThrow(InstanceLockedError);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(acquireInstanceLock(d, { port: 1, dbPath: '' }, deps(200, new Set())).path).toBe(path);
  });

  it('release removes only our own lock', () => {
    const d = dir();
    const path = join(d, INSTANCE_LOCK_FILE);
    const a = acquireInstanceLock(d, { port: 1, dbPath: '' }, deps(100, new Set()));
    // A later process took it over (we were presumed dead): our release must not remove theirs.
    acquireInstanceLock(d, { port: 1, dbPath: '' }, deps(200, new Set()));
    a.release();
    expect(existsSync(path)).toBe(true);
    const b = acquireInstanceLock(d, { port: 1, dbPath: '' }, deps(200, new Set([200])));
    b.release();
    expect(existsSync(path)).toBe(false);
  });
});

describe('liveness', () => {
  it('this process is live and a Node process; a reaped child is not', async () => {
    expect(pidExists(process.pid)).toBe(true);
    expect(isLiveNodeProcess(process.pid)).toBe(true);
    const child = spawn('/bin/sh', ['-c', 'exit 0']);
    await new Promise((r) => child.on('exit', r));
    await new Promise((r) => setTimeout(r, 20));
    expect(pidExists(child.pid ?? -1)).toBe(false);
    expect(pidExists(0)).toBe(false);
  });

  it('a live process that is NOT Node does not hold the lock (a reused pid)', async () => {
    if (process.platform === 'win32') return;
    const child = spawn('/bin/sleep', ['30']);
    try {
      // 'spawn' fires once the exec happened: before it, the child is still a fork of Node.
      await new Promise((r) => child.once('spawn', r));
      expect(pidExists(child.pid ?? -1)).toBe(true);
      expect(isLiveNodeProcess(child.pid ?? -1)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('with real processes', () => {
  it('a running Node holder refuses; once it dies, its lock is taken over', async () => {
    const d = dir();
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const exited = new Promise((r) => holder.on('exit', r));
    try {
      await new Promise((r) => holder.once('spawn', r));
      writeFileSync(
        join(d, INSTANCE_LOCK_FILE),
        JSON.stringify({ pid: holder.pid, port: 4000, dbPath: '/real.sqlite', startedAt: '' }),
      );
      expect(() => acquireInstanceLock(d, { port: 4200, dbPath: '/s.sqlite' })).toThrow(InstanceLockedError);
    } finally {
      holder.kill('SIGKILL');
      await exited;
    }
    const lock = acquireInstanceLock(d, { port: 4200, dbPath: '/s.sqlite' });
    expect(lock.tookOverFrom?.pid).toBe(holder.pid);
    lock.release();
  });
});
