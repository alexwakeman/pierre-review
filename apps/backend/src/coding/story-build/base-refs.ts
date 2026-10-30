import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { repoCloneDir, withRepoLock } from '../../review/clone-manager.js';

// A BUILD'S BASE COMMITS, PINNED ("Implement story", docs/STORY-BUILD.md § Base refs).
//
// The plan's first pass FIXES each repository's base commit, and every re-plan, build, retry and push
// checks out that same sha — possibly days later. The fetch refs the clone uses (`refs/pierre/story-plan-
// base`, `…/story-build-base`) are SHARED and move with the next fetch, and a stacked PR's head is fetched
// with no ref at all, so a long-open session's base was reachable from nothing: the conflict janitor's
// `gc --prune=now` (or any repack) could drop it. So every base gets its OWN ref,
// `refs/pierre/story-build/<buildId>/<repoId>`, written at the plan's checkout and again by each build pass,
// and deleted when the session no longer needs it: on Discard, once every included repository is pushed,
// and by the worktree sweep for any session that is no longer open.

const execFileAsync = promisify(execFile);
export const STORY_BUILD_REF_PREFIX = 'refs/pierre/story-build/';

/** The ref pinning one repository's base commit in one session. */
export function storyBuildBaseRef(buildId: number, repoId: number): string {
  return `${STORY_BUILD_REF_PREFIX}${buildId}/${repoId}`;
}

/** `{buildId, repoId}` of one of these refs, or null (an unrecognised ref is KEPT, never guessed at). */
export function parseStoryBuildBaseRef(ref: string): { buildId: number; repoId: number } | null {
  if (!ref.startsWith(STORY_BUILD_REF_PREFIX)) return null;
  const m = /^(\d+)\/(\d+)$/.exec(ref.slice(STORY_BUILD_REF_PREFIX.length));
  if (m == null) return null;
  return { buildId: Number(m[1]), repoId: Number(m[2]) };
}

async function gitOut(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** Point the session's ref at `sha` (the caller holds the repo lock and the commit is in the store). */
export async function pinStoryBuildBase(cloneDir: string, buildId: number, repoId: number, sha: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(sha)) return;
  await gitOut(cloneDir, ['update-ref', storyBuildBaseRef(buildId, repoId), sha]);
}

/** The session's refs in one clone (all of the session's, or one repository's). Takes the repo lock. */
export async function dropStoryBuildBaseRefs(fullName: string, buildId: number, repoId?: number): Promise<void> {
  const i = fullName.indexOf('/');
  if (i <= 0) return;
  const owner = fullName.slice(0, i);
  const name = fullName.slice(i + 1);
  const dir = repoCloneDir(owner, name);
  if (!existsSync(join(dir, '.git'))) return;
  await withRepoLock(`${owner}/${name}`, async () => {
    const prefix = repoId != null ? storyBuildBaseRef(buildId, repoId) : `${STORY_BUILD_REF_PREFIX}${buildId}/`;
    const refs = (await gitOut(dir, ['for-each-ref', '--format=%(refname)', prefix]).catch(() => ''))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const ref of refs) await gitOut(dir, ['update-ref', '-d', ref]).catch(() => {});
  });
}

/**
 * The sweep: every clone's `refs/pierre/story-build/*` whose (session, repository) `keep` does not hold
 * is deleted, under the repo lock. Sequential (git does not scale with concurrency here); never throws.
 */
export async function sweepStoryBuildBaseRefs(
  keep: (refs: ReadonlyArray<{ buildId: number; repoId: number }>) => Promise<ReadonlySet<string>>,
  cloneRoot: string = config.cloneDir,
): Promise<number> {
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(cloneRoot);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const dir = join(cloneRoot, entry);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, '.git'))) continue;
    } catch {
      continue;
    }
    // `owner__name`: the FIRST `__` splits it (a login has no underscore; a repository name may).
    const split = entry.indexOf('__');
    if (split <= 0) continue;
    const owner = entry.slice(0, split);
    const name = entry.slice(split + 2);
    try {
      await withRepoLock(`${owner}/${name}`, async () => {
        const refs = (await gitOut(dir, ['for-each-ref', '--format=%(refname)', STORY_BUILD_REF_PREFIX]))
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const parsed = refs.map((ref) => ({ ref, key: parseStoryBuildBaseRef(ref) })).filter((x) => x.key != null);
        if (parsed.length === 0) return;
        const kept = await keep(parsed.map((p) => p.key!));
        for (const p of parsed) {
          if (kept.has(`${p.key!.buildId}/${p.key!.repoId}`)) continue;
          await gitOut(dir, ['update-ref', '-d', p.ref]).then(
            () => {
              deleted += 1;
            },
            () => {},
          );
        }
      });
    } catch {
      /* this clone next time */
    }
  }
  return deleted;
}

/** Every ref of one session, across the repositories it read (`candidates_json`). Never throws. */
export async function dropSessionBaseRefs(fullNames: readonly string[], buildId: number): Promise<void> {
  for (const n of new Set(fullNames)) await dropStoryBuildBaseRefs(n, buildId).catch(() => {});
}
