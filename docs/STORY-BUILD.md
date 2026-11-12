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
   (at the reader's own local paths — found through their Claude projects, there is no folder setting — so
   their Claude memories still apply; the boot step counts them, "Loading repositories 3/7: owner/name"; why
   every repository and not a subset: docs/SANDBOX.md § AI Fix sessions → "Which repositories"), the **ticket in full**
   (description, numbered acceptance criteria, open points) and the reader's **own Claude notes** — never
   a past session (owner decision D1). It takes seconds once the image is local.
2. **Plan** (§ Plan first). Limn sends the opening turn itself: the agent investigates the code, the data
   and (with docs) the reference documents, and submits a STRUCTURED PLAN that Limn checks on the host.
   The reader settles each point of contention (Agree / Keep the story / Reply) and talks to the agent
   in the tab; chat turns run in plan mode (the agent reads but does not change files).
3. **Build.** **Approve and start** reads the ticket again and switches the agent to build mode. It implements,
   runs the repositories' own tests — integration tests too, against real services from the compose
   files the reader picked — and reports per acceptance criterion. After every build turn each
   repository's work is stored as a patch.
4. **Push.** The reader reviews one diff per repository and presses **Push** (or Push all). The push runs
   on the HOST: a NEW branch and a NEW pull request, **draft** by default. Or, opted in at Start, THE
   REVIEW LOOP runs (§ The review loop): Limn pushes the branch, reviews it and checks it against the
   ticket, the agent answers every point, each fix is a new commit, and after N rounds the PR opens.

Nothing is pushed, posted or written to the tracker before the reader presses a button — the one
exception is the opt-in "After the build: review and fix, then open the pull request" (§ The review
loop): the reader's tick is the consent. Even then GitHub sees only the branch commits and the final PR. With no container
runtime, the tab says what is missing in one line with "How to set up" (owner decision Q2: there is no
fallback to the removed shell-less agents).

The session machine (caps, the ONE build slot, boot, idle close, stream, restart reconcile, Resume) is
shared with AI Fix, which is its second subject (docs/SANDBOX.md § AI Fix sessions): the two features
share the machine's open sessions and its one build turn at a time.

## Plan first

Owner decisions 2026-11-07: data evidence = repository data (fixtures, seed data, schemas, migrations) and
queries the agent ran through `limn-svc run` against a sandbox service — nothing from production; the
plan is a structured panel; when the story needs work the plan carries a DRAFT ticket update, which the
reader may edit and copy — and, since 2026-11-08, write to a Jira ticket with **Update ticket** (their
press, once; docs/TRACKERS.md § The ticket update — Approve then reads the updated ticket); ≤ 3 PRs per repository, ≤ 6 in all, each building and
passing its tests on its own; Fill gaps gets the same flow, its plan about the gaps; after Approve the
build runs to the end (Stop / redirect stay). The split button offers "Implement with docs" / "Fill gaps
with docs" when the workspace has a built reference document (`docsContextFor().hasDocs`, the `available`
Check against docs reads — not `.usable`, which also needs the Claude Review switch). There is no "build
without a plan": a session whose agent never sends a usable plan can only be messaged or discarded.

- **The opening turn** (`sandbox/session/plan.ts planOpeningInstruction`) is the subject's `firstTurn`,
  sent the moment the agent is ready (the reader's Implement click, so no budget question). The reader's
  line reads "Plan" ("Plan with docs").
- **The plan** leaves the sandbox as the LAST ```` ```limn-plan ```` block of the turn's final text (Claude's
  plan mode refuses every write, so not a file), shape `limn.plan/1` (shared `build-plan.ts`
  `BuildPlanRaw`): the repositories it will change, one entry per criterion (AC1… in TICKET.md's order;
  Fill gaps also the missing items, and a gap may not be `met`), the points of contention, each with 1–4
  pieces of evidence, the PR stack, and an optional ticket update in the ticket's own format. The stored
  conversation item has the block replaced by one line. THE check is docs/SANDBOX.md § The plan and its
  checks: ONE validator text, then every piece of evidence verified on the HOST; what fails is dropped, a
  point left with none is dropped, and only counts and plain reasons are kept.
- **The whole-ticket update** (owner decision 2026-11-12; docs/TRACKERS.md § The ticket update): TICKET.md
  tells the agent WHERE the criteria live (`SessionTicket.acLocation`, `tracker/ac-location.ts`: a field,
  the description's AC section, or none), the criteria as written and the LAYOUT to keep (headings in
  order, list style, GIVEN / WHEN / THEN; shared `ticket-layout.ts`, `seed.ts ticketLayoutFacts`).
  `ticketUpdate` is REQUIRED when the plan has a point of contention OR a criterion is `not_planned` (the
  revised-criteria case); each field is the whole new text or null; criteria that live in the description
  go inside `description` (the validator refuses `acceptanceCriteria` then, via `plan-context.json`
  `ticket`). The host stores the layout check on the revision (`ticketUpdate.layoutProblems`, advice
  only). The plan panel's ticket review (`TicketUpdatePanel.tsx`) is ALWAYS shown on the latest revision —
  seeded with the draft, else the current ticket — and after Approve until the first build turn ends;
  ONE **Update ticket** press writes only what changed. Nothing in the build or the review loop writes
  the tracker.
- **Revisions** (`story_build_plans`): every usable plan is a revision (≤ 12; an identical resubmission is
  none). Agree / Keep the story are stored at once on the LATEST revision (no turn). Reply stores the
  reply and sends a revision turn. A free message is a revision turn only when its answer has a block. An
  answer carries to the next revision when the contention's id AND fingerprint (its problem + evidence)
  are unchanged. No usable plan after an opening, reply or (no plan yet) message turn ⇒ ONE automatic
  repair turn per reader action, which asks the budget gate first (refused ⇒ no turn, one line).
- **Approve and start** (latest revision, every point answered, live, build slot free): ONE transaction sets
  `approved_plan_id` / `approved_at` and writes one `story_build_prs` row per planned PR; `PLAN.md` (the
  plan and the decisions) goes into the sandbox; ONE build turn (`planBuildInstruction`). Start build is
  refused `PlanNotApproved` on a plan-first session. Branches: P1 of a repository on `<KEY>` (the ticket key), its
  second and third on `<KEY>-2` / `-3`.
- **Closed in the plan stage** (idle, the agent ended, a restart): the session keeps its plan as
  `plan_ready` (not live, resumable). Resume boots it, writes PLAN.md marked "not approved yet" and sends
  NO turn. Approve on a closed session: `409 NotLive` ("Resume the session first.").
- **With docs** (`with_docs`): a boot step copies a READ-ONLY subset of the library into the sandbox
  (docs/SANDBOX.md § The workspace mirror → Reference documents) and TICKET.md points at it.
- **The build after Approve** (`planBuildInstruction`): one branch line per planned PR, "make each branch
  from the previous one" for a real stack, the reader's decisions through PLAN.md, Fill gaps "only the
  gaps", and THE BUILD REPORT (`sandbox/workspace/build-report.ts`): `<root>/.limn/build-report.json` —
  per PR status (done / partly / not_done), a summary (its PR body's opening) and the checks it ran; per
  criterion met / partly / not_met — checked with `node ~/.limn/build-report-check.cjs` (ONE validator
  text, the fix-report pattern; Approve copies the checker and `build-context.json` in). A SELF-REPORT:
  shown as "The agent says", never a gate; missing ⇒ the agent's last words, checks "not reported".
- **Unattended to the end**: a build turn that hit the turn cap (`max_turns`) with work unfinished (the
  report says so, or there is none, or a PR is not ready) gets at most TWO automatic continuation turns
  (`stack-turn.ts CONTINUE_LINE`), each an AUTOMATIC run that asks the ONE budget gate first (refused ⇒
  no turn, one notice). Never after Stop or any other end; a reader's message resets the count.
- **Stacks** (`sandbox/session/stack-turn.ts`, after EVERY build turn of an approved plan): per repository
  with planned PRs, ONE git bundle of the planned branches leaves the sandbox (`stack.ts`
  `EXTRACT_STACK_SCRIPT`: `refs/limn/stack/<k>` `^refs/limn/base`, ≤ 8 MB, base64; uncommitted work folded
  into the LAST branch only when it is checked out; a repository with ONE planned PR reads HEAD, as
  before plans) and is VERIFIED ON THE HOST in Limn's clone cache for that repository only
  (`coding/story-build/stack-verify.ts`: only the expected heads, the only prerequisite the base, fetched
  with fsck into `refs/pierre/story-build/<id>/stack/<prRowId>`, base → tip 1 → tip 2 … each an ancestor
  of the next, no merge commit, ≤ 200 commits, no gitlink, no path in `.git`). Each PR row gets the
  HOST's patch (against the PR before it), tip, tree and status (`ready` · `empty` · `failed`, with the
  reason); a failure at PR k fails k and every later PR of that repository. The repository row holds the
  WHOLE change (base → last good tip), so its diff, Resume and the sprint marks keep working. A pushed
  PR is never rewritten. Work in a repository with no planned PR is LEFT OUT (one notice). The planned
  PRs go out on the stream (`{ type: 'prs' }`).
- **Resume of an approved plan** (`restoreApprovedStack`): each stored PR patch back as ONE commit on its
  own branch, each branch made from the previous one, the last left checked out.
- The push of the planned PRs is § Push → Pushing a stack.

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
   STARTED or IN PROGRESS (widened 2026-11-12) and has no PRs; Fill gaps ONLY on a STARTED one whose current story check found gaps. ONE gate
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

From 2026-11-12 (the whole-ticket update, docs/TRACKERS.md § The ticket update): the plan's draft covers
the WHOLE ticket (description and acceptance criteria) and keeps its layout; the reader reviews and edits
both after planning, sees what changes, and writes them with ONE Update ticket press (Jira only; other
trackers copy). The criteria go where the ticket keeps them — their own field in its own format (editmeta),
or the description's criteria section — and the write stays the reader's press only.

From 2026-11-12 (THE REVIEW LOOP, § The review loop):
- The opt-in is "After the build: review and fix, then open the pull request" — it REUSES
  `story_builds.auto_push` as the switch, with a rounds number N (`loop_rounds`, default 3, 1..6), set in
  the Start panel and in the tab until the loop starts. Unticked = the manual flow (Push). The old "Push
  automatically" (one push when the build finishes) is RETIRED: the subject no longer calls
  `maybeAutoPushBuild`.
- The review is Limn's OWN machinery, exactly as a PR review: the code review per target with the
  providers the workspace's auto review uses (Claude + Codex pair on `both`), and ONE story check across
  every target per round (`activeProviderId()`, never a pair). Every finding — blockers, warnings, nits and
  QUESTIONS — and every open criterion goes to the agent, which fixes, answers or PUSHES BACK; it may call a
  criterion not applicable, which the next story check judges. A blocker is never settled by pushback alone.
- Everything the reviewers and the agent say stays IN LIMN: no GitHub comment or review, no tracker write.
  GitHub sees the branch (pushed BEFORE the first review, no PR), one NEW fast-forward commit per fix pass
  per target (never forced), then the PR, READY FOR REVIEW, the reader's own.
- Every automatic run asks the ONE budget gate; a refusal PAUSES with a line and Continue (a reader's press
  is never refused). Every GitHub write is claimed first and never retried; a restart pauses (never resumes
  by itself) and Continue adopts a write that did land.
- After the PR opens, the closing review is stored as ONE non-posted `claude_reviews` row at the PR head
  (trigger `manual`), so auto review does not review the same head again.

## Data model (migrations 0149, 0176, 0179, 0185, 0186, 0187)

Four core tables, all account-scoped, on the erase checklist (`accountScopedTables`) and in the export.

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
- **`story_build_plans`** (0179) — ONE row per plan revision: the verified `plan_json`, `raw_sha`, this
  revision's answers `decisions_json` and the replies sent from it `replies_json` (the decision log).
  Composite FK onto `story_builds (id, account_id)`, cascade; unique `(build_id, revision)`.
- **`story_build_prs`** (0179) — ONE row per PLANNED pull request, written at Approve: key, plan order
  (`position`), `stack_index`, branch, criteria, depends-on, status (shared `StoryBuildPrStatus`), and the
  host-computed patch / tip / tree and the push record. Composite FKs onto the build, the repository and
  the plan row; `deleteRepo` deletes a repository's rows explicitly.
- `story_builds.with_docs`, `approved_plan_id` (NO FK; re-scoped by `(build_id, account_id)`) and
  `approved_at` (0179).
- **The review loop** (0186; § The review loop): `story_builds.loop_rounds` (N), `loop_state`,
  `loop_round`, `loop_pause`, `loop_error`, `loop_resume` (the step Continue returns to), `loop_claimed_at`
  (THE START CLAIM, compare-and-set, never cleared) and `loop_finished_at`; per target
  (`story_build_repos` / `story_build_prs`) `loop_branch`, `loop_pushed_sha`, `loop_pushed_tree`,
  `loop_pushed_at` and `loop_ended` (`pr_opened` | `manual_push` | `stopped`). Five account-scoped
  tables, all with a composite FK onto `story_builds (id, account_id)`: `story_build_loop_pushes` (ONE
  row per GitHub write, inserted BEFORE it — the unique `(build_id, round, step, target_kind, target_id,
  attempt)` is the claim), `story_build_reviews` (one row per code-review run: the `claude_reviews`
  columns and JSON) + `story_build_review_findings` (its findings, with the agent's `response`,
  `response_text`, `response_round` and `merged_into` for a pair's duplicates), `story_build_story_checks`
  (one per round: assessment, members, claims, claim verdicts) and `story_build_ac_responses` (the agent's
  answer per criterion and round). Ids on the wire are BUILD-LOCAL. Contracts: [DATA-MODEL.md](DATA-MODEL.md).
- The plan / docs / checks columns (`plan_json`, `docs_json`, `checks_json`, `worktree_path`, …) are
  DORMANT: only rows of the removed plan/build flow carry them (§ Rows from the old flow). Never drop
  them casually ([MIGRATIONS.md](MIGRATIONS.md)).

The wire mapper is ONE function, `coding/story-build/persist.ts toStoryBuild`, with
`StoryBuild.session` from `sandbox/session/state.ts toStoryBuildSession`: never a patch (that is `GET
…/diff`), never the seed, never a sandbox id.

## States

```
POST /api/story-builds ──► booting ──► planning ──(a usable plan)──► plan_ready ◄──► revising  (Reply / message / repair)
                              │           └──(none)──► ready ──(message)──► revising
                       fail ⇒ failed      plan_ready ──Approve and start (every point answered)──┐
                                                                                                    ▼
                                      building ──► built ◄──► building   (status: building → ready)
                                                    │ Push <repo> · Push all · Push <planned PR>
                                                    ▼
                                                  pushed                  (status: ready, pushedAll)
Discard (any phase) ⇒ discarded · idle 60 min / the agent ending / a restart ⇒ closed: built when it
stored patches (pushable, Resume boots it again), plan_ready when it holds an unapproved plan, else failed
```

`planning` and `revising` are stored as status `planning` ("Working…"), `plan_ready` as `plan_ready`
("Waiting for you"). A session from before plan first keeps `ready ⇄ chatting` and Start build.

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
| `POST …/:id/messages` · `…/:id/build` · `…/:id/resume` | one agent turn · Start build (409 `PlanNotApproved` on a plan-first session) · boot again → 202 | ai + ai_hourly |
| `POST …/:id/plan/reply` · `…/:id/plan/approve` | a revision turn · Approve and start → 202 (409 `PlanStale` / `PlanUnanswered` / `AgentBusy` / `BuildBusy` / `NotLive`) | ai + ai_hourly |
| `POST …/:id/plan/decisions` · `GET …/:id/plan?revision=` | Agree / Keep the story / clear → `BuildPlanView` · one older revision | read |
| `POST …/:id/interrupt` · `…/:id/network/allow` · `…/:id/discard` | Stop · an Allow press · Discard | read |
| `GET …/:id/diff` · `GET …/:id/repos/:repoId/diff` | every stored patch · one | read |
| `POST …/:id/repos/:repoId/push` · `POST …/:id/push` | `StoryBuildPushBody` → `StoryBuildPushResponse` (plan first: that repository's stack / every planned PR, in order; adds `prs`). `branch` only on the per-repository push of a build without planned PRs (400 elsewhere) | github_write |
| `GET …/:id/prs/:prId/diff` | plan first: one planned PR's host-computed patch, `StoryBuildPrDiffResponse` | read |
| `POST …/:id/prs/:prId/push` | plan first: one planned PR → `StoryBuildPushResponse` with `prs: [one]`; takes `branch` | github_write |
| `POST …/:id/auto-push` | the loop's switch, kept for older clients: `StoryBuildAutoPushBody {on}` → `{autoPush}` (400 not a boolean · 404 · 409 `NotReady` once anything pushed or the loop was claimed) | read |
| `GET …/:id/loop` | `StoryBuildLoopRouteResponse {loop}` (404 when the option was never on) | read |
| `POST …/:id/loop/settings` | `{on?, rounds?: 1..6}` → `{loop}` (400 · 404 · 409 `LoopStarted` once claimed or anything pushed) | read |
| `POST …/:id/loop/continue` | `{branch?: {kind, id, name}}` → 202 `{loop}`: the reader's press, one new attempt of the paused step (409 `NotReady` when not paused) | ai + ai_hourly + github_write |
| `POST …/:id/loop/stop` | stop at the next checkpoint → `{loop}` (409 `NotReady` when not running) | read |
| `POST …/:id/auto-approve` | `{on}` → `{autoApprovePlan}` (400 · 404 · 409 `NotReady` once the plan is approved) | read |
| `POST …/:id/ticket-review` | `{done}` → `{ticketReviewDoneAt}`: the ticket step closed (true) or open again (false) | read |
| `GET /api/story-builds/active?workspace=` | THE BUILDS TOAST: `StoryBuildActivityResponse` (DB + the live map) | read |

Error codes: shared `StoryBuildErrorCode` + `SandboxSessionErrorCode` + `BuildPlanErrorCode`. The plan paths
are shared `BUILD_PLAN_API`; the start body's `docs: true` is `400 NoDocs` without a built document; its
`autoPush: true` (+ `loopRounds`, an integer 1..6) stores the option (§ The review loop; a non-boolean is 400). The
stream adds `{ type: 'plan', plan }`, `{ type: 'prs', prs }` and `{ type: 'loop', loop }` (every loop transition: the tab re-reads the build); `StoryBuild.prs` lists the planned PRs (no patch).

## Entry points

ONE component, `apps/frontend/src/components/StoryBuild/StoryBuildEntry.tsx`, the primary button of the
story view's action group (beside Check against docs / Redraw design). The story view is mounted by the
tray, the story tab (`?view=ticket:…`) and the PR view's Story tab (`?prTab=story`), so all three offer it.
Gated on `me.ai.enabled` (hidden, never disabled); opens the build tab through `useOpenStoryBuild` only.
It is a SPLIT BUTTON (`components/ui/SplitButton.tsx`): its menu adds "Implement with docs" / "Fill gaps
with docs" while the library has a built document (the Story section's Check against docs read,
`available`; nothing new is fetched). The choice only opens the tab (`buildOffer.docs`): the start state's
"Give the agent the reference documents" box starts ticked, and its one gated Start sends `docs: true`. The
plan panel and the stack view: docs/FRONTEND.md § The build tab.

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
- **Plan first, too**: the opening turn plans only the gaps (a gap may not be `met`); the build turn says
  "Build only the gaps PLAN.md plans"; a PR body's Covers names the gap refs it builds.
- **In the session**: at boot the latest stored check is folded (`coverage.ts latestTicketCheck` +
  `foldCoverage`: DONE — shared `criterionDone` — is not a gap: `met` with the PRs that deliver it,
  `met_outside_code` ("Met outside code changes", a person's ticket comment) with the comment it rests on;
  everything else, and every missing item, is a gap), and TICKET.md carries those verdicts — an
  outside-code criterion is tagged "already done outside the code (per Dana Lee's comment of …): do not
  build it" — so the agent builds the gaps. `storyBuildCheckGaps` never counts an outside-code criterion.
- **The tab**: the header leads with the action word ("Fill gaps", `storyBuildActionOf`); the start state
  lists the gaps up front — ONE read of that run (`GET /api/ticket-reviews/:id`) when the tab opens,
  folded by shared `storyBuildGapsOf` — and its button reads "Fill gaps".

## Bases and stacking

The session clones every workspace repository; `candidates.ts baseFor` (owner decision 1) decides where
each starts, after `unstackablePrs` has read each stacked PR's head repository once. Every base sha is
PINNED by the session's own ref `refs/pierre/story-build/<buildId>/<repoId>` (`base-refs.ts`), because the
shared fetch refs move and the conflict janitor prunes (`gc --prune=now`). The refs go on Discard, once
every repository is pushed, and with the worktree sweep (`worktree-gc.ts storyBuildRefsToKeep`: kept while
the session is OPEN and that repository is not pushed). Plan first adds one ref per planned PR's verified
tip, `refs/pierre/story-build/<buildId>/stack/<prRowId>` (parsed by `parseStoryBuildBaseRef`, kept while
the session is open and that PR is not pushed, dropped with the session's refs).

## Push (`coding/story-build/push.ts`)

On the reader's press — or by the review loop the reader opted into (§ The review loop: `pushNewBranch` + `pushFastForward` + `openPrForBranch`, the halves of the same code). `coding/git-ops.ts applyAndPushBranch` is the NO-PR variant of AI Fix's
stateless push: a fresh worktree at `base_sha`, the stored patch, ONE commit by the reader (the agent's
commit messages as its message), a NEW branch `<KEY>` (the ticket key, case kept, `sessionBranch`) (`BRANCH_EXISTS` refused with a
sentence, never forced; the default branch, the base ref and a stacked PR's head are protected and
refused before any process runs), then `createPullRequest` (`draft` unless the body says `draft: false`).

- **The reader's PR** (owner decision 2026-11-11): `applyAndPushBranch` writes with origin `'reader'` — no
  `limn_actions` ledger row, no `Limn-Run:` trailer on the commit — so sync attributes the PR AND its commit
  to the reader, never to their `limn:` bot (the one exception to "Limn's writes are a bot",
  docs/CLAUDE-REVIEW.md § Limn's actions are bots). It is then an ordinary PR of the reader's: the
  workspace's auto review picks it up (when on, once it is not a draft), My Turn and Reports count it.
- **Branch** = the ticket key, case kept (`sessionBranch`: `PAY-142`; anything git rejects becomes `-`;
  no `limn/` prefix), so Jira, Linear and GitHub link it.
- **Title** `${KEY}: ${title}` (what Jira, Linear and Notion detection read).
- **Body:** the summary (the agent's last words in the build turn), the criteria this repository covers,
  the ticket link (http(s) only), `Stacked on #n.`, the sibling PRs this session already pushed, `Closes
  owner/repo#n` on a single-repository GitHub Issues build only. No "Built with Limn" footer. The
  model- and ticket-written parts go through `defangGithubText` (a closing keyword before an issue
  reference and an `@mention` are broken with a zero-width space). The code-written `Closes` line is added
  after it.
- **Branch name**: `assertPushTarget` (git's own format check + the protected names) runs BEFORE the
  name is spelled into the `BRANCH_EXISTS` lookup URL, each segment URL-encoded.
- **Rename after `BRANCH_EXISTS`** (an earlier session already pushed `<KEY>` (the ticket key)): the single-item
  routes take `branch` (`StoryBuildPushBody`; the per-repository push of a build WITHOUT planned PRs, and
  `…/prs/:prId/push`). Push all and a planned build's per-repository push refuse it (400: one name, one
  PR). The route checks only shape (1..`STORY_BUILD_BRANCH_MAX` after trim); the name goes through the
  SAME `assertPushTarget` before any lookup (a stack also protects its other planned/pushed branches),
  an existing one is still `BRANCH_EXISTS`, never forced. It is written to the row's `branch` only once
  the push lands (or `PR_NOT_OPENED`, the branch was pushed), so a later Push all reuses it. The code is
  STORED beside `push_error` (`push_error_code` on `story_build_repos` / `story_build_prs`, wire
  `pushErrorCode`), so the tab keys the field on it after a reload or an automatic push — never on the
  sentence. The tab's field is prefilled with shared `storyBuildFreeBranch` (`<branch>-v2`, `-v3`, …:
  `-N` would collide with a stack's PR-N branch).
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

### Push automatically — RETIRED (2026-11-12)

The opt-in now runs THE REVIEW LOOP (§ The review loop). `coding/story-build/auto-push.ts` keeps its claim
columns (`auto_push_claimed_at` is also written by the loop's start claim, so `setStoryBuildAutoPush` and
`reconcileStoryAutoPushOnStartup` stay consistent; the reconcile skips rows with `loop_claimed_at`) and
`maybeAutoPushBuild` with its tests, but the session subject no longer calls it. A build claimed by the
old automatic push before 0186 keeps its recorded outcome (`autoPushError`, "Pushing…") in the tab.

### Pushing a stack (`coding/story-build/push-stack.ts`)

A build with an approved plan pushes its PLANNED PRs (`story_build_prs`), never the repository rows. Each
is ONE commit by the reader through the same `applyAndPushBranch`, plus `expectTree`: the commit's tree
must equal the host-verified tip's (`TREE_MISMATCH` before any push), so what was reviewed is what is
pushed.

- **Base**: PR 1 of a repository keeps the rules above (`push.ts firstPrBase`: the build's base, or the
  reader's own open PR's head; `STACK_CLOSED` / `STACK_FORK` / `STACK_UNKNOWN`). PR k ≥ 2 targets the
  previous PR's pushed branch AT its pushed commit (an EMPTY PR is skipped over: same tree).
- **Dependencies**: the previous PR in the repository pushed (`STACK_PREVIOUS_NOT_PUSHED`: "Push P1 (…)
  first." — or, when GitHub did not open it, "Open the pull request for <branch> on GitHub first.") and
  still open (`STACK_PREVIOUS_CLOSED`: merged or closed ⇒ discard and start again, v1); a PR of another
  repository in `dependsOn` pushed first (`DEPENDS_ON_NOT_PUSHED`). Every other branch of the session is
  protected.
- **Title** `KEY (n/m): title` (n/m in the WHOLE plan; the key still leads for detection); a one-PR plan
  keeps `KEY: <ticket title>`. **Body**: the summary (the build report, else the agent's last words), the
  story, the criteria this PR covers (from the approved plan — this also fills Covers for sessions), the
  `**Part n of m:**` list (each PR as `owner/name — title`, linked once pushed, this one marked), "Builds
  on #n.", `**Decisions on the story:**` ("Kept the story: …" / "Changed from the story: …", the points
  touching this PR's criteria and those touching none), `Closes …` on the LAST PR of a single-repository
  GitHub Issues build only. Earlier PRs' bodies are NOT edited afterwards (no extra GitHub write).
- **Push all** (`pushPlannedStack`): every ready, unpushed PR in PLAN ORDER; a failure stops ITS
  repository (later PRs `STACK_BELOW_FAILED`) and what depends on it (`DEPENDS_ON_NOT_PUSHED`); other
  repositories go on; pressing again pushes what is left (`ALREADY_PUSHED`). The per-repository route
  pushes that repository's stack. ONE stack push per build at a time (`PUSH_IN_PROGRESS`; Discard waits).
- **Recorded** on the PR row; once a repository's every planned PR with changes is pushed, its repository
  row is `pushed` too (the marks and the `pushed` phase read it); once every PR is, the session's refs go.

## The review loop (`coding/story-build/loop/`)

"After the build: review and fix, then open the pull request" — a SOFTWARE FACTORY with adversarial,
iterative review. Owner decisions: § Owner decisions (2026-11-12). Modules: `driver.ts` (the state machine,
never throws to the session), `targets.ts`, `branch-review.ts` (one code-review half), `story-check.ts`,
`seed.ts` (REVIEW.md), `pr-body.ts` + `pr-facts.ts`, `review-on-pr.ts`, `wire.ts` (the folds and the wire
mapper), `persist.ts`, `seams.ts` (lazy defaults; tests swap them with `setStoryLoopSeamsForTests`),
`routes.ts`. The agent's report: `sandbox/workspace/review-response.ts` (docs/SANDBOX.md § The review response).

- **Targets.** A TARGET is one branch that becomes one PR: a `story_build_repos` row with a patch (a
  one-patch-per-repository build) or a `story_build_prs` row (plan first), in stack order. Every claim,
  review row and column is keyed `(target_kind 'repo'|'pr', target_id)`.
- **Rounds.** Round k (1..N) = REVIEW k, then, when anything is open, FIX k + PUSH k. After FIX N one
  CLOSING review (N+1, same machinery, no fix). A review with nothing open opens the PRs at once. So at most
  N fix passes and N+1 reviews. Re-review: round 1 reviews every target; a later round reviews a target whose
  head moved or whose last review left something open; the story check runs every round.
- **"Open"** after a review = this round's consolidated findings (not praise; questions included) + its
  follow-up items `not_addressed` / `partly_addressed` / `reply_disputed` + every criterion `not_met` /
  `partly_met` / `unclear` without an ACCEPTED not-applicable claim + every missing item. A blocker the agent
  only pushed back on stays a dispute (`judgeReplyReport`); the round cap ends it and the PR body lists it.

```
built ─maybeStartLoop─► [CLAIM loop_claimed_at] ─► pushing (round 0: the branch, no PR)
  pushing ─► reviewing k ─ nothing open, or k = N+1 ─► opening ─► [CLAIM 'open' per target] ─► done
                         └ open, k ≤ N ─► fixing k (a host-started build turn) ─► pushing k ─► reviewing k+1
  any ─► paused (budget · session_closed · interrupted · fix_stopped · fix_failed · push_failed ·
                 branch_exists · review_failed · build_busy) ─Continue (the reader)─► the step it paused at
  any ─Stop review loop─► stopped
```

- **The start** (`maybeStartLoop`, from the subject's `afterBuildTurnEnded` on a COMPLETED build turn with
  its work stored and saved): compare-and-set `loop_claimed_at` (also `auto_push_claimed_at`) where
  `auto_push = 1`, `status = 'ready'`, never claimed. It holds the sandbox (`holdSession`: no idle close)
  until the PRs open or the loop pauses. State, round and pause are written at EVERY transition and sent
  as `{type:'loop'}`.
- **The code review** (`branch-review.ts`): `prepareBranchReview` (the clone cache's base...head diff, no
  gh), `buildUserPrompt` with `subject: {kind:'branch'}`, `runReview` with `checkout` (the pushed branch,
  no PR), then the PR pipeline's pure follow-up steps. Providers = the workspace's auto-review setting
  (`both` ⇒ the pair, halves AT ONCE and blind, consolidated by `consolidateHalves`; a failed half leaves
  the other as the review — no cover pass in v1). Docs: [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Reviewing a
  branch. Loop runs do NOT take a PR-review slot.
- **The story check** (`story-check.ts`): the ticket review's prompt, agent and reconcile over every
  target as a member labelled `branch <name>`, with the agent's not-applicable and answer notes as
  `claims`; the ticket is the build's frozen seed and Limn's stored comments (never a tracker read).
- **The fix pass**: the driver writes REVIEW.md (`seed.ts`: `F<n>` findings by severity, `AC<n>` / `M<n>`
  open criteria with the reviewer's words and a rejected claim's reason; an earlier finding still open is
  re-raised as a finding of the round, with the agent's earlier answer), the refs file and the checker,
  then `startHostBuildTurn` (the build slot, claimed in one tick; refused ⇒ waits, then `build_busy`).
  `afterLoopFixTurn` reads `.limn/review-response.json`: `fixed` / `answered` / `pushed_back` per finding,
  `not_applicable` too per criterion; a missing ref is `not_reported` (open again); `fixed` on a target whose
  tree did not change is stored `answered`. The answers ARE the replies the next review judges. A turn
  that ended without its work STORED (the session closing, a failed store) pauses `fix_failed` /
  `session_closed` instead of pushing the old work.
- **What stays open across rounds** (`wire.ts`). An ACCEPTED "not applicable" stays settled on every later
  round (`effectiveClaimVerdicts`: the newest verdict per ref, an earlier `accepted` carried unless a later
  check rejects it) — the criterion leaves the seed, so no claim is sent for it again, and the next check's
  `not_met` does not reopen it; the wire's `claimVerdicts`, the coverage strip and the PR body read the
  same fold. An earlier finding a round's review left `not_checked` (said nothing, or over the prompt cap)
  is CARRIED, as in the PR flow: counted open, seeded to the fix pass with the agent's earlier answer, and
  sent to the next review as `carried: true` (`notCheckedFindingsOf`); one another run of the round judged
  is not.
- **Pushes** (`coding/git-ops.ts`): round 0 `pushNewBranch` per target (the ticket-key branch; a planned PR
  k ≥ 2 on the previous PR's pushed commit); each fix `pushFastForward` — the live ref must still be the
  last pushed commit (else `HEAD_MOVED`: that target ends `stopped`, the others go on), a commit with the
  new tree and parents `[pushed, …]` (a stacked PR whose predecessor moved gets that commit as a SECOND
  parent so GitHub's diff stays right), pushed WITHOUT force; an unchanged tree pushes nothing. Each write
  is a `story_build_loop_pushes` row inserted BEFORE it, never retried. Targets keep `status = 'ready'`
  until their PR opens. ⚠ The fix commit is kept at `refs/pierre/story-loop-push/<buildId>/<kind>-<id>`,
  NEVER under `refs/pierre/story-loop/<buildId>` (the review's and the story check's checkout ref): git
  cannot hold a ref and refs below the same name.
- **Opening** (`pr-facts.ts`): the same title / base / body builders as Push, `draft: false`, origin
  `reader` (the reader's PR, no ledger, no trailer), the body ending in "## Review in Limn" (`pr-body.ts`:
  reviews and who ran them; fixed · answered · pushed back and accepted · still open; criteria met / not
  applicable with why / not met; up to 10 still-open points; defanged, clipped). Then `markLoopReviewOnPr`
  (`review-on-pr.ts`): the closing review as ONE `claude_reviews` row at the PR head, `trigger 'manual'`,
  never posted, so `getAutoReviewCandidates` skips that head; a later head is reviewed normally. If that
  write fails it is logged, and auto review reviews the PR again.
- **Budget.** Every automatic run asks `automaticRunAllowed` (`story_loop_review` per provider,
  `story_loop_check`, `story_loop_fix`); a refusal before a round starts ⇒ `paused(budget)`; mid-round, that
  half is skipped. The step a reader's Continue resumes is the READER'S run and skips the gate; later steps
  ask again.
- **Stop · Discard · manual Push.** "Stop review loop" (`POST …/loop/stop`) aborts a review and interrupts a
  fix turn ⇒ `stopped`; like Discard it is refused (`409`, "Wait for the push to finish") while a push or a
  PR open runs, and no later step writes over `stopped` (`setState` / `pause` read the row first); the header's Stop interrupts the fix turn ⇒ `paused(fix_stopped)` with Continue.
  `busyReason` refuses a message while a step runs; a message while paused or done is a normal turn and
  never restarts the loop. Discard is refused during a push or PR open, else stops the loop first; the
  pushed branch stays on GitHub. A manual Push of a target the loop pushed (`loopManualPush`, refused while
  a step runs) pushes its current tree, opens its PR and ends it `manual_push`; when every target ended the
  loop is `done`.
- **Restart** (`reconcileStoryLoopsOnStartup`, after `reconcileSessionsOnStartup`): a running loop becomes
  `paused(interrupted)`; an unanswered push claim is marked `INTERRUPTED`; nothing is pushed or reviewed.
  Continue reads the live ref first and ADOPTS a push or PR that landed (`liveBranchSha`, `openPrOfBranch`).
- **Settings** (`POST …/loop/settings`, `setLoopSettings`): `{on?, rounds?}` until `loop_claimed_at` is set
  or anything was pushed (409 `LoopStarted`).

## Approve automatically (`sandbox/session/plan.ts`; migration 0187)

"Approve the plan automatically", OFF by default, ticked at Start (`autoApprovePlan: true`) or in the tab
until the plan is approved (`POST …/auto-approve`). With "After the build: review and fix, then open the
pull request" ticked too, Implement → Start is the whole flow: planned → approved → built → reviewed and
fixed → pull request. The Start panel REMEMBERS both boxes in the browser (`START_PREFS_KEY`); the server
stores each build's own choice (`story_builds.auto_approve_plan`).

- **When.** After any plan turn that leaves a usable plan (`afterChatTurn`, the `ok` branch; a repair that
  delivers counts). A plan already waiting when the switch is ticked is NOT approved by it: the reader
  presses Approve and start.
- **What.** Every unanswered point of the LATEST revision is stored as **Agree** (the plan's revision of
  the story, its criteria included, is what gets built), `approveCheck` runs as for a press, and the plan
  is HELD (`pendingApprove` + `pendingAuto`). `runTurn` then claims the build turn IN THE SAME TICK
  (`claimAutoBuild` → `claimBuildTurn`, reader line "Approve and start (automatic)"); `approveNow` records
  `plan_auto_approved_at` and one notice (`AUTO_APPROVED_LINE`).
- **The gate.** The build turn is an AUTOMATIC run: `automaticAllowed` is asked first; refused ⇒ no
  approval, one notice (`AUTO_APPROVE_BUDGET_LINE`), the plan waits. Another session holding the build slot
  ⇒ the held plan is dropped with `AUTO_APPROVE_BUSY_LINE`.
- **The ticket is NEVER written by it.** The plan's draft ticket update is shown AFTER the pull request
  opens (the review loop `done`, or the session `pushed`): the TICKET STEP (`TicketStep`,
  `TicketUpdatePanel.tsx`) — Update ticket (Jira, the reader's press, `POST /api/ticket-update`) or "No
  update needed"; either sets `ticket_review_done_at` (`POST …/ticket-review {done: true}`), "Show the
  ticket changes" clears it. Until then the build sits at the `ticket` gate of the builds toast. A plan the
  READER approved keeps the old place: the ticket review in the plan panel while the build runs.

## The builds toast (`components/StoryBuild/StoryBuildsToast.tsx`)

ONE circle in the ONE toast cluster (`HammerIcon`) while any build of the workspace RUNS or waits at a
GATE. `GET /api/story-builds/active?workspace=` (DB + the in-process live map, rate tier `read`) answers a
row per such build through the ONE fold, shared `storyBuildActivityOf` (`story-build-activity.ts`).

- **Running** = a live sandbox in `booting/planning/revising/chatting/building`, or the loop in
  `pushing/reviewing/fixing/opening`. The circle's RING is the least advanced running build's progress
  (planning ≈15 → build 45 → built 60 → the loop's rounds 62..97 → 100).
- **Gates** (the COUNT badge and the alert ring): `plan` (waits for Approve), `push` (built, the loop off),
  `paused` (the loop paused or stopped), `failed`, `ticket` (approved automatically, the PR open, the ticket
  step not closed). A build neither running nor at a gate is not listed.
- The cluster opens the panel; a row opens that build's tab (`useOpenStoryBuild`). Polled every 5 s while a
  build runs, 30 s otherwise, and refetched after every build action (`invalidateBuild`).

## Limits

| Limit | Default |
|---|---|
| `LIMN_SANDBOX_MAX_SESSIONS` (open sessions on this computer) | 2 |
| `LIMN_SANDBOX_IDLE_MINUTES` (a session with nothing to do closes: its sandbox is removed, its patches stay) | 15 |
| `LIMN_SANDBOX_TURN_MAX_MINUTES` (one agent turn running longer is stopped; SANDBOX.md § Every end removes the sandbox) | 120 |
| `STORY_BUILD_PATCH_MAX_BYTES` (one repository's patch; larger is refused, never cut) | 4 MB |
| The plan block (`BUILD_PLAN_MAX_BYTES`) · revisions per session (`BUILD_PLAN_MAX_REVISIONS`) | 128 KB · 12 |
| Planned PRs per repository · in all · points of contention · evidence per point | 3 · 6 · 12 · 1–4 |
| One repository's stack bundle (`STACK_BUNDLE_MAX_BYTES`) · commits per planned PR | 8 MB · 200 |
| Automatic build continuations after the turn cap (`CONTINUATIONS_MAX`) | 2 |
| The build report (`BUILD_REPORT_MAX_BYTES`) | 128 KB |
| The docs copy (`BUILD_DOCS_COPY_MAX_SECTIONS` / `_BYTES`) | 30 sections · 600 KB |
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
