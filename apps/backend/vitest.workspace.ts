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
// `pnpm test:all` runs both. (A bare `vitest run` also runs the third project, `live`, whose
// cases all skip without LIMN_CODEX_LIVE=1.) Naming a file runs it whichever project it
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
  // A story build on a real scratch worktree per case (git init/add/commit/diff, ~1.5 s each).
  'src/coding/story-build/push-branch.test.ts',
  // The fake Codex CLI: one node process per run (two on a retry), many on real git worktrees.
  'src/coding/codex-resolve.test.ts',
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
  // Moved 2026-10-30 by the time budget: the workspace MCP server spawned under tsx (split from workspace-mcp.test.ts); measured 1.8s for its one case
  'src/ai/codex/workspace-mcp-process.test.ts',
  // Moved 2026-10-30 by the time budget: real git per case (pins and sweeps base refs in a scratch repo); measured 4.3s for one case
  'src/coding/story-build/base-refs.test.ts',
  // Moved 2026-10-30 by the time budget: the fake Codex CLI, one node process per sign-in call, like the other Codex suites; measured 2.0s, 1.6s for one case
  'src/api/routes/ai-codex.test.ts',
  // A real container daemon: builds (once) and runs the sandbox image, the proxy and an internal network;
  // skipped with its reason when no daemon answers.
  'src/sandbox/runtime/docker-real.test.ts',
  // A real microVM (msb): the same checks on microsandbox. Skips, saying why, where `msb doctor`
  // fails (an Intel Mac, Linux without /dev/kvm); CI runs it only on a KVM runner.
  'src/sandbox/runtime/microsandbox-real.test.ts',
  // The services relay as real Node processes (the shipped limn-svcd + limn-svc, a unix socket, TCP
  // forwards); and services on a real daemon (compose, builds, the real BNG backend file when cloned).
  'src/sandbox/services/relay.test.ts',
  'src/sandbox/services/services-real.test.ts',
  // Real git (a blobless cache, worktrees, shallow fetches) and a real daemon: the workspace mirror end to
  // end; its Docker part is skipped with its reason when no daemon answers.
  'src/sandbox/workspace/mirror-real.test.ts',
  // Real git (local clones checked, shallow and partial ones built) and a real daemon: the kept repo store
  // filled from a dirty local clone; its Docker part is skipped with its reason when no daemon answers.
  'src/sandbox/workspace/store-real.test.ts',
  // Moved 2026-11-07 by the time budget: real git per case: a shallow sandbox-shaped repo, Limn's merge scripts run with sh, bundles verified in a clone
  'src/coding/ai-fix/merge-verify.test.ts',
  // Moved 2026-11-07 by the time budget: real git for every sandbox step of the merge (Limn's scripts run with sh on a local shallow repo) plus three full sessions
  'src/sandbox/session/fix-merge-session-flow-db.test.ts',
  // Real git for every sandbox step (as the file above) under five unattended dependency-automation sessions
  'src/sandbox/session/fix-deps-session-flow-db.test.ts',
  // Real node + git: the plan checker script run as the agent runs it; the plan evidence blob reader on a scratch repo
  'src/sandbox/workspace/plan-check-script.test.ts',
  'src/coding/story-build/plan-verify-git.test.ts',
  // Moved 2026-11-07 by the time budget: real git on both sides: ~30 git processes per case (bundle, fetch with fsck, lineage, diffs)
  'src/coding/story-build/stack-verify.test.ts',
  // Moved 2026-11-07 by the time budget: real git for every push: a worktree, apply, commit, push to a local bare repository per PR
  'src/coding/story-build/push-stack-db.test.ts',
  // Moved 2026-11-07 by the time budget: real git for the stacked extraction after Approve (the sandbox script and the host's bundle check)
  'src/sandbox/session/plan-session-flow-db.test.ts',
  // Moved 2026-11-09 by the time budget: real git, a scratch store and sandbox repositories per case
  'src/sandbox/session/fix-merge-store-real.test.ts',
];

// THE LIVE CODEX TESTS: a real `codex` binary and a real ChatGPT sign-in, spending real usage. Every
// case is skipped unless LIMN_CODEX_LIVE=1, so in `fast`/`slow` they only paid the import. They are
// their own project, run by hand: `pnpm --filter @pierre-review/backend test:live`.
export const LIVE_TESTS = ['src/**/*.live.test.ts', 'src/**/*-live.test.ts', 'src/ai/codex/live.test.ts'];

// The sandbox spikes (scripts/sandbox-spikes/) are throwaway proofs run with `node --test`, not
// vitest; their `*.test.mjs` would otherwise match vitest's default include and fail as "No test
// suite found".
const NODE_TEST_SCRIPTS = ['scripts/sandbox-spikes/**'];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: { name: 'fast', exclude: [...defaultExclude, ...NODE_TEST_SCRIPTS, ...SLOW_TESTS, ...LIVE_TESTS] },
  },
  {
    extends: './vitest.config.ts',
    test: { name: 'slow', include: SLOW_TESTS, exclude: [...defaultExclude, ...NODE_TEST_SCRIPTS, ...LIVE_TESTS] },
  },
  {
    extends: './vitest.config.ts',
    test: { name: 'live', include: LIVE_TESTS },
  },
]);
