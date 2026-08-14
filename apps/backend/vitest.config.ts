import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Backend test config.
//
// Bare `vitest run` (the backend suite, `pnpm --filter @pierre-review/backend test`)
// keeps vitest's built-in discovery untouched — root = this workspace, the default
// include/exclude globs — so which tests run is unaffected.
//
// The defaults we override are the two TIMEOUTS, for one reason: vitest runs test FILES
// in parallel, so every duration here is a function of how loaded the machine is.
//
//  • `hookTimeout`. A dozen suites open a throwaway SQLite file and run the whole
//    migration chain in `beforeAll`; that is comfortably under a second idle, but on a
//    loaded machine (CI, or several agents building at once) 2–8 of them blow the 10s
//    default and fail with "Hook timed out in 10000ms". Those look exactly like real
//    regressions — a different subset each run, always in `beforeAll`, never an
//    assertion — and cost real time to dismiss.
//  • `testTimeout`, for the SAME reason one level down, which the hook-only fix missed.
//    `src/coding/git.test.ts` and `src/coding/merge.test.ts` shell out to real `git`
//    from the test BODY (init, commit, format-patch/am, trial merges), so their time is
//    NOT in a hook and `hookTimeout` never covered them. Idle they land at 2–4.5s
//    against the 5s default — no margin at all — and under parallel load they cross it
//    and fail with "Test timed out in 5000ms". That has already fired: two separate
//    agents in one batch reported it as a suspected regression in code they had not
//    touched, re-ran the file in isolation, and dismissed it by hand.
//
// Both ceilings are slack for CONTENTION, not licence to be slow: a genuinely hung
// migration or a `git` call waiting on a lock still fails the run rather than sitting
// there. Raising a ceiling cannot turn a failing assertion green.
//
// The private `@pierre/pro` plugin ships NO vitest/better-sqlite3 devDeps (by design,
// so a pure-OSS install can't break on its native build) and its tests live OUTSIDE
// this workspace root, so vitest can neither discover nor resolve them by default.
// When the CLI is explicitly pointed at a `packages/pro` test path — e.g.
//   pnpm --filter @pierre-review/backend exec vitest run ../../packages/pro/test/isolation.test.ts
// — switch into a repo-rooted mode and alias `better-sqlite3` to this workspace's
// already-built copy so the plugin's throwaway-SQLite tests run from here.
const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '../..');
const proRun = process.argv.some((a) => a.includes('packages/pro'));

// Shared by both branches so the two can never drift: the plugin's isolation suite
// migrates a throwaway DB in `beforeAll` for the same reason core's do.
const HOOK_TIMEOUT_MS = 30_000;
// Same argument, applied to test bodies (see above) — the git-shelling suites are the
// ones that need it, and they are core-only, but keeping it shared is what stops the
// two branches drifting the way hookTimeout/testTimeout already did.
const TEST_TIMEOUT_MS = 20_000;

export default defineConfig(
  proRun
    ? {
        test: {
          root: repoRoot,
          include: ['packages/pro/test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
          hookTimeout: HOOK_TIMEOUT_MS,
          testTimeout: TEST_TIMEOUT_MS,
        },
        resolve: {
          alias: {
            'better-sqlite3': path.join(dir, 'node_modules/better-sqlite3/lib/index.js'),
          },
        },
      }
    : { test: { hookTimeout: HOOK_TIMEOUT_MS, testTimeout: TEST_TIMEOUT_MS } },
);
