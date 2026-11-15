// The one-time ~/.limn (or ~/.pierre-review) → ~/.ensemble move (data-dir.ts), over a temp "home" only.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDocsDir, migrateLegacyDataDir, resolveDataDir } from './data-dir.js';

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
  it('is ~/.ensemble by default', () => {
    expect(resolveDataDir({}, home)).toBe(join(home, '.ensemble'));
  });
  it('honours ENSEMBLE_DATA_DIR, then LIMN_DATA_DIR', () => {
    expect(resolveDataDir({ LIMN_DATA_DIR: join(home, 'elsewhere') }, home)).toBe(join(home, 'elsewhere'));
    expect(resolveDataDir({ ENSEMBLE_DATA_DIR: join(home, 'new') }, home)).toBe(join(home, 'new'));
    expect(resolveDataDir({ ENSEMBLE_DATA_DIR: join(home, 'new'), LIMN_DATA_DIR: join(home, 'old') }, home)).toBe(join(home, 'new'));
  });
  it('⚠ is the OLD directory while it exists and ~/.ensemble does not (the move has not happened)', () => {
    seedLegacy();
    expect(resolveDataDir({}, home)).toBe(join(home, '.pierre-review'));
    mkdirSync(join(home, '.ensemble'));
    expect(resolveDataDir({}, home)).toBe(join(home, '.ensemble'));
  });
});

describe('migrateLegacyDataDir', () => {
  it('moves everything, once, and says so once', () => {
    seedLegacy();
    const logs: string[] = [];
    const first = migrateLegacyDataDir({ env: {}, home, log: (m) => logs.push(m) });
    expect(first.moved).toBe(true);
    expect(existsSync(join(home, '.pierre-review'))).toBe(false);
    expect(readFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(join(home, '.ensemble', 'pierre-review.sqlite-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(home, '.ensemble', 'config.json'), 'utf8')).toContain('maxReviewBudgetUsd');
    expect(existsSync(join(home, '.ensemble', 'clones', 'acme'))).toBe(true);
    expect(logs).toHaveLength(1);

    const second = migrateLegacyDataDir({ env: {}, home, log: (m) => logs.push(m) });
    expect(second).toEqual({ moved: false, reason: 'no_legacy_dir' });
    expect(logs).toHaveLength(1);
  });

  it('never clobbers an existing ~/.ensemble, and leaves the old directory untouched', () => {
    seedLegacy();
    mkdirSync(join(home, '.ensemble'));
    writeFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'newer');
    const r = migrateLegacyDataDir({ env: {}, home });
    expect(r).toEqual({ moved: false, reason: 'target_exists' });
    expect(readFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'utf8')).toBe('newer');
    expect(readFileSync(join(home, '.pierre-review', 'pierre-review.sqlite'), 'utf8')).toBe('db');
  });

  it('moves nothing when ENSEMBLE_DATA_DIR or LIMN_DATA_DIR names the directory', () => {
    seedLegacy();
    expect(migrateLegacyDataDir({ env: { ENSEMBLE_DATA_DIR: join(home, 'x') }, home })).toEqual({ moved: false, reason: 'explicit_dir' });
    const r = migrateLegacyDataDir({ env: { LIMN_DATA_DIR: join(home, 'x') }, home });
    expect(r).toEqual({ moved: false, reason: 'explicit_dir' });
    expect(existsSync(join(home, '.pierre-review', 'pierre-review.sqlite'))).toBe(true);
    expect(existsSync(join(home, '.ensemble'))).toBe(false);
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
    expect(existsSync(join(home, '.ensemble'))).toBe(false);
    // …so everything else keeps using the same (old) directory.
    expect(resolveDataDir({}, home)).toBe(join(home, '.pierre-review'));
    expect(logs.length).toBeGreaterThan(0);
    // A path elsewhere does not pin it.
    const moved = migrateLegacyDataDir({ env: { DATABASE_URL: join(home, 'other.sqlite') }, home });
    expect(moved.moved).toBe(true);
  });

  it('⚠ a failed rename leaves the old directory in use and creates no ~/.ensemble', () => {
    seedLegacy();
    chmodSync(home, 0o500); // the rename into home is refused (EACCES)
    try {
      const r = migrateLegacyDataDir({ env: {}, home });
      expect(r).toMatchObject({ moved: false, reason: 'rename_failed' });
      expect(existsSync(join(home, '.ensemble'))).toBe(false);
      expect(resolveDataDir({}, home)).toBe(join(home, '.pierre-review'));
    } finally {
      chmodSync(home, 0o700);
    }
    // The next boot tries again.
    expect(migrateLegacyDataDir({ env: {}, home }).moved).toBe(true);
  });

  it('says so when ~/.ensemble exists without a database but the old directory has one', () => {
    seedLegacy();
    mkdirSync(join(home, '.ensemble'));
    const logs: string[] = [];
    expect(migrateLegacyDataDir({ env: {}, home, log: (m) => logs.push(m) })).toMatchObject({ reason: 'target_exists' });
    expect(logs).toHaveLength(1);
  });

  it('is a no-op on a fresh machine', () => {
    expect(migrateLegacyDataDir({ env: {}, home })).toEqual({ moved: false, reason: 'no_legacy_dir' });
    expect(existsSync(join(home, '.ensemble'))).toBe(false);
  });
});

// THE LIMN → ENSEMBLE MOVE: ~/.limn is the newest old directory and is the one moved.
describe('migrateLegacyDataDir from ~/.limn', () => {
  const seedLimn = (): void => {
    mkdirSync(join(home, '.limn', 'codex'), { recursive: true });
    mkdirSync(join(home, '.limn', 'ai-runtime'), { recursive: true });
    writeFileSync(join(home, '.limn', 'pierre-review.sqlite'), 'limn-db');
    writeFileSync(join(home, '.limn', 'codex', 'auth.json'), '{}');
  };

  it('resolves to ~/.limn until the move, then ~/.ensemble', () => {
    seedLimn();
    expect(resolveDataDir({}, home)).toBe(join(home, '.limn'));
    expect(migrateLegacyDataDir({ env: {}, home }).moved).toBe(true);
    expect(resolveDataDir({}, home)).toBe(join(home, '.ensemble'));
  });

  it('moves ~/.limn with everything under it (Codex home, runtimes), once', () => {
    seedLimn();
    const r = migrateLegacyDataDir({ env: {}, home });
    expect(r).toEqual({ moved: true, from: join(home, '.limn'), to: join(home, '.ensemble') });
    expect(existsSync(join(home, '.limn'))).toBe(false);
    expect(readFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'utf8')).toBe('limn-db');
    expect(existsSync(join(home, '.ensemble', 'codex', 'auth.json'))).toBe(true);
    expect(existsSync(join(home, '.ensemble', 'ai-runtime'))).toBe(true);
    expect(migrateLegacyDataDir({ env: {}, home })).toEqual({ moved: false, reason: 'no_legacy_dir' });
  });

  it('prefers ~/.limn over an older ~/.pierre-review left beside it, and leaves that one alone', () => {
    seedLegacy();
    seedLimn();
    expect(resolveDataDir({}, home)).toBe(join(home, '.limn'));
    expect(migrateLegacyDataDir({ env: {}, home })).toMatchObject({ moved: true, from: join(home, '.limn') });
    expect(readFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'utf8')).toBe('limn-db');
    expect(readFileSync(join(home, '.pierre-review', 'pierre-review.sqlite'), 'utf8')).toBe('db');
    // Never a second move into an existing ~/.ensemble.
    expect(migrateLegacyDataDir({ env: {}, home })).toEqual({ moved: false, reason: 'target_exists' });
    expect(resolveDataDir({}, home)).toBe(join(home, '.ensemble'));
  });

  it('never clobbers an existing ~/.ensemble', () => {
    seedLimn();
    mkdirSync(join(home, '.ensemble'));
    writeFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'newer');
    expect(migrateLegacyDataDir({ env: {}, home })).toEqual({ moved: false, reason: 'target_exists' });
    expect(readFileSync(join(home, '.ensemble', 'pierre-review.sqlite'), 'utf8')).toBe('newer');
    expect(readFileSync(join(home, '.limn', 'pierre-review.sqlite'), 'utf8')).toBe('limn-db');
  });

  it('a path pinned inside ~/.limn stops the move', () => {
    seedLimn();
    const r = migrateLegacyDataDir({ env: { DATABASE_URL: join(home, '.limn', 'pierre-review.sqlite') }, home });
    expect(r).toEqual({ moved: false, reason: 'pinned_path' });
    expect(resolveDataDir({}, home)).toBe(join(home, '.limn'));
  });
});

describe('defaultDocsDir — one reference-docs root per database', () => {
  it("keeps <dataDir>/docs for the data directory's own database (the installed CLI)", () => {
    expect(defaultDocsDir('/h/.limn/pierre-review.sqlite', '/h/.limn')).toBe('/h/.limn/docs');
  });

  it('gives any other database its own non-numeric folder under <dataDir>/docs', () => {
    const dev = defaultDocsDir('/repo/apps/backend/data/pierre-review.sqlite', '/h/.limn');
    const worktree = defaultDocsDir('/repo/.claude/worktrees/x/apps/backend/data/pierre-review.sqlite', '/h/.limn');
    const other = defaultDocsDir('/h/.limn/other.sqlite', '/h/.limn');
    for (const d of [dev, worktree, other]) expect(d).toMatch(/^\/h\/\.limn\/docs\/db-[0-9a-f]{12}$/);
    expect(new Set([dev, worktree, other]).size).toBe(3);
    // Stable: the same database always lands in the same folder.
    expect(defaultDocsDir('/repo/apps/backend/data/pierre-review.sqlite', '/h/.limn')).toBe(dev);
  });
});
