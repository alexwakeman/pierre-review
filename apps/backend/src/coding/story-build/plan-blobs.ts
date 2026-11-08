// A PLAN'S CODE EVIDENCE, READ ON THE HOST (docs/SANDBOX.md § The plan and its checks). One file at the
// session's pinned base commit (`story_build_repos.base_sha`, kept alive by `refs/pierre/story-build/<id>/
// <repo>`), read from Limn's clone cache — never from the sandbox, whose refs and even whose `git` the agent
// controls. Hooks and the reader's config are off (merge-verify.ts `mergeGitEnv`); the cache is blobless,
// so a missing blob is fetched lazily with the token only in a process-scoped `insteadOf`.
import { execFile } from 'node:child_process';
import { mergeGitEnv } from '../ai-fix/merge-verify.js';
import { EVIDENCE_BLOB_MAX_BYTES } from './plan-verify.js';

const SHA = /^[0-9a-f]{40}$/;
const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function git(dir: string, args: string[], token: string | null): Promise<{ code: number; stdout: Buffer }> {
  const pre = token ? ['-c', `url.https://x-access-token:${token}@github.com/.insteadOf=https://github.com/`] : [];
  return new Promise((resolve) => {
    execFile(
      'git',
      [...HARDEN, ...pre, '-C', dir, ...args],
      { env: mergeGitEnv({ GIT_NO_LAZY_FETCH: '0' }), timeout: 60_000, maxBuffer: EVIDENCE_BLOB_MAX_BYTES + 1024, encoding: 'buffer' },
      (err, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
        if (err) return resolve({ code: typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1, stdout: out });
        resolve({ code: 0, stdout: out });
      },
    );
  });
}

/** The blob at `sha:path` in a git directory, or null (not a file there, too large, unreadable). */
export async function readBlobAt(dir: string, sha: string, path: string, token: string | null = null): Promise<Buffer | null> {
  if (!SHA.test(sha) || path === '' || path.startsWith('-')) return null;
  const spec = `${sha}:${path}`;
  const type = await git(dir, ['cat-file', '-t', spec], token);
  if (type.code !== 0 || type.stdout.toString('utf8').trim() !== 'blob') return null;
  const size = await git(dir, ['cat-file', '-s', spec], token);
  if (size.code !== 0 || Number(size.stdout.toString('utf8').trim()) > EVIDENCE_BLOB_MAX_BYTES) return null;
  const blob = await git(dir, ['cat-file', 'blob', spec], token);
  return blob.code === 0 ? blob.stdout : null;
}

/** The real seam: the repository's clone cache, under its lock. */
export async function readSessionBaseBlob(accountId: number, fullName: string, sha: string, path: string): Promise<Buffer | null> {
  const i = fullName.indexOf('/');
  if (i <= 0) return null;
  const owner = fullName.slice(0, i);
  const name = fullName.slice(i + 1);
  const cm = await import('../../review/clone-manager.js');
  const token = await (await import('../../auth/account.js')).getAccessToken(accountId).catch(() => null);
  return cm.withRepoLock(`${owner}/${name}`, () => readBlobAt(cm.repoCloneDir(owner, name), sha, path, token));
}
