# Testing: what runs where, and why

The backend suite is two vitest projects (`apps/backend/vitest.workspace.ts`). `pnpm test` runs
the fast one; nothing is dropped, the slow one runs where it can matter.

| Command | Runs |
|---|---|
| `pnpm test` | backend `fast` project + `apps/site` (frontend/shared are no-ops) |
| `pnpm test:slow` | backend `slow` project only |
| `pnpm test:all` | both backend projects + `apps/site` |
| `pnpm --filter @pierre-review/backend exec vitest run <paths>` | the named files, whichever project they are in |
| `./apps/backend/node_modules/.bin/vitest run --root apps/frontend` | the frontend tests (`apps/frontend/test/`, never in CI) |

## The two projects

- **`fast`** — every backend test file not listed in `SLOW_TESTS`.
- **`slow`** — `SLOW_TESTS` in `vitest.workspace.ts`: the files whose time goes on STARTING
  PROCESSES, not on running Limn's code.
  - Real `git`: `conflict/land*.test.ts`, `conflict/model*.test.ts`, `conflict/janitor`,
    `review/clone-hygiene`, `coding/git` (`applyPatchToWorktree`), `coding/merge`.
  - The fake Codex CLI (a node script per `codex exec`, one more per `exec resume` retry):
    `coding/codex-fix`, `ai/providers/codex`, `ai/codex/{app-server,run,hook-process,threads}`,
    `ai/codex/kinds/*`, `review/codex-review-runs`.
  - The runtime installer (a stand-in npm per case): `ai/runtime-install`.
  - The ONNX scorer (only where `packages/ml` holds the weights): `ml/local-scorer`, `ml/model`.

⚠ **A file joins `slow` only for a MEASURED reason** (spawn-bound, seconds per case). A file that
is slow because it seeds too much stays in `fast` and gets faster. When a file mixes cheap
in-process cases with spawning ones, split it so the cheap ones stay in `fast` — that is why
`hook.test.ts` (the path guard's rules) and `hook-process.test.ts` (the guard run as a process,
the trust probe) are two files, and likewise `runtime.test.ts` (the loader, the zod identity pin)
and `runtime-install.test.ts`.

Shared fixtures for split files live in `*.test-support.ts` (excluded from the build by
`tsconfig.build.json`). ⚠ A support file that calls `vi.mock` (`conflict/land.test-support.ts`)
must be imported BEFORE any module under test, and the suite must import the modules under test
dynamically, in `beforeAll` — which is also what lets it set `DATABASE_URL` first.

## What CI runs

| Event | Fast | Slow | E2E + demo check |
|---|---|---|---|
| Pull request (`ci.yml`) | all | the slow files whose IMPORT GRAPH holds a changed file: `vitest run --project slow --changed origin/<base>` | only when the PR touches `apps/frontend/`, `apps/site/`, `packages/shared/`, the demo scripts, `playwright.config.ts`, a `package.json`, the lockfile or a workflow |
| Push to main (`release.yml`, before publishing) | all | all (`pnpm test:all`) | E2E always (`deploy-site.yml` runs the demo check) |
| Nightly 03:17 UTC and manual (`ci.yml` `schedule` / `workflow_dispatch`) | all | all | always |

The browser checks can skip a backend-only PR because neither reads the backend: the E2E specs
answer every `/api` request from `apps/frontend/e2e/mock-api.ts`, and the demo check serves the
built SPA and its committed recording through `apps/site`.

`--changed` walks static AND dynamic imports (`await import()` in a `beforeAll` counts), so a PR
that edits `conflict/model.ts` runs the conflict suites and `codex-fix`, and one that edits
`ai/codex/hook-rule.ts` runs every Codex suite. Some inputs are not imports — the migration chain
every DB suite applies, recorded `__fixtures__`, the `*-main.ts` entry files the Codex tests spawn,
`*.test-support.ts`, any `package.json`, the lockfile, the workflows. Touching one of those runs
EVERY slow file (`FORCE_RERUN_TRIGGERS` in `apps/backend/vitest.config.ts`). A new non-import input
to a slow file belongs on that list. The checkout uses `fetch-depth: 0` because `--changed` diffs
`<base>...HEAD`.

What the import graph cannot see is the `git` binary itself or an upstream change to the Codex
CLI's behaviour; the nightly and the main-branch run are the backstop for those.

## The invariants and the tests that guard them

The CLAUDE.md invariants named after a test stay in `fast`: `coding/ai-fix/no-shell.test.ts`
(the fixer's tool list and `WORKTREE_RULES`), `ai/provider-seam.test.ts` (every model call through
`ai/provider.ts`), `api/plugins/rate-limit.test.ts` (route tiers), `review/claude-review/prompts.test.ts`
and `ai/prompt-tools.test.ts` (`prompt-golden.json`, Claude's prompts byte-identical),
`github/client.test.ts` (`isRetryableGithubError` keeps 403/429 out), `db/erase-account.test.ts`
(`accountScopedTables()`), `platform/test/isolation.test.ts` + `ai/agent-isolation.test.ts`,
`sync/derive-thread-state.test.ts` (+ `sync/__fixtures__/threads/`), `ai/runtime.test.ts` (zod from
the SDK's own install), `ai/codex/hook.test.ts` (the PreToolUse ALLOW-list and the hook shape).

These sit in `slow` and so run on every PR that can affect them, and on main:
`ai/codex/hook-process.test.ts` + `ai/providers/codex.test.ts` (a Codex run refuses unless
`verifyHookTrusted` proves the hook runs), `review/codex-review-runs.test.ts` (the review's
read-only guard roots), `conflict/*` (the resolver: no marker reaches a blob, the wand never picks
a side, the commit is blocked until every decidable region is decided), `coding/codex-fix.test.ts`
(AI Fix and Plan first on Codex).

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
