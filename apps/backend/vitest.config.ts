import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Backend test config.
//
// Bare `vitest run` (the backend suite, `pnpm --filter @pierre-review/backend test`)
// keeps vitest's built-in discovery untouched — root = this workspace, the default
// include/exclude globs — so which tests run is unaffected.
//
// The ONE default we override is `hookTimeout`. A dozen suites open a throwaway SQLite
// file and run the whole migration chain in `beforeAll`; that is comfortably under a
// second idle, but vitest runs test FILES in parallel and on a loaded machine (CI, or
// several agents building at once) 2–8 of them blow the 10s default and fail with
// "Hook timed out in 10000ms". Those look exactly like real regressions — a different
// subset each run, always in `beforeAll`, never an assertion — and cost real time to
// dismiss. 30s is slack for contention, still short enough that a genuinely hung
// migration fails the run rather than sitting there.
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

export default defineConfig(
  proRun
    ? {
        test: {
          root: repoRoot,
          include: ['packages/pro/test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
          hookTimeout: HOOK_TIMEOUT_MS,
        },
        resolve: {
          alias: {
            'better-sqlite3': path.join(dir, 'node_modules/better-sqlite3/lib/index.js'),
          },
        },
      }
    : { test: { hookTimeout: HOOK_TIMEOUT_MS } },
);
