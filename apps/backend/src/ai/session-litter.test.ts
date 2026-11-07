import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_CLEANUP_FLAG,
  cleanSessionLitter,
  litterPrefixes,
  projectKey,
  recordSessionCleanup,
  runBootSessionCleanup,
  sessionCleanupDone,
  type SessionCleanupPlaces,
} from './session-litter.js';

// A fixture tree shaped like the owner's machine: the home is /Users/alex, the data dir ~/.limn,
// the temp dir /var/folders/ct/x/T whose realpath is /private/var/folders/ct/x/T.
const HOME = '/Users/alex';
const TMP = '/var/folders/ct/x/T';
const REAL_TMP = '/private/var/folders/ct/x/T';

const LIMN = [
  '-Users-alex--limn-clones-DEFRA--bng-library--worktrees-00e7333236fbaac67acc0ac15d074ca184577714-7433-112',
  '-Users-alex--limn-docs-1-1-library',
  '-Users-alex--pierre-review-clones-acme--web--worktrees-abc',
  '-private-var-folders-ct-x-T-limn-sprint-paths-Ab12Cd',
  '-private-var-folders-ct-x-T-pierre-ticket-review-Xy9',
  '-private-var-folders-ct-x-T-pierre-diagram-q1',
  '-var-folders-ct-x-T-limn-storyplan-zz',
];
const KEPT = [
  '-Users-alex-Projects-pierre-review',
  '-Users-alex-Projects-pierre-review-apps-backend',
  '-Users-alex-Projects-DEFRA-bng-fe-be-bng-metric-harness',
  '-Users-alex--limnish-notes', // a different directory: ~/.limnish
  '-Users-alex--limn', // the data dir itself, never a Limn run's cwd
  '-private-var-folders-ct-x-T', // the bare temp dir
  '-private-var-folders-ct-x-T-stories-agent-a9CtuA', // not a Limn prefix
  '-private-var-folders-ct-x-T-limnfoo', // no dash after limn
];

let root: string;
let places: SessionCleanupPlaces;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-litter-test-'));
  const projectsDir = join(root, 'projects');
  const dataDir = join(root, 'data');
  mkdirSync(projectsDir);
  mkdirSync(dataDir);
  for (const n of [...LIMN, ...KEPT]) {
    mkdirSync(join(projectsDir, n, 'memory'), { recursive: true });
    writeFileSync(join(projectsDir, n, 'session.jsonl'), '{}\n');
  }
  // The prefixes are computed from these paths, not from the fixture's real location.
  places = { projectsDir, dataDir: `${HOME}/.limn`, home: HOME, tmpDirs: [TMP, REAL_TMP] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const left = (): string[] => readdirSync(places.projectsDir).sort();

describe('projectKey', () => {
  it('replaces every non-alphanumeric character with a dash, as Claude Code does', () => {
    expect(projectKey('/Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-harness')).toBe(
      '-Users-alex-Projects-DEFRA-bng-fe-be-bng-metric-harness',
    );
    expect(projectKey('/Users/alex/.limn')).toBe('-Users-alex--limn');
  });
});

describe('litterPrefixes', () => {
  it('names the data dir, the legacy data dir and both spellings of the temp dir', () => {
    expect(litterPrefixes(places)).toEqual([
      '-Users-alex--limn-',
      '-Users-alex--pierre-review-',
      '-var-folders-ct-x-T-limn-',
      '-var-folders-ct-x-T-pierre-',
      '-private-var-folders-ct-x-T-limn-',
      '-private-var-folders-ct-x-T-pierre-',
    ]);
  });

  it('refuses a data dir that is the home, contains it, is the root, or contains the temp dir', () => {
    for (const dataDir of [HOME, '/Users', '/', '/private/var']) {
      const p = litterPrefixes({ ...places, dataDir });
      expect(p, dataDir).not.toContain(`${projectKey(dataDir)}-`);
      // The temp-dir rules still stand.
      expect(p).toContain('-private-var-folders-ct-x-T-limn-');
    }
    // A custom data dir elsewhere is fine.
    expect(litterPrefixes({ ...places, dataDir: '/srv/limn-data' })).toContain('-srv-limn-data-');
  });
});

describe('cleanSessionLitter', () => {
  it('a dry run lists exactly the Limn directories and deletes nothing', async () => {
    const r = await cleanSessionLitter(places, { dryRun: true });
    expect(r.matched.sort()).toEqual([...LIMN].sort());
    expect(r.kept).toBe(KEPT.length);
    expect(r.removed).toBe(0);
    expect(left()).toEqual([...LIMN, ...KEPT].sort());
  });

  it('removes the Limn directories and leaves every other one untouched', async () => {
    const r = await cleanSessionLitter(places);
    expect(r.removed).toBe(LIMN.length);
    expect(r.failed).toBe(0);
    expect(left()).toEqual([...KEPT].sort());
    for (const n of KEPT) expect(existsSync(join(places.projectsDir, n, 'session.jsonl'))).toBe(true);
  });

  it('never follows or removes a symlink, even with a Limn name', async () => {
    const target = join(root, 'precious');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    symlinkSync(target, join(places.projectsDir, '-Users-alex--limn-clones-link'));
    await cleanSessionLitter(places);
    expect(existsSync(join(places.projectsDir, '-Users-alex--limn-clones-link'))).toBe(true);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it('keeps a Limn-looking name whose transcript records a working directory that is not Limn\'s', async () => {
    // `~/.limn.bak/notes` and `~/.limn/bak-notes` share a key: the recorded cwd decides.
    const lookalike = '-Users-alex--limn-bak-notes';
    mkdirSync(join(places.projectsDir, lookalike));
    writeFileSync(join(places.projectsDir, lookalike, 'a.jsonl'), `${JSON.stringify({ cwd: '/Users/alex/.limn.bak/notes' })}\n`);
    const ours = '-Users-alex--limn-clones-acme--api--worktrees-1';
    mkdirSync(join(places.projectsDir, ours));
    writeFileSync(join(places.projectsDir, ours, 'b.jsonl'), `${JSON.stringify({ cwd: '/Users/alex/.limn/clones/acme/api/.worktrees/1' })}\n`);
    const tmpRun = '-private-var-folders-ct-x-T-limn-x1';
    mkdirSync(join(places.projectsDir, tmpRun));
    writeFileSync(join(places.projectsDir, tmpRun, 'c.jsonl'), `${JSON.stringify({ cwd: `${REAL_TMP}/limn-x1` })}\n`);
    await cleanSessionLitter(places);
    expect(existsSync(join(places.projectsDir, lookalike))).toBe(true);
    expect(existsSync(join(places.projectsDir, ours))).toBe(false);
    expect(existsSync(join(places.projectsDir, tmpRun))).toBe(false);
  });

  it('stops at the time limit and says so', async () => {
    let t = 0;
    const r = await cleanSessionLitter(places, { maxMs: 2, now: () => t++ });
    expect(r.timedOut).toBe(true);
    expect(r.removed).toBeLessThan(LIMN.length);
  });

  it('reports a missing projects directory', async () => {
    const r = await cleanSessionLitter({ ...places, projectsDir: join(root, 'nope') });
    expect(r).toMatchObject({ missing: true, matched: [], kept: 0 });
  });
});

describe('the one-time flag', () => {
  it('is written only after a complete real run', async () => {
    const dir = join(root, 'data');
    expect(recordSessionCleanup(dir, await cleanSessionLitter(places, { dryRun: true }))).toBe(false);
    expect(sessionCleanupDone(dir)).toBe(false);
    let t = 0;
    expect(recordSessionCleanup(dir, await cleanSessionLitter(places, { maxMs: 1, now: () => t++ }))).toBe(false);
    expect(sessionCleanupDone(dir)).toBe(false);
    expect(recordSessionCleanup(dir, await cleanSessionLitter(places))).toBe(true);
    expect(sessionCleanupDone(dir)).toBe(true);
  });

  it('a flag from another rule version does not count', () => {
    const dir = join(root, 'data');
    writeFileSync(join(dir, SESSION_CLEANUP_FLAG), JSON.stringify({ version: 0 }));
    expect(sessionCleanupDone(dir)).toBe(false);
    writeFileSync(join(dir, SESSION_CLEANUP_FLAG), 'not json');
    expect(sessionCleanupDone(dir)).toBe(false);
  });

  it('the boot run cleans once, then does not rescan', async () => {
    const dataDir = join(root, 'data');
    // The flag needs a real data dir, so the boot run's data-dir rule is the fixture's: the two
    // ~/.limn-keyed fixtures no longer match, an entry keyed by the fixture data dir does.
    const own = `${projectKey(dataDir)}-clones-x`;
    mkdirSync(join(places.projectsDir, own));
    const boot = { ...places, dataDir };
    const first = await runBootSessionCleanup(boot);
    expect(first?.removed).toBe(LIMN.length - 2 + 1);
    expect(sessionCleanupDone(dataDir)).toBe(true);
    mkdirSync(join(places.projectsDir, own));
    expect(await runBootSessionCleanup(boot)).toBeNull();
    expect(existsSync(join(places.projectsDir, own))).toBe(true);
  });
});
