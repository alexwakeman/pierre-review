# Testing: what runs where, and why

The backend suite is three vitest projects (`apps/backend/vitest.workspace.ts`). `pnpm test` runs
the fast one; nothing is dropped, the slow one runs where it can matter, and the live one runs
only by hand.

| Command | Runs |
|---|---|
| **`pnpm test:changed`** | **the inner loop**: the backend `fast` + `slow` files whose import graph holds a file changed since the merge-base with `origin/main` (else `main`), staged, unstaged or untracked; the same selection CI makes. `--fast` drops `slow`. No base to diff ⇒ the `fast` project |
| `pnpm test` | backend `fast` project + `apps/site` (frontend/shared are no-ops) — before you push |
| `pnpm test:slow` | backend `slow` project only |
| `pnpm test:all` | backend `fast` + `slow` + `apps/site` |
| `pnpm --filter @pierre-review/backend test:live` | the `live` project: a real Codex, real usage (`LIMN_CODEX_LIVE=1`) |
| `pnpm --filter @pierre-review/backend exec vitest run <paths>` | the named files, whichever project they are in |
| `pnpm --filter @pierre-review/backend test:move-slow <file> "<why>"` | moves a file from `fast` to `slow` (the time budget prints this) |
| `./apps/backend/node_modules/.bin/vitest run --root apps/frontend` | the frontend tests (`apps/frontend/test/`, never in CI) |

`test:changed` is vitest's own `--changed <base>`, so an input no import reaches (a migration, a
fixture, the vitest config: `FORCE_RERUN_TRIGGERS`) selects every file, exactly as in CI. A change
to `conflict/` or `ai/codex/` therefore pulls in minutes of `slow` files; `--fast` is the quick
loop while iterating, and the plain form is the check before pushing.

## The three projects

- **`fast`** — every backend test file not listed in `SLOW_TESTS` or `LIVE_TESTS`.
- **`slow`** — `SLOW_TESTS` in `vitest.workspace.ts`: the files whose time goes on STARTING
  PROCESSES, not on running Limn's code.
  - Real `git`: `conflict/land*.test.ts`, `conflict/model*.test.ts`, `conflict/janitor`,
    `review/clone-hygiene`, `review/worktree-gc`, `coding/git` (`applyPatchToWorktree`),
    `coding/merge`, `coding/story-build/{build,push-branch,base-refs}`.
  - The fake Codex CLI (a node script per `codex exec`, one more per `exec resume` retry):
    `coding/codex-fix`, `ai/providers/codex`, `ai/codex/{app-server,run,hook-process,threads}`,
    `ai/codex/kinds/*`, `review/codex-review-runs`, `api/routes/ai-codex` (the sign-in routes).
  - Other child processes: `ai/codex/workspace-mcp-process` (the workspace MCP server under tsx),
    `coding/checks/runner` (`runProcess`, `dockerPreflight` against a stand-in `docker`),
    `coding/checks/session` (the "Run tests" sandbox).
  - The runtime installer (a stand-in npm per case): `ai/runtime-install`.
  - The ONNX scorer (only where `packages/ml` holds the weights): `ml/local-scorer`, `ml/model`.
- **`live`** — `LIVE_TESTS`: the `*.live.test.ts` / `*-live.test.ts` files and
  `ai/codex/live.test.ts`. A real `codex` binary and a real ChatGPT sign-in, spending real usage;
  every case skips without `LIMN_CODEX_LIVE=1`. Neither `pnpm test`, `test:all` nor CI runs them
  (they used to sit in `fast`, paying their imports to skip).

⚠ **A file joins `slow` only for a MEASURED reason** (spawn-bound, seconds per case). A file that
is slow because it seeds too much stays in `fast` and gets faster. When a file mixes cheap
in-process cases with spawning ones, split it so the cheap ones stay in `fast` — that is why
`hook.test.ts` (the path guard's rules) and `hook-process.test.ts` (the guard run as a process,
the trust probe) are two files, and likewise `runtime.test.ts` / `runtime-install.test.ts` and
`workspace-mcp.test.ts` / `workspace-mcp-process.test.ts`.

Shared fixtures for split files live in `*.test-support.ts` (excluded from the build by
`tsconfig.build.json`). ⚠ A support file that calls `vi.mock` (`conflict/land.test-support.ts`)
must be imported BEFORE any module under test, and the suite must import the modules under test
dynamically, in `beforeAll` — which is also what lets it set `DATABASE_URL` first.

⚠ **A throwaway SQLite file goes under `LIMN_TEST_RUN_DIR`** (one empty directory per run, set in
`vitest.config.ts`): `` `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-<suite>.sqlite` ``. Fixed
`/tmp/pierre-*.sqlite` paths let two runs at once (two worktrees, two agents) open the same file;
measured 2026-10-30, one run lost five files to "table already exists" and UNIQUE violations that
read exactly like regressions.

## The time budget

`pnpm test` stays fast only while every file in it is. A reporter (`apps/backend/test-budget/reporter.ts`,
wired in `vitest.config.ts`) measures every file of the `fast` project and names:

- a **test** over **2s** (its own time, `beforeEach`/`afterEach` included), and
- a **file** whose RUN time is over **5s** (`beforeAll` + its tests + `afterAll`; the time to
  import its modules is left out — that is shared, cached work that depends on what the worker
  loaded first).

Each one comes with the command that moves it (`test:move-slow <file> "<why>"`, which adds it to
`SLOW_TESTS` with the reason and drops any allowlist entry) and the one that re-times it alone.

- **The budgets scale with the machine's load**: the run samples the 1-minute load average per
  core and multiplies every budget by it, clamped to ×1–×8. A dedicated CI runner sits at ×1; this
  machine shared with other builds measured ×4.7, with every DB suite at 3–5× its idle time.
  `LIMN_TEST_BUDGET_LOAD_SCALING=off` turns that off.
- **Modes** (`LIMN_TEST_BUDGET`): `warn` (the default — printed, never fails), `enforce` (fails the
  run), `off`. `LIMN_TEST_BUDGET_TEST_MS` / `LIMN_TEST_BUDGET_FILE_MS` override the budgets;
  `LIMN_TEST_BUDGET_REPORT=<path>` writes the findings as JSON.
- **CI enforces on pull requests, and only on the test files the PR adds or changes**
  (`LIMN_TEST_BUDGET_BASE=origin/<base>`): a new or edited slow test fails its own PR; a timing
  wobble in a file nobody touched is printed and never fails somebody else's change. A source change
  that makes an UNTOUCHED test slow is therefore only a warning — read the warnings. Main and the
  nightly only warn.
- **Exceptions** live in `apps/backend/test-budget/allowlist.json`: a RAISED budget for one file
  (`testMs`, `fileMs`) with the reason, never an unlimited one. Every entry today is in-process work
  (an exhaustive sweep, a full board fold) — candidates to make quicker, not to move. The reporter
  says when an entry fits the default budget again and can go.
- **The frontend tests** (`apps/frontend/vitest.config.ts`) use the same reporter and budgets,
  warn-only (they do not run in CI). There is no slow project there: a slow file gets faster.

A `--reporter` on the command line replaces the configured reporters, the budget included.

## What CI runs

| Event | Fast | Slow | E2E + demo check |
|---|---|---|---|
| Pull request (`ci.yml`) | all, with the time budget ENFORCED on the test files the PR touches | the slow files whose IMPORT GRAPH holds a changed file: `vitest run --project slow --changed origin/<base>` | only when the PR touches `apps/frontend/`, `apps/site/`, `packages/shared/`, the demo scripts, `playwright.config.ts`, a `package.json`, the lockfile or a workflow |
| Push to main (`release.yml`, before publishing) | all (budget warns) | all (`pnpm test:all`) | E2E always (`deploy-site.yml` runs the demo check) |
| Nightly 03:17 UTC and manual (`ci.yml` `schedule` / `workflow_dispatch`) | all (budget warns) | all | always |

No run in CI takes the `live` project.

The browser checks can skip a backend-only PR because neither reads the backend: the E2E specs
answer every `/api` request from `apps/frontend/e2e/mock-api.ts`, and the demo check serves the
built SPA and its committed recording through `apps/site`.

`--changed` walks static AND dynamic imports (`await import()` in a `beforeAll` counts), so a PR
that edits `conflict/model.ts` runs the conflict suites and `codex-fix`, and one that edits
`ai/codex/hook-rule.ts` runs every Codex suite. Some inputs are not imports — the migration chain
every DB suite applies, recorded `__fixtures__`, the `*-main.ts` entry files the Codex tests spawn,
the ML scorer's child (`ml/scorer-process.ts`),
`*.test-support.ts`, `vitest.config.ts` / `vitest.workspace.ts`, any `package.json`, the lockfile,
the workflows. Touching one of those runs
EVERY slow file (`FORCE_RERUN_TRIGGERS` in `apps/backend/vitest.config.ts`). A new non-import input
to a slow file belongs on that list. The checkout uses `fetch-depth: 0` because `--changed` diffs
`<base>...HEAD`.

What the import graph cannot see is the `git` binary itself or an upstream change to the Codex
CLI's behaviour; the nightly and the main-branch run are the backstop for those. The ONNX suites
(`ml/local-scorer`, `ml/model`) read `packages/ml`, a submodule CI does not check out, so in CI they
always skip; run them by hand after a model bump.

Checked 2026-10-30, every non-import input a `slow` file reads: the Codex suites write their fake
CLI and its files into a temp directory at run time (nothing on disk in the repo), spawn the
`*-main.ts` entries (on the list) and `run.ts` (imported, so in the graph); `local-scorer` spawns
`ml/scorer-process.ts` (added to the list that day). Nothing else is read from the repo.

## The invariants and the tests that guard them

⚠ **Never delete, skip or weaken these to save time.** A slow one moves to `slow` (still run on
every PR that can affect it, and in full on main and nightly); it never leaves the suite.

| CLAUDE.md invariant | Suite(s) | Project |
|---|---|---|
| Cross-account isolation (every query filters on `accountId`; id getters 404) | `platform/test/isolation.test.ts`, `ai/agent-isolation.test.ts`, and `pnpm --filter @pierre-review/backend verify:isolation` (a script, not vitest) | fast |
| Rate-limit tiers (`tierFor`, exact path segments in `hitsGithub`) | `api/plugins/rate-limit.test.ts` | fast |
| The fixer has no shell (`DISALLOWED_TOOLS`, `WORKTREE_RULES` change together) | `coding/ai-fix/no-shell.test.ts`, `coding/story-build/no-shell.test.ts` | fast |
| Every model call through `ai/provider.ts` | `ai/provider-seam.test.ts` | fast |
| Claude's prompts byte-identical (`prompt-golden.json`) | `review/claude-review/prompts.test.ts`, `ai/prompt-tools.test.ts` | fast |
| Auto-post: claimed (compare-and-set) BEFORE any GitHub write, never retried; the hidden marker | `review/claude-review/auto-post.test.ts`, `review/claude-review/pair-auto-post.test.ts`, `review/ticket-review/auto-post.test.ts`, `coding/ai-fix/auto-push.test.ts` | fast |
| Migrations (platform files run once by name; backfills; upgrade paths) | `platform/test/migration-files.test.ts`, `platform/test/workspace-settings.test.ts`, `db/ai-usage-provider-migration.test.ts` | fast |
| Erasure covers every `accountId` table (`accountScopedTables()`) | `db/erase-account.test.ts`, the erasure cases in `platform/test/isolation.test.ts` | fast |
| The path guard (every agent run) | `review/path-guard.test.ts`, `ai/codex/hook.test.ts` (the PreToolUse ALLOW-list) | fast |
| A Codex run refuses unless `verifyHookTrusted` proves the hook runs | `ai/codex/hook-process.test.ts`, `ai/providers/codex.test.ts` | slow |
| The review's read-only guard roots on Codex | `review/codex-review-runs.test.ts` | slow |
| "Run tests" sandbox: no shell, frozen names, a hostile test is stopped | `coding/checks/deny-scan.test.ts` (fast); `coding/checks/runner.test.ts`, `coding/checks/session.test.ts` (slow) | both |
| The conflict resolver (no marker reaches a blob, the wand never picks a side, the commit blocked until every decidable region is decided) | `conflict/*` | slow |
| AI Fix and Plan first on Codex | `coding/codex-fix.test.ts` | slow |
| The worktree sweep keeps a tree a live job uses | `review/worktree-gc-policy.test.ts` (fast), `review/worktree-gc.test.ts` (slow) | both |
| `isRetryableGithubError` keeps 403/429 out | `github/client.test.ts` | fast |
| Derived thread state | `sync/derive-thread-state.test.ts` + `sync/__fixtures__/threads/` | fast |
| zod from the SDK's own install | `ai/runtime.test.ts` | fast |
| The demo answers every view | `scripts/verify-demo.mjs` (`pnpm demo:verify`, in PR CI and `deploy-site.yml`), `apps/frontend/test/demoRuntime.test.ts` | CI step / frontend |

## Measured, 2026-10-30

On the author's 12-core macOS machine, shared with other agents (load average 5–40 throughout),
every run with `--pool=forks --poolOptions.forks.maxForks=4` (`pnpm test` itself uses one worker
per core but one, so it is quicker than this on an idle machine):

| Run | Wall clock | Files | Tests | Longest file |
|---|---|---|---|---|
| Before: the whole backend suite (was `pnpm test`) | 720s | 419 | 6,118 | `conflict/land.test.ts`, 713s |
| After: `fast` (now `pnpm test`) | 142s | 401 | 5,806 | `db/my-turn-settings.test.ts`, 11s |
| After: `slow` (`pnpm test:slow`) | 412s | 23 | 312 | `conflict/land-partial.test.ts`, 315s |
| Site (`apps/site`, part of `pnpm test`) | 4s | 3 | 46 | |
| E2E (`pnpm test:e2e`, 2 workers) | 101s | 6 | 40 | |

Before, `conflict/land.test.ts` (713s) and `conflict/model.test.ts` (465s) were 66% of all test
time, and one file runs in one worker, so no run could finish before land.test.ts did. Split into
five files they run side by side; the longest is now 315s under the same load. The fast project's
own time is mostly loading modules (93s of "collect" across 400 files) rather than tests (99s).
The demo check (`pnpm demo:verify`) was not measured here: it uses ports shared with other work
on the machine.

Why spawning dominates: inside a vitest worker on macOS, `git --version` measured 150–550 ms
against ~20 ms from plain node (`/usr/bin/true` stays ~6 ms). A conflict case shells out ~60 times
(the land path rebuilds the model before it commits). Linux CI pays no Gatekeeper assessment, so
the slow project should be much quicker there; it has not been timed on CI yet.

### The follow-up (time budget, live project, four more files to `slow`), same day

Three full runs of the `fast` project on the same shared machine, default workers:

| Run | Load average | Wall clock | Files | Tests (skipped) | Sum of test time |
|---|---|---|---|---|---|
| Before | ~30 | 135s | 428 | 6,204 (42) | 805s |
| After pruning + `live` split, before the four moves | ~50 | 338s | 425 | 6,168 (8) | 628s |
| Same, budget reporter on | 5–15, but every file 3–10× its first-run time | 497s | 425 | 6,168 (8) | 524s |

The wall clocks are NOT comparable: the machine's load changed the result more than the change
did, so the table is a record, not a speed-up claim. What changed for certain: 3 `live` files no
longer load ~8 heavy modules to skip 34 cases; 4 spawn-bound files (measured 11s of test time in
the first run, 4 of the 40 slowest tests among them) left `fast`; `fast` is now 421 files. The first run's
slowest `fast` files (`db/my-turn-settings` 21s, `benchmark-rollup` 10s) are in-process sweeps and
are on the allowlist, not moved.

