// THE COMMIT HOOK (docs/SECURITY.md § Sandboxed checks; docs/CLAUDE-REVIEW.md § AI Fix "Run tests").
// Limn makes the commit with the repository's pre-commit hook (husky, lefthook, simple-git-hooks)
// ENABLED, inside the same sandbox as a check — and in a THROWAWAY git folder, never the shared clone:
//
//   • `<run>/spec/hook-git` is a fresh repository Limn creates (Limn-only, never the checks' `sbx/`),
//     whose object store BORROWS the clone's (`objects/info/alternates`, read only to the sandbox)
//     and whose `HEAD` is the fix's base commit;
//   • Limn stages the worktree into it (git add -A, outside the sandbox — no repository code runs in a
//     stage), then runs `git commit` INSIDE the sandbox with GIT_DIR / GIT_WORK_TREE pointing there,
//     so the hook (and lint-staged, which stashes and re-stages) writes only that throwaway folder and
//     the worktree. The clone's config, refs and objects — which every later run and every push reads —
//     are never writable;
//   • the hook script is copied into a hooks folder only Limn writes (`core.hooksPath`), with husky's
//     old `. "$(dirname "$0")/_/husky.sh"` line dropped (its helper is made by an install script Limn
//     never runs).
// What a hook changes in the worktree (a formatter's fix-ups) stays there and becomes part of the fix;
// the throwaway commit itself is never pushed — Push commits the stored patch as it always did.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from './spawn.js';
import type { HookDef } from './types.js';

/** The hook script Limn installs as `pre-commit` (repository-authored shell, run in the sandbox). */
export function hookScriptBody(hook: HookDef): string {
  const body = hook.script
    .split(/\r?\n/)
    .filter((l) => !/^\s*\.\s+["']?\$\(\s*dirname\s+(?:--\s+)?["']?\$0["']?\s*\)\/_\/husky\.sh["']?\s*$/.test(l))
    .filter((l, i) => !(i === 0 && l.startsWith('#!')))
    .join('\n');
  return `#!/bin/sh\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/** Write the hooks folder (Limn-only) with one executable `pre-commit`. Returns the folder. */
export function writeHooksDir(specDir: string, hook: HookDef): string {
  const dir = join(specDir, 'hooks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pre-commit');
  writeFileSync(file, hookScriptBody(hook), { mode: 0o755 });
  chmodSync(file, 0o755);
  return dir;
}

async function git(args: string[], env: Record<string, string>, cwd: string): Promise<{ ok: boolean; out: string }> {
  const r = await runProcess({ command: 'git', args, cwd, env, timeoutMs: 120_000, outputCap: 20_000 });
  return { ok: r.exitCode === 0, out: r.output };
}

/**
 * Create the throwaway repository and stage the worktree into it (Limn's own git, outside the
 * sandbox). Returns false when there is nothing to commit. Throws when git refuses.
 */
export async function stageIntoThrowawayRepo(o: {
  gitDir: string;
  worktree: string;
  /** The clone's object store (`<clone>/.git/objects`). */
  objectsDir: string;
  baseSha: string;
  hooksDir: string;
  excludesFile: string | null;
  env: Record<string, string>;
}): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(o.baseSha)) throw new Error('bad base commit');
  mkdirSync(o.gitDir, { recursive: true });
  const base = { ...o.env, GIT_DIR: o.gitDir, GIT_WORK_TREE: o.worktree };
  const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
  const run = async (args: string[]): Promise<string> => {
    const r = await git([...safe, ...args], base, o.worktree);
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.out.slice(-400)}`);
    return r.out;
  };
  await run(['init', '-q']);
  mkdirSync(join(o.gitDir, 'objects', 'info'), { recursive: true });
  writeFileSync(join(o.gitDir, 'objects', 'info', 'alternates'), `${o.objectsDir}\n`);
  await run(['config', 'core.bare', 'false']);
  await run(['config', 'core.hooksPath', o.hooksDir]);
  await run(['config', 'commit.gpgSign', 'false']);
  if (o.excludesFile) await run(['config', 'core.excludesFile', o.excludesFile]);
  await run(['update-ref', 'refs/heads/limn-fix', o.baseSha]);
  await run(['symbolic-ref', 'HEAD', 'refs/heads/limn-fix']);
  await run(['read-tree', o.baseSha]);
  await run(['add', '-A']);
  const staged = await git([...safe, 'diff', '--cached', '--quiet'], base, o.worktree);
  return !staged.ok; // `--quiet` exits 1 when something is staged
}

/** The argv that makes the commit (run INSIDE the sandbox, so the hook is too). */
export function commitArgv(message: string): string[] {
  return [
    'git',
    '-c',
    'user.name=Limn',
    '-c',
    'user.email=limn@localhost',
    '-c',
    'core.fsmonitor=false',
    'commit',
    '-q',
    '--no-gpg-sign',
    '-m',
    message.slice(0, 2_000) || 'AI fix',
  ];
}
