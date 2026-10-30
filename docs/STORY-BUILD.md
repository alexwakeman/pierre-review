# Implement story

> Topic doc for the "Implement story" feature (`apps/backend/src/coding/story-build/`,
> `packages/shared/src/story-build.ts`). CLAUDE.md keeps only the doc-map row; put new detail HERE.
> Status: the CONTRACT (C0) is in — shared types, the tables, the seams, the route paths and tiers, the
> sprint card field. The session manager, the agents, the push, the docs run and the screen arrive in
> work packages WP1–WP4 (§ Work packages). Sections marked _(WP n)_ describe the agreed design that WP
> implements.

## What it is

On the This Sprint board, a ticket that has NOT STARTED (its status sits in the Not started bucket) and has
NO pull request shows an **Implement** button. One click opens a build tab that:

1. **Assesses** the ticket: its story and criteria, and (rarely, since the button needs no PRs) what any
   existing ticket PRs already deliver — the gap fold.
2. **Plans** the work across at most 4 repositories with a READ-ONLY agent (`story_plan`). The reader
   steers the plan by chat, optionally with a planned design diagram.
3. Optionally **weighs the workspace docs** against the plan. **The story wins**: where they disagree the
   docs point is "superseded", never a fix to the story.
4. On **Accept**, **builds** each repository IN PLAN ORDER, one at a time, in its own kept worktree with a
   write agent that has NO SHELL (`story_build`), optionally running the project's own checks in the
   sandbox ("Run tests").
5. **Pushes** each repository as a NEW pull request — only when the reader presses Push. PRs open as
   **draft** by default (a toggle opens them ready for review).

Nothing is pushed, posted or written to the tracker before the reader presses a button.

## Owner decisions (2026-10-30)

These override the design document where they differ.

1. **Stacking.** A repository with an OPEN ticket PR that is the READER'S OWN: stack on it (base = its head,
   the new PR targets that branch). Someone else's open PR: branch from the default branch and say so in
   one line (`StoryBuildCandidate.baseNote`).
2. **Draft by default** (`STORY_BUILD_PUSH_DRAFT_DEFAULT`), with a toggle to open ready for review.
3. **≤ 4 repositories change** (`STORY_BUILD_MAX_REPOS`), built **sequentially in plan order** (a later
   repository reads earlier ones' worktrees read-only); **one build at a time per machine**.
4. **Entry point:** the Implement button appears ONLY on This Sprint ticket cards whose story is NOT
   STARTED and has no PRs (shared `storyBuildOffered`). Not the story view header, not Open PRs, not
   Reports. ⌘K offers "Implement KEY" only for the same tickets while the sprint board is open; the build
   tab registers its own commands (Accept plan, Push all, Cancel). Once a session exists the card shows the
   build MARK (`storyBuildMark`: Building… / Plan ready / Ready to push / Pushed) and a click opens the tab.
5. **Gap-filling** against existing ticket PRs stays in the backend (cheap), though (4) makes it rare.
6. **Docs defaults:** suggestions ticked, superseded unticked ("the story wins, acknowledged"), grounded
   informational (`storyBuildDocsDefaultDecision`).
7. **Effort:** Settings → AI → Effort reaches `story_plan` and `story_build`. Default model depth: deep for
   both.
8. **Session budget** `STORY_BUILD_SESSION_BUDGET_USD` (default 30), with the per-pass caps below;
   `OverBudgetConfirm` before Start and Accept.

## Data model (migration 0149)

Two core tables, both account-scoped and on the erase checklist (`accountScopedTables`) and in the export.

- **`story_builds`** — ONE row per session (one ticket, one click). Named composite FK
  `story_builds_workspace_account_fk` onto `workspaces (id, account_id)`, cascade: a session stays with the
  workspace it started in. Unique `(id, account_id)` is the parent key for the repository rows.
  **One open session per ticket** is the partial unique `story_builds_one_open` on
  `(account_id, workspace_id, ident) WHERE status IN (…open…)` — in the `.sql` ONLY (drizzle predicates are
  inert); its status list is shared `STORY_BUILD_OPEN_STATUSES`. `seed_json` (the frozen, fenced prompt
  inputs, `persist.ts StoryBuildSeed`) is NEVER on the wire and NOT exported.
- **`story_build_repos`** — ONE row per repository in a session. Composite FKs onto
  `story_builds (id, account_id)` and `repos (id, account_id)`, both cascade; unique `(build_id, repo_id)` is
  the ON CONFLICT target. `stacked_on_pr_id` has NO FK (readers re-scope it). `deleteRepo` deletes the
  repository's rows explicitly and keeps the session.

The wire mapper is ONE function, `coding/story-build/persist.ts toStoryBuild`: never a patch (that is
`GET …/diff`), never the seed, never a worktree path.

## State machine _(WP1)_

```
POST /api/story-builds  ──► assessing ──► planning ──► plan_ready ◄──► planning (chat re-plan)
                                │                         │
                         fail ⇒ failed            Accept (revision, repos, checks) ⇒ building
                         cancel ⇒ cancelled               │ per included repo, IN PLAN ORDER:
                                                          │ queued → preparing → building → checking
                                                          ▼          → ready | failed | cancelled
                                                        ready  (≥ 1 ready; all failed ⇒ failed)
                                                          │ Retry <repo> · Push <repo> · Push all
                                                          ▼
                                       pushedAll (derived; status stays `ready`)
Discard (any non-running state) ⇒ discarded
```

- **Restart reconcile:** `assessing`/`planning` with a plan → `plan_ready` ("Stopped when Limn
  restarted."); without one → `failed`. A repository in `preparing/building/checking` → `failed`, or
  `ready` if an earlier pass stored a patch.
- **The stream gap:** set the in-memory running marker in the same tick as the claim
  (`persist.ts insertStoryBuild`), before any await, and emit `done` on every bail path.

## Phases and agents

| Phase | Kind | Model | Tools | Read roots | Write roots |
|---|---|---|---|---|---|
| Repo shortlist | `complete` | fast | none | none | none |
| Ticket check (if needed) | `ticket_review` | unchanged | unchanged | unchanged | none |
| Assess + plan, re-plan | `story_plan` | reader's pick (deep) | Read/Glob/Grep + `submit_story_plan` | candidate checkouts (+ library) | **none** |
| Docs consideration | `story_docs` | Haiku shortlist + Sonnet read | Read/Glob/Grep + `submit_build_docs` | shortlisted doc folders | none |
| Build (per repo) + hook repair | `story_build` | the session's | file tools + `run_check` (opt) + `submit_build` | own worktree, earlier repos' worktrees, library | own worktree minus the deny-list |

- **`Bash` is denied on every phase.** The build also gets a second PreToolUse write hook that denies
  `.github/**`, `.git*`, `.husky/**`, `.npmrc` / `.yarnrc*` / `.pnpmfile.cjs`, lockfiles and CI configs
  (mirrored in `ai/codex/hook-rule.ts`, inside the ALLOW-list). The ticket text, comments, PR cards and
  docs are UNTRUSTED and nonce-fenced; the reader's chat is the one steering block.
- **Both providers.** The agent kinds `story_plan` / `story_build` are in `AI_AGENT_KINDS` (so `/api/me`
  `ai.kinds` reports both) and in `ai/codex/kinds/story-build.ts`. ⚠ They were listed there FROM THE
  CONTRACT COMMIT, ahead of their runners, because `codexRunnable()` needs every kind; WP1 and WP2 MUST each
  ship the Codex port (strict schema in `ai/result-schemas.ts`, workspace-MCP read roots, the hook rule,
  offline tests on recorded streams) with the runner.
- **Run choice:** a MANUAL run with a model menu (`resolveManualRunChoice(kind:'story_plan')` at Start);
  chat, docs and build follow up on the session's provider (`followUpProvider`, `requestModelOf`).
- **Worktree ledger:** two kinds so a `runId` names one table — `'story_plan'` (read-only plan checkouts,
  runId = `story_builds.id`) and `'story_build'` (each repository's KEPT write worktree, runId =
  `story_build_repos.id`). The patch is stored after every pass, so a swept tree is re-made from
  `base_sha` + patch. `worktree-gc.ts dbFacts` learns both kinds in WP1/WP2.
- **Spend ledger** (`ai_usage.feature`, shared `STORY_BUILD_LEDGER_FEATURES`): `story_plan`,
  `story_build_repos`, `story_build`, `story_build_docs` — grouped with AI Fix in Reports → AI usage.

## Limits

Defaults in shared, env overrides read at call time by `coding/story-build/limits.ts storyBuildLimits()`.

| Limit | Default |
|---|---|
| `STORY_BUILD_SESSION_BUDGET_USD` (whole session) | 30 |
| `STORY_PLAN_BUDGET_USD` (assess + plan, summed across revisions) | 4 |
| `STORY_BUILD_REPO_BUDGET_USD` (one repository + hook repairs) | 8 |
| A pass is refused below this much budget left | $0.25 |
| `STORY_PLAN_MAX_TURNS` / `STORY_BUILD_MAX_TURNS` | 40 / 80 |
| `STORY_BUILD_PATCH_MAX_BYTES` | 4 MB |
| Repositories that change / candidates read | 4 / 6 |
| Plan revisions / chat message | 12 / 2,000 chars |
| Steps per repository / step title | 12 / 120 chars |
| Builds at once per machine | 1 |

## Routes

Paths are spelled once in shared `STORY_BUILD_API` (`storyBuildPath(route, {id, repoId})`). Every `:id`
read scopes the account (wrong owner ⇒ 404). Registered only from `review/agentic.ts`
(`registerStoryBuildRoutes`), so AI off ⇒ 404. Tiers are decided in `api/plugins/rate-limit.ts`
(pinned by `rate-limit.test.ts`, which also walks every `STORY_BUILD_API` path).

| Route | Does | Tier | WP |
|---|---|---|---|
| `GET /api/story-builds?workspace=&ident=` | `StoryBuildForTicketResponse` | read | 1 |
| `GET /api/story-builds/:id` | `StoryBuild` | read | 1 |
| `GET /api/story-builds/:id/stream` | SSE `StoryBuildProgress` | read | 1 |
| `POST /api/story-builds` | `StoryBuildStartBody` → 202/200 `StoryBuildStartResponse` | ai + ai_hourly | 1 |
| `POST …/:id/plan/message` | re-plan pass | ai + ai_hourly | 1 |
| `POST …/:id/accept` | freeze + start the builds (409 `PlanMoved`) | ai + ai_hourly | 1 |
| `POST …/:id/cancel` · `…/discard` | DB + abort | read | 1 |
| `GET …/:id/repos/:repoId/checks` | `StoryBuildChecksPreview` | search + read | 2 |
| `POST …/:id/repos/:repoId/retry` | rebuild one repository | ai + ai_hourly | 2 |
| `GET …/:id/repos/:repoId/diff` | `StoryBuildDiffResponse` | read | 2 |
| `POST …/:id/repos/:repoId/push` · `POST …/:id/push` | `StoryBuildPushBody` → `StoryBuildPushResponse` | github_write | 2 |
| `POST …/:id/docs` | `StoryBuildDocsBody` → 202/200 `StoryBuildDocsResponse` (`started` · `already_running` · `current` · `refused`) | ai + ai_hourly | 3 |
| `PUT …/:id/docs/decisions` | `StoryBuildDocsDecisionsBody` → the decisions in force (DB only) | read | 3 |

Error codes: shared `StoryBuildErrorCode`.

## The sprint card

`SprintGraphNode.build: SprintNodeBuild | null` — the ticket's latest OPEN session, coarse (`id`, `status`,
`readyRepos`, `pushedRepos`), read in ONE batched query by `db/sprint-builds.ts sprintBuildsFor` inside the
graph fold (null when AI is off, for a ghost, or with no open session). It rides `changeToken`, appended
only when present, so a sprint with no session keeps its old token. The board fetches nothing on mount.

## Docs consideration _(WP3)_

A `build` mode of the story-docs pipeline — the SAME `story_docs` read (shortlist, inlined sections, the
shortlisted documents' folders as the only read-only roots, Read/Glob/Grep + one submit, Bash and every write
tool denied, low effort on both providers, `storyDocsTurnCap`) — weighed against the session's PLAN, with its
own answer `submit_build_docs` (`review/story-docs/schema.ts`, strict form in `ai/result-schemas.ts`).

- **THE PRECEDENCE RULE: the story is the spec** (`review/story-docs/build-prompts.ts`). `grounded` = the docs
  agree; `superseded` = the story changes what the docs say — NEVER a fix to the story; `suggestion` = the docs
  require something the story is silent on (only this kind carries `suggestion` text). The validator holds the
  machine-checkable half: a `suggestion` on any other kind is REFUSED back ("the story is never changed to
  match the docs").
- **Shape** (`build-validate.ts`, refused with what to fix, ≤ 3 attempts; Codex: one `exec resume`): a 2–3
  sentence summary, ≤ `STORY_BUILD_DOCS_ITEMS_MAX` (12) items, `about` ONLY from the values the prompt lists
  (`story`, the gap fold's `AC…`/`M…`, every plan step `R1:step 3`; loose spellings read canonical), note ≤ 400,
  suggestion ≤ 240, 1–3 references with quotes of ≥ 12 letters.
- **Grounding = DROP**: every reference through `validateDocReferences` against the library filtered to the
  shortlist; an item with none left is dropped. Survivors get ids `D1…` in order. Something said but nothing
  survives ⇒ `nothingGrounded` with the summary hidden. An empty shortlist stores "Nothing in the docs bears on
  this plan." with no items.
- **Inputs** (`docs.ts buildDocsInputsOf`): the frozen seed (story, comments), the gap fold (else the seed's
  criteria as `AC<n>`), the CURRENT plan revision and the candidates' names — all nonce-fenced, all in the
  nonce scan. The prefilter's query adds the plan's steps.
- **Storage**: the SESSION's row only (`docs_status` running → ready | failed | refused, `docs_json`,
  `docs_error`, `docs_cost_usd` summed across runs) — never `story_docs_alignments`. A new run CLEARS
  `docs_decisions_json` (its ids name different points). Ledger: `story_docs_shortlist` + `story_build_docs`.
- **Provider and spend**: a follow-up on the session's provider when it can run `story_docs`, else the default
  (`buildDocsProvider`); the read's US$ cap is min(`STORY_DOCS_ALIGNMENT_BUDGET_USD`, the session's remaining
  budget); below $0.25 left ⇒ `409 SessionBudgetSpent`.
- **The queue** (`docs-runner.ts`): one claim per session, taken synchronously; one FIFO lane (≤ 10 ⇒ `409
  Busy`); a registered review-slot PEER (read-only pass). A throw, a timeout (10 min), an abort
  (`abortStoryBuildDocs` — WP1 calls it on Cancel / Discard / Accept) or a restart
  (`reconcileStoryBuildDocsOnStartup`, kicked from `registerStoryBuildDocsRoutes`) all end `failed` with a
  sentence — never stuck `running`. Progress: `onStoryBuildDocsProgress` (the manager forwards each event to the
  session SSE; `{kind:'done'}` ends a run) and `phase` on the row while no plan/build pass owns it.
- **Defaults** (owner decision 6, `storyBuildDocsDefaultDecision`): suggestion ticked, superseded unticked,
  grounded no checkbox. `PUT …/docs/decisions` merges over the stored ones, drops unknown and grounded ids, and
  refuses while a docs run is in flight (it replaces the points) and once the plan is accepted. ⚠ A run that
  outlives Accept, Cancel or Discard ends `failed` "Stopped." and never replaces `docs_json`: the frozen
  decisions name its ids. The `about` list printed to the model (outside the fences) keeps only short codes.
- **Consumption** (`docsBlocksFor(build, {nonce, frozen})`, through `storyBuildDeps()`): `included` = every
  ticked item, fenced `DOCS POINTS THE READER INCLUDED` (a ticked SUPERSEDED item says the reader chose the docs
  there); `superseded` = every unticked superseded item, fenced `DOCS THE STORY SUPERSEDES (acknowledged)`
  ("the story wins"). Grounded items never reach a prompt. ⚠ The pass's nonce must be picked over
  `storyBuildDocsUntrustedTexts(build, {frozen})` too. `frozen: true` reads `accepted_docs_json` (the build).
- **"n docs points aren't in the plan yet"** = shared `storyBuildDocsPending(docs, decisions)`: a point the
  reader includes now that the latest plan pass did not, or the reverse. ⚠ WP1's plan pass stores
  `docsJson: plannedDocsFor(build)` WITH its new plan (stamps `plannedDecisions`), so pending reads 0 until the
  reader changes a decision; docs with no stamp count every included point as pending.

## Push _(WP2)_

A no-PR `applyAndPush` variant (base = `base_sha`; protected refs = the default branch, plus the stacked
PR's head), `createPullRequest` with `draft`, `getViewerCanPush` re-checked. Title `${KEY}: ${title}` (what
Jira, Linear and Notion detection read). Body: the summary, the criteria covered, the ticket link
(`safeExternalUrl`), sibling PRs already pushed, "Built with Limn from <KEY>". GitHub Issues: "Closes" only
on a single-repository build. Always a `detected_from='manual'` tracker link row after the PR syncs. Push
all runs in plan order; each repository succeeds or fails on its own. The SPA refetches through
`invalidateAfterPrWrite` + `['ticket-prs']` + `['sprint-graph']`.

## Work packages

| WP | Branch | Owns |
|---|---|---|
| C0 contract | `feat/story-build-contract` | this doc; shared `story-build.ts`; the kinds; migration 0149 + schema; erase/export/deleteRepo; `persist.ts`, `seams.ts`, `limits.ts`; route stubs; tiers; `WorktreeKind`; `db/sprint-builds.ts` + the fold field |
| WP1 session + plan | `feat/story-build-plan` | `inputs`, `coverage`, `candidates`, `checkouts`, `plan`, `plan-agent`, `prompts` (plan), `manager`, `routes.ts`, SSE; Codex `story_plan`; gc facts for `story_plan` |
| WP2 build + push | `feat/story-build-build` | `coding/agent.ts buildInWorktree` refactor, `prepBranchWorktree`, the write-deny hook, `build.ts`, `push.ts`, `routes-build.ts`; Codex `story_build`; gc facts for `story_build` |
| WP3 docs | `feat/story-build-docs` | the story-docs `build` mode, `docs.ts`, `routes-docs.ts` |
| WP4 frontend + demo | `feat/story-build-ui` | the tab kind, `useOpenStoryBuild`, `components/StoryBuild/*`, the card button + mark, ⌘K, hooks + client, `mock-api.ts`, demo seed/recorder |

Each WP owns its files; the manager reaches WP2/WP3 only through `seams.ts` (`storyBuildDeps()`; tests use
`setStoryBuildDepsForTests`). Merge order: WP1 → WP3 → WP2 → WP4, then re-record the demo.
