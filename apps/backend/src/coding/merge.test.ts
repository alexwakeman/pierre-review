import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasConflictMarkers } from './merge.js';

// Exercises (a) the exported conflict-marker verifier and (b) the exact git mechanics
// coding/merge.ts relies on — `format-patch`→`git am` (rebase artifact replay), the
// trial-merge conflict probe, the `merge-base --is-ancestor` up-to-date short-circuit,
// and `--force-with-lease` — against REAL throwaway repos, so a git-behaviour or
// version regression is caught locally (no network).

let dir: string;

function git(args: string[], cwd = dir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function initRepo(at: string): void {
  git(['init', '-q', '-b', 'main'], at);
  git(['config', 'user.email', 'test@example.com'], at);
  git(['config', 'user.name', 'Test'], at);
  git(['config', 'commit.gpgsign', 'false'], at);
}

function commit(at: string, file: string, body: string, message: string): string {
  writeFileSync(join(at, file), body);
  git(['add', '-A'], at);
  git(['commit', '-q', '-m', message], at);
  return git(['rev-parse', 'HEAD'], at).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pierre-merge-test-'));
  initRepo(dir);
  commit(dir, 'a.txt', 'line1\nline2\nline3\n', 'base');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('hasConflictMarkers', () => {
  it('detects the unambiguous open/close markers', () => {
    expect(
      hasConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\nb\n'),
    ).toBe(true);
    expect(hasConflictMarkers('a\n||||||| base\n')).toBe(true);
  });

  it('does not false-positive on a bare ======= divider (real markdown/rst)', () => {
    expect(hasConflictMarkers('Title\n=======\n\nbody text\n')).toBe(false);
    expect(hasConflictMarkers('const x = 1;\n')).toBe(false);
  });
});

describe('format-patch → git am round-trip (the rebase artifact replay)', () => {
  it('replays the PR commits onto a MOVED trunk, preserving them', () => {
    // Two "PR" commits on top of base.
    const base = git(['rev-parse', 'HEAD']).trim();
    commit(dir, 'a.txt', 'line1\nline2 CHANGED\nline3\n', 'pr: edit line2');
    commit(dir, 'feature.txt', 'new feature\n', 'pr: add feature');

    // The mbox artifact = the PR commits, exactly as coding/merge.ts captures it.
    const mbox = git(['format-patch', '--stdout', `${base}..HEAD`]);
    expect(mbox).toContain('pr: edit line2');
    expect(mbox).toContain('pr: add feature');

    // Advance the trunk with a NON-conflicting change, then replay the artifact onto it.
    git(['checkout', '-q', base]);
    commit(dir, 'trunk.txt', 'trunk moved\n', 'trunk: unrelated advance');
    const movedTrunk = git(['rev-parse', 'HEAD']).trim();

    const mboxFile = join(dir, 'series.mbox');
    writeFileSync(mboxFile, mbox);
    git(['am', '--3way', mboxFile]);

    // The replayed tip contains BOTH PR commits (preserved) on top of the moved trunk.
    const log = git(['log', '--format=%s', `${movedTrunk}..HEAD`]);
    expect(log).toContain('pr: edit line2');
    expect(log).toContain('pr: add feature');
    // …and the moved-trunk file is present (we're based on it).
    expect(git(['cat-file', '-t', `HEAD:trunk.txt`]).trim()).toBe('blob');
  });
});

describe('trial-merge conflict probe + abort', () => {
  it('detects conflicts, lists the files, and abort restores the tree', () => {
    const base = git(['rev-parse', 'HEAD']).trim();
    // Fix branch (detached, like the worktree): change line2 one way.
    commit(dir, 'a.txt', 'line1\nFIX\nline3\n', 'fix: line2');
    const fixTip = git(['rev-parse', 'HEAD']).trim();

    // Trunk: change the SAME line the other way.
    git(['branch', '-q', 'trunk', base]);
    git(['checkout', '-q', 'trunk']);
    commit(dir, 'a.txt', 'line1\nTRUNK\nline3\n', 'trunk: line2');
    const trunkTip = git(['rev-parse', 'HEAD']).trim();

    // Back on the fix tip, the trial merge conflicts.
    git(['checkout', '-q', fixTip]);
    let conflicted = false;
    try {
      git(['merge', '--no-commit', '--no-ff', trunkTip]);
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    const files = git(['diff', '--name-only', '--diff-filter=U']).trim();
    expect(files).toBe('a.txt');

    // Abort restores the fix tip cleanly.
    git(['merge', '--abort']);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(fixTip);
    expect(git(['status', '--porcelain']).trim()).toBe('');
  });

  it('a non-conflicting trunk merges cleanly (no conflict files)', () => {
    const base = git(['rev-parse', 'HEAD']).trim();
    commit(dir, 'fix.txt', 'fix\n', 'fix: add');
    const fixTip = git(['rev-parse', 'HEAD']).trim();
    git(['branch', '-q', 'trunk', base]);
    git(['checkout', '-q', 'trunk']);
    commit(dir, 'other.txt', 'trunk\n', 'trunk: add other');
    const trunkTip = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', fixTip]);
    git(['merge', '--no-commit', '--no-ff', trunkTip]); // succeeds
    expect(git(['diff', '--name-only', '--diff-filter=U']).trim()).toBe('');
    git(['merge', '--abort']);
  });
});

describe('already-up-to-date short-circuit (merge-base --is-ancestor)', () => {
  it('is-ancestor is true when the fix already contains the trunk tip', () => {
    const trunkTip = git(['rev-parse', 'HEAD']).trim();
    commit(dir, 'fix.txt', 'fix\n', 'fix: on top of trunk');
    const fixTip = git(['rev-parse', 'HEAD']).trim();
    // trunkTip IS an ancestor of fixTip → up to date.
    expect(() =>
      git(['merge-base', '--is-ancestor', trunkTip, fixTip]),
    ).not.toThrow();
    // A diverged commit is NOT an ancestor.
    git(['checkout', '-q', trunkTip]);
    const diverged = commit(dir, 'z.txt', 'z\n', 'diverged');
    let isAncestor = true;
    try {
      git(['merge-base', '--is-ancestor', diverged, fixTip]);
    } catch {
      isAncestor = false;
    }
    expect(isAncestor).toBe(false);
  });
});

describe('--force-with-lease guard', () => {
  it('rejects a stale lease and accepts a fresh one', () => {
    // A bare repo acts as the remote.
    const remote = mkdtempSync(join(tmpdir(), 'pierre-remote-'));
    git(['init', '-q', '--bare', '-b', 'main'], remote);

    // Clone, push an initial feature branch.
    const clone = mkdtempSync(join(tmpdir(), 'pierre-clone-'));
    git(['clone', '-q', remote, clone], process.cwd());
    initRepo(clone); // set identity in the clone
    commit(clone, 'f.txt', 'v1\n', 'feat v1');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/feat'], clone);
    const oldSha = git(['rev-parse', 'HEAD'], clone).trim();

    // Someone else advances the remote branch out from under us.
    const other = mkdtempSync(join(tmpdir(), 'pierre-other-'));
    git(['clone', '-q', '-b', 'feat', remote, other], process.cwd());
    initRepo(other);
    commit(other, 'f.txt', 'v2 from someone else\n', 'feat v2');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/feat'], other);

    // Our rewritten history, pushed with a STALE lease (expects oldSha) → rejected.
    commit(clone, 'f.txt', 'v1 rebased\n', 'feat v1 rebased');
    let staleRejected = false;
    try {
      git(
        [
          'push',
          `--force-with-lease=refs/heads/feat:${oldSha}`,
          'origin',
          'HEAD:refs/heads/feat',
        ],
        clone,
      );
    } catch {
      staleRejected = true;
    }
    expect(staleRejected).toBe(true);

    // With the CURRENT remote sha as the lease, the force push is accepted.
    git(['fetch', '-q', 'origin'], clone);
    const currentSha = git(['rev-parse', 'origin/feat'], clone).trim();
    expect(() =>
      git(
        [
          'push',
          `--force-with-lease=refs/heads/feat:${currentSha}`,
          'origin',
          'HEAD:refs/heads/feat',
        ],
        clone,
      ),
    ).not.toThrow();

    for (const d of [remote, clone, other]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
