import { defaultExclude, defineWorkspace } from 'vitest/config';

// The backend suite in TWO projects, so `pnpm test` is fast by default (docs/TESTING.md).
//
//   • `fast` — everything not listed below. `pnpm test` runs it; so does every CI run.
//   • `slow` — the files whose time is spent STARTING PROCESSES, not running our code: real `git`
//     (init, commit, merge-tree, rebase — up to ~60 spawns per case), the fake Codex CLI (a node
//     script per run, plus `exec resume` for the retry), the AI-runtime installer and the ONNX
//     scorer. Measured 2026-10-30 these cases were 20 of 419 files and 93% of the suite's test
//     time (1,655s of 1,778s), and the longest file alone set the wall clock of the whole run.
//
// `pnpm test:all` (or a bare `vitest run`) runs both. Naming a file runs it whichever project it
// is in, so `vitest run src/conflict/land.test.ts` still works.
//
// CI never drops a slow file silently: a pull request runs the `slow` files that IMPORT anything
// the PR changed (`vitest run --project slow --changed origin/<base>`, which walks static AND
// dynamic imports; vitest.config.ts `forceRerunTriggers` widens that to all of them for the
// inputs no import reaches), and a push to main, the release and the nightly run all of it.
//
// ⚠ A file belongs here only for a MEASURED reason (spawn-bound, seconds per case). A file that
// is slow because it seeds too much belongs in `fast`, made faster. Every invariant a slow file
// guards still runs on any change to the code it covers — see docs/TESTING.md for the list.
export const SLOW_TESTS = [
  // Real git, every case building its own temp repository.
  'src/conflict/land*.test.ts',
  'src/conflict/model*.test.ts',
  'src/conflict/janitor.test.ts',
  'src/review/clone-hygiene.test.ts',
  'src/coding/git.test.ts',
  'src/coding/merge.test.ts',
  'src/review/worktree-gc.test.ts',
  'src/coding/checks/session.test.ts',
  // A story build on a real scratch worktree per case (git init/add/commit/diff, ~1.5 s each).
  'src/coding/story-build/build.test.ts',
  'src/coding/story-build/push-branch.test.ts',
  // The fake Codex CLI: one node process per run (two on a retry), many on real git worktrees.
  'src/coding/codex-fix.test.ts',
  'src/ai/providers/codex.test.ts',
  'src/ai/codex/app-server.test.ts',
  'src/ai/codex/run.test.ts',
  'src/ai/codex/hook-process.test.ts',
  'src/ai/codex/threads.test.ts',
  'src/ai/codex/kinds/*.test.ts',
  'src/review/codex-review-runs.test.ts',
  // The first-use installer: a stand-in npm, run as a child process per case.
  'src/ai/runtime-install.test.ts',
  // The ONNX model (runs only where packages/ml holds the weights; ~240 MB to load).
  'src/ml/local-scorer.test.ts',
  'src/ml/model.test.ts',
];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: { name: 'fast', exclude: [...defaultExclude, ...SLOW_TESTS] },
  },
  {
    extends: './vitest.config.ts',
    test: { name: 'slow', include: SLOW_TESTS },
  },
]);
