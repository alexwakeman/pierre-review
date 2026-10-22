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
const HOOK_TIMEOUT_MS = 30_000;
// Same argument, applied to test bodies (see above).
//
// ⚠ RAISED 20s → 90s FOR `src/conflict/`, AND THE REASON IS MEASURED, NOT A GUESS.
// `land.test.ts` and `model.test.ts` prove claims about what git does with a tree nobody
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
// same contention argument as above, two orders of magnitude louder. Idle, `land.test.ts`
// runs its 27 tests in ~112s (~4s each); during a full `pnpm test` the same tests take
// 24–34s and six of them failed on the 20s ceiling, each with a green assertion behind it.
//
// 90s is slack for that tax and nothing else. `conflict/git.ts` kills any git command at
// 120s, so a genuinely hung or lock-waiting git still fails the run rather than sitting
// there, and — as above — raising a ceiling cannot turn a failing assertion green.
const TEST_TIMEOUT_MS = 90_000;

export default defineConfig({
  test: { hookTimeout: HOOK_TIMEOUT_MS, testTimeout: TEST_TIMEOUT_MS },
});
