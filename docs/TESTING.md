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
    `coding/merge`, `coding/story-build/{push-branch,base-refs,plan-verify-git,stack-verify,push-stack-db}`,
    `sandbox/workspace/plan-check-script`, `sandbox/session/plan-session-flow-db` (the stacked
    extraction after Approve, real git on both sides).
  - The fake Codex CLI (a node script per `codex exec`, one more per `exec resume` retry):
    `ai/providers/codex`, `ai/codex/{app-server,run,hook-process,threads}`,
    `ai/codex/kinds/*`, `review/codex-review-runs`, `api/routes/ai-codex` (the sign-in routes).
  - Other child processes: `ai/codex/workspace-mcp-process` (the workspace MCP server under tsx).
  - The runtime installer (a stand-in npm per case): `ai/runtime-install`.
  - The ONNX scorer (only where `packages/ml` holds the weights): `ml/local-scorer`, `ml/model`.
  - A real container daemon: `sandbox/runtime/docker-real` (the sandbox image, the egress proxy and
    an internal network; builds the image once, needs the internet; skipped with its reason when no
    daemon answers — [SANDBOX.md](SANDBOX.md) § Testing); `sandbox/session/fix-merge-store-real` (real git,
    no daemon: the MERGE item's fetch into a repository that borrows the repo store); `sandbox/workspace/mirror-real` (real git on a
    blobless cache, then the workspace mirror end to end in a real sandbox; its Docker part skips the
    same way); `sandbox/services/services-real` (services on a real daemon: a refused file, a build from
    the sandbox, `limn-svc` from inside, and the BNG backend file when its clone is on the machine —
    [SANDBOX.md](SANDBOX.md) § Services).
  - A real microVM: `sandbox/runtime/microsandbox-real` (the docker-real checks on microsandbox; ⚠ never
    run yet). Skipped with its reason wherever `msb doctor` fails (an Intel Mac, Linux without
    `/dev/kvm`); `.github/workflows/microsandbox.yml` runs it on a Linux runner only when `/dev/kvm`
    exists, with `LIMN_MSB_REQUIRED=1` so a skip there fails ([SANDBOX.md](SANDBOX.md) § microsandbox).
  - Real Node processes for the services relay: `sandbox/services/relay` (the shipped `limn-svcd.cjs`
    and `limn-svc`, a unix socket, a TCP forward).
- **`live`** — `LIVE_TESTS`: the `*.live.test.ts` / `*-live.test.ts` files and
  `ai/codex/live.test.ts`. A real `codex` binary and a real ChatGPT sign-in, spending real usage;
  every case skips without `LIMN_CODEX_LIVE=1`. Neither `pnpm test`, `test:all` nor CI runs them
  (they used to sit in `fast`, paying their imports to skip). `sandbox/drivers/drivers.live.test.ts`
  (a real daemon and a real model through the sandbox drivers) skips unless `LIMN_SANDBOX_LIVE` names
  the provider (`claude`, `codex`) — [SANDBOX.md](SANDBOX.md) § Agent drivers.
  `sandbox/session/session.live.test.ts` (one whole session through the routes on a real daemon and
  the real Claude Code: boot, a chat turn, Start build, the patch, discard) skips unless
  `LIMN_SANDBOX_LIVE_SESSION=1` and `CLAUDE_CODE_OAUTH_TOKEN` are set — [SANDBOX.md](SANDBOX.md) §
  Sessions.

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
  that makes an UNTOUCHED test slow is therefore only a warning — read the warnings. A base git
  cannot diff against enforces nothing (it says so). Main and the nightly only warn.
- **Exceptions** live in `apps/backend/test-budget/allowlist.json`: a RAISED budget for one file
  (`testMs`, `fileMs`) with the reason, never an unlimited one. Every entry today is in-process work
  (an exhaustive sweep, a full board fold) — candidates to make quicker, not to move. The reporter
  says when an entry fits the default budget again and can go.
- **The frontend tests** (`apps/frontend/vitest.config.ts`) use the same reporter and budgets,
  warn-only (they do not run in CI). There is no slow project there: a slow file gets faster.

A `--reporter` on the command line replaces the configured reporters, the budget included.

## What CI runs

| Event | Fast | Slow | E2E |
|---|---|---|---|
| Pull request (`ci.yml`) | all, with the time budget ENFORCED on the test files the PR touches | the slow files whose IMPORT GRAPH holds a changed file: `vitest run --project slow --changed origin/<base>` | only when the PR touches `apps/frontend/`, `packages/shared/`, `playwright.config.ts`, a `package.json`, the lockfile or a workflow |
| Push to main (`release.yml`, before publishing) | all (budget warns) | all (`pnpm test:all`) | E2E always |
| Nightly 03:17 UTC and manual (`ci.yml` `schedule` / `workflow_dispatch`) | all (budget warns) | all | always |

No run in CI takes the `live` project.

The browser checks can skip a backend-only PR because they do not read the backend: the E2E specs
answer every `/api` request from `apps/frontend/e2e/mock-api.ts`.

`--changed` walks static AND dynamic imports (`await import()` in a `beforeAll` counts), so a PR
that edits `conflict/model.ts` runs the conflict suites, and one that edits
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

## Scratch stack (`pnpm dev:scratch`)

The reader's own Limn is `pnpm dev` in the MAIN checkout: `tsx watch` on `apps/backend/data/pierre-review.sqlite`,
data dir `~/.limn`. An edit in that checkout restarts it. So **an agent edits in a git worktree and checks
its work on `pnpm dev:scratch` from that worktree**, never on the main checkout's servers.

`scripts/dev-scratch.mjs` (seeding: `scripts/lib/scratch-seed.mjs`):

| Flag | Default | What |
|---|---|---|
| `--seed demo\|copy\|empty` | `demo` | `demo`: the fictional acme/* data of `pnpm demo`. `copy`: a snapshot of the real dev DB (below). `empty`: migrations only. |
| `--slot N` | `0` | ports `4200+10N` (API) / `5373+10N` (SPA); folder `<repo>/.scratch/<N>/` (gitignored). |
| `--github off\|read\|write` | `off`; `read` for `copy` | `off`: a failing `gh` first on the PATH, no token variable. `read`: the reader's `gh` token, every write blocked in code. `write`: real writes; ask the reader each time. |
| `--sync` | off | the scheduler (sync, auto review, tracker, Slack). It spends the SAME hourly GitHub budget as the real Limn. |
| `--codex` | off | allow Codex; sign in again into the scratch Codex home (Settings → AI). `~/.limn/codex` is never shared: a token refresh could sign the real Limn out. |
| `--ml` | off | ML scoring, with `~/.limn`'s downloaded model linked in. |
| `--reseed` · `--keep-tracker` · `--no-frontend` | | replace the DB · keep tracker/Sonar/wiki tokens in a copy · API only |

Claude is on: `<slot>/ai-runtime` links to `~/.limn/ai-runtime` and the machine's Claude login is used.
`LIMN_AI_AUTO_INSTALL=false`, so the scratch stack never writes the linked runtime.

**The backend's own guards** (they apply however the process starts, with `LIMN_SCRATCH=1`):

- `config.ts` loads ONLY `<repo>/.env.scratch` (never `.env`, which can name the real DB or
  `ENCRYPTION_KEY`) and REFUSES TO START (`scratch.ts` `scratchRefusal`) on a DB under `~/.limn`,
  `~/.pierre-review` or any checkout's `apps/backend/data/`, a data dir that is or is inside `~/.limn`,
  a clone or docs dir outside the data dir, port 4000 or frontend port 5173. Paths are compared after
  `realpath`, so a symlink does not get past it.
- Unless `--github write`, the WRITE GUARD (`scratch-guard.ts`) answers every write with a 403 it never
  sends: `globalThis.fetch` (GitHub REST and GraphQL mutations, Slack, Linear/Notion/Jira writes, any
  PUT/PATCH/DELETE off loopback), plus `limnWrite`, `pushRef`/`pushForceWithLease` and the tracker's
  `node:https` transport. Model calls and loopback pass. It does not see a child process other than
  `git push`; the `gh` CLI is only used to read.
- The Claude session cleanup (`ai/session-litter.ts`) does not run: the folder it cleans is the machine's.

**One backend per data dir, every mode** (`instance-lock.ts`): `start()` takes `<dataDir>/server.lock`
(pid, port, DB) before any sweep. A live holder refuses the start and names itself; a dead pid's lock
(a crash, a SIGKILL) is taken over; the lock goes on exit. So a forgotten `LIMN_DATA_DIR` can no longer
let one backend's boot sweeps (sandbox labels, worktree GC) delete another's live work. ⚠ The installed
`limn` next to `pnpm dev` now refuses: both default to `~/.limn`.

**The copy seed**: the source is the `.sqlite` the `:4000` process has open (`lsof`), else the main
checkout's `apps/backend/data/pierre-review.sqlite`. It is opened READ-ONLY and copied with SQLite's
online backup (consistent while the real Limn writes). Then a scrub turns off auto review, auto post
(and its verdict / resolve), auto fix and Push automatically, auto diagrams, team claims, dependency
automation; deletes armed merges and Slack targets; and nulls the tracker, Sonar and wiki tokens
(`--keep-tracker` keeps them; they stay sealed without `.env`'s key). Each statement runs alone, so a
missing column is named and skipped. The scrub stops automatic work from STARTING; the write guard is
the real protection. The copy holds every PR body: it stays 0600 in the gitignored `.scratch/`.

`dev:scratch` refuses to run from the main checkout while `:4000` is served from it, and frees its own
ports only when the holder runs from THIS checkout.

**Under vitest**, an unset `DATABASE_URL` is `<LIMN_TEST_RUN_DIR>/default-<pid>.sqlite`, and the dev
default path throws: an import-time DB client can no longer open the real dev DB.

## The invariants and the tests that guard them

⚠ **Never delete, skip or weaken these to save time.** A slow one moves to `slow` (still run on
every PR that can affect it, and in full on main and nightly); it never leaves the suite.

| CLAUDE.md invariant | Suite(s) | Project |
|---|---|---|
| Cross-account isolation (every query filters on `accountId`; id getters 404) | `platform/test/isolation.test.ts`, `ai/agent-isolation.test.ts`, and `pnpm --filter @pierre-review/backend verify:isolation` (a script, not vitest) | fast |
| Rate-limit tiers (`tierFor`, exact path segments in `hitsGithub`) | `api/plugins/rate-limit.test.ts` | fast |
| No host-side worktree agent is left (`coding/agent.ts` removed); AI Fix and Implement have a shell ONLY in the sandbox | `ai/provider-seam.test.ts` | fast |
| Every model call through `ai/provider.ts` | `ai/provider-seam.test.ts` | fast |
| Claude's prompts byte-identical (`prompt-golden.json`) | `review/claude-review/prompts.test.ts`, `ai/prompt-tools.test.ts` | fast |
| Auto-post: claimed (compare-and-set) BEFORE any GitHub write, never retried; the hidden marker | `review/claude-review/auto-post.test.ts`, `review/claude-review/pair-auto-post.test.ts`, `review/ticket-review/auto-post.test.ts`, `coding/ai-fix/auto-push.test.ts` | fast |
| Migrations (platform files run once by name; backfills; upgrade paths) | `platform/test/migration-files.test.ts`, `platform/test/workspace-settings.test.ts`, `db/ai-usage-provider-migration.test.ts` | fast |
| Erasure covers every `accountId` table (`accountScopedTables()`) | `db/erase-account.test.ts`, the erasure cases in `platform/test/isolation.test.ts` | fast |
| The path guard (every agent run) | `review/path-guard.test.ts`, `ai/codex/hook.test.ts` (the PreToolUse ALLOW-list) | fast |
| A Codex run refuses unless `verifyHookTrusted` proves the hook runs | `ai/codex/hook-process.test.ts`, `ai/providers/codex.test.ts` | slow |
| The review's read-only guard roots on Codex | `review/codex-review-runs.test.ts` | slow |
| The runtime CLI never gets a credential | `sandbox/runtime/host-env.test.ts` | fast |
| The conflict resolver (no marker reaches a blob, the wand never picks a side, the commit blocked until every decidable region is decided) | `conflict/*` | slow |
| AI Fix as a sandboxed session (start at once, the report file, left-out repos, Plan first, unattended runs, no runtime, caps) | `sandbox/session/fix-session-flow-db.test.ts`, `sandbox/workspace/fix-report.test.ts`, `coding/ai-fix/auto-fix.test.ts`, `merge/dependency-automation-teams.test.ts` | fast |
| AI Fix's MERGE: only a merge with parents (PR head, base tip), no marker left and fixes on top is pushable; the item never in an auto fix | `coding/ai-fix/merge-verify.test.ts`, `sandbox/session/fix-merge-session-flow-db.test.ts` (slow), `coding/ai-fix/review-seed.test.ts`, `merge/dependency-automation-ai.test.ts` (fast) | both |
| The worktree sweep keeps a tree a live job uses | `review/worktree-gc-policy.test.ts` (fast), `review/worktree-gc.test.ts` (slow) | both |
| `isRetryableGithubError` keeps 403/429 out | `github/client.test.ts` | fast |
| One backend per data dir (live holder refuses, stale lock taken over) | `instance-lock.test.ts` | fast |
| A scratch backend refuses the real DB / data dir / ports, and writes nothing (fetch guard, `limnWrite`, git push, tracker transport) | `scratch.test.ts` | fast |
| Derived thread state | `sync/derive-thread-state.test.ts` + `sync/__fixtures__/threads/` | fast |
| zod from the SDK's own install | `ai/runtime.test.ts` | fast |

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

