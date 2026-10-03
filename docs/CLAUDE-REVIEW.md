# Claude Review (agentic PR review)

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Claude Review (agentic PR review)

A **Claude Review** tab runs the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)
against the selected PR, returns **structured JSON findings** (persisted per head SHA,
history kept), lets the user author their own review + tick which findings to post, then
posts **one** GitHub review (inline + body + verdict).

- **FREE, ON BY DEFAULT, LOCAL-ONLY — and ALWAYS VISIBLE locally.** Since apiVersion 22 Claude
  Review (with its follow-up, ticket check, auto review and chat) and AI Fix's fixer
  are CORE again — no plan, no opt-in flag. They run on the user's OWN Claude Code session or
  `ANTHROPIC_API_KEY`; Limn stores no key and charges nothing for them. ONE switch,
  `config.aiEnabled` = `!isCloud && LIMN_AI_DISABLED !== 'true'`; `ENABLE_CLAUDE_REVIEW`,
  `PRO_ADVANCED_AI_ENABLED` and its alias `PRO_CLAUDE_REVIEW_ENABLED` are DELETED as gates (the
  manager's second-guard constant, once `CLAUDE_REVIEW_ENABLED`, is `AGENTIC_AI_ENABLED` =
  `config.aiEnabled`).
  - ⚠ **CLOUD IS OFF BY AN EXPLICIT `isCloud` CHECK**: `registerAgenticRoutes` (`review/agentic.ts`)
    registers NOTHING there, so the routes 404 (pinned by `review/agentic.test.ts`). It used to
    rest on an env var being unset. `api/plugins/auth.ts`'s `isProPath` 402 still lists every
    Claude Review URL and covers the fixer's `/api/pro/` paths — the SECOND guard.
  - `LIMN_AI_DISABLED=true` is the kill switch for a team that forbids AI tooling: no agentic
    route registers and `MeResponse.ai.enabled` is false, so every surface hides.
  - `MeResponse.ai` (TOP-LEVEL, never inside `pro`, so `entitledProCapabilities` cannot zero it):
    `enabled`, `runtime` (the one-time SDK download, `ai/runtime.ts`), `auth` + `authMessage`
    (`detectClaudeAuth`'s heuristic). No credential replaces the Run button with ONE line —
    `NO_CLAUDE_AUTH_MESSAGE`, "Sign in to Claude Code or set ANTHROPIC_API_KEY" — never hides the
    feature. The run itself is the authoritative check.
  - Safety facts the copy may state, and nothing more: the reviewer reads code and cannot edit
    files, run commands or reach the web; the fixer edits files, has no shell, builds and tests
    nothing; nothing is posted or pushed until the reader presses the button. Never promise
    subscription billing.
- **Auth is a TWO-RUNG ladder and there is no stored key** (`review/auth.ts`,
  `applyClaudeReviewAuth`): an **ambient Claude session** (`CLAUDE_CODE_OAUTH_TOKEN` or a
  logged-in `claude` on disk) is PREFERRED — the run STRIPS any `ANTHROPIC_API_KEY` for its
  duration so the Agent SDK draws on the subscription instead of metering, restored in
  `finally`, gated on `reviewConcurrency===1` to avoid an env race — and otherwise the
  environment's `ANTHROPIC_API_KEY` is left exactly as it is for the SDK to pick up.
  `detectClaudeAuth` is a best-effort pre-flight over the same two rungs (the first real SDK
  auth error is the authoritative gate).
  ⚠ **THE BYO KEY IS RETIRED.** The Settings form, `GET`/`PUT /api/claude-review/key`,
  `ReviewSeam.setLocalKey` and every reader of `~/.pierre-review/config.json`'s
  `anthropicApiKey` are gone; an already-stored value is left on disk **untouched and never
  read** (stopping the read was the decision, destroying the file was not — which is also why
  there is no "clear it" route). `review/local-settings.ts` is DELETED (the per-review
  budget is the `REVIEW_BUDGET_USD` env var alone). Pinned by `review/auth.test.ts`, whose two ⚠ cases are exactly "a stored
  key never makes `detectClaudeAuth` say ok" and "a stored key is never written into the
  environment".
- **ALL OF IT IS CORE now** (`apps/backend/src/review/`). The security-sensitive half:
  `agent.ts` (the SDK run: an in-process MCP `submit_review` tool — `schema.ts` — captures
  structured output; read-only tools, `cwd` = a worktree, `bypassPermissions`,
  `settingSources:[]`, `maxTurns`/`maxBudgetUsd` caps, `AbortController` cancel), `submit-map.ts`,
  `model-options.ts`, `prepare.ts` (`gh pr diff` + `NOISE_GLOBS` stripping + per-file metrics +
  cap), `clone-manager.ts`, `post-review.ts` + `post-seam.ts`, `pricing.ts`, `chat-agent.ts`. The
  product half, moved back from the plugin at apiVersion 22 and published under FSL-1.1-MIT:
  `claude-review/` (`manager.ts` — in-memory queue, one review/PR, `PRO_REVIEW_CONCURRENCY`, the
  auto lane, startup reconcile; `routing.ts`, `prompts.ts`, `follow-up.ts`, `ticket.ts`,
  `persist.ts`, `routes.ts`, `chat.ts`, `auto.ts`, `auto-settings.ts`, `specialists.ts`) and
  `../coding/ai-fix/` (the fixer).
  - ⚠ **REVIEW MEMORY IS DELETED** — capture (the review event bus `review/events.ts` and its one
    subscriber), retrieval, the "Reviewer preferences from past reviews" prompt block, the
    "From your past reviews in this repo (N signals)" panel's two routes
    (`GET /api/pro/prs/:id/review-learnings`, `GET /api/pro/claude-reviews/:reviewId/actions`), the
    shared types and the `review_learnings` table (DROPPED by sqlite `0075` / pg `0062`; gone from
    both schemas, both delete paths, erasure, `accountScopedTables()` and `verify:isolation`). It
    never improved a review. Do not bring it back as a prompt block: the review prompt carries the
    PR, the optional user stories, the previous review's findings and the other reviewers' open
    threads, nothing about the reader.
  - ⚠ **They take ONE context argument, `AgentContext`** (`review/agent-context.ts`), built by
    `buildAgentContext` from DIRECT core imports — `ctx.review.*`, `ctx.coding.generateFix` /
    `applyAndPush`, `ctx.github.*`, `ctx.aiCredits`, `ctx.db` / `ctx.schema`.
    It is not `ProContext`: those seams were DELETED from the plugin contract. The argument stays
    because the tests pass a fake one and the queues carry it per item. Every SDK-bearing module is
    still reached through a lazy `await import()` inside the member that runs it.
  - Registration: routes in `buildApp` via `registerAgenticRoutes`; the process-level half
    (the auto-review sweeper, the crash-orphan reconciles) once at boot via
    `startAgenticBackground` (index.ts).
  - **One Pro input rides an OPTIONAL plugin seam**, `ProContext.registerAgenticProviders?`
    (`review/plugin-providers.ts`): `resolveReviewTicket` (the Jira fill for an AUTO review — see
    § Auto review). Absent, the feature runs without it. (AI Fix's `readCiAnalysisSeed` went with
    its `ci_analysis` seed.)
  - The URL paths never moved: the SPA client calls exactly what it called before.
- **Deterministic routing** (`claude-review/routing.ts`, tested): BEFORE the agent runs, a pure
  diff-metrics gate (`config.reviewRouting`) picks a `reviewMode` — `skip` / `diff_only`
  (tool-less, no clone) / `worktree` (full clone as context) — stored on `reviewMode` +
  `routeReason` (migration 0013). Conservative: `diff_only` only within every size/spread
  ceiling AND touching no exported contract (`API_PATH_PATTERNS`/`EXPORT_MARKERS`); ambiguity
  → `worktree`. ⚠ **THE ROUTER ALWAYS DECIDES**: the Quick / Deep choice is gone from the request
  (`GenerateReviewBody.mode` deleted; the route schema drops a stale `mode` key, it does not 400),
  from `startReview` and from `decideReviewMode`, so every new run records `requested: 'auto',
  decidedBy: 'router'`. Older rows keep the forced values they were started with.
- **Deep reviews consult specialists** — see § Deep-review specialists.
- **Line-anchoring is the load-bearing bug risk** (`buildAnchorIndex` in
  `post-review.ts`): a ticked finding posts inline on its `(path, line, side)` when that
  lands on an addable diff line; otherwise it **re-anchors to the file's first changed
  line** (so an off-by-a-line finding still posts inline) and only truly unplaceable
  ones fall back to the review body. Posting pins `commit_id` to the head SHA, 409s if
  it moved.
- **Frontend:** `ClaudeReviewTab.tsx` + `useClaudeReview.ts` (live progress over SSE,
  `…/stream`). Claude's output is **read-only** (Copy buttons); a separate "Review summary"
  textarea + verdict is what posts. Re-reviewing the same head SHA **warns but is allowed**.
  The follow-up and user-story pieces live in `ClaudeReviewFollowUp.tsx` (three components, one
  mount each, pinned by `test/claudeReviewFollowUp.test.ts`) over the pure
  `lib/claudeReviewFollowUp.ts` (ordering, anchors, the draft ↔ request mapping, chip palette);
  the pieces that need markdown or an href — a Jira-read story (`JiraStoryView`, `JiraKeyLink`) —
  live in `ClaudeReviewTickets.tsx`, so the plain-text guard on `ClaudeReviewFollowUp.tsx` still
  holds.
  - ⚠ **THE SCREEN CARRIES NO DEPTH PICKER, NO BUDGET LINE AND NO MEMORY PANELS.** Depth is the
    router's call; the per-review budget is the `REVIEW_BUDGET_USD` env var ALONE (default $6.75) —
    `PUT /api/claude-review/budget`, the `config.json` override and `getLocalKeyStatus` are
    DELETED, and the SPA neither shows nor edits it. How a
    run went (tokens, turns, a capped diff, noise files left out) sits behind the "i" beside the
    meta line (`metaLine`: reviewed SHA · model label · cost). Explanations that earned a place are
    `InfoButton`s (`components/InfoModal.tsx`), never a paragraph.
  - **OUTDATED IS SAID TWICE, BRIEFLY**: beside Re-review ("Reviewed abc1234 · 2 newer commits",
    amber; Re-review turns blue) and as an "Outdated" chip in the review's header. Both read
    `ClaudeReview.head` through ONE `outdatedPhrase()`; `commitsSince: null` reads "the branch has
    changed since", `0` "history rewritten since"; an older server falls back to comparing SHAs.
  - ⚠ **A POSTED FINDING IS DONE.** `postedAt != null` (posted singly OR inside a submitted review —
    `markReviewPosted` stamps every included finding) removes Post, Reword and Ignore; only the
    "Posted" link and Copy remain. The post route matches it: `POST …/post` sends included findings
    with `postedAt == null` only, so a re-submitted review cannot post a comment twice
    (`post-review-skips-posted.test.ts`). There is NO per-finding "Ask Claude" — the review's one
    chat thread covers every finding. A finding from a deep-review specialist wears a small lens chip
    (`CLAUDE_FINDING_LENS_LABELS`).
  - **"Generate fix from this review" is the LAST thing on the screen**, under Post to GitHub.
  - **Model picker** opens on `DEFAULT_CLAUDE_REVIEW_MODEL` and is NEVER re-seeded from the
    stored run (a run stored under a retired id, such as the old Opus 4.8, would otherwise be a
    select value with no option).
  - **"User stories (optional)"** sits under the Run row: ONE TAB PER STORY (`lib/storyTabs.ts`,
    `role=tablist`, arrow keys / Home / End, Delete removes), up to `CLAUDE_REVIEW_MAX_TICKETS`. Its
    header says what Run sends (" · 2 stories" / " · needs a fix") open or closed. Each tab has a ×
    ("Remove BMD-1040"); "Clear all" asks first (`window.confirm`). "+ Add story" (hidden at the cap)
    adds and selects a typed tab with three editable fields. A tab PULLED FROM JIRA is read-only
    markdown (`JiraStoryView`): key linked, title, "Criteria from: <field> · Change", Refresh. Jira
    tickets detected on the PR (`TicketRef.canFetchDetails`) are **pulled automatically when the tab
    opens**, once the stored run has loaded, ONCE per PR per detected-key set, never re-adding a key the
    reader removed this session (`createStoryPullMemory`; no retry — a failure is one line). "Pull all
    from Jira (N)" in the header is the manual action (clears the removed mark), "Or pull one" the
    per-key one. ⚠ **A PULL READS THE STORED TICKET, NOT JIRA**: the plugin's worker read it when the
    PR was received (plugin 0038, [PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) § Stored
    Jira tickets), so the auto-pull and "Pull all" are instant. Every read goes through ONE
    `qc.fetchQuery(['jira-ticket', prId, key])` (1-min stale, not persisted). Refresh is
    `POST …/jira-ticket/refresh` — Jira is read again server-side, through the worker's path, and
    the stored row answered. ⚠ **"Story N" is the number the RUN
    gives the story**: the check drops all-blank stories, so a blank tab is "New story" and does not
    count (`storyIndexAt`); numbering by raw position made the second story "Story 3". The check's
    message names a story the same way (key, else "Story N"). It runs the SAME
    `checkClaudeReviewTickets` the route runs (field errors under the tab's field; Re-review / "Run
    anyway" disabled while it fails). No `maxLength`. The list prefills from the LATEST run's stored
    stories; a list the reader has touched wins, per PR for the session.
  - **The criteria FIELD is the reader's to correct, and the choice is the WORKSPACE's.** The server
    picks it (`JiraTicketDetails.acField` / `acFieldSource`): the workspace's field for the ticket's
    issue type on that Jira site when the ticket has it, else the strong name match; the tab shows
    which (`TicketDraft.acField`, client-only — "not recorded" for a story prefilled from a run).
    "Change" opens the picker over the stored candidates (no Jira call); a pick is
    `PUT …/jira-ticket/ac-field`, which saves it for that issue type, re-derives every stored ticket
    of the type and re-reads this one — other open tabs of the type are rebuilt from their stored
    rows. "Reset to default" sends `fieldId: null`. "None of these" empties this tab's criteria only
    and is never saved. Removing a tab does NOT clear the choice (it belongs to the issue type). An
    old per-browser choice (localStorage `limn:jira-ac-field:v1:…`) is moved to the server ONCE on
    the next pull and the key deleted (`legacyAcFieldToMigrate`). Candidate text is wiki markup rewritten to markdown by the plugin
    (`candidateText` → `jiraWikiToMarkdown`), like the description.
  - **In `ClaudesReview`** (latest AND historic runs): the templated `followUpSentence` sits above
    Claude's summary; then **Previous review** — open items first (Not addressed, Partly addressed,
    then Not checked in GREY, never amber: unknown is not "not addressed"), addressed / no longer
    applies in a collapsed disclosure. Each row's anchor prefers the re-raising finding's
    (current) path and line, else the earlier path with its line DROPPED once the code moved since
    THAT comment was raised (`itemHeadMoved`: the item's own `headMoved`, falling back to the
    record's on older rows — a carried comment is older than the previous review); a
    "Raised again below" button scrolls to `#claude-finding-<id>`. Then the **User stories** section
    (titled "User story" when there is one), ONE BLOCK PER STORY (`ClaudeReview.tickets`; sub-header =
    key, else "Story N", omitted for a lone keyless story · title · alignment chip ·
    `ticketCriteriaSentence`). ⚠ **LIKE FOR LIKE**: each not met / partly met criterion and each
    "Not done" item renders as THE SAME `FindingRow` card the Findings list uses (`renderFinding`,
    chip `storyItemChipLabel`: "AC2 · Partly met" / "Not done"), in AC order, and the Findings list
    LEAVES THOSE OUT (`placeStoryFindings` → `placed`), so each is on screen once; the Findings
    header says how many are "under User stories". Met criteria are one compact line (tick · ref ·
    text · path); "Not asked for" is a compact informational list. A run stored before story
    findings has no card to show, so its unmet rows fall back to read-only rows. A story finding
    no story can place keeps the `storyChipLabel` chip ("BMD-1040 · AC2") in the Findings list —
    see § User stories → story results are findings. A finding linked to
    a still-open earlier comment wears "Not addressed since last review" / "Partly addressed since
    last review" and sorts first within its severity; one that repeats a comment already posted on
    this same commit also wears a grey "Already posted" (`alreadyPostedReraiseIds`) and arrives
    ignored. Claude's explanations are prefixed
    "Claude:"; all model and user-story text renders as plain text (no Markdown, no href), and an
    anchor is a `<button>` into the Changes tab only when the file is in the PR.
- **Packaging (NO AI SDK in the npm manifest):** the AI SDKs (`@anthropic-ai/claude-agent-sdk`,
  `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`) are NOT dependencies of the published
  package; "Set up AI" (`POST /api/ai/runtime/install`, or `limn ai install`) downloads exact
  pinned versions into `<dataDir>/ai-runtime` on first use, and ONE loader module,
  `apps/backend/src/ai/runtime.ts`, value-imports them. [PACKAGING.md](PACKAGING.md) owns the
  details and the guardrail. The product modules import no SDK themselves.

## Models

- **Claude Opus 5.5 (`claude-opus-5-5`) is the DEFAULT and the first offered model**
  (`CLAUDE_REVIEW_MODELS[0] === DEFAULT_CLAUDE_REVIEW_MODEL`, pinned by a test). The picker always
  opens on it — it is NOT seeded from the stored run, or every already-reviewed PR would keep
  reopening on its old model. A request with no `model` runs it.
- **Opus 4.8 (`claude-opus-4-8`) is REMOVED, not just unoffered.** It is gone from the
  `ClaudeReviewModel` union, `CLAUDE_REVIEW_MODEL_LABELS`, the price table (`review/pricing.ts`
  `RATES`) and `EFFORT_CAPABLE_MODELS`. `claude_reviews.model` has NO drizzle `enum:` in either
  core schema — it was always plain `text` in both dialects (no CHECK, no pg enum), so no migration —
  and `ClaudeReview.model` / `ClaudeReviewSummary.model` are typed `string`. Stored 4.8 rows
  therefore read back verbatim and the SPA prints the raw id (labels are looked up only for the
  offered list). Nothing re-prices a stored run; an id outside `RATES` falls back to Sonnet 5 rates
  in the live estimate. Both generate routes (Claude Review and AI Fix) answer 400 for it.
  Retiring a model is now a shared-types + pricing + model-options edit, never a schema edit.
- **Opus 5.5's effort is PINNED to `medium` on every path** (`PINNED_EFFORT` in
  `review/model-options.ts`) — a product decision. `REVIEW_DIFF_ONLY_EFFORT` (default low) and
  `REVIEW_EFFORT` (default medium) still drive the other effort-capable models, never this one.
  It is passed explicitly rather than left to the API default. It also always gets
  `thinking: { type: 'adaptive' }`, which overrides any `MAX_THINKING_TOKENS=0` the environment
  might carry. ⚠ **Opus 5.5 400s on `thinking: {type:'disabled'}`, on a thinking budget
  (`budget_tokens` / `maxThinkingTokens`) and on a forced `tool_choice`** — nothing in the review,
  coding or llm paths sends any of them (the review relies on the model CHOOSING `submit_review`).
  One table, `review/model-options.ts`, holds the effort-capable and adaptive sets for both
  `review/agent.ts` and `coding/agent.ts`.
- ⚠ **The Agent SDK BUNDLES ITS OWN Claude Code, and the API gates new models on THAT version** —
  the user's own `claude` CLI being current is irrelevant. SDK `0.3.N` ships Claude Code `2.1.N`;
  on 0.3.162 every Opus 5.5 run failed with `400 Claude Code 2.1.162 does not support this model;
  version 2.1.280 or newer is required`. It is now `^0.3.283`. A new model in the picker needs a
  matching SDK bump (regenerate `pnpm-lock.yaml` under the pinned pnpm) and a restart of the
  backend — a running `tsx watch` keeps the old SDK loaded.
- **AI Fix inherits the offered list and opens on `DEFAULT_AI_FIX_MODEL` = `claude-opus-5-5`**
  (`packages/shared`, ONE spelling), read by the fixer picker (`AiFixTab`) and the core start route (`coding/ai-fix/routes.ts`). "On medium" is the `PINNED_EFFORT` pin above,
  reached through `coding/agent.ts` → `sdkModelOptions(model, 'worktree')`; the constant carries no
  effort of its own. `POST /api/pro/prs/:id/ai-fix` checks `model` IN THE HANDLER — there is no ajv
  body schema, because `removeAdditional` would strip `seed`/`reviewText`/`commentTargets`: absent or
  null → the default; a string in `CLAUDE_REVIEW_MODELS` → that model; anything else →
  `400 {error:'ModelNotOffered'}`. No stored fix row's model is ever re-run. Only the FIXER moved:
  the pane's summary stays on Haiku. Opus 5.5 is about 1.33× Sonnet 5's
  per-token price, so `aiFixBudgetUsd` went from $3 to **$5**: the heaviest succeeded Sonnet 5 fix
  in the dev DB cost $2.34, about $3.12 at Opus 5.5 rates for the same tokens. An explicit
  `AI_FIX_BUDGET_USD` still beats the default. Pinned by `review/claude-review-ticket.test.ts`,
  `packages/pro/test/ai-fix-routes.test.ts` and `apps/frontend/test/aiFixModelDefault.test.ts`.
- Price (live estimate only; the recorded cost is the SDK's own): Opus 5.5 is $4 in / $20 out per
  MTok, cache write $5, cache read $0.20.
- **THE OFFERED LIST IS TWO MODELS: Opus 5.5 and Sonnet 5.** Sonnet 4.6 and Haiku 4.5 went the
  way of Opus 4.8 — out of the `ClaudeReviewModel` union, the labels, `RATES` and
  `EFFORT_CAPABLE_MODELS` (and the Haiku-only turn multiplier, `REVIEW_HAIKU_TURN_MULTIPLIER`, is
  deleted). Nothing stores a model as a SETTING, so there was nothing to migrate: stored runs and
  fixes keep their id and print it raw, both generate routes 400 the two ids, and the review chat's
  `chatModelFor` already falls back to the default for a stored run on an unoffered model.

## Deep-review specialists

When the router picks `worktree`, the lead reviewer gets a catalogue of specialist sub-agents
(`claude-review/specialists.ts`, passed as the Agent SDK's `agents` option by `review/agent.ts`)
and decides which are worth consulting for THIS change:

| Lens / agent name | Asks |
|---|---|
| `design` | module boundaries, responsibilities, coupling, fit with existing patterns |
| `tests` | changed behaviour with no test, tests that assert nothing, missing edge cases |
| `impact` | consumers outside the diff: other packages/apps, callers, config, schemas, deploy files |
| `accessibility` | semantics, labels, keyboard, focus, contrast — OFFERED ONLY when a UI file changed (`.tsx/.jsx/.vue/.svelte/.astro/.html/.css/…`) |
| `security` | injection, missing authorisation/tenant checks, unsafe input, secrets |
| `performance` | queries in loops, unbounded work, blocking calls, wasted renders |

- **The lead decides, the code caps.** At most `CLAUDE_REVIEW_MAX_SPECIALISTS` (3, shared) dispatches
  per review. ⚠ **The cap is a PreToolUse hook** (`createDispatchGuard`), not a sentence in the
  prompt: the 4th dispatch is DENIED. A hook deny holds under `bypassPermissions`, where
  `canUseTool` would never be asked. The same guard denies any `subagent_type` outside the offered
  catalogue — the SDK's built-in agent types (`general-purpose` …) INHERIT every tool — and rewrites
  an allowed dispatch to the foreground (`run_in_background: false`), with no model override and no
  isolation, so a report is back before the lead submits. Both dispatch-tool spellings (`Agent`, and
  the older `Task`) are policed.
- **Specialists are read-only**: `tools: Read/Glob/Grep`, and `disallowedTools` names Bash, every
  write tool, the web tools, the dispatch tool and the whole `mcp__review` server (no
  `submit_review`). `model: 'inherit'` — a specialist runs on the review's own model.
  `SPECIALIST_MAX_TURNS` (12) each; their spend counts against the ONE `maxBudgetUsd` =
  `REVIEW_BUDGET_USD` (default $6.75, sized for a deep run's three specialists; no per-specialist
  add-on). Cap 3 and 12 turns are a COST choice: most PRs want design + tests + one more, and the
  lead tends to use what it is offered. A run that crosses its budget before `submit_review` fails with no
  findings and is billed anyway.
- **Diff-only never gets them.** `reviewToolPolicy` (agent.ts) offers specialists only when
  `mode === 'worktree'`; otherwise the dispatch tool is added to `disallowedTools` (so a diff-only
  run cannot reach a built-in agent either). Pinned by `claude-review/specialists.test.ts`.
- **Findings flow through the lead.** A specialist replies in plain text; the lead checks it against
  the code, drops what it cannot confirm, and submits the rest through `submit_review` with the
  finding's optional `lens` set. `lens` is stored on `claude_review_findings.lens` (sqlite `0075` /
  pg `0062`, nullable, no backfill; a stored value outside `CLAUDE_FINDING_LENSES` reads as null)
  and rides `ClaudeFinding.lens` (labels: `CLAUDE_FINDING_LENS_LABELS`). null = a general finding.
- **A deep review always carries design comments**: the worktree system prompt (`systemPromptForMode(
  'worktree', offered)` appends the catalogue section) requires at least one `lens: 'design'`
  finding about the change as a whole, file-level when it is about the file, `praise` when the
  design is sound — alongside the usual line-level findings. With no specialists offered the
  worktree prompt is byte-identical to before.
- Progress: a dispatch shows as "Asking the <lens> specialist", and a specialist's own steps are
  prefixed with its name (`describeAssistantBlocks` maps `parent_tool_use_id` → lens).
- Cost: a deep review that consults specialists costs more than one that does not — each specialist
  re-reads code in its own context. The per-review budget is the guard; nothing else meters it.

## Follow-up on the previous review

When a run starts for a PR that has an earlier succeeded review, the new run checks that review's
comments **that were posted to GitHub** and says, for each one, whether the current code deals
with it. If none of them was posted, there is nothing to follow up: the run is an ordinary fresh
review, with no "Previous review" prompt section, no `follow_up` record and no follow-up sentence.

- **Which review.** The newest `claude_reviews` row for the same PR and account with
  `status='succeeded'`, an id below the current run's, and `review_mode IS NULL OR review_mode <>
  'skip'` (a skip run read no code). ⚠ The NULL arm is load-bearing: pre-routing rows have no
  mode, and `ne()` alone drops them. `persist.ts` `loadPriorReviewForFollowUp`, account-scoped
  through the repos join.
- **Which comments — POSTED ONLY.** `postedAt != null && severity !== 'praise'`
  (`isFollowUpEligible`, the ONE selection point: the previous review's own findings and every
  carried one go through it, so the prompt, the stored `follow_up` items, the counts in the
  templated sentence and the SPA's "Previous review" list all agree). A finding the reader ignored,
  left unposted or only copied was never said to the author, so it is not asked about. ⚠ The signal
  is `postedAt`, NOT `githubCommentId`: Post review (`markReviewPosted`) stamps `postedAt` on its
  inline findings but stores no per-comment id (they ride the GitHub review), while the
  single-comment route (`markFindingPosted`) stamps both. ⚠ The `included` tick is not part of the
  rule either way: it is what the reader meant to send, and an ignored-after-posting comment is
  still on the PR. The prompt says the findings were "posted … as comments" and uses the body the
  user saw: `editedBody` when non-blank, else `body` (the routes' `resolvedBody` rule). Follow-up
  records stored before this rule may still name unposted findings; they are not rewritten, and
  the next run's carry-forward re-checks every id through the same rule.
- **CARRY-FORWARD.** Every item the previous run recorded as `not_checked` names an older finding;
  those are re-loaded (ids from our own stored JSON, re-scoped to this PR + account by the query),
  re-checked for eligibility (so an unposted one drops out) and marked `carried`. Without it, a comment Claude skipped — or one
  over the cap — would silently drop out of the chain one review later. The same load also carries
  a still-open item (not / partly addressed) that no ELIGIBLE (posted) finding of that run raises
  again, when its earlier finding is itself eligible — the re-raise saved ignored because it was
  already on the commit (below), or one the reader never posted. The original comment, which IS
  on the PR, is followed up instead; once the re-raise is posted, the chain runs through it.
- ⚠ **"HAS THE CODE MOVED?" IS PER FINDING.** Each loaded finding carries the head of the review
  that RAISED it (`PriorFindingForFollowUp.headSha`; the carried query selects `cr.headSha`), and
  `findingHeadMoved` compares THAT with this run's head. The plan-level `headMoved` (previous
  review vs now) drives only the compare call: a carried finding is older, so on a same-head
  re-run it would tell the model "nothing changed, answer not_addressed" and copy a stale line and
  an applyable suggestion onto its re-raise. The prompt scopes that sentence to the previous
  review's own findings when a carried one is older and marks each carried block
  `(from an earlier review, at head <sha>)`; each stored item records its own `headMoved`.
- **Caps and fences** (`follow-up.ts`): at most 40 earlier findings and ~24k characters in the
  block, own findings first (blocker → warning → question → nit, then id), carried ones after; the
  rest are `not_checked` with `sent:false, ref:null`. Each finding sits inside a
  `---BEGIN PREVIOUS FINDING P<n> <nonce>---` fence; the nonce is random per run and re-rolled while
  any fenced text contains it (`pickReviewNonce`). The earlier text was written by a model reading
  this same attacker-influenced PR, so it is data.
- **Changes since the previous review.** Only when the head moved: ONE
  `ctx.github.fetchCompareDiff(priorHead…head, paths: changedFiles ∪ the sent findings' paths)` call
  (never throws; wrapped anyway). The filter is client-side, so the extra paths cost nothing, and
  they matter: a push that REVERTS a flagged file drops it out of `changedFiles`, and filtering on
  those alone hid the revert. A clipped patch ends `…(shortened)` so a cut is not read as "the rest
  did not change". Nothing stored, patches clamped to 8k per file and 30k in total, NONCE-FENCED like the
  other blocks (compare's own contract: patches are attacker-authored) and included in the nonce
  collision scan. `filesTruncated` is stated. `ok:false` (force-push, 404, rate limit) degrades to
  "judge against the full diff". The prompt says whether the head moved; when it did not, it
  tells the model the honest answer is mostly `not_addressed`. ⚠ SUPERSEDED for the same-head
  case (2026-10): when this run's head IS the previous review's head, the status is now decided in
  code — see § Only new commits change a judgement. (The old reason not to — the run's head is the
  synced DB head while `gh pr diff` is live — still applies in principle; the product chose
  stability over that edge.) The prompt tells the
  model to LEAVE OUT a ref whose code it cannot see (a file cut from a capped diff_only prompt, or a
  deep-review finding outside the diff) rather than guess — it then records `not_checked` and is
  carried to the next review, instead of a guessed "addressed" dropping out of the chain.
- **Reconcile — NEVER INVENT "ADDRESSED".** `reconcileFollowUp`: unknown refs dropped, a duplicate
  ref keeps its first report, any sent ref not reported is `not_checked`. Stored on
  `claude_reviews.follow_up` with the prior review id, its head, `headMoved` and
  `changesSinceShown`.
- **Raise again.** Every `not_addressed` / `partly_addressed` earlier finding becomes a finding in
  the new review, linked by `claude_review_findings.prior_finding_id` (a SOFT reference, no FK —
  same PR, and retention/deleteRepo delete a PR's findings in one statement). The model is asked
  to raise it with `priorRef`; a finding's `priorRef` links only when its item is open, first
  finding per ref wins. An open item it did not raise gets a SYNTHESIZED finding ("Raised in the
  last review and not addressed yet." — "an earlier review" for a carried one — + Claude's
  explanation + the earlier body): when the code has not moved since THAT finding was raised it
  copies the anchor, hunk and suggestion; when it moved the line is dropped, so posting re-anchors
  to the file's first change rather than asserting a stale line. The next review sees the
  re-raised finding as one of its own, so the chain continues.
- ⚠ **ALREADY ON THIS COMMIT ⇒ SAVED IGNORED.** A re-raise (linked or synthesized) of an earlier
  finding that was POSTED, on a head that has not moved since it was raised
  (`isAlreadyOnThisCommit`), is saved with `included: false`. Findings are otherwise included by
  default, and Post review sends every included finding with no duplicate check, so a same-commit
  re-run (the "Run anyway" path, e.g. to add a user story) would put the same inline comments on
  the same lines of the same commit a second time. The item stores `priorPosted` and the finding
  wears "Already posted"; the reader can still un-ignore it. On a moved head the reminder is the
  point, so it stays included.
- **The sentence is TEMPLATED** (`followUpSentence` in shared, e.g. "Last review's 5 comments:
  3 addressed, 1 partly addressed, 1 not addressed.", or "Last review's 3 comments and 2 older
  ones: …" when some were carried — a carried comment is not the last review's) from the
  server-validated statuses — a
  code-derived figure; Claude's explanations are shown separately, as Claude's text. On the wire,
  each follow-up item carries a DERIVED `reraisedFindingId` (the finding whose `priorFindingId`
  matches), and findings carry `priorFindingId`.

## Other reviewers' threads (people and review bots)

Every run that reads code (diff-only or deep) also judges **every unresolved review thread on the
PR that is not rooted on one of Limn's own posted findings** — comments from people and from other
review bots (CodeRabbit, Copilot, …). Limn's own posted findings stay in the follow-up above. After
a run the reader has the PR against the user stories, Claude's findings, the follow-up AND every
other open comment, so "Generate fix from this review" can produce one fix for all of it.

- **Loader (CORE, DB-only):** `db/review-threads-for-review.ts` `loadReviewThreadsForReview`,
  reached as `ctx.queries.loadReviewThreads` (absent ⇒ no thread block). Unresolved threads only
  (resolved ones are not sent — cheap to add later, not obviously useful). Per thread: path, line,
  outdated, the comments (author login, `authorIsBot` from the GLOBAL automation set
  `globalAutomationUserIds`, time, body), a github.com link, and how many synced commits are dated
  after its first and its latest comment — the "has the code moved since this comment" evidence.
- ⚠ **OWN-COMMENT EXCLUSION IS ONE PREDICATE**, `isLimnPostedComment`, shared by the loader and
  the auto re-review trigger. Limn posts AS THE READER, so TWO facts must hold together: the
  comment's author is the ACCOUNT'S OWN login (`accounts.github_login`, case-insensitive), AND it
  carries Limn's provenance. Provenance is the hidden `<!-- pierre:claude-review` marker — every
  finding comment, inline or PR-level, now ends with `<!-- pierre:claude-review-finding v=1 -->`
  (`FINDING_COMMENT_MARKER`, post-review.ts), which survives an edit on GitHub — or, for comments
  posted before that marker, a posted finding's `github_comment_id` or a text that STARTS WITH a
  posted finding's resolved body. ⚠ The marker under someone else's login (a teammate's own Limn,
  pasted text) is ANOTHER reviewer's comment; an unknown author is never own. The marker's
  `pierre:claude-review` prefix is deliberate — it is the 'pierre' fingerprint, so a single posted
  comment is attributed to Limn too. A thread rooted on such a comment is the
  follow-up's; a person's REPLY inside it still counts as a new comment for the trigger.
- **Prompt** (`claude-review/threads.ts` `pushReviewThreadsSection`): a "Review threads" section
  after the previous review, one `---BEGIN REVIEW THREAD Rn <nonce>---` fence per thread (the
  thread text is in the nonce-collision scan). Each thread shows its first comment and the newest
  ones (`THREAD_COMMENTS_SHOWN` = 6, each clipped to 1,500 characters, "(N more replies not shown)").
  People's threads go before bots', then oldest first. Caps: 40 threads and ~24k characters; the rest
  are `not_checked` with `sent:false, ref:null`. The model reports `threads: [{ref, validity, addressed,
  explanation, draftReply?}]` — validity `valid | partly_valid | not_valid | unclear`, addressed
  `addressed | partly_addressed | not_addressed | unclear`; `not_checked` is server-only. It is told
  to judge the comment on the code, not on who wrote it, to leave out a ref whose code it cannot see
  rather than guess, and NOT to repeat a thread as a finding (it is already on the PR).
  - **Diff-only vs deep.** Both routes get the block. A deep run may Read the file at a thread's
    path; a diff-only run sees only the diff, so a thread about code outside it should come back
    unreported (`not_checked`) rather than guessed. Expect more `not_checked` / `unclear` on
    diff-only runs, and validity judgements on cross-file claims to be weaker there.
- **Reconcile — NEVER INVENT "ADDRESSED"** (`reconcileThreads`): refs upper-cased, unknown refs and
  malformed entries dropped, the first report per ref wins, an unreported thread `not_checked`;
  explanation clipped to 1,000 characters, `draftReply` to 1,500, the stored excerpt (first comment)
  to 600. Output order: sent (R order), carried, over the cap.
- **Stored** on `claude_reviews.thread_assessments` (sqlite `0076` / pg `0063`, nullable JSON, no
  backfill) and served verbatim as `ClaudeReview.threadAssessments` (`ClaudeThreadAssessment[]`;
  **null = the run did not assess threads** — an older row, a skip, a failed run — never `[]`), plus
  `ClaudeReview.threadAssessmentCounts` folded server-side by shared `threadAssessmentCounts`. The
  "still needs a fix" rule is ONE shared function, `isThreadToFix` (valid / partly valid AND not /
  partly addressed). `draftReply` is a suggestion only; nothing posts it.
- **The Pro Haiku per-thread annotations stay** (validity / addressed / simplify, `prSummary`). They
  answer one thread at a time on demand; the review now covers every open thread in one agentic
  pass with the code checked out. The two are independent and may disagree.
- **AI Fix.** "Generate fix from this review" sends ONLY the review id
  (`GenerateFixBody.sourceReviewId`); the server builds the seed from the stored run, and the
  threads `isThreadToFix` keeps are its `T` items (see § AI Fix). One fix covers the findings and
  the other reviewers' comments.

### Only new commits change a judgement (same-head runs)

A run at the SAME head as the previous succeeded run — a comment-triggered auto re-review, or "Run
anyway" on the same commit — has no new code to judge. So the earlier answers carry forward IN
CODE, not by prompt:

- **Threads** (`planThreadReview`): per thread, against the head THAT judgement was made at
  (`assessedAtHead` — the follow-up's `findingHeadMoved` idea), never the previous run's head. A
  thread judged at this head with no newer comment is CARRIED whole (`carried: true`, not sent). One
  with a newer comment is sent (a reply may change its validity), but its `addressed` is LOCKED to
  the earlier answer whatever the model says. An earlier `not_checked` never carries.
- **Follow-up** (`selectPriorFindings` → `plan.locked`, applied in `reconcileFollowUp`): when the
  previous review's head is this head, a finding it raised here is `not_addressed` and a carried open
  item keeps the status the previous run gave it; stored with `statusCarried: true`. The findings are
  still SHOWN, so the model links its re-raise by `priorRef` rather than repeating the comment as a
  new, included finding; only the answer is fixed. A carried `not_checked` item was never judged, so
  the model still is. ⚠ This deliberately overrides the older "the server does NOT coerce statuses
  on an unmoved head" rule for the same-head case only (product decision, 2026-10).
- **User stories** (`ticket.ts` `sameHeadTicketCarry`): a story unchanged since the previous run at
  this head keeps that assessment (minus its `posted` record); when every story carries, the stories
  section is not sent at all.

## Failed CI on the reviewed head

Every run that reads code (diff-only or deep) also looks at the reviewed commit's CI. For each
FAILING check with a readable GitHub Actions log, Claude gets a bounded excerpt of that log and
reports the cause. This replaced the Pro "CI failure analysis" card (deleted with its plugin routes,
prompt and `readCiAnalysisSeed` provider): the review is now the one place that reasons about CI.

- **Reads (CORE, server-side, `AgentContext.ci`, all never-throw):** `readCommitChecks` —
  `github/commit-checks.ts`, ONE GraphQL read of the checks on the reviewed head **by commit oid**
  (not the PR's latest commit: the PR may have moved while the run waited), mapped through the ONE
  `checkRunsFrom` so "failing" (`failure` | `error`) means what the Checks tab means; then, only for
  failing Actions jobs, `readJobLog` (`github/actions-logs.ts`, the viewer's default TAIL window,
  128 KiB, one ranged GET) and `readFailedStep` (REST `actions/jobs/{id}`, the first failed step by
  GitHub's own record). ⚠ The signed log blob URL never leaves `actions-logs.ts`: only excerpt TEXT
  enters the prompt, and only the check's details page (`CheckRun.url`) is stored. A partial GraphQL
  answer (a token without checks access) is `no_check_access`, never "no checks". Any read failure
  costs the CI section only (`ciFailures: null`), never the review. ⚠ **All three respect the
  account's rate budget**: while `isLimited(accountId)` none asks GitHub (checks → `rate_limited`,
  so no CI section; a job's log / step → unreadable), and a rate-limited reply to ANY of them —
  the job-log read included — is fed to `noteLimited`.
- **Caps** (`claude-review/ci-failures.ts`): at most `CI_FAILURES_MAX` = 6 jobs read per run; the
  excerpt is the lines around the FIRST error marker (8 before, 20 after — a specific error beats the
  runner's "Process completed with exit code N") plus the window's last 30 lines, timestamps and ANSI
  stripped, each line ≤ 400 chars, ≤ 6,000 chars per check and ≤ 24,000 for the block. No error
  marker ⇒ the tail alone.
- **Prompt:** a "CI failures" section after the review threads, one
  `---BEGIN CI FAILURE Fn <nonce>---` fence per failure carrying the check name (set by the PR's own
  workflow file), the failed step and the excerpt — all in the nonce-collision scan. The model
  reports `ciFailures: [{ref, cause, explanation, category, step?, relatedFiles?, fixableInPr}]`,
  category `code | test | flaky_or_infra | config | unclear`. It is told to say `unclear` when the
  excerpt does not show why, to leave out a ref it cannot judge, and not to raise a finding for a
  flaky or infrastructure failure. The deep route may Read the files the log points at.
- **Reconcile — NEVER INVENT A CAUSE** (`reconcileCiFailures`): refs upper-cased, unknown refs and
  malformed entries (blank cause, unknown category) dropped, first report per ref wins; cause ≤ 160,
  explanation ≤ 1,000, ≤ 5 related files (blank paths dropped, a non-positive line → null). EVERY
  failing check gets exactly one entry: `diagnosed`, or `not_checked` with a server reason —
  `not_reported`, `log_unavailable`, `over_cap`, or `no_log` (not an Actions job: listed with its
  name, nothing read). GitHub's failed-step record beats the model's `step`.
- **Carry-forward:** a failure diagnosed at THIS head for the SAME job id (`selectCiFailures`) is
  carried — no log read, not re-sent. A workflow re-run is a new job id, so it is read again; a
  `not_checked` never carries.
- **Stored** on `claude_reviews.ci_failures` (sqlite `0077` / pg `0064`, one nullable JSON object
  `{state, checkCount, failures}`, no backfill); served as `ClaudeReview.ciFailures`
  (`ClaudeCiFailure[]`) + `ClaudeReview.ciState` (`{state: passing|failing|pending|none|unknown,
  checkCount}`). **null = the run did not look at CI** (an older row, a skip, a failed run, unreadable
  checks); `[]` = it looked and nothing was failing.
- **SPA:** `ClaudeReviewCiFailures.tsx` over the pure `lib/claudeReviewCi.ts`, mounted once in
  `ClaudesReview` right after Claude's summary. Nothing for null; a green "CI passing" for `[]` on a
  passing head, one grey line on a still-running one; otherwise a count-pill header and one row per
  check (category, name, step, cause, a collapsible "Why", related `file:line` buttons into the
  Changes tab for files in the PR, and the check's details link through `safeExternalUrl`). Fixable
  here first, then other diagnoses, then the unchecked. All model text is plain text.
- **AI Fix:** the review seed's `C<n>` items are this list's `diagnosed` + `fixableInPr` failures
  (§ AI Fix).

## Starting from the Open PRs tab

The Open PRs cards (`OpenPrsCards`, the pinned "Open PRs" tab) carry a **Claude review** panel on every card
when — and only when — `MeResponse.ai.enabled` is on; without it there is no panel and no
request.

- **ONE read for the whole table**: `POST /api/claude-review/states` with the listed PR ids
  (`useClaudeReviewStates`), never a request per row. It polls every 5s only while a listed PR is
  queued or running; a start, and the tab's SSE `done`, invalidate it.
- **The panel** (each card's last block, `ClaudeReviewPanel`; layout in
  [FRONTEND.md](FRONTEND.md) § Open PRs; state from `lib/claudeReviewColumn.ts` `reviewCellFor`):
  no run → "Not reviewed" + **Review**; queued → **Queued**; running → **Reviewing…**; succeeded →
  the verdict pill and **Open review** (`openClaudeReview`), or "N newer commits" and **Re-review**
  when the PR has moved since that run; failed → "Review failed" +
  **Review**; cancelled → **Review**. A succeeded run adds the states route's `summary`: findings by
  severity, CI failures on the reviewed head and how many were explained (`summary.ci`, DB-only,
  from the stored `ci_failures`; absent when the run did not look), posted, design-lens count, story
  alignment, the previous review's findings fixed/still open, and other reviewers' threads to fix.
  AI Fix's state ("Fixing…" / "Fix ready") is a button that opens the AI Fix tab. Every control
  stops propagation (the card opens the PR). The header's Sort menu orders by state (needs-a-review
  first) and by findings (most severe first).
- **A click starts a run through the SAME route and queue as the tab** (`POST
  /api/prs/:id/claude-review`, default model, `auto` mode, no picker): `REVIEW_CONCURRENCY` run at
  once and the rest queue, so many clicks are many queued runs. ⚠ **ONE MUTATION KEY PER PR**
  (`claudeReviewStartKey`) for both surfaces, read through `useClaudeReviewStarting`, so the button
  disables the moment it is pressed and the tab sees the list's start in flight (and the reverse).
  Both starts bump `claudeReviewKickoff`, so the same "Claude reviews" toast appears. A `409`
  (already running, queue full) or any error shows under the button and re-enables it.
- **The user story, on click only** (`resolveListTicket`): a RE-REVIEW reuses the previous run's
  stored ticket; otherwise the PR's first FILLABLE Jira ticket (`PrDetail.tickets`, read through the
  shared `['pr', id]` cache entry) is read from the STORED tickets and filled exactly as the panel
  does — ONE helper, `fillDraftFromJira` (title + description, then the criteria from the field the
  server picked: the workspace's choice for the issue type, else the best strong name match, else
  none). ⚠ **The run starts EITHER
  WAY**: no ticket, no token, a Jira error, or a draft over a cap sends no story and the cell says
  so for a few seconds.
- **Auto review in the column.** The states route folds the manager's live hold over the stored
  runs, so a PR whose auto review waits in its lane (no row yet) reads **Queued** and an auto run in
  flight reads **Queued** / **Reviewing…** — no button either way, even over a start in flight
  (`heldByAutoReview`); the poll keeps running while any is queued. Queued, running and finished
  auto runs carry a small "Auto review" marker. A click that races the hold gets `409
  AutoReviewInProgress`: the start stays pending until the column has re-read (`onError` returns the
  invalidation), so the button never comes back while the hold lasts, and the message shows under
  the cell only for as long as the hold does.

## User stories (one or more tickets)

Optional user stories — each a title, description and acceptance criteria — that the person running
the review pastes or fills from Jira. ⚠ **A review carries up to `CLAUDE_REVIEW_MAX_TICKETS` (5)
and Claude assesses EACH ON ITS OWN**; the screen renders one section per ticket.

- **Wire.** `GenerateReviewBody.tickets: ClaudeReviewTicketInput[]` (the legacy single `ticket` is
  read only when `tickets` is absent). `checkClaudeReviewTickets` (shared) runs each through
  `checkClaudeReviewTicket`, drops all-blank entries, and refuses over the count — `400
  {error:'TicketInvalid', index, field, message}`, `index` null for the count; never truncated. A
  ticket may carry `source: 'jira' | 'manual'` and, for Jira only, `key`, `url` (http/https) and
  `fetchedAt` — provenance, dropped when malformed, never a reason to refuse. A Jira ticket's
  `description` is MARKDOWN (the plugin converts Jira's wiki markup, `jiraWikiToMarkdown`), so the
  SPA renders it read-only as markdown; a manual one is shown as typed.
- **Stored MIGRATION-FREE.** `claude_reviews.ticket` holds an ARRAY of tickets and
  `ticket_assessment` an index-aligned ARRAY of assessments; a run from before stored ONE object in
  each, and every reader goes through shared `storedList` (one object → a one-element list).
  `ClaudeReview.tickets: ClaudeReviewTicketEntry[]` (`{index, ref:'T1'…, ticket, assessment}`) is
  the read, READ-ONLY; `ticket`/`ticketAssessment` survive as the FIRST entry, deprecated. A row
  written while the per-ticket post existed may carry a `posted` record inside its stored
  assessment: `ticketEntriesOf` / `cleanStoredAssessment` strip it on read (old rows still read; the
  record is never served).
- **Prompt + model.** One "User stories" section (`ticket.ts` `pushTicketsSection`): the shared
  instructions once, then each ticket under `### Ticket Tn`, its key/title/description/criteria
  fenced as `Tn KEY` / `Tn TITLE` / `Tn DESCRIPTION` / `Tn ACCEPTANCE CRITERIA`. `submit_review`
  takes `tickets: [{ref, alignment, summary, criteria?, missing?, notRequested?}]`;
  `reconcileTicketAssessments` matches by ref (unknown / repeated refs dropped, an unreported ticket
  `not_checked`; the legacy single `ticket` report reads as T1).
- **STORY RESULTS ARE FINDINGS — posted to GitHub exactly like every other finding.** (User decision,
  2026-10-03: it must be clear what is sent.) At persist time the manager runs `ticket.ts`
  `storyFindingsFrom(tickets, assessments, strippedDiff)` over the run's FINAL assessments (fresh or
  carried) — deterministic, no model call — and every criterion judged `not_met` / `partly_met` and
  every `missing` ("Not done") item becomes a row of `claude_review_findings`, tagged with its origin
  (`story_index` + `story_ref`, migration `0079` / pg `0066`; wire `ClaudeFinding.story: {index,
  ref}`, `ref` = the criterion's `AC2` or the not-done item's `M1`). `notRequested` ("Not asked
  for"), `met`, `unclear` and `not_checked` NEVER become findings: they stay in the read-only
  stories section.
  - **Severity** (shared `STORY_CRITERION_SEVERITY` / `STORY_MISSING_SEVERITY`, the one spelling):
    not met → `warning`, not done → `warning`, partly met → `nit`. `blocker` is never used — whether
    a missing piece blocks the change is the reader's call.
  - **Title** = the criterion's text / the gap's title. **Body** = Claude's explanation ALONE (`''`
    when there is none). ⚠ **The story line is added at POST time, never stored**: shared
    `storyCommentLead(finding, review.tickets)` builds `BMD-1040 · AC2 (not met): <criterion>` (a
    story with no key is `Story N`; a gap reads `BMD-1040 · Not done: <title>`; one line, defanged
    against @-mention pings), the routes pass it as `storyLead` (`PostReviewFinding.storyLead?`,
    optional, no apiVersion bump) and `findingCommentBody` / `prLevelFindingBody` put it FIRST —
    single post and Submit review alike — so GitHub (where the title is not posted) still names the
    story. Storing it repeated the card's title on screen. Rows stored before carry the lead in
    `body`: `stripStoredStoryLead` removes it on read (persist.ts) and again before posting (a reword
    started from it), so it is never doubled.
  - **Anchoring is the model findings' own** (`buildAnchorIndex` / `isFindingAnchored` /
    `extractHunk` against the same stripped diff): a path + line on an addable line posts inline; a
    changed file without one re-anchors to the file's first change; a file outside the diff posts
    PR-level with the file named; **no path** is stored `path: ''` and posts as a PR-level comment
    with neither the file line nor the outside-the-diff note (`prLevelFindingBody`). The card shows
    a "PR comment" chip and no code anchor.
  - **The same controls and lifecycle, no special-casing beyond the chip**: Post (single), Reword,
    Ignore, included in Submit review, the posted state + link, `FINDING_COMMENT_MARKER`, the
    Open PRs severity pills (story findings count as ordinary findings there; the story alignment
    pills stay), and the follow-up — a posted story finding is a P item on the next review.
  - ⚠ **ONE STORY ITEM IS ONE ROW OF ONE REVIEW.** `follow-up.ts` `linkReraisedFindings` takes the
    run's story findings and links each to a still-open (not / partly addressed) earlier STORY
    finding with the same `storyMatchKey` (kind — criterion or not done — plus the case- and
    space-folded text; refs renumber between runs, so never the ref). The link is taken FIRST: a
    model finding re-raising that same earlier finding by `priorRef` is then DROPPED, and no
    synthesized re-raise is added. A still-open earlier story finding nothing matches is synthesized
    as before and keeps its `story` origin. A SAME-HEAD re-run carries the assessment
    (`sameHeadTicketCarry`), re-creates its findings, and a story finding that was POSTED on that
    commit is linked and saved left out (`isAlreadyOnThisCommit`) — never posted twice. Pinned by
    `story-findings-pipeline.test.ts` (end to end through the manager), `follow-up.test.ts` and
    `ticket.test.ts`.
  - The prompt says so: each unmet criterion and missing item is posted from the `tickets` report on
    its own, so Claude must not repeat one in `findings` — only a concrete defect behind it.
  - ⚠ **THE PER-TICKET "POST AS COMMENT" IS RETIRED** — the route `POST
    /api/claude-reviews/:reviewId/tickets/:index/post` (now 404), `ticketAnalysisCommentBody`, its
    `githubWrite` rate-tier line, `AgentContext.prWrites`, the SPA's `TicketPostControl` /
    `usePostTicketAnalysis` and the `posted` wire field are deleted. Nothing produces
    `<!-- pierre:claude-review-ticket v=1 -->` any more, but comments already on GitHub carry it,
    so `isLimnPostedComment` and `sync/review-fingerprint.ts` keep matching the `pierre:claude-review`
    PREFIX (pinned in `threads-db.test.ts`).

- **ONE shared module** (`packages/shared/src/claude-review.ts`): `CLAUDE_REVIEW_TICKET_LIMITS`
  (title ≤ 300 characters, description ≤ 8000, criteria ≤ 8000 characters),
  `CLAUDE_REVIEW_TICKET_MAX_CRITERIA` (40 rows kept) and `checkClaudeReviewTicket`, read by the
  route AND the SPA — never retype a cap.
- ⚠ **CLAUDE WORKS OUT THE CRITERIA; THERE IS NO CODE-SIDE SPLIT.** The first cut split the text
  deterministically (bullets, numbers, Roman numerals, pasted `AC2:` labels, headings, Gherkin) and
  made the model answer per server-numbered item. Real tickets arrive in more shapes than any rule
  set (nested sub-bullets, tables, Given/When/Then blocks, prose with numbered clauses), and every
  mis-split was a wrong row on screen. Now the whole text is fenced as ONE
  `ACCEPTANCE CRITERIA` block and the model enumerates the criteria itself, best effort, reporting
  each with its own one-sentence `text`. The person's text is kept verbatim in
  `acceptanceCriteria`, which prefills the panel. `ClaudeReviewTicket.criteria` is LEGACY (old
  rows only; never written).
- **The 400 contract.** `POST /api/prs/:id/claude-review` declares `ticket` and `tickets` in its body schema
  (ajv's `removeAdditional` would strip it otherwise) with no `maxLength`; over a cap it answers
  `400 { error: 'TicketInvalid', field, message }` and starts nothing. Never truncated. Control
  characters (other than tab/newline) are refused (pg jsonb cannot hold `\u0000`).
- **Stored at QUEUE time** on `claude_reviews.ticket`, so a failed or cancelled run still prefills
  the panel for the re-run.
- **Reconcile** (`ticket.ts` `reconcileTicketAssessment`): Claude's list in its order, renumbered
  AC1..n, rows with no text or an unknown status dropped, capped at 40, text clipped to 500. If
  criteria text was sent and Claude reported none, ONE `not_checked` row carries the pasted text —
  never an invented `met`, never a silent empty list; alignment `not_checked` when Claude reported
  nothing. Gap lists ("Asked for but
  not done", "Added but not asked for") are capped at 20 and clipped. Stored on
  `claude_reviews.ticket_assessment`.
- **Fill from Jira** (plugin `jira/`, migration `0035`). When the PR carries a Jira ticket the
  existing detection found AND its workspace has a saved Jira token, `PrDetail.tickets[i]
  .canFetchDetails` is true and the EXPANDED panel shows one "Fill from KEY" button per such
  ticket. `GET /api/pro/prs/:id/jira-ticket?key=` answers the STORED row the plugin's worker wrote
  when the PR was received (the issue read with every field — REST v2,
  `fields=*all&expand=names,schema`; the description's wiki markup converted to markdown, ADF
  flattened — plus status and assignee) and the panel REPLACES title and description. Manual entry is unchanged and
  everything stays editable; nothing is truncated on the way in.
- ⚠ **THE ACCEPTANCE-CRITERIA FIELD IS CHOSEN PER TICKET, IN THE PANEL — not in Settings.** A
  site-wide picker shipped first and was unusable: real sites carry several fields named
  "Acceptance Criteria" and the one in use varies by issue type. (Since plugin 0038 the CHOICE is
  stored per workspace + Jira site + issue type, server-side — see "The criteria FIELD" above; the
  rest of this paragraph is the candidate list and the default rule.) The route returns `candidates` —
  every custom field with text on THIS ticket, strong name matches first (`/acceptance criteria/`),
  then weak ("AC", "definition of done"), then by name, capped at 50 — and the panel shows
  "Acceptance criteria from" (`Name (customfield_123) — preview`, blank first). The DEFAULT
  (`defaultAcCandidate`, in `packages/shared/src/claude-review.ts`, applied by the plugin's
  `deriveAc`): the workspace's field for this issue type on this Jira site, when this ticket has it; else the best STRONG name match (an exact
  "Acceptance Criteria" first — a weak "AC" / "Definition of Done" match is listed near the top but
  never preselected, because a wrong prefill is worse than a blank); strong matches carry a ★ in the
  dropdown; else blank, leaving the box untouched. The chosen field fills the box at once. ⚠ **The token that counts is the one on the workspace that OWNS the
  PR's repo**, not the workspace being viewed (`?workspace=` is only the viewer's scope): when a Jira
  ticket is detected but that workspace has no token, the panel names it ("add a Jira API token in
  Settings for the BNG workspace") instead of silently showing no button. ⚠ The route re-runs detection and refuses a key the PR does not carry,
  so the saved token can read only tickets this workspace's PRs name. Settings, token storage and
  SSRF rules: [PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) § Jira API access and
  [SECURITY.md](SECURITY.md).
- **Posted only on request**, as findings (above): nothing reaches GitHub until the reader posts a
  finding or submits the review.
- **Vocabularies** (shared): criteria Met / Partly met / Not met / Can't tell from the code /
  Not checked; alignment Matches the user story / Partly matches / Doesn't match / Can't tell /
  Not checked; follow-up Addressed / Partly addressed / Not addressed / No longer applies /
  Not checked. `'not_checked'` is in no model-facing enum: only the server writes it.

## Auto review (per workspace)

Settings → Workspace → **Auto Claude review** (shown wherever `MeResponse.ai.enabled` is — local,
free; **OFF until switched on**, because it spends the user's own Claude in the background). When a
workspace switches it on, Claude reviews each **human-authored, non-draft PR OPENED at
or after that moment** — once per HEAD, plus once per burst of new review comments (see re-review below) — with the same model (`DEFAULT_CLAUDE_REVIEW_MODEL`) and
per-review budget as the Review button. Storage: CORE `workspaces.auto_review_enabled` +
`auto_review_enabled_at` (core `0074` / pg `0061`; it lived on the plugin's
`pro_workspace_settings` (plugin `0036`) until Claude Review left the plugin, and plugin `0037`
copied each ON switch across once — those plugin columns are dormant). Read and written through
`GET`/`PUT /api/workspaces/:id/auto-review` (`claude-review/auto-settings.ts`, 404 for another
account's workspace, `enabled` required); `setWorkspaceAutoReview` is the ONE writer. `enabled_at`
is re-stamped on every off → on (whole seconds, so the echo matches what SQLite stores), KEPT on a
repeated on, and cleared on off, so nothing opened while it was off is picked up. Runs carry `claude_reviews.trigger = 'auto'`
(core `0071` / pg `0058`; `'manual'` is the default).

- **THE PIPELINE, AS ONE STATE DESCRIPTION.** Each minute the sweeper reads the candidates (first
  reviews, and re-reviews of a moved head or of new comments). A candidate is:
  1. **TRIGGERED** — a first review, a new head, or a new review-thread comment by a PERSON or a
     REVIEW bot (below);
  2. **WAITING** until `autoReviewDue` (`auto.ts`, pure) says
     `(quiet ≥ 5 min OR burst ≥ 20 min) AND (CI not running OR head age ≥ 30 min)`.
     *Quiet* = since the key (head, newest qualifying comment) last changed — every push or comment
     resets it (`AUTO_REREVIEW_SETTLE_MS`). *Burst* = since the FIRST trigger of this burst; a key
     change never resets it (`AUTO_REREVIEW_MAX_WAIT_MS`), and the burst ends when its run is
     QUEUED (the clocks are forgotten at enqueue — a comment landing while that run is in flight
     opens a NEW burst with its own 5-minute quiet, never inherits the old 20-minute clock) or when
     the PR stops being a candidate. A FIRST review has no settle (always "settled"). *CI running* = the PR's synced
     `ci_status` is `pending`/`expected`; *head age* = since the earliest `ci_status_events` row for
     that head, else since the sweeper first saw it (`AUTO_REVIEW_CI_WAIT_MS`). While waiting,
     `autoReviewWaiting` says why (`ci` / `comments` / `commits`) and the Claude Review header
     prints "Auto review waiting for CI" / "…for comments to settle" / "…for pushes to settle".
     All clocks are in memory: a restart restarts a wait, never skips one;
  3. **QUEUED → RUNNING** on the auto lane (daily cap, lane cap, lock — below);
  4. on SUCCESS, **AUTO FIX** when the PR is the reader's OWN (§ AI Fix → Auto fix).
- **A PULL SWEEPER, NOT A HOOK** (`review/claude-review/auto.ts`, every minute on the core
  scheduler). `sync/upsert.ts` runs inside a transaction and sees every PR of a first sync or a
  90-day backfill as new, so it is the wrong place. Each tick asks core
  `getAutoReviewCandidates` (db/queries.ts): open, not draft,
  `opened_at >= enabled_at`, the author a PERSON under the workspace's own judgement
  (`hiddenBotUserIds`, the resolver behind `InsightPrRef.authorIsBot`; an unmapped author is
  skipped), and **no `claude_reviews` row of any kind** (manual, auto, failed). The DB is the queue:
  a waiting auto item has no row, so a restart loses nothing.
- **THE LANE** (`manager.ts`). Auto items wait in their own FIFO, capped by
  `PRO_REVIEW_AUTO_MAX_QUEUED` (default 20), and launch only when no manual item waits. The ONE
  `PRO_REVIEW_CONCURRENCY` is shared and unchanged. ⚠ Auto work can never make a click answer
  `busy` (the manual cap is untouched). The row is written when a slot opens, through the same
  `startReview` steps. ⚠ **Switching a workspace OFF drops its WAITING items** (`dropAutoReviews`,
  called by the auto-review PUT and again by every sweep against the roster): they have no row, so
  nothing is lost, and otherwise a full lane would still be reviewed and billed after the switch. A
  run that already started keeps its Stop.
- ⚠ **MANUAL IS LOCKED WHILE AUTO HOLDS THE PR.** While an auto review is waiting in the lane (or
  mid-start) or running, `startReview` refuses with `auto_in_progress` and the route answers
  `409 {error:'AutoReviewInProgress', auto:'queued'|'running'}` (it used to let the click take the
  item over). The SPA knows from `ClaudeReviewResponse.autoReview` (`autoReviewHold`), re-reads the
  pane every 5s while it is `'queued'` (no row exists to tell it otherwise; a start refused with the
  409 re-reads the pane, so a stale pane learns of the hold), and disables Run /
  Re-review / Run anyway beside "Auto review queued" / "Auto review running". Once the auto run
  ends — success or failure — a manual run is allowed again. The status route answers a waiting item
  as `{status:'queued', reviewId:null, trigger:'auto'}` and `GET /api/claude-reviews/active` lists it
  the same way. A waiting item has no Stop (cancel would not stick — the sweeper re-finds a PR with
  no row); a RUNNING auto run keeps the ordinary Stop. The Open PRs column shows the same hold (§
  Starting from the Open PRs tab).
- ⚠ **AN AUTO RUN TRIES JIRA WHEN THE PLUGIN OFFERS IT.** Jira stays PRO: `startAutoItem` asks the
  OPTIONAL `resolveReviewTicket` provider (`review/plugin-providers.ts`), which the plugin registers
  when its tracker tier is on, backed by `packages/pro/src/jira/resolve-ticket.ts`
  (`resolveAutoReviewTicket`), before the row is written. Without the plugin, free auto review runs
  with no story (free manual review checks a PASTED story). No browser is there to "Fill from KEY",
  so the plugin does the same fill: EVERY detected key, in detection order, up to
  `CLAUDE_REVIEW_MAX_TICKETS` (the one detection path, so the token still reads only tickets this
  workspace's PRs name; one failing key skips that ticket only; a moved key answering twice is kept
  once; each marked `source:'jira'` with key, browse URL and fetch time), READ FROM THE STORED
  TICKETS (plugin 0038 — no Jira call; a detected ticket the worker has not reached yet is read once
  through the worker's own path), criteria as stored — the workspace's field for the issue type,
  else a strong name match, else none, never a weak one. A ticket Jira refused is skipped and its
  stored error CODE logged. Each field is CUT to its cap (and unstorable characters dropped)
  instead of refused: nobody is there to trim. It NEVER throws — no tracker, no token or a Jira
  error is no ticket and the review runs without a story (the provider answers `tickets[]`, plus
  the first as `ticket` for an older host); a Jira failure logs account,
  workspace, PR and the error code only. Before this every auto run went out with no ticket. The
  manual paths are unchanged (an empty panel on a click still means "no story").
- ⚠ **RE-REVIEW ON NEW COMMITS.** The same candidate read returns `reReview: [{prId, headSha}]`:
  a PR of the same population (opened at/after the floor, human, open, not draft) that has a
  SUCCEEDED run (manual or auto), whose synced head matches NO run of any status (new commits or a
  rewritten history), and whose latest run is not queued/running. ONE RUN PER HEAD: any row at the
  new head settles it, and `startAutoItem` re-checks `hasReviewAtHead` before writing the row (a
  person may have reviewed it while it waited). ⚠ **DEBOUNCED IN THE SWEEPER**: a moved head must
  hold still for `AUTO_REREVIEW_SETTLE_MS` (5 min, first-seen time in memory) before it is queued,
  so a burst of pushes costs ONE run on the last head; a restart only restarts the wait. It is a
  FULL fresh review on the ordinary auto lane (same cap, slots, model); it carries the previous
  run's stories (`getLatestStoredTickets`, else the Jira fill), and the existing follow-up reads the
  earlier POSTED findings so they are not repeated. Switching auto review off stops it like any
  auto run. `AutoSweepResult.reQueued` counts them.
- ⚠ **RE-REVIEW ON NEW REVIEW COMMENTS.** The same read also offers a PR whose head has NOT moved
  but whose unresolved review threads gained a QUALIFYING comment — a PERSON's or a CODE-REVIEW
  bot's, never Limn's own (`isLimnPostedComment`, § Other reviewers' threads, so posting a review
  never re-triggers it) — newer than what every run at that head covered: its
  `claude_reviews.comments_through` (sqlite `0076` / pg `0063`; the newest qualifying comment the run
  saw, written when it loads the threads), else its `created_at` (older rows, or a run that failed
  before loading — never 0, or a deploy would re-review every commented PR). `reReview` items carry
  `commentsAtMs` (null for a moved head) and `reason: 'head' | 'comments'`. ⚠ **THE SETTLE KEY IS
  (head, newest comment time)**: any change restarts `AUTO_REREVIEW_SETTLE_MS`, so a burst of
  comments, pushes or both costs ONE run — but never more than `AUTO_REREVIEW_MAX_WAIT_MS` after
  its first trigger. ⚠ **ONLY REAL REVIEWERS COUNT** (`db/queries.ts`
  `reReviewCommentAuthorFilter`, passed into `newestReviewCommentAt`): an author qualifies when it
  is NOT in the workspace's bot union `hiddenBotUserIds` (a person; a manual "this is a human"
  wins), OR is in `automatedReviewerUserIds(…, 'review')` — the reviewer cohort, `=== 'review'`,
  where the STORED workspace role beats the vendor login seed both ways and a vendor with no row
  takes the seed. CI, coverage, deploy, dependency and housekeeping bots never trigger. The run's
  `comments_through` uses the SAME filter (`ctx.queries.loadReviewThreads` →
  `reReviewCommentAuthorFilterForPr`), so seen and new still agree. ⚠ The filter is on the
  TRIGGER only: the run still sends and judges every open thread, whoever wrote it. The waiting item re-checks with `isAutoReReviewSettled`
  (a row at the head that covered `commentsAtMs`). Review BODIES and PR-level comments do not
  trigger (they are not assessed either). Same lane, cap, lock, floor and "a succeeded run first"
  rule as a moved head. On such a run every earlier judgement carries forward (§ Only new commits
  change a judgement); the new work is the new and changed threads.
- **OUTDATED, ON THE READ.** `ClaudeReview.head: {currentHeadSha, outdated, commitsSince}` compares
  the reviewed commit with the PR's SYNCED head (DB-only). `commitsSince` counts the PR's synced
  commits newer (by commit time) than the reviewed one; null when the reviewed commit is not among
  them (a force-push can drop it) — never a guess; `0` with `outdated` = a rewrite added no commit.
  `head` is null when the PR's head is unknown.
- **THE COST GUARD**: `AUTO_REVIEW_DAILY_CAP` = 20 auto runs per workspace per **UTC** day, counting
  today's auto rows plus items still waiting in the lane. Past it, PRs wait for the next day. An
  account whose agent credits are spent sits the tick out.
- ⚠ **IT NEVER RUNS WHERE CLAUDE REVIEW IS OFF.** `autoReviewAvailable` = `config.aiEnabled` AND a
  local host, checked separately; in cloud (and under LIMN_AI_DISABLED) neither the job nor the
  auto-review routes are registered.
- **Who hears about it.** ⚠ **OWNERSHIP IS PRIMARY**: an auto run raises the My Turn "Claude
  review ready" card for the account whose workspace switched it on, exactly like a manual run —
  there is NO author / requested-reviewer audience test (an earlier cut had one and dropped auto
  runs with no viewer). The ball rule still clears it (docs/BACKEND.md § the ball rule). The progress
  banner ignores auto runs (`ActiveReview.trigger`).
- **It says it was auto.** "Auto review" is printed on the Pending card's chip
  (`MyTurnCard.trigger`, `AUTO_REVIEW_LABEL` in `Activity/pendingLabels.ts`), the Slack Pending line
  (`pending-blocks.ts`), the Open PRs column's marker (`ClaudeReviewPrState.trigger`), and in the
  Claude Review tab's header, running row and History options
  (`ClaudeReview`/`ClaudeReviewSummary.trigger`). The Feed's Claude item is not labelled.

## Chat about a review

After a review **succeeds**, the reader can ask Claude about it: ONE **thread** per review
("Ask Claude about this review", under the findings), which covers every finding. The per-finding
threads' route (`?findingId=`) still answers, for threads stored before the button was removed, but
nothing on screen opens a new one. Free and local-only like the rest of Claude Review. Host:
`review/chat-agent.ts`, reached as `ctx.review.chat` on the core `AgentContext`. Product:
`review/claude-review/chat.ts`. SPA: `components/ClaudeReviewChat.tsx` +
`hooks/useClaudeReviewChat.ts`. Table: `claude_review_chat_messages` (core `0073` / pg `0060`).

- **AN AGENT THAT MIRRORS THE REVIEW'S MODE.** A worktree review's questions are answered with
  Read/Glob/Grep on a worktree checked out at the **REVIEWED** head (`review.headSha`), never the
  PR's current one; a diff-only review's are answered with **no tools**. The SDK's `tools` base set,
  `allowedTools` and the deny list all say the same thing, and **Bash is denied outright**
  (`chat-agent.test.ts` pins it). Same model as the review (a retired model falls back to the
  default), same credential ladder (`applyClaudeReviewAuth`; env mutation only under the review's
  own concurrency-1 rule AND no review in flight — `chatMayApplyAuthEnv`), its own per-turn budget
  `REVIEW_CHAT_BUDGET_USD` (default $1) and low turn caps (`REVIEW_CHAT_MAX_TURNS` 8,
  `REVIEW_CHAT_DIFF_ONLY_MAX_TURNS` 2). The answer is free text — no MCP tool.
- **THE GROUNDING IS THE WHOLE REVIEW, FENCED.** PR title + description, verdict + summary, every
  finding (severity, file, line, body, the reader's reword, suggestion, hunk), the user story and its
  assessment, the follow-up record, the diff (`ctx.review.prepareReview`, cached 10 minutes per
  review) and the thread's earlier turns — each block inside a per-turn nonce fence
  (`pickReviewNonce`). A finding thread names its finding (`F3`) and carries only its own turns.
- ⚠ **THE TRANSCRIPT IS REBUILT SERVER-SIDE FROM STORED ROWS.** The client sends only the new
  question, so it cannot inject an earlier "assistant" turn. At most 8 prior turns and 40k
  characters, oldest dropped first (`trimmedTurns` on the answer); the grounding is never trimmed.
- ⚠ **A MOVED HEAD.** `gh pr diff` reads the CURRENT head, so once the PR has moved past
  `review.headSha` no diff is sent: the findings' own hunks (and, in worktree mode, the files at the
  reviewed commit) are what the answer reads, and the thread shows one line: "Answers are about the
  reviewed commit; the PR has moved on."
- **COST GATES** (the sprint-chat pattern): one answer per ACCOUNT at a time, the slot claimed
  SYNCHRONOUSLY before the first await (`409 Busy` otherwise), a process cap of 2, the
  `agentBlocked` credit check inside the try/finally, `recordAiUsage({seam:'agent', feature:
  'claude_review_chat'})` for any turn that cost money — answered or not. Nothing is stored unless an
  answer came back; then the question and the answer are stored together.
- **Never carried across reviews**: a new review of the same PR starts with empty threads; an older
  review's threads stay readable when that review is picked from history.
- **SPA.** Nothing fetches until a thread is opened. ⚠ Every thread of a review shares ONE mutation
  key (`claudeReviewChatAskKey(reviewId)`) read through `useIsMutating`/`useMutationState`, so a tab
  switch mid-answer cannot offer a second billed POST, and the completed turn is written into the
  thread's cache in the hook-level `onSuccess`, never a `mutate()` callback. A thread reopened while
  the server is still answering polls every 4s until the answer lands.

## AI Fix (the agentic fixer)

CORE, free and local-only since apiVersion 22 (`apps/backend/src/coding/ai-fix/`: `manager.ts`,
`routes.ts`, `review-seed.ts`, `pr-context.ts`, `prompts.ts`, `persist.ts`; the agent itself is
`coding/agent.ts`). Its table `ai_fixes` is core since sqlite `0074` / pg `0061`; `trigger`,
`review_items` and `change_report` since `0078` / pg `0065`. The PR summary stayed PRO (one-shot
Haiku, `prSummary`).

- **The paths kept their historical `/api/pro/` prefix** — `GET|POST /api/pro/prs/:id/ai-fix`,
  `…/ai-fix/status`, `…/ai-fix/stream`, `…/ai-fix/cancel`, `GET /api/pro/ai-fixes/:fixId`,
  `POST /api/pro/ai-fixes/:fixId/push` — so the SPA client did not move. Nothing about them is
  paid; they register only through `registerAgenticRoutes`.
- **TWO ENTRY POINTS** (`AiFixSeed`): `review` ("Fix from review", in the AI Fix tab and from the
  Claude Review tab) and `plain` (the reader's instruction, a text box). ⚠ The picked-comments
  basket (`comments`) and the Pro CI diagnosis (`ci_analysis`) were REMOVED as seeds: the route
  answers `400 SeedRemoved`, but rows stored under them still READ (`AiFixStoredSeed`) and render
  as history ("no longer offered"). Their `comment_targets` / `comment_verdicts` columns are dormant.
- **THE REVIEW SEED IS THE WHOLE REVIEW EXCEPT PRAISE AND QUESTIONS, BUILT SERVER-SIDE** from the STORED run
  (`review-seed.ts`; the body carries only `sourceReviewId`, so the auto agent can use it with no
  browser). Items and their refs, numbered in the review's own order so one stored review always
  yields the same refs:
  - `F<n>` every finding but praise and questions (`NOT_FOR_FIX`: a question asks the author something — the answer is a reply, not a code change; the same rule drops a question from `P`), posted or not — EXCEPT one the reader IGNORED
    (`included === false`, never posted, and NOT a re-raise): an ignore is the reader's explicit
    "no". ⚠ A re-raise (`priorFindingId` set) saved `included: false` by `isAlreadyOnThisCommit`
    is still an OPEN issue and stays — `P` drops its earlier twin, so skipping it here would hand
    the fixer the issue nowhere (NothingToFix). Cost: a reader unticking a re-raise is not honoured
    by the fixer; the two cases share one stored shape.
  - `P<n>` the follow-up's earlier findings still `not_addressed` / `partly_addressed`, unless this
    run re-raised it (`reraisedFindingId`) — then `F` covers it.
  - `T<n>` other reviewers' threads `isThreadToFix` keeps.
  - `S<t>-AC<n>` / `S<t>-M<n>` per user story: criteria `not_met` / `partly_met`, and `missing`
    pieces (`notRequested` is not a fix) — ⚠ ONLY those the review did NOT make a finding of (an
    older review, from before story findings). A story finding arrives as an `F` item and its `S`
    item is dropped, so each issue appears once; one the reader IGNORED is in neither. Refs keep
    their own numbering (the criterion's ref, the gap's position), so a dropped item moves no other.
  - `C<n>` the review's `ciFailures` that are `diagnosed` with `fixableInPr === true`.
  Every item is nonce-fenced (`pickReviewNonce`, re-rolled against all fenced text), its body
  clipped to 3,000 chars. A 40,000-char budget decides what is SHOWN, in priority order (CI and
  blockers first, nits last; the first item always); the rest are NAMED in the prompt as left out
  and stored `included: false` — never silently dropped. A review with nothing to fix is refused
  (`409 NothingToFix`) before GitHub is asked anything.
- **THE PER-CHANGE REPORT.** `submit_fix` takes `changes: [{path, summary, refs}]` (one per changed
  file, 1–3 sentences) and `unaddressed: [{ref, reason}]`. `normalizeChangeReport` validates it on
  save: a ref the run was not SHOWN is dropped, a file not in the captured git diff is dropped (the
  diff is authoritative), entries for one file merge, text is clipped, and `notReported` lists the
  shown refs it never mentioned. Stored on `ai_fixes.change_report`, the items on
  `ai_fixes.review_items`, both on the wire (`AiFix.changeReport` / `.reviewItems`). The SPA
  (`components/AiFix/FixReport.tsx`) prints, per changed file, the summary and ref chips labelled
  with the section they came from (a Finding chip jumps to `claude-finding-<id>` in the Claude
  Review tab), then Not addressed with reasons, No report, and Left out — above the diff and its
  "Not built or tested here."
- **`startReviewFix(ctx, { accountId, prId, reviewId, model, trigger })`** (`manager.ts`) is THE
  entry the auto-review agent calls (`trigger: 'auto'`); the manual route goes through the same
  `startFix` — same single slot, claim, queue and worktree, and `trigger` is recorded on the row.
  Nothing is pushed until a person presses Push.
- **AUTO FIX** (`coding/ai-fix/auto-fix.ts` `maybeStartAutoFix`, called fire-and-forget by the
  review manager after an AUTO run is saved as succeeded — a failure here never touches the
  review). ⚠ **ONLY THE READER'S OWN PR**: `pull_requests.author_id → users.github_login` equals
  `accounts.github_login` (case-insensitive), local and cloud alike; anyone else's PR gets nothing
  and records nothing. Then the first of these that holds SKIPS it, logged and kept in memory per
  review (`autoFixOutcomeFor` → `ClaudeReviewResponse.autoFix`, one line in the Claude Review tab):
  `nothing_to_fix` (empty seed), `head_moved` (synced head ≠ reviewed head), `fix_in_progress`
  (the fixer's claim — auto or manual; `startFix` takes it SYNCHRONOUSLY right after the check, so
  a click racing the auto start cannot both pass), `fix_waiting` (a SUCCEEDED, never-pushed fix with
  a non-empty patch on the CURRENT head — its `base_sha` is the synced head, the REVIEWED head, or,
  asked only when an unpushed fix sits on neither, the LIVE head: the fixer builds on the live
  head, so a lagging sync must not hide a waiting fix), `cap` (`AUTO_FIX_DAILY_CAP` = 3 rows with `trigger='auto'`
  for the PR created in the last 24h, shared constant), `already_tried` (the latest auto fix AT THIS
  HEAD listed every item this review would send under `unaddressed`). Otherwise
  `startReviewFix(…, {model: the review's model (a retired one → DEFAULT_AI_FIX_MODEL), trigger:
  'auto'})` — the same queue, slot and worktree. ⚠ **NEVER PUSHED**: it waits for Push.
  ⚠ **LOOP SAFETY.** A pushed fix makes a new head → an auto re-review (which verifies it) → maybe
  another fix. Every turn of that chain needs a PERSON pressing Push (an unpushed fix blocks the
  next one), and the cap bounds it anyway. `already_tried` stops the push-free loop (a fix that
  changed nothing, retried on every comment-triggered review). Items match across reviews by
  (kind, thread id, story index, path, title) — refs and finding ids are per review — so a finding
  a later review RE-WORDS counts as new and only the cap stops it. There is no "discard" for a fix,
  so "waiting" means succeeded + unpushed + on the current head.
  **Shown**: the AI Fix tab's "Auto fix" chip (`AiFix.trigger`); the Open PRs strip's "Fixing…" /
  "Fix ready" pill (`ClaudeReviewPrState.fix`, one batched `ai_fixes` read in
  `POST /api/claude-review/states`; "ready" = the same waiting rule); "Auto fix started" / "No auto
  fix: <why>" under the Claude Review controls.
- **No shell.** `WORKTREE_RULES` (the one fix system prompt) and the tool list change together
  (`coding/ai-fix/no-shell.test.ts`).
- A finished fix PUSHES AS-IS (no trunk step) and only when the reader presses Push.
