#!/usr/bin/env node
// THE INNER LOOP (docs/TESTING.md): run only the backend tests your change can affect.
//
//   pnpm test:changed            # fast + slow files whose import graph holds a changed file
//   pnpm test:changed --fast     # the same, fast project only
//   pnpm test:changed <args>     # anything else is passed to vitest
//
// "Changed" is everything since the merge-base with origin/main (falling back to local main),
// plus staged, unstaged and untracked files — vitest's own `--changed <ref>` (it diffs
// `<ref>...HEAD`). It is the same selection CI makes for the slow project, so a green run here is
// the run CI will make. An input no import reaches (migrations, fixtures, vitest config — the
// FORCE_RERUN_TRIGGERS in vitest.config.ts) selects EVERY file, as in CI.
//
// With no base to diff against (no origin/main or main), it runs the fast project: `pnpm test`.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fastOnly = args.includes('--fast');
const rest = args.filter((a) => a !== '--fast');

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: backend, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const base = [process.env.LIMN_TEST_BASE, 'origin/main', 'main'].find((r) => r && refExists(r));
const vitestArgs = ['run'];
if (base) {
  vitestArgs.push('--changed', base, '--passWithNoTests');
  if (fastOnly) vitestArgs.push('--project', 'fast');
  else vitestArgs.push('--project', 'fast', '--project', 'slow');
  console.log(`test:changed — the backend tests that import anything changed since ${base}${fastOnly ? ' (fast project only)' : ''}`);
} else {
  vitestArgs.push('--project', 'fast');
  console.log('test:changed — no origin/main or main to diff against: running the fast project');
}
const bin = resolve(backend, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const r = spawnSync(bin, [...vitestArgs, ...rest], { cwd: backend, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
