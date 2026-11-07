# Implement story

> Topic doc for "Implement story" — the product flow: who sees the button, what a session does, the data,
> the routes, Fill gaps, the bases and Push. HOW the sandbox works (runtime, proxy, credentials, the
> workspace mirror, the agent drivers, services, the session manager) and how a reader sets one up is
> [SANDBOX.md](SANDBOX.md). CLAUDE.md keeps only the doc-map row; put new detail in one of the two.
> Code: `apps/backend/src/sandbox/` (the session), `apps/backend/src/coding/story-build/` (the data, the
> bases, the gap fold, Push), `packages/shared/src/story-build.ts` + `sandbox-session.ts`, the build tab
> `apps/frontend/src/components/StoryBuild/`.

## What it is

In the STORY VIEW (This Sprint's tray, the story tab, the PR view's Story tab — § Entry points), a ticket
that has NOT STARTED and has NO pull request offers **Implement**. A STARTED ticket whose current story
check found gaps offers **Fill gaps** instead (§ Fill gaps). One click opens a build tab (opened PINNED:
no ✕, kept by Close all and across a reload, until the reader unpins it) and starts a **workspace
session** (since 2026-11-07):

1. **Set up.** Limn starts a sandbox on the reader's computer with **every workspace repository** cloned
   (at the reader's own local paths, so their Claude memories still apply), the **ticket in full**
   (description, numbered acceptance criteria, open points) and the reader's **own Claude notes** — never
   a past session (owner decision D1). It takes seconds once the image is local.
2. **Talk.** The reader talks to a full Claude Code or Codex agent in the tab (plans, questions, "look at X
   first") and watches every step live. Chat turns run in plan mode: the agent reads and runs commands
   but does not change files.
3. **Build.** **Start build** reads the ticket again and switches the agent to build mode. It implements,
   runs the repositories' own tests — integration tests too, against real services from the compose
   files the reader picked — and reports per acceptance criterion. After every build turn each
   repository's work is stored as a patch.
4. **Push.** The reader reviews one diff per repository and presses **Push** (or Push all). The push runs
   on the HOST: a NEW branch and a NEW pull request, **draft** by default.

Nothing is pushed, posted or written to the tracker before the reader presses a button. With no container
runtime, the tab says what is missing in one line with "How to set up" (owner decision Q2: there is no
fallback to the removed shell-less agents).

The session machine (caps, the ONE build slot, boot, idle close, stream, restart reconcile, Resume) is
shared with AI Fix, which is its second subject (docs/SANDBOX.md § AI Fix sessions): the two features
share the machine's open sessions and its one build turn at a time.

## Owner decisions

From 2026-10-30, still in force:

1. **Stacking.** A repository with an OPEN ticket PR that is the READER'S OWN: stack on it (base = its head,
   the new PR targets that branch). Someone else's open PR: branch from the default branch and say so in
   one line. ⚠ Never a PR opened from a FORK: `candidates.ts unstackablePrs` reads it live (ONE
   `fetchPrHeadInfo` per stacked PR, at boot) and falls back to the default branch with one line ("Your #n
   is from a fork, …"; a failed read falls back too). Push re-reads it and refuses `STACK_FORK`.
2. **Draft by default** (`STORY_BUILD_PUSH_DRAFT_DEFAULT`), with a toggle to open ready for review.
3. **One build at a time per computer** (`409 BuildBusy`); chat turns in other sessions go on.
4. **Entry point:** the STORY VIEW's action group (§ Entry points): Implement ONLY on a story that is NOT
   STARTED and has no PRs; Fill gaps ONLY on a STARTED one whose current story check found gaps. ONE gate
   decides both: shared `storyBuildOffered` returns `'implement' | 'fill_gaps' | null`. Not Open PRs, not
   Reports. ⌘K offers "Implement KEY" / "Fill gaps in KEY" (or "Open KEY's build") only while that ticket's
   story view is open. Once a session exists the story view offers "Open build · <mark>" and the sprint
   card shows the build MARK (`storyBuildMark`: Working… / Waiting for you / Ready to push / Pushed) — a
   status, never a button.
5. **Gap-filling** against existing ticket PRs reads the stored story check (§ Fill gaps).
6. **Effort:** Settings → AI → Effort reaches the session's turns (`agenticRunEffort`, read once per
   session start by `sandbox/drivers/index.ts resolveSandboxAgentChoice`).

From 2026-11-06 (the workspace session; [SANDBOX.md](SANDBOX.md) has the reasons and measurements):
D1 memories only, never past sessions · D2 talk before the build · D3 on Docker, the only way out is
Limn's proxy · D4 Claude Code and Codex, chosen like every other run · D5 integration tests run in the
sandbox environment · D6 repositories outside the workspace are named and left out · D7 the setup is
documented (SANDBOX.md § Setting up a runtime) · D9 every part is free. Q1 the user `CLAUDE.md` comes in,
skills opt-in per workspace · Q2 no old fallback · Q3 the image is pulled from GHCR by digest, built
locally if that fails · Q4 the model credential is injected at the proxy (spike 3).

## Data model (migrations 0149, 0176)

Two core tables, both account-scoped, on the erase checklist (`accountScopedTables`) and in the export.

- **`story_builds`** — ONE row per session (one ticket, one click). Named composite FK
  `story_builds_workspace_account_fk` onto `workspaces (id, account_id)`, cascade. Unique `(id,
  account_id)` is the parent key for the repository rows. **One open session per ticket** is the partial
  unique `story_builds_one_open` on `(account_id, workspace_id, ident) WHERE status IN (…open…)` — in the
  `.sql` ONLY (drizzle predicates are inert); its status list is shared `STORY_BUILD_OPEN_STATUSES`.
  A session's own state is `session_phase` (shared `SandboxSessionPhase`) and `session_json` (the stored
  conversation, boot steps, layout, Network rows; `sandbox/session/state.ts`); `status` is DERIVED from
  the phase (`sandboxSessionStatus`), so the one-open index, the sprint mark and Push's `ready` check hold
  unchanged. `runtime`, `build_cost_usd`, `last_active_at`; `sandbox_ref` / `agent_ref` are internal and
  not exported. `seed_json` is NEVER on the wire and NOT exported.
- **`story_build_repos`** — ONE row per mirrored repository. Composite FKs onto `story_builds (id,
  account_id)` and `repos (id, account_id)`, both cascade; unique `(build_id, repo_id)` is the ON CONFLICT
  target. `stacked_on_pr_id` has NO FK (readers re-scope it). The work is `patch` (+ `patch_sha`,
  `stat_json`, `files_changed_json`, `commit_message`, `summary`); `sandbox_path` is where it sat in the
  sandbox. `deleteRepo` deletes the repository's rows explicitly and keeps the session.
- The plan / docs / checks columns (`plan_json`, `docs_json`, `checks_json`, `worktree_path`, …) are
  DORMANT: only rows of the removed plan/build flow carry them (§ Rows from the old flow). Never drop
  them casually ([MIGRATIONS.md](MIGRATIONS.md)).

The wire mapper is ONE function, `coding/story-build/persist.ts toStoryBuild`, with
`StoryBuild.session` from `sandbox/session/state.ts toStoryBuildSession`: never a patch (that is `GET
…/diff`), never the seed, never a sandbox id.

## States

```
POST /api/story-builds ──► booting ──► ready ◄──► chatting          (status: assessing → plan_ready ⇄ planning)
                              │          │ Start build
                       fail ⇒ failed     ▼
                                      building ──► built ◄──► building   (status: building → ready)
                                                    │ Push <repo> · Push all
                                                    ▼
                                                  pushed                  (status: ready, pushedAll)
Discard (any phase) ⇒ discarded · idle 60 min / the agent ending / a restart ⇒ closed: built when it
stored patches (pushable, Resume boots it again), else failed
```

The details (boot steps, turns, the patch extraction, closing, Resume, the stream) are
[SANDBOX.md](SANDBOX.md) § Sessions.

## Routes

Paths are spelled once in shared `STORY_BUILD_API` (`storyBuildPath(route, {id, repoId})`) and
`SANDBOX_SESSION_API` (`sandboxSessionPath(route, id)`). Every `:id` read scopes the account (wrong owner ⇒
404). Registered only from `review/agentic.ts` (`registerSandboxSessionRoutes`, which also registers
`coding/story-build/routes-build.ts`), so AI off ⇒ 404. Tiers are decided in `api/plugins/rate-limit.ts`
(pinned by `rate-limit.test.ts`, which walks every shared path). Contracts: [API.md](API.md) § Implement
story.

| Route | Does | Tier |
|---|---|---|
| `GET /api/story-builds?workspace=&ident=` | `StoryBuildForTicketResponse` | read |
| `GET /api/story-builds/:id` | `StoryBuild` (with `session`) | read |
| `GET /api/story-builds/:id/stream` | SSE `SandboxSessionStreamEvent` | read |
| `POST /api/story-builds` | `SandboxSessionStartBody` → 202/200 `StoryBuildStartResponse` (409 `NoRuntime` / `TooManySessions`, 400 `NoStory`) | ai + ai_hourly |
| `POST …/:id/messages` · `…/:id/build` · `…/:id/resume` | one agent turn · Start build · boot again → 202 | ai + ai_hourly |
| `POST …/:id/interrupt` · `…/:id/network/allow` · `…/:id/discard` | Stop · an Allow press · Discard | read |
| `GET …/:id/diff` · `GET …/:id/repos/:repoId/diff` | every stored patch · one | read |
| `POST …/:id/repos/:repoId/push` · `POST …/:id/push` | `StoryBuildPushBody` → `StoryBuildPushResponse` | github_write |

Error codes: shared `StoryBuildErrorCode` + `SandboxSessionErrorCode`.

## Entry points

ONE component, `apps/frontend/src/components/StoryBuild/StoryBuildEntry.tsx`, the primary button of the
story view's action group (beside Check against docs / Redraw design). The story view is mounted by the
tray, the story tab (`?view=ticket:…`) and the PR view's Story tab (`?prTab=story`), so all three offer it.
Gated on `me.ai.enabled` (hidden, never disabled); opens the build tab through `useOpenStoryBuild` only.

- **Inputs.** The tray hands in the board's node: the gate reads it exactly as the board would, and no
  request is made. Elsewhere the view derives the node's fields (`lib/storyBuild.ts`): the stage from the
  sprint graph already in memory, else the tracker status category (`storyStageOfCategory`: To Do ⇒ Not
  started, Done ⇒ Complete, anything else ⇒ started; unknown ⇒ Implement is never offered); the PR count
  from the view's ticket-PR read; the check from the view's ticket-check state and the latest run the
  Story section already reads (`storyViewCheck` — stale for any reason the state names); and the session
  from ONE DB read, `GET /api/story-builds?workspace=&ident=` (`sprintNodeBuildOf`).
- **A ticket outside the sprint.** The tab's `StartPanel` gates on the sprint node; with none, on what the
  story view offered (`TabTicketMeta.buildOffer`). A tab rebuilt from a URL carries no offer, so it still
  refuses.
- **The sprint card** carries no build button: only the mark (§ The sprint card).

## The sprint card

`SprintGraphNode.build: SprintNodeBuild | null` — the ticket's latest OPEN session, coarse (`id`, `status`,
`readyRepos`, `pushedRepos`), read in ONE batched query by `db/sprint-builds.ts sprintBuildsFor` inside the
graph fold (null when AI is off, for a ghost, or with no open session). It rides `changeToken`, appended
only when present. The board fetches nothing on mount. A session's phases map onto the marks through the
derived `status`: booting, a chat turn and a build turn read "Working…"; an agent waiting for the reader
"Waiting for you".

## Fill gaps

The second entry, for a ticket that is already under way. Same session, routes and tab.

- **When** (`storyBuildOffered` → `'fill_gaps'`): no open session, STARTED (≥ 1 PR, or a status past Not
  started) and not Complete, whose `SprintGraphNode.check` — the latest SUCCEEDED story check — is NOT
  stale and found gaps: `storyBuildCheckGaps` = not met + partly met + unsettled + `missing`. No check, or
  a stale one ⇒ nothing is offered. A session NEVER starts a story check.
- **Data** (DB only, no fetch on mount): `db/sprint-ticket-checks.ts` adds `missing` and `reviewId` to the
  check it already reads; the change token appends `missing` ONLY when non-zero.
- **In the session**: at boot the latest stored check is folded (`coverage.ts latestTicketCheck` +
  `foldCoverage`: `met` is done with the PRs that deliver it; everything else, and every missing item, is a
  gap), and TICKET.md carries those verdicts, so the agent builds the gaps.
- **The tab**: the header leads with the action word ("Fill gaps", `storyBuildActionOf`); the start state
  lists the gaps up front — ONE read of that run (`GET /api/ticket-reviews/:id`) when the tab opens,
  folded by shared `storyBuildGapsOf` — and its button reads "Fill gaps".

## Bases and stacking

The session clones every workspace repository; `candidates.ts baseFor` (owner decision 1) decides where
each starts, after `unstackablePrs` has read each stacked PR's head repository once. Every base sha is
PINNED by the session's own ref `refs/pierre/story-build/<buildId>/<repoId>` (`base-refs.ts`), because the
shared fetch refs move and the conflict janitor prunes (`gc --prune=now`). The refs go on Discard, once
every repository is pushed, and with the worktree sweep (`worktree-gc.ts storyBuildRefsToKeep`: kept while
the session is OPEN and that repository is not pushed).

## Push (`coding/story-build/push.ts`)

Only on the reader's press. `coding/git-ops.ts applyAndPushBranch` is the NO-PR variant of AI Fix's
stateless push: a fresh worktree at `base_sha`, the stored patch, ONE commit by the reader (the agent's
commit messages as its message), a NEW branch `limn/<ticket key>` (`BRANCH_EXISTS` refused with a
sentence, never forced; the default branch, the base ref and a stacked PR's head are protected and
refused before any process runs), then `createPullRequest` (`draft` unless the body says `draft: false`).

- **Title** `${KEY}: ${title}` (what Jira, Linear and Notion detection read).
- **Body:** the summary (the agent's last words in the build turn), the criteria this repository covers,
  the ticket link (http(s) only), `Stacked on #n.`, the sibling PRs this session already pushed, `Closes
  owner/repo#n` on a single-repository GitHub Issues build only, and "Built with Limn from KEY." The
  model- and ticket-written parts go through `defangGithubText` (a closing keyword before an issue
  reference and an `@mention` are broken with a zero-width space). The code-written `Closes` line is added
  after it.
- **Branch name**: `assertPushTarget` (git's own format check + the protected names) runs BEFORE the
  name is spelled into the `BRANCH_EXISTS` lookup URL, each segment URL-encoded.
- **Stacked:** the new PR targets the head branch of the reader's own open PR it stacks on; once that PR
  is no longer open the push is refused (`STACK_CLOSED`); a PR GitHub says is from a FORK is refused
  `STACK_FORK`, an unreadable one `STACK_UNKNOWN`.
- **Recorded** on the repository row: `pushed` + branch / PR / commit / title / body, or `push_error`. A PR
  GitHub refused to open (`PR_NOT_OPENED`) keeps the branch it pushed and says so. `getViewerCanPush` is
  re-checked (`NO_PUSH_PERMISSION`); a second press is `skipped` (`ALREADY_PUSHED`); a press while one is
  in flight is `PUSH_IN_PROGRESS`.
- **After the PR syncs** (`syncNewPrInRepo`, then `afterSync`): a `detected_from='manual'` tracker link
  row (`tracker/manual-links.ts resolveTicketRefs`, imported lazily), so GitHub Issues links it too.
- **Push all** (`pushAllRepos`) pushes every unpushed ready repository IN BUILD ORDER; each succeeds or
  fails on its own, and a later body links the earlier PRs.
- The routes answer 200 `StoryBuildPushResponse` with per-repository results (`404` for another account's
  build). The SPA refetches through `invalidateAfterPrWrite` + `['ticket-prs']` + `['sprint-graph']`.
- ⚠ Known gap: when an earlier session already pushed `limn/<key>`, Push answers `BRANCH_EXISTS` and there
  is no way to rename the branch yet.

## Limits

| Limit | Default |
|---|---|
| `LIMN_SANDBOX_MAX_SESSIONS` (open sessions on this computer) | 2 |
| `LIMN_SANDBOX_IDLE_MINUTES` (a session with nothing to do closes; its patches stay) | 60 |
| `STORY_BUILD_PATCH_MAX_BYTES` (one repository's patch; larger is refused, never cut) | 4 MB |
| Build turns at once per computer | 1 |
| CPUs / memory / disk per session (Settings → Sandbox) | 4 / 8 GB / 30 GB |

There is no per-session US$ cap: every turn is a reader's press, each turn's spend is recorded on the
ledger (`story_plan` for chat turns, `story_build` for build turns, grouped with AI Fix in Reports → AI
usage) and shown in the session's Spend panel.

## Rows from the old flow

Before 2026-11-07 Implement ran a read-only plan agent and then a shell-less build agent per repository
in host worktrees (`plan-agent.ts`, `build.ts`, `docs-runner.ts`, … — REMOVED, with their routes, prompt
goldens and the provider's `protectWrites` write deny-list). Rows it made have `session_phase IS NULL`.
`coding/story-build/legacy.ts` is all that remains for them: their Discard (kept worktrees through
`kept-worktree.ts`, pinned refs) and a boot reconcile that settles any still marked running (after
`reconcileSessionsOnStartup`; it reads only `session_phase IS NULL`). Their stored patches stay pushable
from the build tab, which shows them as closed. A new session on the same ticket closes an open old row.
The dormant columns stay (never dropped).

## The demo seed

`seed-demo-agentic.ts seedStoryBuilds` (for `pnpm demo`): PLAT-310 is a CLOSED workspace session (phase
`built`) — acme/api pushed as draft #143 (its `pull_requests` row seeded and not linked to the ticket),
acme/web-app ready to push, a stored conversation, a Network panel with one blocked host, and Resume.
PLAT-312 and PLAT-318 have no session (their story view offers Implement). PLAT-301 (in progress, its story
check current with one criterion not met and one partly met) is the Fill gaps ticket. A demo has no
sandbox, so no session is live.
