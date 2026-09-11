import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { codedError } from './git.js';

// Where a write is allowed to land inside a checked-out worktree.
//
// File paths reach the coding seams from adapter plans whose locations can be influenced by
// REPO CONTENT (a T3 manifest proposes a configPath), i.e. attacker-suppliable in cloud. Two
// guards, and NEITHER is sufficient alone:
//   - assertSafeTargetPath is LEXICAL and runs before any side effect;
//   - resolveContainedTargetPath is FILESYSTEM and runs after checkout, immediately before
//     the write, because a committed symlink is a real directory entry and no amount of
//     string inspection can see it.

/**
 * Lexical: repo-relative, no traversal, no drive letter, no `.git` segment at ANY depth,
 * case-folded. Throws a coded 'APPLY_FAILED'.
 * ⚠ `.git` is checked per SEGMENT and case-INSENSITIVELY: the predecessor anchored it at the
 * root (`norm === '.git' || norm.startsWith('.git/')`), so `a/.git/hooks/pre-commit` — a hook
 * git runs on the next commit — sailed through, and `.GIT/config` did too on macOS.
 */
export function assertSafeTargetPath(path: string): void {
  const norm = path.replace(/\\/g, '/');
  const segments = norm.split('/');
  if (
    !norm ||
    norm.startsWith('/') ||
    /^[A-Za-z]:/.test(norm) ||
    segments.some(
      (s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git',
    )
  ) {
    throw codedError('APPLY_FAILED', `invalid target path: ${path}`);
  }
}

/**
 * Containment: resolve every EXISTING component of `<root>/<path>` and assert the result
 * stays inside `<root>`. Returns the absolute path to write to.
 *
 * ⚠ A COMMITTED SYMLINK IS A REAL DIRECTORY ENTRY, so `link/evil.txt` is traversal-free text
 * that writes wherever `link` points — outside the worktree, with no `..` anywhere in it. An
 * in-tree symlink is REFUSED outright rather than followed: git records the LINK, not the
 * target, so a repo can ship one and nothing about writing through it is ever intended.
 * ⚠ realpath the ROOT too — /tmp is a symlink to /private/tmp on macOS, and comparing an
 * unresolved root against a resolved child refuses every legitimate write.
 *
 * Call AFTER checkout, IMMEDIATELY before the mkdir/write.
 */
export function resolveContainedTargetPath(root: string, path: string): string {
  assertSafeTargetPath(path);

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw codedError('APPLY_FAILED', `worktree root is not readable: ${root}`);
  }

  let current = realRoot;
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    const next = join(current, segment);
    let entry;
    try {
      entry = lstatSync(next);
    } catch {
      // Nothing there yet — this segment and everything after it is ours to create, and a
      // path that does not exist cannot redirect us anywhere.
      current = next;
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw codedError(
        'APPLY_FAILED',
        `refusing to write through the symlink ${segment} in ${path}`,
      );
    }
    current = next;
  }

  if (current !== realRoot && !current.startsWith(realRoot + sep)) {
    throw codedError('APPLY_FAILED', `target path escapes the worktree: ${path}`);
  }
  return current;
}
