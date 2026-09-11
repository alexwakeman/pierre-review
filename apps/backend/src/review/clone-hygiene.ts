import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

// Credential + disk hygiene for the shared clone cache under config.cloneDir.
//
// The cache is keyed `owner__name` and SHARED ACROSS ACCOUNTS (in cloud two tenants can
// watch the same repo), so a token that reaches `.git/config` is readable by every other
// account on the box and by anything that backs the home directory up. This module is the
// one place that decides what a clone on disk is allowed to contain: a token-LESS origin,
// owner-only permissions, and no worktree older than the TTL.
//
// It deliberately imports NOTHING from clone-manager.ts — clone-manager imports this, and
// the startup sweep needs `liveWorktrees` without the cycle.

const execFileAsync = promisify(execFile);

/** Run git and hand back stdout. Rejects on a non-zero exit; callers decide what that means. */
async function gitOut(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** The token-less https URL a clone's `origin` remote is set to on disk. */
export function plainUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

/**
 * Rewrite https://github.com/ → the tokenized form for THIS git invocation only.
 * ⚠ POSITION IS LOAD-BEARING: `-c` BEFORE the subcommand is the process-scoped form
 * (passed to children via GIT_CONFIG_PARAMETERS, never written into the new repo).
 * `git clone -c …` — AFTER the subcommand — is `--config` and WOULD persist it, which is
 * exactly the defect this replaces: a `remote set-url` afterwards is a repair, and a repair
 * that runs in a `.catch(() => {})` is not a guarantee.
 */
function insteadOfArgs(token: string): string[] {
  return [
    '-c',
    `url.https://x-access-token:${token}@github.com/.insteadOf=https://github.com/`,
  ];
}

/**
 * The full argv for a blobless, checkout-less clone. The POSITIONAL url is the plain one —
 * the token exists only in the process-scoped `-c` that precedes `clone`.
 */
export function cloneArgv(
  owner: string,
  name: string,
  token: string,
  dir: string,
): string[] {
  return [
    ...insteadOfArgs(token),
    'clone',
    '--filter=blob:none',
    '--no-checkout',
    plainUrl(owner, name),
    dir,
  ];
}

/**
 * Does this URL carry userinfo (`user:pass@host`) in its AUTHORITY?
 * ⚠ Not "does it contain an @": `git@github.com:o/n` is scp-like syntax with no scheme and
 * no userinfo to leak, and `https://github.com/o/n@2.git` has the `@` in the PATH.
 */
export function urlHasUserinfo(url: string): boolean {
  const scheme = url.indexOf('://');
  if (scheme < 0) return false;
  const authority = url.slice(scheme + 3);
  const end = authority.search(/[/?#]/);
  return (end < 0 ? authority : authority.slice(0, end)).includes('@');
}

export type CleanOriginOutcome = 'clean' | 'repaired' | 'removed';

/**
 * Fail-closed credential check for one clone: repair a tokenized `origin`, then re-read the
 * WHOLE local config and DELETE the clone if any credential survived. A clone is a
 * rebuildable cache — losing one costs a fetch; leaving a live token on disk costs the token.
 * `origin` is not the only hiding place (an `insteadOf` written by an old `clone --config`,
 * a second remote left by a crashed run), which is why the second read is unconditional.
 */
export async function assertCleanOrigin(
  dir: string,
  owner: string,
  name: string,
): Promise<CleanOriginOutcome> {
  let repaired = false;
  const origin = await gitOut([
    '-C',
    dir,
    'config',
    '--local',
    '--get',
    'remote.origin.url',
  ]).catch(() => '');
  if (urlHasUserinfo(origin.trim())) {
    await gitOut(['-C', dir, 'remote', 'set-url', 'origin', plainUrl(owner, name)]).catch(
      () => {},
    );
    repaired = true;
  }
  const local = await gitOut(['-C', dir, 'config', '--local', '--list']).catch(() => '');
  if (/https:\/\/[^\/\s]*@github\.com/i.test(local)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* couldn't delete — the caller still learns it is not clean */
    }
    return 'removed';
  }
  return repaired ? 'repaired' : 'clean';
}

/** chmod one path, but only when the mode actually differs, so the sweep's count is honest. */
function chmodTo(path: string, mode: number): boolean {
  try {
    if ((statSync(path).mode & 0o777) === mode) return false;
    chmodSync(path, mode);
    return true;
  } catch {
    /* missing, or a filesystem where chmod means nothing — never fatal */
    return false;
  }
}

/**
 * Owner-only on the clone ROOT and its parent. `mkdirSync`'s `mode` applies only on CREATE,
 * so a directory made before this rule existed keeps its 0755 forever unless something
 * chmods it (the db/client.ts precedent). Each chmod is swallowed individually.
 */
export function tightenCloneRoot(): void {
  for (const dir of [dirname(config.cloneDir), config.cloneDir]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }
}

/** Owner-only on one clone's tree and its `.git/config`. True if anything needed changing. */
export function tightenClonePerms(dir: string): boolean {
  const tree = chmodTo(dir, 0o700);
  const gitConfig = chmodTo(join(dir, '.git', 'config'), 0o600);
  return tree || gitConfig;
}

/**
 * Worktree paths THIS PROCESS created, → the ms it created them.
 * ⚠ IDENTITY, NOT AGE. A long agent run touches nothing under its worktree for hours, so an
 * mtime test alone deletes a tree out from under a running review. Every consumer asks this
 * map first and only then looks at the clock.
 */
export const liveWorktrees = new Map<string, number>();

/**
 * Does `repoDir` hold a worktree we must not evict? A worktree this process owns always
 * counts; anything else counts only while it is younger than config.worktreeTtlMs.
 * ⚠ This replaced a bare "is `.worktrees/` non-empty" test, under which ONE orphan left by a
 * crashed run pinned a whole repo clone in the cache forever.
 */
export function hasFreshWorktrees(repoDir: string, now: number): boolean {
  const root = join(repoDir, '.worktrees');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    if (liveWorktrees.has(full)) return true;
    try {
      if (now - statSync(full).mtimeMs < config.worktreeTtlMs) return true;
    } catch {
      /* vanished mid-scan — not fresh */
    }
  }
  return false;
}

export interface CloneHygieneReport {
  scanned: number;
  credentialsRepaired: number;
  clonesRemoved: number;
  permissionsTightened: number;
  worktreeRecordsPruned: number;
  worktreeDirsRemoved: number;
}

/**
 * `git worktree prune -v` prints one "Removing …" line per dropped record —
 * ⚠ on STDERR, not stdout (verified on git 2.54), so counting stdout reports zero forever.
 */
async function pruneWorktreeRecords(dir: string): Promise<number> {
  const { stderr, stdout } = await execFileAsync(
    'git',
    ['-C', dir, 'worktree', 'prune', '--verbose'],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return `${stdout}\n${stderr}`.split('\n').filter((l) => l.startsWith('Removing')).length;
}

/** Delete every `.worktrees/<entry>` this process does not own that is past the TTL. */
function removeStaleWorktreeDirs(dir: string, now: number): number {
  const root = join(dir, '.worktrees');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = join(root, entry);
    if (liveWorktrees.has(full)) continue;
    try {
      if (now - statSync(full).mtimeMs < config.worktreeTtlMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* leave it and move on */
    }
  }
  return removed;
}

/**
 * Drop the conflict-resolver's fetch refs. No resolver job survives a restart, so at boot
 * every `refs/pierre/conflict/*` is an orphan by definition and each one pins objects.
 */
async function deleteConflictRefs(dir: string): Promise<void> {
  const out = await gitOut([
    '-C',
    dir,
    'for-each-ref',
    '--format=%(refname)',
    'refs/pierre/conflict/',
  ]);
  for (const ref of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    await gitOut(['-C', dir, 'update-ref', '-d', ref]).catch(() => {});
  }
}

/**
 * Walk every clone in the cache once: repair credentials, tighten permissions, prune dead
 * worktree records, delete worktree directories past the TTL, prune again (the deletes above
 * just orphaned their records), and drop the resolver's fetch refs.
 *
 * Every step is individually try/caught: one unreadable clone must not stop the sweep, and
 * the sweep must never be the reason the server does not start. `now` is a parameter so a
 * test can age a worktree without touching the clock.
 */
export async function sweepCloneCache(
  now: number = Date.now(),
): Promise<CloneHygieneReport> {
  const report: CloneHygieneReport = {
    scanned: 0,
    credentialsRepaired: 0,
    clonesRemoved: 0,
    permissionsTightened: 0,
    worktreeRecordsPruned: 0,
    worktreeDirsRemoved: 0,
  };
  tightenCloneRoot();

  let entries: string[];
  try {
    entries = readdirSync(config.cloneDir);
  } catch {
    return report;
  }

  for (const entry of entries) {
    const dir = join(config.cloneDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(dir, '.git'))) continue;
    // `owner__name` is the key ensureClone minted. The FIRST `__` splits it: a GitHub login
    // cannot contain an underscore, a repository name can.
    const split = entry.indexOf('__');
    if (split <= 0) continue;
    const owner = entry.slice(0, split);
    const name = entry.slice(split + 2);
    report.scanned++;

    try {
      const outcome = await assertCleanOrigin(dir, owner, name);
      if (outcome === 'repaired') report.credentialsRepaired++;
      if (outcome === 'removed') {
        report.clonesRemoved++;
        continue;
      }
    } catch {
      /* couldn't read this clone's config — leave the rest of the sweep to the next boot */
      continue;
    }

    try {
      if (tightenClonePerms(dir)) report.permissionsTightened++;
    } catch {
      /* best-effort */
    }
    try {
      report.worktreeRecordsPruned += await pruneWorktreeRecords(dir);
    } catch {
      /* best-effort */
    }
    try {
      report.worktreeDirsRemoved += removeStaleWorktreeDirs(dir, now);
    } catch {
      /* best-effort */
    }
    try {
      report.worktreeRecordsPruned += await pruneWorktreeRecords(dir);
    } catch {
      /* best-effort */
    }
    try {
      await deleteConflictRefs(dir);
    } catch {
      /* best-effort */
    }
  }
  return report;
}
