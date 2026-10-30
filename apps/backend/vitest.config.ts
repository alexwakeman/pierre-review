import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import TestBudgetReporter from './test-budget/reporter.js';

// Backend test config.
//
// Which files run is decided by vitest.workspace.ts: two projects, `fast` (`pnpm test`) and
// `slow` (`pnpm test:slow`), both extending this file; a bare `vitest run` runs both. This
// file holds what they share.
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
const HOOK_TIMEOUT_MS = 30_000;
// Same argument, applied to test bodies (see above).
//
// ⚠ RAISED 20s → 90s FOR `src/conflict/`, AND THE REASON IS MEASURED, NOT A GUESS.
// `land*.test.ts` and `model*.test.ts` prove claims about what git does with a tree nobody
// checked out, so they shell out ~30 times per test (a model build is merge-base +
// 3×diff-tree + batch-check + merge-tree + rev-list + per-blob cat-file + the merge-file
// oracle, and a land REBUILDS the model before it commits, so the whole sequence runs
// twice) on top of the fixture repo each test builds with real `git init`/`commit`.
//
// The cost per spawn is the variable, and it is NOT ours. Measured on the author's macOS
// machine, same binary, same moment:
//   • `git --version` from the shell ............................  8 ms
//   • `git --version` via node's execFile, standalone ...........  25 ms
//   • `git --version` via node's execFile, inside a vitest worker . 425 ms
// with `syspolicyd` (Gatekeeper's assessment daemon) pegged at ~87% of a core throughout.
// Forking a vitest worker's large heap and re-assessing the binary is a per-exec tax, so a
// suite's runtime here is a function of how many processes the whole run is starting — the
// same contention argument as above, two orders of magnitude louder. (Re-measured 2026-10-30:
// 150–550 ms per `git --version` inside a worker against ~20 ms from plain node — the reason
// these files are the `slow` project in vitest.workspace.ts.) Idle, `land.test.ts` (before it
// was split three ways) ran its 27 tests in ~112s (~4s each); during a full `pnpm test` the
// same tests took 24–34s and six of them failed on the 20s ceiling, each with a green
// assertion behind it.
//
// 90s is slack for that tax and nothing else. `conflict/git.ts` kills any git command at
// 120s, so a genuinely hung or lock-waiting git still fails the run rather than sitting
// there, and — as above — raising a ceiling cannot turn a failing assertion green.
const TEST_TIMEOUT_MS = 90_000;

// THE INPUTS NO IMPORT REACHES. CI runs the `slow` project with `--changed`, which picks the
// test files whose import graph holds a changed file. These are read from disk or run as a
// separate process instead of imported, so a change to one of them runs EVERY test rather than
// none: the migration chain every DB suite applies, the recorded fixtures, the entry files the
// Codex tests spawn, and the test setup itself. (The defaults spread here are vitest's own
// package.json / config triggers.) ⚠ vitest.config.ts is spelled out: the default
// `**/{vitest,vite}.config.*/**` does NOT match a plain `vitest.config.ts` path under micromatch
// (measured), so without it a change to the timeouts or to this list ran no slow test.
const FORCE_RERUN_TRIGGERS = [
  ...configDefaults.forceRerunTriggers,
  '**/vitest.config.ts',
  '**/vitest.workspace.ts',
  '**/pnpm-lock.yaml',
  '**/src/db/migrations/**',
  '**/src/platform/migrations/**',
  '**/__fixtures__/**',
  '**/*.test-support.ts',
  '**/src/ai/codex/*-main.ts',
  '**/src/ml/scorer-process.ts',
  '**/.github/workflows/**',
];

// THE TIME BUDGET (test-budget/reporter.ts, docs/TESTING.md § The time budget): every file in the
// `fast` project is measured; a test over 2s or a file running over 5s is named, with the command
// that moves it to `slow`. A warning locally; CI fails a pull request whose added or edited test
// file is over (LIMN_TEST_BUDGET=enforce + LIMN_TEST_BUDGET_BASE in ci.yml).
const backendRoot = fileURLToPath(new URL('.', import.meta.url));
const budget = new TestBudgetReporter({
  root: backendRoot,
  projects: ['fast'],
  label: 'backend fast project',
  allowlistPath: join(backendRoot, 'test-budget', 'allowlist.json'),
  advice: [
    'Move it:      pnpm --filter @pierre-review/backend test:move-slow {file} "<what makes it slow>"',
    'Re-time it:   pnpm --filter @pierre-review/backend exec vitest run {file}',
  ],
});

export default defineConfig({
  test: {
    // `default` + the budget (+ GitHub's annotations in Actions, which an explicit list would drop).
    // A `--reporter` on the command line replaces this list, budget included.
    reporters: ['default', ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []), budget],
    hookTimeout: HOOK_TIMEOUT_MS,
    testTimeout: TEST_TIMEOUT_MS,
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
    // ⚠ NEVER THE READER'S ~/.limn. Modules resolve the data directory at IMPORT time (the AI runtime,
    // the Codex home), before a test's own beforeEach can set LIMN_DATA_DIR — so a machine with Codex
    // installed and signed in under ~/.limn saw it in "not installed" tests, and a sign-in test could
    // spawn the real binary against the real home. One empty directory per run; a test that sets its
    // own LIMN_DATA_DIR still wins.
    //
    // LIMN_TEST_RUN_DIR: one empty directory per run for the throwaway SQLite files the DB suites open.
    // They used to be fixed `/tmp/pierre-*.sqlite` paths, so two runs at once on one machine (two
    // worktrees, two agents) opened the SAME file and failed each other with "table already exists"
    // and UNIQUE violations that looked like regressions. (Measured 2026-10-30: 5 files in one run.)
    env: {
      LIMN_DATA_DIR: process.env.LIMN_TEST_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'limn-test-data-')),
      LIMN_TEST_RUN_DIR: process.env.LIMN_TEST_RUN_DIR ?? mkdtempSync(join(tmpdir(), 'limn-test-run-')),
    },
  },
});
