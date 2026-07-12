import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Backend test config.
//
// Bare `vitest run` (the backend suite, `pnpm --filter @pierre-review/backend test`)
// keeps vitest's built-in defaults untouched — root = this workspace, the default
// include/exclude globs, so the 232-test suite is byte-for-byte unaffected.
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

export default defineConfig(
  proRun
    ? {
        test: {
          root: repoRoot,
          include: ['packages/pro/test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
        },
        resolve: {
          alias: {
            'better-sqlite3': path.join(dir, 'node_modules/better-sqlite3/lib/index.js'),
          },
        },
      }
    : {},
);
