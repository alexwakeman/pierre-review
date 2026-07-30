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
export default {
  test: {
    include: ['test/**/*.test.ts'],
  },
};
