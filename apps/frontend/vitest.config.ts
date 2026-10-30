// Vitest config for the frontend's unit tests (`test/**`), run from the workspace that HAS vitest:
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// This mirrors `packages/pro/vitest.config.ts` exactly, for the same two reasons:
//
//  1. It deliberately does NOT `import { defineConfig } from 'vitest/config'` — that specifier is
//     unresolvable from a package without vitest installed, and the import would fail before the
//     config could be used at all. Vitest accepts a plain object, which is the only shape that
//     works here.
//  2. `include` is PINNED to `test/**`. Vitest's default globs also match `e2e/*.spec.ts`, which
//     are Playwright specs (`pnpm test:e2e`); collecting one under vitest fails the run with
//     "Playwright Test did not expect test.describe() to be called here".
//
// Vitest prefers this file over `vite.config.ts`, so the React plugin is not applied — fine, and
// intentional: everything under `test/` is a pure `.ts` module, no JSX.
//
// THE TIME BUDGET (apps/backend/test-budget/reporter.ts, docs/TESTING.md): the same reporter the
// backend's fast project uses, with its budget (a test over 2s, a file over 5s), warn-only here:
// these tests do not run in CI. The source-scanning suites (designRules, textContrast, aiGating)
// read the whole SPA and sit near the line under load; they are the ones to watch.
import { fileURLToPath } from 'node:url';
import TestBudgetReporter from '../backend/test-budget/reporter.js';

const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  test: {
    include: ['test/**/*.test.ts'],
    reporters: [
      'default',
      new TestBudgetReporter({
        root,
        label: 'frontend tests',
        advice: ['Everything here is a pure module: make it faster (there is no slow project to move it to).'],
      }),
    ],
  },
};
