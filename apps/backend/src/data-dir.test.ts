// The one-time ~/.pierre-review → ~/.limn move (data-dir.ts), over a temp "home" only.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyDataDir, resolveDataDir } from './data-dir.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'limn-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const seedLegacy = (): void => {
  mkdirSync(join(home, '.pierre-review', 'clones', 'acme'), { recursive: true });
  writeFileSync(join(home, '.pierre-review', 'pierre-review.sqlite'), 'db');
  writeFileSync(join(home, '.pierre-review', 'pierre-review.sqlite-wal'), 'wal');
  writeFileSync(join(home, '.pierre-review', 'config.json'), '{"maxReviewBudgetUsd":2}');
};

describe('resolveDataDir', () => {
  it('is ~/.limn by default', () => {
    expect(resolveDataDir({}, home)).toBe(join(home, '.limn'));
  });
  it('honours LIMN_DATA_DIR', () => {
    expect(resolveDataDir({ LIMN_DATA_DIR: join(home, 'elsewhere') }, home)).toBe(join(home, 'elsewhere'));
  });
  it('⚠ is the OLD directory while it exists and ~/.limn does not (the move has not happened)', () => {
    seedLegacy();
    expect(resolveDataDir({}, home)).toBe(join(home, '.pierre-review'));
    mkdirSync(join(home, '.limn'));
    expect(resolveDataDir({}, home)).toBe(join(home, '.limn'));
  });
});

describe('migrateLegacyDataDir', () => {
  it('moves everything, once, and says so once', () => {
    seedLegacy();
    const logs: string[] = [];
    const first = migrateLegacyDataDir({ env: {}, home, log: (m) => logs.push(m) });
    expect(first.moved).toBe(true);
    expect(existsSync(join(home, '.pierre-review'))).toBe(false);
    expect(readFileSync(join(home, '.limn', 'pierre-review.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(join(home, '.limn', 'pierre-review.sqlite-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(home, '.limn', 'config.json'), 'utf8')).toContain('maxReviewBudgetUsd');
    expect(existsSync(join(home, '.limn', 'clones', 'acme'))).toBe(true);
    expect(logs).toHaveLength(1);

    const second = migrateLegacyDataDir({ env: {}, home, log: (m) => logs.push(m) });
    expect(second).toEqual({ moved: false, reason: 'no_legacy_dir' });
    expect(logs).toHaveLength(1);
  });

  it('never clobbers an existing ~/.limn, and leaves the old directory untouched', () => {
    seedLegacy();
    mkdirSync(join(home, '.limn'));
    writeFileSync(join(home, '.limn', 'pierre-review.sqlite'), 'newer');
    const r = migrateLegacyDataDir({ env: {}, home });
    expect(r).toEqual({ moved: false, reason: 'target_exists' });
    expect(readFileSync(join(home, '.limn', 'pierre-review.sqlite'), 'utf8')).toBe('newer');
    expect(readFileSync(join(home, '.pierre-review', 'pierre-review.sqlite'), 'utf8')).toBe('db');
  });

  it('moves nothing when LIMN_DATA_DIR names the directory', () => {
    seedLegacy();
    const r = migrateLegacyDataDir({ env: { LIMN_DATA_DIR: join(home, 'x') }, home });
    expect(r).toEqual({ moved: false, reason: 'explicit_dir' });
    expect(existsSync(join(home, '.pierre-review', 'pierre-review.sqlite'))).toBe(true);
    expect(existsSync(join(home, '.limn'))).toBe(false);
  });

  it('⚠ moves nothing when DATABASE_URL or CLONE_DIR points inside the old directory', () => {
    seedLegacy();
    const logs: string[] = [];
    for (const env of [
      { DATABASE_URL: join(home, '.pierre-review', 'pierre-review.sqlite') },
      { CLONE_DIR: join(home, '.pierre-review', 'clones') },
    ]) {
      const r = migrateLegacyDataDir({ env, home, log: (m) => logs.push(m) });
      expect(r).toEqual({ moved: false, reason: 'pinned_path' });
    }
    expect(existsSync(join(home, '.pierre-review', 'pierre-review.sqlite'))).toBe(true);
    expect(existsSync(join(home, '.limn'))).toBe(false);
    // …so everything else keeps using the same (old) directory.
    expect(resolveDataDir({}, home)).toBe(join(home, '.pierre-review'));
    expect(logs.length).toBeGreaterThan(0);
    // A path elsewhere does not pin it.
    const moved = migrateLegacyDataDir({ env: { DATABASE_URL: join(home, 'other.sqlite') }, home });
    expect(moved.moved).toBe(true);
  });

  it('⚠ a failed rename leaves the old directory in use and creates no ~/.limn', () => {
    seedLegacy();
    chmodSync(home, 0o500); // the rename into home is refused (EACCES)
    try {
      const r = migrateLegacyDataDir({ env: {}, home });
      expect(r).toMatchObject({ moved: false, reason: 'rename_failed' });
      expect(existsSync(join(home, '.limn'))).toBe(false);
      expect(resolveDataDir({}, home)).toBe(join(home, '.pierre-review'));
    } finally {
      chmodSync(home, 0o700);
    }
    // The next boot tries again.
    expect(migrateLegacyDataDir({ env: {}, home }).moved).toBe(true);
  });

  it('says so when ~/.limn exists without a database but the old directory has one', () => {
    seedLegacy();
    mkdirSync(join(home, '.limn'));
    const logs: string[] = [];
    expect(migrateLegacyDataDir({ env: {}, home, log: (m) => logs.push(m) })).toMatchObject({ reason: 'target_exists' });
    expect(logs).toHaveLength(1);
  });

  it('is a no-op on a fresh machine', () => {
    expect(migrateLegacyDataDir({ env: {}, home })).toEqual({ moved: false, reason: 'no_legacy_dir' });
    expect(existsSync(join(home, '.limn'))).toBe(false);
  });
});
