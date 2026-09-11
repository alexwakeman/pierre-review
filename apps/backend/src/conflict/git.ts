import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The git environment for EVERY command the conflict resolver runs — discovery and landing
 * alike. Stricter than `coding/merge.ts`'s GIT_ENV on purpose.
 *
 * A developer's global git config must not change what we COMPUTE or what we COMMIT:
 * `merge.conflictStyle`, `diff.algorithm`, `diff.renames` and custom merge drivers all move
 * the answer. MEASURED: the same `merge-tree` on the same two commits wrote tree 0bc8605
 * with global config nulled and bf04533 with `merge.conflictStyle=zdiff3`.
 *
 * ⚠ EXPORTED because the land path seeds from merge-tree's tree — the user must not review
 * one merge and push another. In-tree `.gitattributes` stays honoured on purpose: it is part
 * of the repository, and turning it off would change how the repo's own owners merge.
 */
export const CONFLICT_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ADVICE: '0',
};

export interface GitOutput {
  code: number;
  stdout: Buffer;
  stderr: string;
}

// `merge-tree -z`, `diff-tree -z` and `cat-file --batch` are NUL-delimited and byte-oriented,
// and blobs are arbitrary bytes. Decoding stdout to a string anywhere in this pipeline is how
// a Latin-1 file becomes U+FFFD, so stdout is a Buffer the whole way down and only the strict
// UTF-8 gate in model.ts is allowed to turn bytes into text.
const MAX_BUFFER = 256 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

/** Run git, throwing on a non-zero exit (for the commands that MUST succeed). */
export async function git(
  args: string[],
  cwd: string,
  stdin?: Buffer,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: Buffer; stderr: string }> {
  const res = await gitTry(args, cwd, stdin, env);
  if (res.code !== 0) {
    throw new Error(
      `git ${args.slice(0, 3).join(' ')} failed (${res.code}): ${res.stderr.slice(0, 500)}`,
    );
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

/**
 * Run git WITHOUT throwing; returns the exit code plus output.
 *
 * `env` is MERGED OVER `CONFLICT_GIT_ENV`, for the two variables the land path needs and
 * that have no command-line equivalent: `GIT_INDEX_FILE` (the scratch index every tree is
 * built in, so the shared clone's own index is never touched) and `GIT_AUTHOR_*` (a rebased
 * commit keeps the original author while the account is the committer).
 *
 * ⚠ Several commands here exit non-zero on complete success — `merge-tree` exits 1 when it
 * finds conflicts, and the by-OID prefetch exits non-zero even when every object landed.
 * Callers branch on the OUTPUT, never on the code alone.
 */
export async function gitTry(
  args: string[],
  cwd: string,
  stdin?: Buffer,
  env?: NodeJS.ProcessEnv,
): Promise<GitOutput> {
  return new Promise<GitOutput>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        // ⚠ The overrides go AFTER the constant, never before: `GIT_INDEX_FILE` and the
        // `GIT_AUTHOR_*` ident the land path sets must be additions to the hardened env, not
        // a replacement for it. A caller cannot re-open `GIT_CONFIG_GLOBAL` by accident, only
        // deliberately, and nothing does.
        env: env ? { ...CONFLICT_GIT_ENV, ...env } : CONFLICT_GIT_ENV,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr);
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          // A numeric `code` is git's exit status. A string one (ENOENT, ETIMEDOUT) means the
          // process never ran or was killed, which is a real failure, not a git verdict.
          if (typeof code === 'number') {
            resolve({ code, stdout: out, stderr: errText });
            return;
          }
          reject(err);
          return;
        }
        resolve({ code: 0, stdout: out, stderr: errText });
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/**
 * `git merge-tree --write-tree` needs git 2.38. Probed ONCE per process and memoised — the
 * open route turns a false into `git_too_old` and the overlay prints it once.
 *
 * ⚠ This is NOT on `/api/me`. `MeResponse.conflictResolver` is `!config.isCloud` and shells
 * out to nothing; probing git on every SPA boot to answer a question the open route can
 * answer once is the trade this replaced.
 */
let versionProbe: Promise<boolean> | null = null;

export function gitSupportsMergeTree(cwd: string = process.cwd()): Promise<boolean> {
  versionProbe ??= (async () => {
    try {
      const { stdout } = await gitTry(['--version'], cwd);
      const m = /git version (\d+)\.(\d+)/.exec(stdout.toString('utf8'));
      if (!m) return false;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
      return major > 2 || (major === 2 && minor >= 38);
    } catch {
      return false;
    }
  })();
  return versionProbe;
}

/** Test seam only: forget the memoised probe. */
export function resetGitVersionProbe(): void {
  versionProbe = null;
}
