// THE COMPOSE FILES A READER CAN PICK (Settings → Sandbox → Services; docs/SANDBOX.md § Services → Which
// files). Every compose file of every workspace repository, read from LIMN'S OWN CLONE CACHE: file NAMES
// only (`git ls-tree`), so the blobless cache answers without a download — `GIT_NO_LAZY_FETCH=1` makes
// sure of it. No network, no GitHub call, nothing from the reader's own checkout.
//
// The tree read is the newest of the cache's default-branch refs (the clone's own branch, the remote's
// HEAD, the ticket default-branch ref a review fetched). A repository Limn has never copied says so.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxComposeRepoFiles } from '@pierre-review/shared';
import { repoCloneDir } from '../../review/clone-manager.js';

const run = promisify(execFile);

/** Files per repository at most (a repository with more names the first, sorted). */
export const COMPOSE_FILES_MAX = 50;

/** `compose.yml`, `compose.dev.yaml`, `docker-compose.yml`, `docker-compose-test.yaml`, `docker-compose.override.yml` … */
const COMPOSE_NAME = /^(docker-)?compose([.-][A-Za-z0-9_.-]+)?\.ya?ml$/i;
/** Folders whose compose files are someone else's: dependencies, vendored code. */
const SKIP_SEGMENTS = new Set(['node_modules', 'vendor', 'third_party', 'bower_components']);

/** A path inside a repository that names a compose file Limn offers. Pure. */
export function isComposeCandidate(path: string): boolean {
  const parts = path.split('/');
  const base = parts[parts.length - 1] ?? '';
  return COMPOSE_NAME.test(base) && !parts.slice(0, -1).some((p) => SKIP_SEGMENTS.has(p));
}

/** Every git call here: no hooks, no fsmonitor, no lazy fetch, no prompt. */
const GIT_ENV = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const git = async (dir: string, args: string[]): Promise<string> =>
  (await run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env: GIT_ENV, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The newest default-branch commit the cache holds, or null. */
async function newestTip(dir: string): Promise<string | null> {
  const out = await git(dir, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=1',
    '--format=%(objectname)',
    'refs/pierre/ticket-default-branch',
    'refs/heads',
    'refs/remotes/origin',
  ]).catch(() => '');
  const sha = out.trim().split('\n')[0] ?? '';
  if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
  const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')).trim();
  return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
}

/** The compose files of one cached repository. null: Limn has no copy of it. */
export async function composeFilesInClone(dir: string): Promise<string[] | null> {
  if (!existsSync(join(dir, '.git'))) return null;
  const tip = await newestTip(dir);
  if (tip == null) return [];
  const out = await git(dir, ['ls-tree', '-r', '--name-only', '-z', tip]).catch(() => '');
  return out
    .split('\0')
    .filter((p) => p !== '' && isComposeCandidate(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, COMPOSE_FILES_MAX);
}

export async function listComposeFiles(repos: ReadonlyArray<{ owner: string; name: string }>, cloneDirOf = repoCloneDir): Promise<SandboxComposeRepoFiles[]> {
  return Promise.all(
    repos.map(async (r) => {
      const files = await composeFilesInClone(cloneDirOf(r.owner, r.name)).catch(() => null);
      return { repo: `${r.owner}/${r.name}`, files: files ?? [], copied: files != null };
    }),
  );
}
