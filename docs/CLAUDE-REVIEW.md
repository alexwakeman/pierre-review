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
With Codex as the provider the same review runs on Codex instead (§ Codex, the second provider).

- **ON BY DEFAULT and ALWAYS VISIBLE.** Claude Review (with its follow-up, ticket check, auto
  review and chat) and AI Fix's fixer are core — no plan, no opt-in flag. They run on the user's
  OWN Claude Code login or `ANTHROPIC_API_KEY`; Limn stores no key and charges nothing. ONE switch,
  `config.aiEnabled` = `LIMN_AI_DISABLED !== 'true'`; `ENABLE_CLAUDE_REVIEW`,
  `PRO_ADVANCED_AI_ENABLED` and its alias `PRO_CLAUDE_REVIEW_ENABLED` are DELETED as gates (the
  manager's second-guard constant, once `CLAUDE_REVIEW_ENABLED`, is `AGENTIC_AI_ENABLED` =
  `config.aiEnabled`).
  - `LIMN_AI_DISABLED=true` is the kill switch for a team that forbids AI tooling: no agentic
    route registers (`registerAgenticRoutes`, `review/agentic.ts`), `cheapComplete` refuses on
    every rung, and `MeResponse.ai.enabled` is false, so every AI surface hides.
  - `MeResponse.ai` (top-level): `enabled`, `runtime` (the one-time SDK download,
    `ai/runtime.ts`), `auth` + `authMessage` (`detectClaudeAuth`'s pre-flight). No credential
    replaces the Run button with ONE line — `NO_CLAUDE_AUTH_MESSAGE`, "Sign in to Claude Code or
    set ANTHROPIC_API_KEY" — through the one `AiRunGate`, and never hides the feature. The run
    itself is the authoritative check.
  - Safety facts the copy may state, and nothing more: the reviewer reads code and cannot edit
    files, run commands or reach the web; the fixer edits files, has no shell, builds and tests
    nothing; nothing is posted or pushed until the reader presses the button — EXCEPT what a
    workspace has switched AUTO-POSTING on for (§ Auto-posting; off by default). Never promise
    subscription billing. Copy reads "your own Claude Code login or Anthropic API key", or names
    the ChatGPT sign-in when Codex is the provider (§ Codex, the second provider).

### The credential ladder

ONE ladder for EVERY model call Limn makes — the agent runs (Claude Review, AI Fix, the ticket /
CI reviews, diagrams, sprint paths, the docs build and chat, Resolve with Claude, every chat) AND
the one-shot completions (`review/llm.ts` `cheapComplete`, which the sprint briefs/themes, story
labels, docs ranking, sprint Ask and every platform feature — period reports, synthesis, work-plan
wording, Chronology pointers, bot themes, the impact note, the Slack report —
go through). It lives in **`ai/credentials.ts`** and nowhere else:

1. **The local Claude Code login** (default) — `CLAUDE_CODE_OAUTH_TOKEN`, or a logged-in `claude`
   on disk (`hasClaudeLogin`, a heuristic over the credential files). Used through the Agent SDK;
   any `ANTHROPIC_API_KEY` is HIDDEN from that run, or the SDK would prefer it and silently meter.
2. **`ANTHROPIC_API_KEY`** from the environment — the alternative when there is no login. Agent
   runs hand it to the Agent SDK; one-shot completions call the Anthropic API directly (the SDK
   loaded through `ai/runtime.ts` `loadAnthropicSdk`).

`LIMN_AI_USE_API_KEY=true` flips the order when a key is set. `LIMN_AI_DISABLED=true` refuses
everything (checked by the callers; the ladder answers only "which credential"). Nothing is
stored; the ladder is read at call time, so an env change takes effect on the next call.

- Every Agent SDK `query` spreads **`agentAuthOptions()`** — the ladder's environment as the
  query's `env` option (`agentSdkEnv`: login → without `ANTHROPIC_API_KEY`; key → without
  `CLAUDE_CODE_OAUTH_TOKEN`) — so a login run never sees the key and two concurrent runs cannot
  race on `process.env`. `review/auth.ts` `applyClaudeReviewAuth` still mirrors the same choice
  onto `process.env` for anything else a run spawns, only when the caller says no other run shares
  the env.
- `detectClaudeAuth` (`review/auth.ts`) is the pre-flight view of the same ladder; the first real
  SDK auth error is the authoritative gate.
- ⚠ **`SUMMARY_ANTHROPIC_API_KEY`, the `apiKey` / `localRoute` / credential options and the
  key-only Reports/Bots clients are GONE** (2026-10-22): the platform uses one Haiku client over
  `cheapComplete`. Same model whichever rung answers.
- ⚠ **THE BYO KEY IS RETIRED.** The Settings form, `GET`/`PUT /api/claude-review/key`,
  `ReviewSeam.setLocalKey` and every reader of `~/.pierre-review/config.json`'s `anthropicApiKey`
  are gone; an already-stored value is left on disk **untouched and never read**. The per-review
  budget is the `REVIEW_BUDGET_USD` env var alone.
- Pinned by `ai/credentials.test.ts` (login, key, opt-in, none, disabled), `review/llm-ladder.test.ts`
  (incl. the platform clients) and `review/auth.test.ts`.

- **ALL OF IT IS CORE now** (`apps/backend/src/review/`). The security-sensitive half:
  `agent.ts` (the SDK run: an in-process MCP `submit_review` tool — `schema.ts` — captures
  structured output; read-only tools, `cwd` = a worktree, `bypassPermissions`,
  `settingSources:[]`, `maxTurns`/`maxBudgetUsd` caps, `AbortController` cancel), `submit-map.ts`,
  `model-options.ts`, `prepare.ts` (`gh pr diff` + `NOISE_GLOBS` stripping + per-file metrics +
  cap), `clone-manager.ts`, `post-review.ts` + `post-seam.ts`, `pricing.ts`, `chat-agent.ts`. The
  product half, moved back from the plugin into core (2026-10) and published under the Limn License 1.0:
  `claude-review/` (`manager.ts` — in-memory queue, one review/PR, `PRO_REVIEW_CONCURRENCY`, the
  auto lane, startup reconcile; `routing.ts`, `prompts.ts`, `follow-up.ts`, `ticket.ts`,
  `persist.ts`, `routes.ts`, `chat.ts`, `auto.ts`, `auto-settings.ts`, `specialists.ts`) and
  `../coding/ai-fix/` (the fixer).
  - ⚠ **REVIEW MEMORY IS DELETED** — capture (the review event bus `review/events.ts` and its one
    subscriber), retrieval, the "Reviewer preferences from past reviews" prompt block, the
    "From your past reviews in this repo (N signals)" panel's two routes
    (`GET /api/pro/prs/:id/review-learnings`, `GET /api/pro/claude-reviews/:reviewId/actions`), the
    shared types and the `review_learnings` table (DROPPED by migration `0075`; gone from
    both schemas, both delete paths, erasure, `accountScopedTables()` and `verify:isolation`). It
    never improved a review. Do not bring it back as a prompt block: the review prompt carries the
    PR, the optional user stories, the previous review's findings and the other reviewers' open
    threads, nothing about the reader.
  - ⚠ **They take ONE context argument, `AgentContext`** (`review/agent-context.ts`), built by
    `buildAgentContext` from DIRECT core imports — `ctx.review.*`, `ctx.coding.generateFix` /
    `applyAndPush`, `ctx.github.*`, `ctx.db` / `ctx.schema`.
    It is not `ProContext` (the platform's context): those seams were DELETED from that contract. The argument stays
    because the tests pass a fake one and the queues carry it per item. Every SDK-bearing module is
    still reached through a lazy `await import()` inside the member that runs it.
  - Registration: routes in `buildApp` via `registerAgenticRoutes`; the process-level half
    (the auto-review sweeper, the crash-orphan reconciles) once at boot via
    `startAgenticBackground` (index.ts).
    - **No platform input.** The old plugin seam `ProContext.registerAgenticProviders?`
    (`review/plugin-providers.ts`) is GONE: the ticket review's members and
    story, and a deep review's "Related PRs", come from core's tracker through
    `tracker/ticket-source.ts` ([TRACKERS.md](TRACKERS.md) § Peers).
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
  - **THE SUMMARY IS MARKDOWN, LED BY BULLETS** (`'summary'` in the system prompt, pinned by
    `prompts.test.ts`): ONE short plain-English sentence, then a "- " bullet per main issue, most
    serious first — and no list when there are no issues; no headings or tables. The ticket review's
    `summary` follows the same shape (one sentence, then a bullet per gap naming where it belongs).
    Older plain-prose summaries render unchanged.
  - **PR references in every piece of model text link to that PR in Limn** — one batched, DB-only
    `POST /api/prs/resolve` (`read` tier, account-scoped, ≤ `PR_REF_RESOLVE_MAX` refs, 400 over)
    for whatever the screen cannot resolve itself. Contract in docs/FRONTEND.md § The agentic AI
    surfaces.
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
    "Posted" link, Copy and **"Post reminder"** remain (§ Auto-posting, "Reminders"). The post route matches it: `POST …/post` sends included findings
    with `postedAt == null` only, so a re-submitted review cannot post a comment twice
    (`post-review-skips-posted.test.ts`). There is NO per-finding "Ask Claude" — the review's one
    chat thread covers every finding. A finding from a deep-review specialist wears a small lens chip
    (`CLAUDE_FINDING_LENS_LABELS`).
  - **The pane OPENS on "Reviews and actions"**: the Overview's Reviews and Actions rows (the SAME
    components, `components/pr/ReviewsRow.tsx` + `PrActionsRow.tsx`) and, once a review has
    succeeded, "Generate fix from this review" — LEFT-aligned and at the top, because at the foot of
    the pane it sat under the fixed bottom-right toast column. A reader's own Approve / Request
    changes there simply replaces Claude's earlier auto verdict on GitHub; nothing else is dismissed.
  - **A posted inline finding links to its thread**: `ClaudeFinding.threadId` is computed on read
    (`github_comment_id = review_comments.database_id`, scoped to the review's PR; null until the
    comment syncs), and the jump opens and flashes that thread's pill in Changes. Others keep the
    path/line jump.
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
    per-key one. ⚠ **A PULL READS THE STORED TICKET, NOT JIRA**: core's tracker worker read it when the
    PR was received ([TRACKERS.md](TRACKERS.md) § Fetch on receipt), so the auto-pull and "Pull all"
    are instant. Every read goes through ONE
    `qc.fetchQuery(['jira-ticket', prId, key])` (1-min stale, not persisted). Refresh is
    `POST /api/prs/:id/tracker-ticket/refresh` — Jira is read again server-side, through the worker's path, and
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
    `PUT /api/prs/:id/tracker-ticket/ac-field`, which saves it for that issue type, re-derives every stored ticket
    of the type and re-reads this one — other open tabs of the type are rebuilt from their stored
    rows. "Reset to default" sends `fieldId: null`. "None of these" empties this tab's criteria only
    and is never saved. Removing a tab does NOT clear the choice (it belongs to the issue type). An
    old per-browser choice (localStorage `limn:jira-ac-field:v1:…`) is moved to the server ONCE on
    the next pull and the key deleted (`legacyAcFieldToMigrate`). Candidate text is wiki markup rewritten to markdown by the tracker
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

### The AI spend budget (optional, one per machine)

An optional limit that PAUSES Limn's AUTOMATIC model runs before they use up the reader's Claude
allowance or API bill. OFF until switched on (Settings suggests the defaults). ONE per account =
per machine (the login / key it guards is the machine's), never per workspace. Types, defaults and
the estimate table: `packages/shared/src/ai-budget.ts`; the decision, the reading and the gate:
`ai/budget.ts`; stored on `accounts.ai_budget_settings` + `accounts.ai_budget_reading` (migration
`0125`). Routes: `GET`/`PUT /api/ai/budget` ([API.md](API.md) § AI spend budget).

The credential route picks the mode (`decideAiBudget`, pure):

- **Subscription (the login): Limn's SHARE of the week and of the 5-hour session.**
  `weekSharePct` (whole number 1–50, default 5). Share = Limn's OWN `ai_usage.cost_usd` in the
  current week ÷ `SUBSCRIPTION_ESTIMATES[sub].week` (ESTIMATES with their source comment — Anthropic
  publishes no figure). Over when the share ≥ `weekSharePct`. The week is `[reset − 7 days, reset)`
  when Claude's weekly reset has been read and is still ahead (then `resumesAt` = the reset),
  otherwise the last 7 days (`resumesAt` = when enough spend rolls out).
  **The 5-hour share** is measured the same way against `SUBSCRIPTION_ESTIMATES[sub].fiveHour`
  (Pro 15, Max 5x 75, Max 20x 200, Team 20 — internal, never shown), over `[reset − 5 h, reset)`
  when Claude's `five_hour` reset has been read and is ahead, else the rolling last 5 hours. Its
  setting `fiveHourSharePct` is NULL by default = it FOLLOWS `weekSharePct` ("5% a week → 5% a
  session" — a guess, stated as one); a number (1–50) sets it separately, `null` returns it to
  following. Over EITHER share pauses automatic runs: `limitedBy` names which (`'week'` when both),
  `resumesAt` is the later clearing, and the reason is "Limn has used its share of this 5-hour
  session." for the 5-hour one. ⚠ **The US$ arithmetic is internal** — `status.subscription` carries
  only percentages, the subscription, `reviewsPerDay`, the window kinds and the resets (a test
  asserts no dollar field); US$ is for the API key alone. No "pause at N% of Claude's own figure":
  Claude's usage NEVER blocks. The pure rules (`decideAiBudget`, `aiUsageView`, `rollingSpend`)
  live in packages/shared so the static demo runs the same ones; `ai/budget.ts` gathers the inputs.
- **Which subscription** — ONE rule, shared `resolveAiSubscription`: Claude's report of `pro` /
  `team` is used directly (a pick does not override it); `max` needs the reader to pick Max 5x or
  Max 20x (the picker offers only the pair, one line asks which); `enterprise` / anything else /
  no report → the reader picks from all four. Until known: never blocks, `reason` asks for a pick.
- **The reading** gives the subscription type, the reset times and the header's account-wide
  figures — never a decision. It holds the `five_hour`, `seven_day` and per-model `seven_day_*`
  windows (≤ 8), each `{utilization 0–100, resetsAtMs, observedAtMs}`, merged window by window into
  ONE latest value persisted on `accounts.ai_budget_reading` (a week-only row from before still
  reads). Two sources: every agent run's `rate_limit_event` (ai/runtime.ts TAPS every Query — the
  windows named by `unifiedWindows` or `rateLimitType`; its utilisation is a 0–1 FRACTION, converted
  ×100 on that path, believed from the CLI's header parsing, unproven), and a probe through the Agent
  SDK's EXPERIMENTAL usage method (login route only, ≤ once per 5 min, single-flight, 20 s timeout,
  an input stream with no turns so no model call; its utilisation is ALREADY 0–100 — measured on a
  real Max login — and kept as-is). ⚠ **The probe NEVER blocks a request**: `GET /api/ai/budget`
  serves the cached reading and starts the probe in the background whatever the budget (the header
  shows Claude's own figures with the budget off); the gate starts it only while the budget is on. A
  failure keeps the last reading. ⚠ No shared "≤ 1 means a fraction" guess anywhere. Any throw or
  shape mismatch = no reading.
- **The header's usage view** (`usage` on the same response, shared `aiUsageView`): Claude's own
  windows (a window whose reset has passed is dropped; unknown is absent, never 0), Limn's runs and
  tokens in the budget's week, Limn's week / 5-hour shares on a known subscription (budget on or
  off), and on an API key the US$ for the week, the last 5 hours and today (since local midnight).
- **A run's cost on a subscription is a share of the week, never US$.** Run payloads still carry
  their recorded `costUsd`; on the login route with a known subscription `usage.weekPctPerUsd` (a
  RATE, the one US$-named field a subscription carries) turns it into "0.3% of your week" /
  "<0.1% of your week" through the shared `runWeekShareText`, so the SPA never needs the estimate
  table. Unknown subscription ⇒ nothing; API key ⇒ US$ as before.
- **Reviews a working day** (`reviewsPerDay`, shown beside the share): `floor(share × weekly
  allowance ÷ 5 ÷ cycle)`, cycle = the mean `claude_review` cost over 28 days (fallback $0.42) + the
  mean `sequence_diagram` cost (fallback $0.22) when ANY of the account's workspaces has
  `auto_diagrams_enabled`. Null when the subscription is unknown; never NaN / Infinity / negative
  (shared `reviewsPerDayFor` / `cycleCostUsd`, which the demo reuses).
- **API key.** A US$ budget per rolling 7 days (`weeklyUsd`, default 25); `status.apiKey {weeklyUsd,
  usedUsd}`. `resumesAt` = when enough recorded spend rolls out. (The daily budget is gone.)

Settings: `PUT` takes `{enabled, weekSharePct, fiveHourSharePct, subscription, weeklyUsd}` (API key:
no 5-hour setting is used); an unknown key — including
the retired `fiveHourPct` / `weekPct` / `dailyUsd` — is a 400, but a stored row still holding them is
read fine (ignored, dropped on the next write). The GET/PUT answer's `settings.weeklyUsd` is `null`
off the API-key route (`aiBudgetSettingsView`): no US$ figure on the wire for a subscription.

⚠ **Every AUTOMATIC model run asks the ONE gate first** (`allowAutomaticRun`, reached through
`review/budget-gate.ts` `automaticRunAllowed` on `AgentContext.aiBudget`, and `ProContext.aiBudget`
on the platform). Over budget the run is SKIPPED, never queued: auto review's sweep (first reviews,
re-reviews, Check threads — the settle clocks are kept) and its lane start (manager.ts, before the
row exists), auto fix (`over_budget` skip reason), the CI and ticket review sweepers (their cursors
are left alone, so nothing is missed), the design diagrams after an AUTO review, the sprint after-read chain
(briefs → themes → needs code → paths) after a SCHEDULED read, and the Slack digest's sprint summary (the send
still goes, with the stored summary). Logged once per pause. A run the reader STARTS is never
refused, nor what follows from it: the diagrams after a MANUAL review and the chain after the
reader's sprint Refresh (`noteManualSprintRead`, tracker/sprint/hooks.ts) skip the gate. In the SPA,
over budget, the RUN control inside `AiRunGate` takes a second press (`OverBudgetConfirm`); only the
Run control — the buttons marked `data-ai-run`, else the gate's only button — never an ⓘ, Discard
or other button beside it. A new automatic caller must go through the gate.

## Codex, the second provider

Every AI feature can run on Codex (OpenAI) instead of Claude. The DEFAULT provider (Settings → AI)
runs every AUTOMATIC run and every surface without a model menu; a MANUAL run with a model menu (AI
Review run + follow-up, AI Fix + Plan first) may pick any signed-in provider's model (§ The per-run
choice). Build history and the measurements behind each rule:
[CODEX-PLAN.md](CODEX-PLAN.md) and [CODEX-SPIKE.md](CODEX-SPIKE.md) (its "Plan changes" overrule
the plan). Phase 3 is complete: every agent kind runs on Codex and `codexRunnable()` is true.

### The provider seam

- **`ai/provider.ts`** is the ONE door for every model call. The agent runners call a provider's
  `runAgent(spec)` — the RUN's provider (`review/run-provider.ts` `runProvider(args.provider)`: the
  reader's per-run pick, else the default; a runner with no menu gets the default,
  `getActiveProvider()`); `review/llm.ts` `cheapComplete` (and so the platform's
  `ctx.llm`) calls `.complete(req)`. Only `ai/providers/claude.ts` and `ai/runtime.ts` touch an SDK
  (`provider-seam.test.ts`). The model in a spec is a ROLE (`deep` / `standard` / `fast`), with an
  optional exact id; each provider resolves it.
- **`ai/provider-setting.ts`** answers "which provider?" for the registry and the pre-flight alike
  (it sits apart to avoid an import cycle). `LIMN_AI_PROVIDER` = `claude` | `codex` | `auto`
  (unset or unknown ⇒ `auto`). Without it, Settings → AI (`components/settings/AiProviderSection.tsx`,
  `PUT /api/ai/provider`) stores the choice in `accounts.ai_provider` (sqlite `0128`; read and written
  by `ai/provider-store.ts`, loaded at boot) and `aiProviderSetting()` holds it in memory, so a switch
  reaches the next run with no restart. ⚠ The environment WINS: the route answers `409` and the
  Settings control is disabled while `LIMN_AI_PROVIDER` is set. `activeProviderId()`:
  `codex` ⇒ Codex, `claude` ⇒ Claude, `auto` ⇒ `pickAutoProvider` — Claude when both are signed in
  and when neither is; Codex only when it ALONE is signed in (with ChatGPT) and can run every kind.
  An OpenAI API key alone never makes `auto` pick Codex.
- **ONE PROVIDER PER JOB.** A manager resolves the provider once (the run's own choice, else
  `activeProviderId()`), words its prompts for that provider and hands the SAME provider to the run,
  so a setting changed mid-job cannot split it.
- **The neutral run stream.** Both providers report a run the same way through `spec.onProgress`
  and `AgentRunResult.outcome`: a `step` per model step (worded activity lines, the step's text,
  the live token tally) and an `outcome` (subtype, final text, US$, turns, tokens). Runners read
  only this stream. The one Claude-only escape hatch is `spec.claude.onMessage` (the docs build's
  PDF page counter).
- **Per-kind pre-flight.** `detectClaudeAuth(kind)`, `ctx.llm.detectAuth(kind)` and
  `agenticRunReady(ctx, kind)` answer per run kind (`AiRunKind`: the 14 agent kinds plus
  `complete`). `/api/me` carries the map as `ai.kinds`, and Codex's own answers as
  `ai.providers.codex.kinds` whichever provider is active. Every `AiRunGate` names its `kind`.
- **Prompts.** Claude's prompts are byte-identical to before the seam (`prompt-golden.json`,
  `tickets-claude-prompts.json`, `no-shell.test.ts`). Codex wording is made in two ways: tool
  references marked `{Read}` / `{submit_x}` and rendered per provider by `ai/prompt-tools.ts`
  (Codex gets `read_file`, `list_files`, `search`, `apply_patch`, "your final JSON answer"), and
  whole-sentence swaps in the finished prompt (`review/codex-wording.ts`, tested so no Claude-only
  word survives).
- **Labels: every run names what ACTUALLY ran.** An `ai_usage` row carries `provider` (sqlite
  `0127`). Every stored run row carries `provider` + the `model` that ran (sqlite `0128`:
  claude_reviews, claude_review_chat_messages, ticket_reviews, ticket_review_pr_cards, ci_reviews,
  claude_thread_checks, ai_fixes (+ `plan_provider`/`plan_model` for the latest planning pass),
  sprint_paths, sequence_diagrams, story_docs_alignments, reference_docs,
  reference_doc_chat_messages; platform `0042_ai_provider_labels.sql` for the six platform write-ups
  with a live writer). A queued row is labelled from the active provider; the run then stamps what
  ran (`markReviewRanOn`, `markFixRanOn`, … via `ai/provider.ts` `ranOn`). A NULL provider is an
  older row: Claude's unless its model is a Codex id (`aiRunProvider`).
  - ⚠ **A stored model fed into a NEW run goes through `requestModelOf`** (chat, the next plan pass
    or build, auto fix): a Codex id maps back to the Claude model of the same depth, so a provider
    switch between passes never sends a gpt id to Claude.
  - **One spelling on screen**: `packages/shared/src/ai-run-label.ts` `aiRunLabel` ("Claude Opus
    5.5", "Codex · GPT-6.1 Sol"; `components/AiRunLabel.tsx`); sentences about a stored run name
    `aiRunProviderName(run)` (`ai-provider-words.ts`, the same rule); sentences about the run about
    to start name the provider it WILL run on: on a surface with a model menu, the pick
    (`aiProviderName(modelPick.chosen.provider)`), and while it runs, the running row's provider
    (`aiRunProvider(row.provider, row.model)`, stamped at queue time) — "Running Codex review" for a
    Codex pick while Claude is the default; only a surface WITHOUT a menu names the default
    (`useAiProviderName`). The model pickers name what will run
    (`aiModelChoiceLabel`: "Codex · GPT-6.1 Sol (most thorough)"). Never word a provider by hand.
  - **In-situ comparison**: a Codex review of a head Claude already reviewed runs, and both stay in
    history, each labelled (`mixed-providers.test.ts`). Auto review's one-run-per-head counts either
    provider. ⚠ A second review still gets the earlier one as its "Previous review" follow-up, so
    the two are NOT independent. The thread fold lets the newer run win and carries its provider.
  - Run cost follows the RUN's provider (`runCostText(…, provider)`): a Codex run on ChatGPT shows
    no figure, never US$. `useRunCostText()` judges a run of the OTHER provider (a per-run pick) by
    that provider's own reading (`['ai-budget', other]`, read only while it holds a credential), so a
    Claude Opus run on an API key shows its US$ while Codex is the default. Period reports still store the model ASKED for (it is part of the row's
    identity); the core one-shot tables (sprint briefs/themes, story labels) store a constant id.

### The per-run choice (decided 2026-10-26)

The user changed § 6's "one provider for every feature" for MANUAL runs: "for manual runs, I should
ideally be able to pick from any of the models available if I'm signed into both Claude and Codex.
I would pick a preference for auto-review in settings."

- **Settings → AI is the DEFAULT** ("Automatic runs and default: Auto / Claude / Codex";
  `LIMN_AI_PROVIDER` still wins, `auto` = Claude when both are signed in). It decides auto review,
  auto fix, the CI and ticket auto runs, every scheduled one-shot, and every surface without a model
  menu (Check threads, ticket and CI reviews, diagrams, the docs library, Resolve with Claude, the
  Open PRs table's one-click review), and it is the menu's opening choice. ⚠ One exception: the
  Check threads run that starts IN PLACE of a manual review routed `skip` runs on that review's
  provider (the reader's pick, `startThreadCheckBesideManualReview(…, provider)`).
- **The menus** (`components/ModelPicker.tsx`, `lib/modelPick.ts`): the Claude Review run (and its
  re-review, the follow-up) and AI Fix (+ Plan first) list the models of EVERY provider that is set
  up, signed in and can run the kind (`aiRunnableProviders`: `me.ai.providers.claude.runtime/auth`,
  `me.ai.providers.codex.runtime/kinds`), the default's first, each labelled by `aiModelChoiceLabel`
  ("Claude Opus 5.5 (most thorough)", "Codex · GPT-6.1 Sol (most thorough)"). Codex offers the depths
  Claude's menu offers (`CODEX_PICKER_MODELS`: astra = deep, sol = standard; luna is not offered on
  these surfaces). One provider ready ⇒ the menu reads as it did. `AiRunGate anyProvider` is ready
  when ANY provider can run the kind; its `provider` is the pick, whose budget the meter and the
  over-budget confirm read (`GET /api/ai/budget?provider=`). A click is never refused by the budget.
  ⚠ A FOLLOW-UP gate (the review chat, another plan pass, the build of a plan) is `AiRunGate followUp`,
  NEVER `anyProvider`: the run goes to `useFollowUpProvider`'s provider and no other, so the button
  shows only when THAT provider can run the kind (`aiGateReadyFor`); a signed-out default with a
  signed-in Codex shows the default's sign-in line on a Claude review's chat, not an Ask that fails.
- **The request** carries `{ provider, model }`; `ai/run-choice.ts resolveManualRunChoice` validates
  it in the route: an unknown provider or a model no menu offers ⇒ 400; a NAMED provider with the
  other's model ⇒ 400 `ModelNotOnProvider` ("GPT-6.1 Sol runs on Codex, not Claude."); the provider
  not signed in or unable to run the kind ⇒ 400 `NoClaudeAuth` with its own sentence. No provider ⇒
  a Codex model's own provider, else the default (an older SPA's Claude model is a DEPTH, run on the
  default as before). The answer is the provider and the Claude model of the same depth, which every
  entry point takes.
- **The run's provider, everywhere.** The review manager stores it on the job (`QueueItem.provider`,
  decided at queue time; auto runs read the default then) and hands it to `RunReviewArgs.provider`
  (`review/agent.ts` `runProvider(args.provider)`); AI Fix passes `StartFixInput.provider` to its
  prompts and `GenerateFixArgs.provider`. The queued row's label (`queuedRanOn`), `ranOn`, the ledger
  (`ai_usage.provider`, written by the provider that ran), the run's cost text, the follow-up chain
  (`loadPriorReviewForFollowUp(…, provider)`) and the thread carry (`priorAssessmentsForProvider`) all
  read the RUN's provider. `AgentRunSpec` needs no provider field: a spec is handed to the provider
  that runs it.
- **Follow-ups on a stored run** run on that run's provider while it is signed in, else the default
  (`followUpProvider`): the review chat on its review, another Plan-first pass and the build of a plan
  on the plan's provider. The SPA's gates and wording follow the same rule (`useFollowUpProvider`).

### The effort setting (decided 2026-10-26)

The user compared Opus 5.5 (pinned at medium, 30 turns) with Codex GPT-6 Astra (high) on one PR and
asked to "make effort a setting". Settings → AI → **Effort** (`AiProviderSection.tsx` `EffortControl`,
`PUT /api/ai/effort`, `accounts.ai_effort`, sqlite `0130`) holds ONE level for both providers:
Default, Low, Medium, High, Extra high, Max.

- **The map is the identity** (`packages/shared/src/ai-effort.ts`). Claude's Agent SDK `effort` and
  Codex's `model_reasoning_effort` both take `low | medium | high | xhigh | max`: Opus 5.5 and Sonnet 5
  accept all five with adaptive thinking; the Codex CLI 0.164.0 enum is `none | minimal | low | medium
  | high | xhigh | max | ultra` (read from the binary), with Sol and Terra taking low … ultra and Luna
  low … max. `none`, `minimal` and `ultra` have no Claude counterpart and are not offered. So "High"
  is `high` on both, which is the fair comparison the user asked for.
- **Default (NULL) is today's behaviour, exactly**, because today's defaults are not one level:
  Claude medium (diff-only medium on Opus, low on Sonnet), Codex by depth (deep high, standard medium,
  fast low; diff-only one step lower). A chosen level runs at that level on a worktree run. Diff-only
  it runs one step lower, but NEVER below what Default runs that review at — unless the chosen level
  is itself lower, when it runs at the chosen level (`diffOnlyEffortAt`). ⚠ Without that floor,
  picking Medium (what Default already runs Opus at) dropped Opus's diff-only reviews to low.
- **Who it reaches** (`ai/effort.ts` `agenticRunEffort`, read ONCE at the run's start): the PR review
  (`review/agent.ts`: the lead, Claude's specialists through the SDK's per-agent `effort` — sent only
  when a level is chosen — and Codex's Limn-run specialists), its follow-up re-reviews (same runner),
  AI Fix and Plan first (`coding/ai-fix/manager.ts` decides it, `GenerateFixArgs.effort` /
  `GeneratePlanArgs.effort` carry it). Claude gets it as `spec.claude.effort`
  (`sdkModelOptions(model, mode, effort)`), Codex as `spec.codex.effort`. Every other kind keeps
  `defaultRunEffort`. A provider switch never changes the level, only who reads it.
- **Precedence**: an explicitly set `REVIEW_EFFORT` (one of the five) WINS and locks the control
  ("Set by REVIEW_EFFORT"; the PUT answers 409). `REVIEW_DIFF_ONLY_EFFORT`, when set, decides every
  diff-only review on both providers, at Default too. ⚠ **Both env vars reach EXACTLY what the
  control reaches** (the review, AI Fix, Plan first) — `defaultRunEffort` reads no environment, so the
  CI review, ticket review, diagrams, Check threads, chats and Resolve with Claude keep their fixed
  depth (Opus 5.5 medium, as under the old pin). Before 2026-10-26 these two variables also moved
  Sonnet on every Claude kind; that was dropped so the label under the control is the whole story.
- ⚠ **The Opus 5.5 pin (`PINNED_EFFORT`) is GONE.** What stays fixed is real: Opus 5.5 always gets
  `thinking: {type: 'adaptive'}` and is never sent disabled thinking, a thinking budget or a forced
  tool choice.
- **No turn limit**: a WORKTREE review has no turn limit on either provider (Codex never had one; the
  owner removed Claude's on 2026-10-26 so the two compare fairly) unless `REVIEW_MAX_TURNS` is set
  (`config.reviewMaxTurnsPinned`), which caps it at that number. The tool-less diff-only cap (6) and AI
  Fix's caps are unchanged. ⚠ `REVIEW_BUDGET_USD` ($6.75) still stops a run on an API key, and is not
  scaled by effort.
- **Stored and labelled**: the run stamps the effort it SENT with its provider and model
  (`AiRanOn.effort` → `claude_reviews.effort`, `ai_fixes.effort` / `plan_effort`), and
  `aiRunLabel(provider, model, effort)` adds it: "Claude Opus 5.5 · high", "Codex · GPT-6.1 Sol ·
  extra high". A NULL (older row, queued run) reads as before.

### The review tab's history

Every run on the PR is listed, always (`components/ReviewHistoryList.tsx`): all providers, all
heads, newest first (`listClaudeReviewHistory` is uncapped and now carries `findingCount`). A row
shows the head, what ran (`aiRunLabel`), status, verdict, findings, when and the Auto marker;
pressing it shows that run, and the shown run is marked. Which run is shown is the reader's
(`lib/reviewHistory.ts nextShownReviewId`): a run starting or finishing, a provider switch or the
model menu never moves it, except to a run the reader just started (a MANUAL run that became the
latest). Opening while an auto run is in flight shows the newest finished run. Editing and posting
stay on the latest run only. AI Fix keeps no per-PR run selector (only "Earlier fixes pushed").

### The Codex runner

- **The CLI, run directly** (`ai/codex/run.ts`, argv from `ai/codex/config.ts`): `codex exec --json
  --strict-config --skip-git-repo-check -C <cwd> --output-schema <file> -m <model>`, the prompt on
  stdin. Not the SDK: it cannot pass `--strict-config` and hides stderr, where Codex writes its
  refusals. `--strict-config` makes an unknown `-c` key an error, so a typo cannot unlock anything.
  No `--ephemeral` (the retry needs the session file), no `--ignore-user-config` (the config is
  Limn's own), no `--dangerously-bypass-hook-trust`.
- **Locked settings**: ONE list, `LOCKED_SETTINGS`, written into Limn's `config.toml` AND passed as
  `-c` on every `codex exec` and app-server start: `approval_policy="never"`,
  `forced_login_method="chatgpt"`, no shell, no image reads, no web search, no history, no
  analytics, no subagents, `project_doc_max_bytes=0` (the only thing that keeps a PR's own
  `AGENTS.md` out of the prompt), `skills.include_instructions=false`, and every plugin, app,
  connector, memory and goal feature off. Writes use `sandbox_mode="workspace-write"` with the
  write roots only, no network, and `/tmp` and `$TMPDIR` excluded; everything else is `read-only`.
- **Reads: Limn's workspace MCP server** (`ai/codex/workspace-mcp.ts`, `workspace-files.ts`). With
  the shell off, `read_file`, `list_files` and `search` are the run's only way to see files. Every
  path is placed by the same rule as the Claude path guard (`realPathFor`) and refused outside the
  read roots. Globs and search use a linear-time matcher (`linear-regex.ts`). Node built-ins only,
  because Codex starts it by file path.
- **The PreToolUse hook** (`ai/codex/hook.ts`, rule in `hook-rule.ts`) is an ALLOW-list with matcher
  `.*`: write tools only inside the write roots, `mcp__workspace__*` only inside the read roots,
  `update_plan`; every other tool is denied. It fails closed. ⚠ Codex skips an untrusted hook
  WITHOUT A WORD, so every run (and every `complete()`) first writes the trust entry into Limn's
  home and refuses unless `verifyHookTrusted` sees it trusted with our hash AND it denies a canary
  call. The roots travel in `LIMN_CODEX_GUARD`, so the command and its hash are the same for every
  run.
- **Results.** Each result tool (`submit_review`, `submit_fix`, …) becomes ONE strict JSON Schema
  (`ai/result-schemas.ts`), built from the same zod shape the Claude tool uses. The final answer is
  mapped back to the tool's arguments, parsed against that shape and handed to the SAME handler,
  so every server-side check (`validateDesign`, the fix's shown-ref check, the digit gate, …)
  stays where it is. A rejected answer gets ONE retry on the same thread (`codex exec resume`);
  then the run fails.
- **Specialists are run by Limn**, not by Codex subagents (`ai/codex/specialists.ts`): up to the
  same cap, chosen in code (`pickCodexSpecialists`), each its own read-only run in parallel, before
  the lead; their reports reach the lead fenced, and a skipped or failed one is named. An automatic
  review asks the spend gate before each.
- **Writes are read from git**, never from the event stream (a refused patch emits nothing): the
  changed files are what `git status` shows in the write roots; a change outside them fails the run.
- **Effort**: Settings → AI → Effort when the reader chose a level (the review, its specialists,
  AI Fix and Plan first; § The effort setting); otherwise the Default by depth: deep = high,
  standard = medium, fast = low, and a diff-only review one step lower (`ai/effort.ts`
  `defaultRunEffort`; `codexReviewEffort` for the chat and Check threads). Default agent timeout 45
  minutes; a stop signals the whole process group.
- **Clean-up.** Codex keeps every run twice in Limn's home (the rollout file and its own sqlite
  rows), and both hold PR text. Once a run's usage is recorded, its thread is queued
  (`ai/codex/threads.ts`): one app-server per drain calls `thread/delete`, the rollout file is
  removed whatever that answers, and the log rows go by `thread_id`. Anything older than a day is
  swept every six hours and at boot. Account erasure deletes the files (`rollouts.ts`).
- **What Codex cannot do here**: a PDF docs build refuses on Codex (it cannot read PDF pages).

### Sign-in, models and cost

- **Limn's own Codex home, `~/.limn/codex`** (`ai/codex/home.ts`). Every Codex process Limn starts
  gets `CODEX_HOME` pointed there. ⚠ The reader's `~/.codex` is never read or written, and its
  `auth.json` is never copied (a ChatGPT refresh token rotates, so two copies would sign one out).
  Sign in with `limn ai login codex` (`--device-auth` on a headless machine) or from Settings
  (`/api/ai/codex/login`, driven through `codex app-server`); `limn ai logout codex` signs out.
- **ChatGPT sign-in only.** The OpenAI API-key route is REFUSED ("Codex with an OpenAI API key is
  not available yet — sign in with ChatGPT") until `CODEX_PRICES_PER_MTOK` holds real prices,
  because an unpriced run would record US$ 0 and no US$ cap would trip. Codex itself enforces it
  (`forced_login_method="chatgpt"`), and Limn checks the sign-in KIND before every run; a sign-in
  whose kind is not yet confirmed does not run.
- **Models per role** (`CODEX_MODEL_FOR_ROLE`, pinned for `@openai/codex` 0.164.0): deep =
  `gpt-6.1-sol` (the default), standard = `gpt-6.1-terra`, fast = `gpt-6-luna`. ⚠ `gpt-6-astra` was
  deep until 2026-10-26: at High it spent a ChatGPT Plus 5-hour window in about two reviews, so the
  owner moved Codex to Sol and Terra. Stored Astra rows still label, and `requestModelOf` maps them
  to deep. A review on Opus runs deep, on
  Sonnet standard. A Claude model id passed through is never sent to Codex. Re-check the table on
  every CLI bump (`codex debug models`).
- **Usage and cost.** Codex reports tokens, never US$. On a ChatGPT sign-in a run costs US$ 0 and
  its tokens are recorded; the provider writes its own ledger row (`usageRecord`), so the caller
  writes none. A cancelled run records NULL tokens. Reasoning tokens are part of output tokens and
  are never added on top. Per-run `budget.usd` and turn caps are Claude's; a Codex run is bounded
  by its timeout.
- **The ChatGPT budget share is TOKEN-WEIGHTED** (`packages/shared/src/ai-budget.ts`
  `codexWindowSharePct`): Limn's tokens in the window ÷ the account's tokens in the window × the
  window's `usedPercent`. The windows (5-hour and weekly, whole percent, with resets) come from
  `account/rateLimits/read`, the account's tokens from `account/usage/read`, read by a background
  probe at most every 5 minutes. Both counts cover the SAME span. Unknown account tokens leave
  Limn's share unknown, which never blocks. The share is coarse (whole percent); the copy says so
  behind the ⓘ.
- **Install.** The Codex CLI is downloaded on first use into `~/.limn/ai-runtime` ("Set up AI"
  with Codex, or `limn ai install codex`); `LIMN_CODEX_PATH` points at a codex program of your own.
  See [PACKAGING.md](PACKAGING.md).

## Related repos (2026-10-26)

Repos of ONE workspace the reader reviews together — a frontend and its backend. A DEEP review of a PR
in one reads the matching change in each related repo, read-only, beside the ticket peers. Asked for
after a review of `bng-metric-frontend#418` missed a bug only the backend branch of the same name
showed.

- **The setting** (Settings → Workspace → Related repos, `RelatedReposSection`; shown on
  `me.ai.enabled`). `GET /api/workspaces/:id/related-repos` → `{workspaceId, pairs}`; `PUT
  /api/workspaces/:id/related-repos/:repoId {relatedRepoIds}` REPLACES that repo's relations. Table
  `repo_relations` (migration `0131`), keyed `(account_id, workspace_id, repo_id, related_repo_id)`,
  three composite FKs. ⚠ **SYMMETRIC, STORED BOTH WAYS** (two rows per pair, written and deleted
  together). ⚠ **Both repos must be members of the row's workspace NOW**: a move out (`assignReposToWorkspace`,
  `rehomeReposToDefault`, `deleteWorkspace`) or `deleteRepo` drops the repo's rows
  (`dropRepoRelations`), and every reader joins membership anyway. At most
  `RELATED_REPOS_MAX_PER_REPO` (8) per repo, ⚠ ON BOTH SIDES: `setRelatedRepos` skips a partner that
  already has 8 relations of its own (Settings disables its box, "already has 8"; `partnerIsFull`),
  else nine repos each saving [A] gave A nine. Off by default (no rows). In the export and the erasure.
- **The match** (`review/claude-review/related-repos.ts` `relatedRepoPeersFor`), per related repo, the
  FIRST that holds: (1) an OPEN PR whose head branch has the same name → "Companion PR: same branch
  name"; (2) an OPEN PR whose title or branch carries one of this PR's ticket keys → "Companion PR:
  same ticket" (`sharedTicketKeys`, below); (3) a BRANCH of the same name with no PR (one REST read,
  `fetchBranchHeadSha`, only when 1 and 2 found nothing; never the default branch) → "Companion
  branch"; (4) the DEFAULT BRANCH → "Reference: default branch". Closed PRs and other accounts' rows
  never match. DB only apart from rule 3. Never throws.
- ⚠ **Rule 2's keys are GUARDED** (`sharedTicketKeys`). A lower-case branch key (`bmd-1048-…`) is the
  same shape as an ordinary `fix-2-login` / `node-18` branch — the tracker's largest false-positive
  source. With the workspace tracker's project keys set (`workspace_trackers.project_keys`), only
  those prefixes count, in any case, title or branch (exact). Without them, the branch is read
  upper-cased but a shared key counts only when at least ONE of the two PRs writes it in upper case in
  its TITLE, as the tracker reads a title. So `fix-2-login` never matches `fix-2-timeout`, and the BMD
  case (`BMD-1048: …` in the frontend title, `bmd-1048-…` as the backend branch) still does.
- **The peers** (`manager.ts` `reviewPeersFor`): related CHANGES (1–3) lead, with a ticket peer that
  sits IN a related repo beside them; then the other ticket peers as before, then default-branch
  REFERENCES; ONE cap, `TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW` (still 4: each peer is a full checkout
  plus prompt bytes, and a related repo is one peer at most). A related repo that already has a ticket
  peer is skipped by the walk — that PR is its companion change — and ⚠ that ticket peer is MOVED UP
  into the leading group, or the cap could drop it after the walk had skipped the repo, and the review
  read nothing from a repo the reader related. The walk is told the cap (`maxPeers`) and stops once
  the leading group is full, so no rule-3 GitHub read is spent on a change the cap would drop. Refs
  `X1…` in that order.
- **The checkout** (`agent.ts` `checkOutPeers`): a PR peer at its head (`prepPeerWorktrees`), a branch
  or default-branch peer at the branch tip (`prepDefaultBranchCheckouts`, `RunReviewArgs.peers[].kind`).
  All are READ roots: Claude's path guard and `additionalDirectories`, Codex's workspace MCP server and
  its PreToolUse guard (`roots`, never write roots; pinned in `codex-review-runs.test.ts`).
- **The prompt.** Ticket peers alone keep "## Related PRs on the same ticket" BYTE-IDENTICAL (golden
  `worktreeTicketPeers`, generated from the old builder). Any related-repo peer switches to "## Related
  code in other repositories" (golden `worktreeRelated`): one heading per peer naming its kind, the
  title / branch / ticket / files FENCED (`RELATED PR Xn` or `RELATED CODE Xn`) — ⚠ a branch name is
  other people's text and never sits in a heading — and one added rule: a default branch is the
  repository as it stands, read only to see what this PR calls or is called by.
- **What was read** (`claude_reviews.peers_read`, `RunReviewResult.peersCheckedOut`): only the peers
  that checked out; served as `ClaudeReview.alsoRead` and shown under the run's meta line, "Also read:
  acme/api#21, acme/infra @ bmd-1048-…" (`reviewPeerReadLabel`).
- **Not the ticket review.** It reads every PR on its ticket already (and the default branch of the
  merged members' repos); it does not use `reviewPeersFor` and is unchanged.

## Reference docs in a review

When the PR's workspace has "Use reference docs in Claude Review" on and its library has a built
document, the PR review and the ticket review may READ the library
(a read-only path-guard root), get the navigation block in their system prompt, and report the passages
they relied on in `docReferences` (a PR finding also carries `docRefs`). The server checks every one (the
link names a built section; the quote is in it) and drops the rest. Off ⇒ prompts, tools and shapes are
byte-for-byte unchanged. Full contract: [REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Use in reviews.

## SonarCloud in a review

When the PR's workspace has SonarCloud set up, a run takes (or reuses) the head's stored snapshot before
it builds the prompt and adds a fenced "SonarCloud analysis of this commit" block (the 25 most severe of
up to 50 items, as evidence, never to be copied). The tab shows a **SonarCloud** section after CI check
with a "Post SonarCloud findings" button: ONE separate GitHub review per (PR, head) — inline threads on
changed lines, everything else in its summary body (docs/SONARCLOUD.md § Posting) — claimed before the write, never
retried; an auto review posts it under auto-posting's `sonar` kind. AI Fix seeds the same items as
`Q<n>`. Contract: [SONARCLOUD.md](SONARCLOUD.md).

## Data, not only code (2026-10-26)

An Opus-vs-Astra comparison on five BNG PRs found that every bug BOTH models missed was a DATA-lifecycle
bug: a value one side writes that the other side cannot read back ("30+" vs ">30"), stored values outside
a filtered list wiped on Save, 0 stored where "no value" was meant. The prompts pointed reviewers at CODE
contracts only. So (both providers — Codex renders the same text):

- The full-checkout system prompt's "Why you're here" has a "Follow the DATA" bullet: for each value
  written, stored or sent, find its readers and check they handle every value the writer can now
  produce; existing stored values must survive an edit that does not touch them; "no value" stays
  distinct from zero or "".
- The `impact` specialist carries the same rule (no seventh lens: a new lens is a schema/UI change).
- `FINDINGS_AND_FINISHING` (both modes) asks the lead to re-check every finding, its own and the
  specialists', before submitting, and to drop or turn into a 'question' any it cannot confirm (Opus
  had submitted one wrong finding).

`prompt-golden.json` pins the USER message only, so it did not change.

## No praise findings

A review posts only what the author should act on or answer. `praise` is OUT of `submit_review`'s
severity enum (`review/schema.ts`) and `mapSubmittedReview` drops any that arrives anyway. What is
good is ONE line of the summary: the lead sentence, the issue bullets (if any), then exactly one
`- Good: …` bullet. ⚠ `ClaudeFindingSeverity` KEEPS the `praise` member — older runs stored praise
rows and they are never deleted — but every read the SPA, the chat, posting and the counts go
through HIDES them (`isShownFinding` in `claude-review/persist.ts`: `getClaudeReviewById`, the
states fold, `getFindingPostContext` 404s one). Follow-up and the AI Fix seed already excluded
praise; My Turn's "unposted finding" test skips it. NOT applied to `ownPostedCommentsForPrs`: a
praise comment already on GitHub is still Limn's own comment. The ticket review never had praise.

## Models

- **Claude Opus 5.5 (`claude-opus-5-5`) is the DEFAULT and the first offered model**
  (`CLAUDE_REVIEW_MODELS[0] === DEFAULT_CLAUDE_REVIEW_MODEL`, pinned by a test). The picker always
  opens on it — it is NOT seeded from the stored run, or every already-reviewed PR would keep
  reopening on its old model. A request with no `model` runs it.
- **Opus 4.8 (`claude-opus-4-8`) is REMOVED, not just unoffered.** It is gone from the
  `ClaudeReviewModel` union, `CLAUDE_REVIEW_MODEL_LABELS`, the price table (`review/pricing.ts`
  `RATES`) and `EFFORT_CAPABLE_MODELS`. `claude_reviews.model` has NO drizzle `enum:` — it was always
  plain `text` (no CHECK), so no migration —
  and `ClaudeReview.model` / `ClaudeReviewSummary.model` are typed `string`. Stored 4.8 rows
  therefore read back verbatim and the SPA prints the raw id (labels are looked up only for the
  offered list). Nothing re-prices a stored run; an id outside `RATES` falls back to Sonnet 5 rates
  in the live estimate. Both generate routes (Claude Review and AI Fix) answer 400 for it.
  Retiring a model is now a shared-types + pricing + model-options edit, never a schema edit.
- **Opus 5.5's effort is no longer pinned** (2026-10-26, § The effort setting): every run is sent
  an explicit effort (never the API default) — Settings → AI → Effort for the review and AI Fix,
  else the Default (medium; diff-only medium on Opus, low on Sonnet); `REVIEW_EFFORT` /
  `REVIEW_DIFF_ONLY_EFFORT` move both models alike, on the review and AI Fix only. It always gets
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
  (`packages/shared`, ONE spelling), read by the fixer picker (`AiFixTab`) and the core start route (`coding/ai-fix/routes.ts`). Its
  effort is Settings → AI → Effort (Default medium), decided by the fix manager and carried to
  `coding/agent.ts`; the constant carries no effort of its own. `POST /api/pro/prs/:id/ai-fix` checks `model` IN THE HANDLER — there is no ajv
  body schema, because `removeAdditional` would strip `seed`/`reviewText`/`commentTargets`: absent or
  null → the default; a string in `CLAUDE_REVIEW_MODELS` → that model; anything else →
  `400 {error:'ModelNotOffered'}`. No stored fix row's model is ever re-run. Only the FIXER moved:
  the pane's summary stays on Haiku. Opus 5.5 is about 1.33× Sonnet 5's
  per-token price, so `aiFixBudgetUsd` went from $3 to **$5**: the heaviest succeeded Sonnet 5 fix
  in the dev DB cost $2.34, about $3.12 at Opus 5.5 rates for the same tokens. An explicit
  `AI_FIX_BUDGET_USD` still beats the default. Pinned by `review/claude-review-ticket.test.ts`,
  `coding/ai-fix/routes.test.ts` and `apps/frontend/test/aiFixModelDefault.test.ts`.
- Price (live estimate only; the recorded cost is the SDK's own): Opus 5.5 is $4 in / $20 out per
  MTok, cache write $5, cache read $0.20.
- **THE OFFERED LIST IS TWO MODELS: Opus 5.5 and Sonnet 5.** Sonnet 4.6 and Haiku 4.5 went the
  way of Opus 4.8 — out of the `ClaudeReviewModel` union, the labels, `RATES` and
  `EFFORT_CAPABLE_MODELS` (and the Haiku-only turn multiplier, `REVIEW_HAIKU_TURN_MULTIPLIER`, is
  deleted). Nothing stores a model as a SETTING, so there was nothing to migrate: stored runs and
  fixes keep their id and print it raw, both generate routes 400 the two ids, and the review chat's
  `chatModelFor` already falls back to the default for a stored run on an unoffered model.
- The story report, once the one agentic run on Haiku 5.5, was REMOVED 2026-10-18 (§ Story report).

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
  finding's optional `lens` set. `lens` is stored on `claude_review_findings.lens` (migration `0075`, nullable, no backfill; a stored value outside `CLAUDE_FINDING_LENSES` reads as null)
  and rides `ClaudeFinding.lens` (labels: `CLAUDE_FINDING_LENS_LABELS`). null = a general finding.
- **A deep review always looks at the design**: the worktree system prompt (`systemPromptForMode(
  'worktree', offered)` appends the catalogue section) asks for a `lens: 'design'` finding for
  each design problem in the change as a whole, file-level when it is about the file — and NO
  finding when the design is sound (that goes in the summary's one "Good:" line, § No praise
  findings) — alongside the usual line-level findings. With no specialists offered the
  worktree prompt is byte-identical to before.
- Progress: a dispatch shows as "Asking the <lens> specialist", and a specialist's own steps are
  prefixed with its name (`describeAssistantBlocks` maps `parent_tool_use_id` → lens).
- Cost: a deep review that consults specialists costs more than one that does not — each specialist
  re-reads code in its own context. The per-review budget is the guard; nothing else meters it.

## Follow-up on the previous review

When a run starts for a PR that has an earlier succeeded review, the new run checks that review's
findings **that were posted to GitHub, or are still waiting to be posted** (not posted, not
ignored) and says, for each one, whether the current code deals with it. If there is none, there is
nothing to follow up: the run is an ordinary review, with no "Previous review" prompt section, no
`follow_up` record and no follow-up sentence. A FROM-SCRATCH run (§ From-scratch review) skips all
of this.

- **Which review.** The newest `claude_reviews` row for the same PR and account with
  `status='succeeded'`, an id below the current run's, and `review_mode IS NULL OR review_mode <>
  'skip'` (a skip run read no code). ⚠ The NULL arm is load-bearing: pre-routing rows have no
  mode, and `ne()` alone drops them. `persist.ts` `loadPriorReviewForFollowUp`, account-scoped
  through the repos join.
- **Which findings — POSTED, OR STILL WAITING TO BE POSTED** (`isFollowUpEligible`, the ONE
  selection point: the previous review's own findings and every carried one go through it, so the
  prompt, the stored `follow_up` items, the counts in the templated sentence and the SPA's
  "Previous review" list all agree). Never praise, never a legacy story finding. A finding is in when:
  - it was **POSTED** (`postedAt != null`, `isPostedForFollowUp`), whatever its `included` tick
    says now: an ignored-after-posting comment is still on the PR. ⚠ The signal is `postedAt`, NOT
    `githubCommentId`: Post review (`markReviewPosted`) stamps `postedAt` on its inline findings
    but stores no per-comment id (they ride the GitHub review), while the single-comment route
    (`markFindingPosted`) stamps both; or
  - it is **NOT POSTED YET and still INCLUDED** (`included === true`: the reader has not ignored
    it) and does NOT repeat a posted comment (`repeatsPosted`: its `priorFindingId` names a posted
    finding — that comment is followed up instead, carried, so a same-commit re-run never re-raises
    it as a new, included finding to post twice). ⚠ **Why (2026-10-27, PR 182520):** the rule used
    to be POSTED ONLY. A same-head re-run of a review whose five findings were all unposted — four
    the server's own left-out re-raises of posted comments (followed up through those comments), one
    NEW and still included — dropped the new one silently: not sent, not named, and the model did
    not happen to find it again, so it vanished from the newest run, the one the pane shows and Post
    review sends. Now it is sent (its fence says "Not posted to GitHub yet", and the lead sentence
    says some were not posted — the wording is unchanged when every sent finding was posted, so
    `prompt-golden.json` holds), locked `not_addressed` on the same head, and raised again
    INCLUDED (`isAlreadyOnThisCommit` needs a POSTED earlier finding). A carried, never-posted
    finding whose re-raise the reader IGNORED is not carried back: the ignore is the reader's latest
    word on it.
  ⚠ **NOTHING DROPS OUT SILENTLY: `follow_up.leftOut`.** Every OWN finding of the previous review
  that is not followed up is named on the stored record with its reason
  (`followUpLeftOutReason`): `ignored` (the reader ignored it before posting), `already_posted` (an
  unposted repeat of a comment on GitHub — the server's own left-out re-raise, or one the reader
  ticked; the posted one is followed up), `settled` (an earlier review accepted a reply on it, see
  below), `story`. Praise is not listed (not a shown finding). The pane prints one muted line
  (`followUpLeftOutSentence`, "Left out: 1 ignored, 4 repeated posted comments."), titles on hover.
  When NOTHING is followed up no record is stored, so nothing is named: every finding left out then
  was the reader's ignore, a settled or a story one. ⚠ The settled list and the backward-compatible
  unjudged-reply load stay POSTED ONLY (`isPostedForFollowUp`): both are about a reply on the
  finding's GitHub thread. The prompt uses the body the user saw: `editedBody` when non-blank, else
  `body` (the routes' `resolvedBody` rule). Follow-up records stored before 2026-10-27 have no
  `leftOut`; they are not rewritten, and the next run's carry-forward re-checks every id through
  the same rule.
- ⚠ **SETTLED BY A REPLY ⇒ OUT OF THE FOLLOW-UP, AND NEVER RAISED AGAIN** (`settled-by-reply.ts`,
  pure; loader `persist.ts` `loadSettledByReplyFindings`, over EVERY earlier succeeded review of the
  PR, account-scoped). A posted finding is settled ONLY when an earlier review ACCEPTED a person's
  reply on its thread (`reply_accepted`, § Replies to Limn's findings). Then: it is filtered out of
  `loadPriorReviewForFollowUp` (own AND carried, after the carry bookkeeping), so it is never a P
  item, never on the stored `follow_up` record, never in the pane's open "Previous review" list and
  never an AI Fix `P` seed item; the prompt lists it (up to 30) under **Settled in an earlier
  review**, one `---BEGIN SETTLED FINDING S<n> <nonce>---` fence each carrying the path, title and the
  reply as data (in the nonce-collision scan), telling the model not to raise it again; and the
  manager DROPS, in code, any new finding that repeats one (`dropSettledReraises`: same path, title
  equal once folded or word overlap ≥ `SETTLED_TITLE_SIMILARITY` 0.6). A finding LINKED to a
  still-open earlier one (`priorFindingId` set) is that one's re-raise and is kept. The review READ
  carries the same list as `ClaudeReview.settledEarlier` (succeeded runs only, DB-only, minus any id
  the run's own follow-up still lists), and the tab shows it in the closed "Addressed, settled or no
  longer applies" group: the reply's author + excerpt and how it was accepted ("not an issue" / "to
  be handled later"), marked "settled in an earlier review".
  ⚠ **RETIRED (2026-10): "resolved + someone else replied + code unchanged ⇒ settled on sight".**
  Resolving is a click, so a RESOLVED thread with a person's reply is now JUDGED exactly like an open
  one (§ Replies to Limn's findings). ⚠ **A thread resolved with NO reply is unchanged** — followed up
  on the code and re-raised as before. ⚠ **Backward compatibility:** a finding the retired rule
  settled in an earlier run left the chain WITHOUT being judged, and nothing would bring it back.
  `persist.ts` `loadUnjudgedReplyFindings` (pure rule `unjudgedReplyCandidateIds`) finds earlier
  posted findings with no closing follow-up status (`addressed`, `no_longer_applies`,
  `reply_accepted`) as their NEWEST item, not continued by a later POSTED re-raise and not already in
  this run's follow-up or settled — oldest first, at most `UNJUDGED_REPLY_MAX` (20). The manager
  attaches their threads and keeps only those RESOLVED WITH A REPLY, as CARRIED items, so each is
  judged once on the next run and then follows the ordinary chain. Old runs' stored records are not
  rewritten. Pinned by `settled-by-reply.test.ts` (the rules) and `settled-by-reply-pipeline.test.ts`
  (end to end through the manager).
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
  wears "Already posted"; the reader can still un-ignore it. On a moved head it stays included, but
  ⚠ since 2026-10-14 it is still NOT POSTED AGAIN by hand: its chain is on GitHub, so it carries
  `earlierPost` and reads as posted (§ Auto-posting, "What is already on GitHub") — except as an explicit,
  marked REMINDER ("Reminders").
- **The sentence is TEMPLATED** (`followUpSentence` in shared, e.g. "Last review's 5 comments:
  3 addressed, 1 partly addressed, 1 not addressed.", or "Last review's 3 comments and 2 older
  ones: …" when some were carried — a carried comment is not the last review's) from the
  server-validated statuses — a
  code-derived figure; Claude's explanations are shown separately, as Claude's text. On the wire,
  each follow-up item carries a DERIVED `reraisedFindingId` (the finding whose `priorFindingId`
  matches), and findings carry `priorFindingId`.

### From-scratch review (`fresh`)

`POST /api/prs/:id/claude-review {fresh: true}` starts a run that uses NO earlier review: it
reviews as if it were the first run on the PR (manager.ts `QueueItem.fresh`).

- **What it skips:** the follow-up (`loadPriorReviewForFollowUp` — no "Previous review" section, no
  `follow_up` record, no re-raise, no `priorFindingId` link), the settled-by-reply list and its
  repeat-dropping (`loadSettledByReplyFindings`), the backward-compatible unjudged-reply load, and
  every carried thread judgement (`loadPriorRunForCarry` and `currentThreadAssessmentsForPrs` →
  `planThreadReview(…, null)`). Other reviewers' open threads are still SHOWN and judged afresh.
- **What it keeps:** everything else — routing, specialists, peers, SonarCloud, the reference
  library, the CI review beside a manual run. A `skip`-routed fresh run is an ordinary skip (it
  reads no code); the Check threads run it starts carries its own judgements as usual.
- **Stored** on the run: `claude_reviews.fresh` (migration 0133; true, else NULL), served as
  `ClaudeReview.fresh` / `ClaudeReviewSummary.fresh`; the tab's run pills and the history list say
  "From scratch". There is no SPA control yet: the route takes it.
- ⚠ **The NEXT ordinary run follows up the fresh run** (the newest succeeded one), so comments
  posted from runs BEFORE the fresh one leave the follow-up chain — that is the point of starting
  over. Auto review never sets it.
- `fresh` is validated on the RAW body: only a JSON boolean (`"true"`, `1`, `null` → 400), because
  Fastify's validator coerces types.

### Replies to Limn's findings (accept, or push back once)

When someone REPLIES on the GitHub thread of one of Limn's own posted findings — whether the
thread is still open OR was resolved after the reply — the re-review judges the reply instead of
re-raising the finding blind. Other
reviewers' threads are unchanged (next section). Code: `claude-review/finding-replies.ts` (loader +
which replies count), `follow-up.ts` (`judgeReplyReport`, the gate), `auto-resolve.ts` +
`auto-pushback.ts` (the GitHub writes).

- **Which replies.** The finding's thread is found through its first INLINE-posted ancestor along
  `prior_finding_id` (`loadThreadOwners`, shared with auto resolve) and the ONE matcher
  (`finding-thread.ts`). Every comment after the root counts when it has text and its author is a
  known login that is NOT automation (`users.is_bot`, `github_type='Bot'`, the login seeds). A
  Limn-posted reply (the account's login AND the `<!-- pierre:claude-review` marker — a "Post reply"
  from the tab or an earlier auto reply) is KEPT as context, marker stripped and labelled "posted
  from Limn", so the conversation reads whole; only the OTHER replies can be judged
  (`judgeableReplies`, which gates both statuses and picks the quoted reply). The reader's OWN
  unmarked replies count. The last 5, each clipped to 1,500 characters, ride INSIDE that finding's
  nonce fence as data (and in the collision scan). A read failure costs the replies only.
  ⚠ An automatic pushback SKIPS a RESOLVED thread (nothing claimed); a manual "Post reply" may still
  post there.
- ⚠ **A RESOLVED thread with a reply is judged, not settled on sight** (it used to be — § Follow-up,
  SETTLED BY A REPLY). `PriorFindingForFollowUp.thread` carries `isResolved` + `resolvedBy`
  (`review_threads.resolved_by_login`, null when not synced); the finding's fence says "The thread was
  resolved on GitHub by @who." (or without the name), and the prompt says resolving alone does not
  settle it. ⚠ **COST: such a finding goes LAST in `selectPriorFindings`** (after every open one, own
  then carried; `isResolvedWithReplies`), so its replies (up to 5 × 1,500 characters) never crowd an
  open finding out of the 40-item / 24k cap; one that does not fit is `not_checked` and carried like
  any other. ⚠ **The same-head lock never decides one nobody has judged** (`lockFor`, follow-up.ts):
  unreported, an un-judged resolved-with-reply finding is `not_checked` (carried, not raised again,
  not counted) rather than the lock's `not_addressed`, which would count it in the verdict without
  anyone reading the reply; a reported code status is still overruled by the lock, and a carried one
  with an earlier judgement locks as before. Outcomes: `reply_accepted` ⇒ settled from then on (no reply is posted: auto resolve skips
  a resolved thread, and "Reply and resolve" is not offered); `reply_disputed` ⇒ OPEN like any
  pushback — raised again, carried, counted in the auto verdict at its severity, an AI Fix `P` item —
  and the row wears **"Resolved on GitHub"** beside "Pushed back"; NO automatic pushback, a manual
  "Post reply" still posts.
- **Two statuses, only on an item that had replies**: `reply_accepted` (+ `acceptKind`
  `not_valid` — the reply shows the finding was wrong — or `deferred` — a reasonable promise to fix
  it later, a follow-up PR or a ticket — and a one-sentence acknowledgement) and `reply_disputed`
  (+ a short, specific pushback). The prompt says a deferral is reasonable only for a non-critical
  issue, never for a real bug, security or data-loss problem.
- ⚠ **THE GATE IS IN CODE** (`judgeReplyReport`): a reply status on an item with no replies, or an
  acceptance with no valid kind, is treated as unreported (`not_checked`, or the same-head lock); a
  `deferred` acceptance of a BLOCKER becomes `reply_disputed` with a templated pushback
  (`deferralRefused: true`); `not_valid` is accepted at any severity; empty text gets a templated
  one (≤ 600 chars). A reply status MAY override the same-head lock — a reply is new evidence even
  when the code has not moved. A carried `reply_disputed` locks as `not_addressed`.
- **Accepted ⇒ settled from then on** — the ONLY rule feeding `loadSettledByReplyFindings`
  (`acceptedReplyFindings`, over every earlier succeeded run's `follow_up`): out of later
  follow-ups, listed under "Settled in an earlier review" ("Accepted: …") in the prompt and in the
  tab's closed group (`settledEarlier`, who replied + excerpt + how), and a re-raise is
  dropped in code — in the same run too (`dropAcceptedReraises`: its `priorRef`, or same path +
  similar title). ⚠ A NEW reply or new commits do NOT unsettle it (kept simple: the author was told
  it was accepted).
- **Disputed stays OPEN** exactly like `not_addressed`: raised again (synthesized lead "the reply on
  GitHub did not settle it"), carried, counted in the auto verdict at its severity (a disputed
  blocker ⇒ `REQUEST_CHANGES`), and an AI Fix `P` seed item.
- **GitHub writes — AUTO runs only**, same claim-before-write / never-retry / footer + marker rules:
  accepted + `autoResolve` on ⇒ auto resolve posts the acknowledgement, then resolves (outcome
  `reply_accepted` + `acceptKind`; an already-resolved thread is a no-op). Disputed + auto-posting on
  ⇒ `auto-pushback.ts` posts ONE reply (footer + `PUSHBACK_REPLY_MARKER`), never resolves, recorded
  on the owner row's `claude_review_findings.pushback` (`FindingPushbackRecord`, migration `0092`). ⚠ **AT MOST ONE PUSHBACK PER THREAD, EVER**: the record is claimed from NULL, and a
  pushback marker already on the thread (posted by hand) blocks it too. A later run may still accept.
- **Manual runs (or the switches off)** post nothing: the "Previous review" row shows the reply's
  author + excerpt and the text as a draft, with "Post reply" ("Reply and resolve" for an accepted
  one; plus "Resolve" through the ordinary `/resolve` route). ⚠ **"Post reply" goes through ITS OWN
  ROUTE, `POST /api/claude-reviews/:reviewId/follow-up/:priorFindingId/reply`
  (`manual-reply.ts`, `github_write` tier), never the plain thread-reply route** — it builds the
  body (text + Limn's marker, the pushback one for a pushback; no auto footer) and CLAIMS the same
  owner-row record the auto run claims (`pushback`, or `auto_resolve` with `manual: true`) BEFORE
  writing, under a synchronous in-process slot. So a second click, a remount, a later run
  disputing the same thread, or an auto run racing it can never post twice: whoever claims first
  writes, the other gets a 409 (the auto run skips). An accepted reply is answered AND resolved.
- ⚠ **An unclear failure is never offered again.** Every writer stores `refused: true` only when
  GitHub CLEARLY turned the reply down (a GraphQL error answer, or a 4xx other than 401/429 —
  `isClearReplyRefusal`); a 5xx / network error may have posted, so the row says "Couldn't confirm
  the reply posted" and offers nothing. Only a clearly refused record may be re-claimed, and only
  by hand. The prompt's "already pushed back" line uses the same rule (`pushbackMayBePosted`).
- The row reads the thread OWNER's record, which an earlier run may have written: a record whose
  `byReviewId` is another review says "Limn already pushed back / replied on this thread earlier"
  and hides this run's (never posted) text. The wire carries `threadId` / `threadFindingId` on the
  item (stored at run time) and, derived on read, `threadResolved`, `autoResolve`, `pushback`.
- Open PRs cards: "Earlier: N fixed · N settled · N still open" — accepted is settled, disputed is
  open.

## Other reviewers' threads (people and review bots)

Every run that reads code (diff-only or deep) also judges **every review thread on the PR —
RESOLVED ones too (2026-10-18) — that is not rooted on one of Limn's own posted findings** — comments from people and from other
review bots (CodeRabbit, Copilot, …). Limn's own posted findings stay in the follow-up above. After
a run the reader has the PR against the user stories, Claude's findings, the follow-up AND every
other open comment, so "Generate fix from this review" can produce one fix for all of it.

- **Loader (CORE, DB-only):** `db/review-threads-for-review.ts` `loadReviewThreadsForReview`,
  reached as `ctx.queries.loadReviewThreads` (absent ⇒ no thread block). Resolved threads are
  loaded too (`isResolved`) — resolving is a click, not evidence — and sent AFTER every unresolved
  one inside the same cap. ⚠ `newestCommentAt` (the auto re-review key) still counts UNRESOLVED
  threads only, and AI Fix's seed threads (`thread-candidates.ts`) filter resolved ones out. Per
  thread: path, line,
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
  explanation, reason, draftReply?}]` — `reason` is ONE line, at most `THREAD_REASON_CHARS` (120),
  REQUIRED and `max`-capped by the tool schema (the ONE `buildThreadReportItem`, review/schema.ts,
  shared with Check threads), whitespace-collapsed and clipped again on reconcile; older stored
  rows read it as null. Each thread says `Resolved on GitHub: yes|no`. Validity `valid | partly_valid | not_valid | unclear`, addressed
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
- **Stored** on `claude_reviews.thread_assessments` (migration `0076`, nullable JSON, no
  backfill) and served verbatim as `ClaudeReview.threadAssessments` (`ClaudeThreadAssessment[]`;
  **null = the run did not assess threads** — an older row, a skip, a failed run — never `[]`), plus
  `ClaudeReview.threadAssessmentCounts` folded server-side by shared `threadAssessmentCounts`. The
  "still needs a fix" rule is ONE shared function, `isThreadToFix` (valid / partly valid AND not /
  partly addressed AND NOT resolved — `resolved` is stored on the assessment; absent = an older,
  unresolved-only row). `draftReply` is a suggestion only; nothing posts it.
- **The old plugin's Haiku per-thread annotations are REMOVED (2026-10-18)** (validity / addressed / simplify,
  the "Check review" button). This review's thread judgements are the ONE AI judgement of a thread;
  the BotTriageCard's "real issues" count reads them too.
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

### Check threads — a light, threads-only pass (2026-10-18)

`review/claude-review/thread-check.ts` (+ `-agent`, `-persist`, `-routes`). Registered by
`registerAgenticRoutes`. Wire: [API.md](API.md) § Check threads.

- **WHAT IT JUDGES: only the threads that CHANGED since their last judgement** — never judged, a
  comment newer than the judgement, a resolve or unresolve since, or new commits (judged at another
  head). "Changed" is exactly what `planThreadReview` SENDS against THE ONE FOLD
  (`currentThreadAssessmentsForPrs`, below), so a check and a same-head review agree on what is new.
  Nothing changed ⇒ refused `nothing_changed` ("Every thread already has a current judgement."),
  no thread ⇒ `no_threads`, and ⚠ only threads rooted on Claude's OWN posted findings ⇒
  `own_findings_only` (the loader's `ownThreadCount`; those are the follow-up's, never a check's) —
  no model (a click's refusal is only answered; an AUTO one is stored, so it covers the burst).
  `refusalFor` is the ONE rule. A thread with NO usable judgement — never judged, `not_checked`,
  judged at another head, or an old unresolved-only judgement of a thread resolved since — is always
  SENT (pinned in `thread-check.test.ts`).
- **A MANUAL review routed `skip`** (no textual change, so no thread block) starts a manual check in
  its place (`startThreadCheckBesideManualReview`, from `manager.ts`): every manual run gets its
  threads judged. Diff-only and deep runs judge them themselves. Auto runs unchanged
  (`manual-skip-threads.test.ts`).
- **THE RUN:** Sonnet 5; Read/Glob/Grep in the PR's read-only worktree behind the PATH GUARD (the
  diff alone when no checkout can be made); `Bash`, the write/web tools and the dispatch tools
  DENIED; connectors isolated; ONE tool `submit_threads` whose item is the review's. The prompt is
  `pushReviewThreadsSection` (nonce-fenced) + the fenced title. Reconcile is the review's
  (`reconcileThreads`: never invents "addressed", locks `addressed` at the same head). Caps:
  `THREAD_CHECK_BUDGET_USD` ($1), `THREAD_CHECK_MAX_TURNS` (20), auto `THREAD_CHECK_DAILY_CAP` (30
  per workspace per UTC day; clicks never count). One run per PR (claimed synchronously), the ONE
  shared `REVIEW_CONCURRENCY` slot (`registerReviewSlotPeer`; a PR-review click goes first).
- **STORED** in `claude_thread_checks` (migration `0122`): one row per run, the WHOLE
  reconciled set (changed + carried) in `thread_assessments`, `comments_through` = the newest
  qualifying comment it covered. Composite FK onto `pull_requests (id, account_id)` (cascade, like
  `ci_reviews`); erased; in `accountScopedTables()`; checked by `verify:isolation`.
- ⚠ **THE ONE FOLD** — `currentThreadAssessmentsForPrs` (thread-judgements.ts): the latest
  succeeded non-skip review's `thread_assessments`, with the newest succeeded check that finished
  AFTER it folded over it per thread (newer wins). Readers: the thread cards
  (`getThreadJudgements`), the Claude Review tab (`currentThreadAssessments` on
  `GET /api/prs/:id/claude-review`), the next REVIEW's carry (`manager.ts`, `beforeReviewId`), the
  next check's plan, and AI Fix's seed when the named review is the latest. Never read
  `review.threadAssessments` for "what Claude says now".
- **AUTO** (when the workspace's auto review is on): a SAME-HEAD comment burst — the code has not
  moved — now starts a CHECK, not a full re-review (`commentBurstRoute`, auto.ts), under the same
  settle rule. ⚠ ONE exception keeps the full review: a reply on one of Limn's OWN posted findings
  newer than what the reviews at this head saw (`newestOwnThreadCommentAt` vs the candidate's
  `coveredMs`) — finding replies and the one pushback live in the review. A check row at the head
  whose `comments_through` reaches the burst covers it (any status, one attempt per burst). A moved
  head still gets a full review.

### The judgement on the thread cards

Wherever a thread wears a state pill — the Changes tab's Threads only view and every `ThreadCard` (Feed, Pending
expansions), the Timeline marker popover, the inline thread in the Changes diff — the LATEST judged
run's verdict REPLACES the derived-state pill AND the "Likely addressed" confidence marker with ONE
`--ai-*` marker: "Claude: addressed" / "partly addressed" / "not addressed" / "not valid" / "unsure"
(`not_valid` wins over any addressed answer). The ONE rule is `threadPillFor`
(`lib/claudeThreadMarker.ts`, pinned by `apps/frontend/test/claudeThreadMarker.test.ts`); the ONE
component is `ThreadStatePill` (`ThreadView/ClaudeThreadBadge.tsx`). ⚠ A RESOLVED thread keeps
"Resolved"; a thread the run did not judge (both halves `not_checked`, or absent), no judged run, or
judgements still loading keep the old pills — a missing judgement never makes a claim. ⚠ A judgement
whose `assessedAtHead` is not the PR's synced head is still shown, marked "earlier commit"; an
unknown synced head is never "moved". The run, commit and reason sit behind the ⓘ. ⚠ The data is ONE
batched `POST /api/claude-review/thread-judgements` per screen (`hooks/useClaudeThreadJudgements.ts`,
microtask-batched like reactions), keyed under `['claude-review', prId]` so a run finishing refreshes
it with the review's own invalidations — never a per-card fetch. "Latest" is the newest succeeded,
non-skip run with `thread_assessments`, with any later Check threads run folded over it (THE ONE
FOLD above; the response adds `checkId`, and `reviewId` is null for a check-only PR); a run in
flight, failed or skipped leaves the previous judgements standing. Each judgement now carries
`reason` (one line) and `resolved`; the SPA's two pills (validity + state) read them. The removed Haiku "addressed" check panel was an explicit, separate output and is
NOT replaced. ⚠ **The Threads only view's State chips count and filter what the CARDS show**
(`threadStateBucket` / `threadStateBucketCounts`, same module): a thread wearing a Claude marker sits
under its own "Claude judged" chip (shown only when one exists), never under the derived state its
card no longer displays — a "Likely addressed" chip listing cards that read "Claude: not addressed"
contradicted itself. The file-group and Changes-tab count chips (`rollupCounts`) still count the
derived states.
- ⚠ **CLAUDE'S OWN FINDINGS ON THEIR THREADS (2026-10-19).** A thread rooted on one of Limn's posted
  findings is never a thread judgement, so its card used to show only "Resolved" — nothing of what
  the later reviews found. `getThreadJudgements` now adds, per such thread, the NEWEST succeeded
  review's follow-up item naming it (`item.threadId`; `not_checked` skipped, so an older word is not
  hidden) as a judgement with `finding: {status, acceptKind, replyAuthor, reviewId}`
  (`findingJudgementsFromFollowUps`); `validity`/`addressed` MIRROR it (`findingMirror`) for readers
  that know only those. A settled finding leaves later follow-ups, so the newest item IS its last
  word — it may come from an older review than the latest. The card wears ONE outcome pill
  (Addressed · Partly addressed · Not addressed · No longer applies · Reply accepted · Fix later ·
  Pushed back, `claudeFindingPill`) plus "Resolved" when GitHub says so, a templated reason line and
  Claude's explanation under More. A PR whose reviews only followed up findings is listed too.

## CI review (why checks failed — its own process)

⚠ **THE PR REVIEW NO LONGER DIAGNOSES CI.** The split (2026-10) made the CI review its own Claude
process (`src/review/ci-review/`), modelled on the ticket review: own tables, own claim, own lane,
own cap, own budget. New PR-review runs read no logs, carry no "CI failures" prompt section, and
`submit_review` has no `ciFailures` field (a stray one is stripped). `claude_reviews.ci_failures`
(migration `0077`) stays as READ-ONLY history: the SPA shows an old run's diagnosis only
when the PR has no CI review. ⚠ The SPA shows a CI diagnosis (either kind) ONLY for the PR's
CURRENT head — an earlier commit's is hidden whether the head is green or red
(`ciRunAtCurrentHead`, docs/FRONTEND.md). Wire contract: [API.md](API.md) § CI review.

- **Keyed per (PR, head commit, sorted failing check names).** `ci_reviews` (one row per run,
  history kept) + `ci_review_items` (one row per failing check), migration `0082`. Two keys
  per run (`currency.ts`): `failing_key` = sha256 of the names the run READ live; `trigger_key` = the
  SYNCED names that started an automatic run. Currency and "is it due?" accept EITHER, so a lagging
  sync never re-runs the same failures nor reads a fresh run as stale. `job_id` is a 64-bit SQLite
  integer (Actions job ids are past 2^31). Ownership is structural: composite FKs `(pr_id, account_id)` →
  `pull_requests` and `(ci_review_id, account_id)` → `ci_reviews`; both delete paths call
  `db/ci-review-prune.ts`; erasure + `accountScopedTables()` + `verify:isolation` cover both tables.
- **Reads (CORE, server-side, `AgentContext.ci`, all never-throw)** — `prepare.ts`
  `readCiInputs`: `readCommitChecks` (`github/commit-checks.ts`, ONE GraphQL read of the head's checks
  **by commit oid**, mapped through the ONE `checkRunsFrom`), then, only for failing Actions jobs,
  `readJobLog` with `full` (the WHOLE log, `tail: 0`, up to `MAX_LOG_BYTES` 8 MiB, read from the end
  when longer — the viewer still reads its 128 KiB tail page) and `readFailedStep` (GitHub's own
  first failed step). ⚠ The signed log blob URL never leaves `actions-logs.ts`: only excerpt TEXT
  enters the prompt, and only the check's details page (`CheckRun.url`) is stored. All three respect
  the account's rate budget (`isLimited` / `noteLimited`).
- **Refusals — no model runs, stored as `failed` + `refused`** (with the keys, so the sweeper does
  not try the same inputs again): `no_failures` (a re-run passed), `no_logs` (every failing check is
  outside GitHub Actions), `logs_unavailable` (no failing job's log could be read),
  `checks_unreadable`, `head_unreadable` (the checkout failed). A THROWN run clears both keys and
  stays retryable; a restart orphan likewise. ⚠ A `no_failures` refusal judged nothing, so it keeps
  NO `trigger_key` (a check re-running at the live read fails again under the same name and must
  still be explained); `ciReviewDue` holds it only until the sync observes the failure AFTER the
  refusal finished, and the state stops saying "nothing is failing" at that point too. ⚠ A run whose
  PR head moved between queue and start drops its `trigger_key` (it was the OLD head's synced set).
- **The log PRE-SCAN and caps** (the ONE implementation, `claude-review/ci-failures.ts`
  `extractFailureExcerpt`): at most `CI_FAILURES_MAX` = 6 jobs read per run. The whole read log is
  scanned for CULPRIT lines in three classes (`culpritClass`, case-insensitive): SPECIFIC (`npm ERR!`,
  `error TS…`, `…Error:`, Traceback, `panicked at`, `found N vulnerabilities`, `Severity:
  high|critical`, a leading `FAIL`, ✕/✗, `not ok`, a non-exit-code `##[error]`), GENERIC (the words
  error / failed / assert / panic / fatal / critical / vulnerab / `exit code N` — as WORDS, never
  inside a path or name like `error-ex`) and WARNING. A "0 failed" / "found 0 vulnerabilities" line
  is no culprit; a line repeated verbatim is anchored once. The excerpt = the last 30 lines + the
  PRIMARY culprit (the first specific, else generic) with 8 before / 20 after and its step's
  `##[group]` header, then a 3-before / 6-after window on every other culprit — specific, generic,
  then warnings, each in log order — while the budget holds (overlaps merge; a window that does not
  fit is skipped). So an npm audit failure isolates its package and advisory from the middle of a long
  install log (fixtures: `claude-review/__fixtures__/ci-logs/`). Timestamps and ANSI stripped, each
  line ≤ 400 chars, ≤ 8,000 chars per check and ≤ 32,000 for the block.
- **The run** (`manager.ts`, `agent.ts`): a read-only worktree of the PR head (`prepareMemberWorktrees`,
  the path guard confines Read/Glob/Grep to it and the scratch cwd), the noise-stripped diff capped at
  `CI_REVIEW_DIFF_CHARS` (60,000), and one `---BEGIN CI FAILURE Fn <nonce>---` fence per failure
  carrying the check name (set by the PR's workflow file), the failed step and the excerpt — the
  title, diff, file names, names, steps and excerpts all in the nonce-collision scan. ⚠ **Bash is
  denied** outright (`ciToolPolicy`: the PR review's `DISALLOWED_TOOLS` + the dispatch tools). Its own
  `CI_REVIEW_BUDGET_USD` (default $2) and `CI_REVIEW_MAX_TURNS` (25), env only; the model is the
  default review model. The model calls `submit_ci_review` once with `{ summary, failures: [{ref,
  cause, explanation, category, fixableInPr, confidence, step?, path?, line?, suggestion?,
  relatedFiles?}] }`. `confidence` (0-100, "above 50 only when the log lines you cite show it") is
  rounded and clamped by `confidenceOf` and stored on `ci_review_items.confidence`; the CI check
  section prints it beside the check name; a carried item keeps its own.
- **Reconcile — NEVER INVENT A CAUSE** (`reconcile.ts` over `reconcileCiFailures`): every failing
  check gets exactly ONE item — `diagnosed`, or `not_checked` with a server reason (`not_reported`,
  `log_unavailable`, `over_cap`, `no_log`). Unknown refs and malformed entries dropped, the first
  VALID report per ref wins (the same test both folds apply). `path` is repository-relative or nothing
  (absolute, `..` and URLs refused; falls back to the first safe related file); a `not_checked` item
  carries no path, line or suggestion.
- **Carry-forward (automatic runs only):** an item explained at THIS head for the SAME job id by the
  previous succeeded run is copied with its path and suggestion — no log read, not re-sent. A set
  that GREW therefore costs one read and one diagnosis; with nothing new to read the run saves with
  NO model (`numTurns: 0`, the earlier summary). A click ("Check CI" / "Re-check") carries nothing.
- **Concurrency.** Claim `${accountId}:${prId}` taken SYNCHRONOUSLY; one FIFO lane (a click ahead of
  every automatic item; 20 automatic / 50 manual waiting at most); the ONE shared
  `REVIEW_CONCURRENCY` slot with PR and ticket reviews (`registerReviewSlotPeer` now takes any
  number of peers; `pumpReviewLane` pumps them all). A run in flight is never cancelled by a push.
- **The sweeper** (`sweep.ts`, a `* * * * *` pull, only where auto review can run): open, non-draft,
  RED PRs a PERSON opened (the global automation set) in auto-enabled workspaces; the failing set is
  the newest `ci_status_events` row AT the synced head. ⚠ **NO SETTLE AND NO CI HOLD** — a failing
  check is final, so a run is queued on the first tick that sees it; a set that grows later is a new
  key. The onboarding floor: only a failure OBSERVED at or after the workspace switched auto review
  on. Its own `CI_REVIEW_DAILY_CAP` (default 20) automatic runs per workspace per UTC day, counted
  from rows (written when QUEUED); manual runs and server REFUSALS (no model ran) never count.
- **Beside a manual review (2026-10-19)** (`with-review.ts` `startCiReviewBesideManualReview`, called
  by `POST /api/prs/:id/claude-review` after a successful MANUAL start — the tab's Run and the Open
  PRs Review button): when the synced rollup is red and `ciReviewDue` holds for the current head's
  failing set, the CI review starts through `startCiReview` as a click (`trigger: 'manual'`,
  `triggerKey` = the synced set, so the next click and the sweeper see it as taken). Every
  workspace, auto review on or off. ⚠ Still its own process: the PR review prompt reads no logs.
  "No Actions log" is the run's own stored `no_logs` refusal (no model). Awaited (DB reads only; never
  throws), so the SPA's refetch after the start already shows the CI section's existing status.
  Auto runs never come here. Pinned in `persist-db.test.ts`.
- **Currency** (`deriveCiReviewState`, DB-only — the synced head and failing names): `current`,
  `stale` (`pushed` | `checks_changed` | `now_passing`), `running`, `none`; plus `refused` when the
  newest attempt AT THE CURRENT HEAD refused. Served per PR and batched (`POST
  /api/ci-reviews/states`, one request per board — nothing fetches per card).
- **CI auto-posting** (`ci-review/auto-post.ts`, called by `manager.ts` when an AUTOMATIC CI run
  ends; it reads the status itself, never throws, never retries): only when the workspace's
  auto-posting is ON and its `ciFailures` kind on (default on); the PR passes the PR review's ONE
  `autoPostEligibility` (open, not draft, not a bot's, scope); the items are `diagnosed` with
  `confidence > 50` (null never posts), flaky/infra ones labelled "Likely flaky or an infrastructure
  problem"; ONE PR-level comment per (PR, head, `failing_key`) — an earlier run at the same head and
  key whose record is `posting`/`posted`/`partial`/`failed` makes this one `skipped` /
  `already_posted`, a changed set posts again. The live PR must be open, not draft, at the run's
  head (moved ⇒ `failed`, no post). ⚠ `ci_reviews.auto_post` is CLAIMED (CAS NULL → `posting`) BEFORE
  the write; then `posted` + `commentId`, or `failed` + the error; `settlePrAfterWrite` after a post.
  The body neutralises @-mentions and `<!--` in model/check text and ends with `AUTO_POST_FOOTER` +
  `<!-- pierre:claude-review-ci v=1 -->`, so `isLimnPostedComment` holds. The wire carries
  `CiReview.autoPost` (`CiAutoPostWire`); the CI check section says "Posted to the PR automatically."
  or "Couldn’t post automatically: …".
- **AI Fix:** the review seed's `C<n>` items are the `diagnosed` + `fixableInPr` items of the latest
  succeeded CI review AT THE PR'S CURRENT SYNCED HEAD (`getFixableCiItemsForPr`), manual and auto
  fixes alike — never the code review's legacy `ciFailures` (§ AI Fix).

## Design diagrams (how a change is built — its own process)

A SEPARATE agentic process (`src/review/diagrams/`), never inside the PR review, the ticket review or
the CI review: own table, own claim, own lane, own cap, own budget. Routes in `registerAgenticRoutes`; the SPA
gates on `me.ai`. **Sonnet 5 always** (`DIAGRAM_MODEL`); nothing on
the wire picks the model. Wire contract: [API.md](API.md) § Design diagrams. It REPLACED the Mermaid
sequence diagrams (2026-10-17): those were stack-trace detailed (12 participants, 5000px wide); a
design is the stages, layers and patterns used to deliver the change, readable without zooming. The
table, the routes' paths, the queue and the `SEQUENCE_DIAGRAM_*` env names keep "sequence diagram".

- **What a run produces — a `DesignDiagram`** (`packages/shared/src/sequence-diagrams.ts`, where
  every cap is spelled ONCE for the validator, the prompt and the renderer): `acts` (1–4 columns, the
  stages as a reader tells them, titles ≤ 24), `layers` (1–5 rows from the FIXED vocabulary
  `DESIGN_LAYERS`: `ui` UI · `api` API / route · `domain` Domain / service · `data` Data / store ·
  `external` External / integration · `tests` Tests / CI; canonical order), `cells` (≤ 14, at most
  ONE per (act, layer): a RESPONSIBILITY ≤ 40 chars, never a function name; `pattern` ≤ 24 or null;
  `change` new / changed / unchanged; `pr` 'PR1'… on story designs only; `files` ≤ 6) and `arrows`
  (≤ 8, between existing cells, labels ≤ 3 words / 24 chars). Plus a title (≤ 80) and a caption
  (≤ 2 sentences, ≤ 220). ⚠ **The layer vocabulary is PROVISIONAL** — the user is trialling it; a
  change to it bumps `DESIGN_DIAGRAM_VERSION`.
- **Two kinds.** `'pr'` — ONE design of how this PR's change is built, at its head.
  `'story'` — when the PR is on a TRACKER ticket (core tracker, STORED rows only via
  `tracker/ticket-source.ts`; a pasted `manual:` story never counts) with **more than one** open or
  merged PR, ONE design of the whole story across every participating repository — how the PRs fit
  together, each cell tagged with its PR, arrows free to cross repositories (at most
  `SEQUENCE_DIAGRAM_STORY_MAX_PRS` = 12 members, else refused `too_many_prs`; at most 3 tickets per PR).
- **The trigger** (`trigger.ts` `maybeDrawDiagramsAfterReview`): `claude-review/manager.ts` calls it
  fire-and-forget after EVERY SUCCEEDED review, manual or auto. It only QUEUES and never throws, so it
  can neither block nor fail the review. ⚠ **THE WORKSPACE SWITCH comes first**:
  `workspaces.auto_diagrams_enabled` (core `0126`, **ON by default** — only a stored false is off),
  edited in Settings → Auto Claude review as "Draw a design diagram after each review" and written
  through `GET`/`PUT /api/workspaces/:id/auto-review` as `autoReview.autoDiagramsEnabled`
  (`setWorkspaceAutoReview`, the ONE writer). Read per PR by `persist.ts` `diagramsSwitchedOnForPr`
  (through the repo's workspace membership; no membership ⇒ ON). Off ⇒ outcome `switched_off`: no
  budget read, nothing queued, nothing stored. It gates ONLY this automatic draw — the reader's own
  Draw / Redraw (`routes.ts` → `startDiagram`, `trigger: 'manual'`) still works. Skip rules (`fingerprint.ts` `diagramSkipReason`): no CODE
  (stored file list through `db/code-loc.ts`'s `isNonCodeFile` — docs/config/lockfile-only ⇒ none;
  unknown ⇒ the pipeline decides from the diff with the same classifier), a row already at this
  fingerprint (any status — a click redraws a failure), one in flight, or the daily cap
  (`SEQUENCE_DIAGRAM_DAILY_CAP`, default 30, review-started rows per ACCOUNT per UTC day that ran or
  will run the model — every row EXCEPT the server-decided free refusals `no_code`, `head_moved`,
  `unreadable`, `too_few_prs`, `too_many_prs`; ⚠ `invalid_diagram` COUNTS, it was billed; a Redraw
  never counts). A no-code change is STORED as a `refused/no_code` row (no model, no cost)
  so the pane can say why and the same head is never judged twice.
- **Fingerprints** (clock-free): PR = sha256(version, prId, headSha) — only a push redraws it;
  story = sha256(version, ident, sorted `prId:headSha:state`) — a member pushed, merged, joined or
  left. ⚠ The ticket TEXT is deliberately NOT in it (rewording does not change the design). Both fold
  `SEQUENCE_DIAGRAM_VERSION` AND `DESIGN_DIAGRAM_VERSION` — the latter's arrival made every
  Mermaid-era fingerprint stale, so every current head draws once more as a design. Bump it when the
  prompt, the validator or the vocabulary changes what a run produces.
- **Storage** `sequence_diagrams` (migrations `0115` + `0118` + `0119`): ONE row per RUN — subject =
  the PR id or the ticket ident. ⚠ A Redraw at the same fingerprint is a NEW row, never a rewrite: the
  slot (`routes.ts` `slotFor`) shows the newest SUCCEEDED row under the newest run, so the good diagram
  stays up while a redraw runs and after it fails, is cancelled or is cut off by a restart (0115's
  rewrite cleared it). "Drawn at this head?" is any row at the fingerprint. An older head's diagram
  reads "Drawn for an earlier commit". No FK on `pr_id`: both delete paths take PR rows AND every story
  row whose `members` names a deleted PR (`db/sequence-diagram-prune.ts`, run before the PRs go — it
  finds the stories through their accounts and filters the JSON in code).
  `accountScopedTables()`, erasure, `verify:isolation`. ⚠ **ONLY DESIGN-ERA ROWS ARE READ**: every run
  queued now is stamped `diagram_type = 'design'` at INSERT and a succeeded one carries the `design`
  JSON column (`0119`); the slot reads take only stamped rows, and a succeeded one only with
  a design — so a stored Mermaid row is "No design yet" and the next review (or Redraw) draws a design.
  `source` is KEPT (no column drops) and never written.
- **The slot pool.** A registered PEER of the ONE `REVIEW_CONCURRENCY` (`registerReviewSlotPeer`): a
  diagram starts only when no PR-review click waits, a review-started diagram only when the PR-review
  auto lane is empty too. Claim `${account}:${kind}:${subject}`, taken synchronously. Spend is recorded
  (`recordAiUsage`, feature `sequence_diagram`); budget `SEQUENCE_DIAGRAM_BUDGET_USD` ($1.50), turns
  `SEQUENCE_DIAGRAM_MAX_TURNS` (30). A restart fails what it orphaned.
- **The pipeline.** PR: the synced head (moved since queued ⇒ `head_moved`) → the diff (no code ⇒
  `no_code`; unreadable ⇒ `unreadable`) → a read-only worktree at the head. Story: the live members
  (changed since queued ⇒ `head_moved`) → every member's diff → a worktree per OPEN member + ONE
  default-branch checkout per repository for MERGED ones (the ticket review's approach) + the stored
  ticket text. Then the agent: Read/Glob/Grep + `submit_design` only, `Bash` and every write tool
  denied, the PreToolUse PATH GUARD over the checkouts, `ownToolsOnlyHook`. Every untrusted string
  (titles, file names, diffs, ticket text) is nonce-fenced.
- **The prompt** (`prompts.ts`) asks for the DESIGN — the stages, which layer does the work, the
  pattern, what is new vs changed; one cell = one responsibility, never a stack frame or a function
  list; fewer cells preferred, empty cells good. Story: how the PRs/repos fit together, every cell
  tagged with its PR, `files` from THAT PR's changed files.
- **Validation** (`validate.ts` `validateDesign`, run INSIDE the tool — a refusal lists EVERY problem
  with its fix, e.g. "5 acts; merge stages so there are at most 4", at most 3 attempts — and AGAIN
  before storing): every cap above; unique, well-formed ids; every cell's act and layer listed; layers
  only from the vocabulary; ONE cell per slot; every listed act and layer has a cell; ≥ 1 cell names a
  pattern; arrows between existing cells, no self-loops, no duplicates; story `pr` refs only the
  prompt's. Plain text only: control characters stripped, anything tag-like (`<x`) or a URL / scheme
  REFUSED. ⚠ `files` is FILTERED server-side, never refused — kept only when the path is in the PR's
  changed files (story: the member the cell's `pr` names, else any member, and a story cell with no
  `pr` then takes the member owning its first kept file, so a click knows which PR to open).
- **The SPA** (docs/FRONTEND.md § Design diagrams) draws it as a CSS grid (`components/DesignGrid.tsx`),
  every string as React text; a card with files opens its PR's Changes tab at that file.

## Starting from the Open PRs tab

The Open PRs cards (`OpenPrsCards`, Activity → Open PRs) carry a **Claude review** panel on every card
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

## Ticket review (one review per ticket, across its PRs)

⚠ **A PR REVIEW NO LONGER CHECKS STORIES.** The split (2026-10) made two processes: the PR review
(code, tests, threads — everything above) and the TICKET review (`src/review/ticket-review/`):
does the SET of PRs naming one ticket deliver its acceptance criteria. New PR-review runs write no
`ticket`, `ticket_assessment` or story findings; `submit_review` has no `tickets` field; the start
route strips a stale `ticket`/`tickets` key. Wire contract: [API.md](API.md) § Ticket review.

- **Keyed per TICKET, not per PR.** Ident `<provider>:<root>#<KEY>` — `jira:<apiRoot>#<KEY>` today,
  unchanged since the plugin era (members from core's stored tickets, `ticketMembers` — any workspace
  of the account on the same site; [TRACKERS.md](TRACKERS.md) § Peers) or
  `manual:<prId>:<hash>` (a pasted story: one PR, no plugin needed, never cascades). The apiRoot fold
  is shared `jiraApiRoot`, ONE copy the server and the SPA both call. Members are OPEN + MERGED PRs
  (a merged one is read at its final head); closed-unmerged drop out. Over `TICKET_REVIEW_MAX_PRS`
  (30; it was 8 before contribution cards) it REFUSES `too_many_prs` with the count, never samples.
- **Adding a ticket by link or key** (the DEFAULT story input): the Story check's paste box turns
  pasted URLs/keys into chips, previews each (`POST /api/prs/:id/tracker-ticket/resolve`, `link:
  false`), and its Check links the readable ones (`link: true`, a `'manual'` stored row — [TRACKERS.md](TRACKERS.md)
  § Adding a ticket by hand) then starts ONE ticket review PER ticket with `{prId, ident}` — never a
  combined run (`hooks/useTicketRefs.ts`). The start route's "is this PR on that ticket" check also
  accepts the ticket's stored members (`ticketMembers`), so a hand-added ticket past the
  `CLAUDE_REVIEW_MAX_TICKETS` story cap still starts. "Input manually" reveals the typed-story form
  (`manual:` idents), unchanged; with no tracker on the PR only that form shows.
- **Started by a sprint refresh** (`sprint-checks.ts`, 2026-10-20): a MANUAL press of This Sprint's
  Refresh (`POST /api/sprint-stories/refresh`, through the `startSprintTicketChecks` seam in
  `tracker/sprint/hooks.ts`, registered only from the agentic registration) starts the ticket review for
  at most `SPRINT_REFRESH_TICKET_CHECKS` (3) sprint tickets — never ghosts — that have ≥ 1 open or merged
  PR in the workspace and no CURRENT run (the server fingerprint). Skipped like the sweeper skips: queued
  / running / held, 0 or > `TICKET_REVIEW_MAX_PRS` members, no stored story, or a failed / refused attempt
  on the SAME fingerprint since the last success. Order: never checked first, then stale; newest member
  activity first within each (≤ 40 examined). Each goes through `startTicketReview(…, trigger: 'manual')`:
  a person pressed the button, so it is ahead of automatic items and NOT counted against
  `TICKET_REVIEW_DAILY_CAP`. No credential → `skipped: 'no_credential'`; the 202
  carries `ticketChecks {started, skipped}`. The cards read the latest SUCCEEDED run's verdicts from the DB
  on the graph GET (`db/sprint-ticket-checks.ts`: three batched queries; `stale` = a member PR gone /
  closed / pushed / merged since, or a new open / merged PR in the workspace — ⚠ a ticket-TEXT edit is
  NOT seen there).
- **Tables** `ticket_reviews` / `ticket_review_members` / `ticket_review_items` (migration `0080`), ownership STRUCTURAL via named composite FKs. Deleting a PR prunes its member rows and drops
  a run left with none (`db/ticket-review-prune.ts`, in BOTH delete paths).
- **Currency is a fingerprint**: sha256 of `TICKET_REVIEW_VERSION`, the story hash and the sorted
  `prId:headSha:state` of the members, recomputed from synced columns on every read
  (`deriveTicketReviewState`) — `stale` names why (`story_edited`, `pr_added`, `pr_left`,
  `pr_pushed`, `pr_merged`). Core's `tracker_tickets.changed_at` (migration `0088`; plugin `0039` before the tracker moved to core) moves only
  when the story text or membership moves (`storyOrMembershipMoved`), and feeds the sweeper.
- ⚠ **ONE STORY PER TICKET, WHOEVER ASKS** (`jiraStoryFor` → core's `ticketStory`, `tracker/peers.ts`): the
  FRESHEST stored row across every PR on the ticket (newest `fetched_at`). The run, the sweeper, the
  states route and the PR pane all hash THIS. Reading "the first member's row" gave each caller a
  different text, because the worker refreshes OPEN PRs only and a merged PR's row keeps the story it
  merged with — the PR pane then showed "story edited" for ever and every sweep re-billed a run.
- ⚠ **NO TRACKER CALL ON A VIEW.** The source (`tracker/ticket-source.ts`: `ticketsForPr`,
  `ticketStory`, `ticketMembers`) reads the STORED rows only (`resolvePrTickets(..., { storedOnly: true })`); a key the worker has not
  reached yet is simply not there until it is. That is why every ticket-review route except start
  and post sits on the `read` tier.
- **CONTRIBUTION CARDS** (`cards.ts`, table `ticket_review_pr_cards`, migration `0086`): a
  factual, VERDICT-FREE description of what ONE PR's head does — `summary`, `interfaces` (endpoint /
  field / event / config / export / schema / other, added / changed / removed — the cross-PR contract,
  the part that matters most), `criteria` it moves forward (how, files) and `looseEnds` (TODOs, stubs,
  flag-off code, against the PR's OWN aim) — plus the changed files at that head (server-written).
  One row per (account, PR, head); re-writing a head replaces it. A card is current while its head is
  the PR's synced head: a MERGED PR's head never moves, so its card holds for good; an OPEN PR's lapses
  on the next push. ⚠ **Card availability never enters the fingerprint** — how a member was read says
  nothing about whether the ticket's PRs moved.
  - **Per run** (`partitionMembers`): a member with a current card is shown AS THE CARD (fenced as
    `PRn DESCRIPTION`, labelled a model-written description to verify when in doubt, never ground
    truth — the agent judges every criterion afresh). Of the rest, the `TICKET_REVIEW_MAX_DIFFS` (4)
    most recently updated (ties by prId) are shown AS DIFFS, and `submit_ticket_review` returns one
    card per diff member in `cards` — validated server-side against exactly the diff members shown
    (`validateRunCards`: unknown refs, card members, repeats and empty cards dropped) and stored with
    `source 'story_check'`.
  - **The PRE-PASS** (`prepass.ts`): when more than 4 members lack a card (the first run on a big
    ticket), the overflow gets a card BEFORE the main run — Sonnet 5, diff-only (only
    `submit_pr_card`; Read/Glob/Grep, `Bash`, writes, web and dispatch denied; the path guard pinned to
    an empty scratch dir), nonce-fenced title/diff/criteria, diff capped at 60k chars,
    `TICKET_CARD_BUDGET_USD` ($0.40) per card, 3 at a time, `source 'prepass'` with its own `cost_usd`.
    A PR whose diff is EMPTY after the noise strip (only lock / generated files) gets a SERVER-written
    card naming those files (`noiseOnlyCard`, model `server`, no model call), so it never burns a
    fallback slot again. Its spend is ADDED TO THE RUN'S COST (one ledger entry, the run's — on success, failure, cancel,
    refusal and a thrown pipeline alike, via `job.spentUsd`). A PR whose card fails falls back to a
    capped diff while `TICKET_REVIEW_MAX_FALLBACK_DIFFS` (2) allows, else it is shown as "not read" —
    named in the prompt, never silently dropped.
  - Diffs and the pre-pass reuse `fetchPrDiff` (with its `localPrDiff` fallback), the noise strip and
    `capDiff`; the 120k shared diff budget now covers at most 4 (+2) members.
- **Checkouts.** An OPEN member gets its own read-only worktree at its head (card or diff — the agent
  may verify a card). A MERGED member gets no worktree of its own: ONE read-only checkout of its
  repository's DEFAULT BRANCH, deduplicated per repo (`prepDefaultBranchCheckouts`: fetched into a
  namespaced ref under the repo lock, never FETCH_HEAD), where its work has landed. A merged member is
  `checkedOut` when that checkout exists. Every checkout is a path-guard root and is removed in the
  pipeline's `finally`.
- **The agent** (`agent.ts`): cwd is a scratch dir holding `MEMBERS.md`; every checkout is
  an `additionalDirectories` entry behind the PreToolUse PATH GUARD (`review/path-guard.ts`); tools
  Read/Glob/Grep + `submit_ticket_review`; `Bash`, writes, web and sub-agents denied; no specialists;
  `TICKET_REVIEW_BUDGET_USD` (4) and `TICKET_REVIEW_MAX_TURNS` (40), env only. Every story field,
  member title, file list, card and diff is nonce-fenced; diffs share ONE 120k-char budget, split fairly.
  `MEMBERS.md` is server text only (repo, number, state, head, how it is shown, checkout) — ⚠ never a file name or card text: it
  sits outside the fences, and a path is chosen by whoever wrote the PR.
  It is also told the open LEGACY story findings (each member's latest PR-review run that checked a
  story) so it can say they are now met elsewhere. ⚠ While any member could not be checked out,
  `reconcile.ts` turns every `not_met` into `unclear` and makes no missing item postable — absence of
  evidence is not a verdict. Spend is recorded (`recordAiUsage`, feature `ticket_review`) on success,
  failure and cancel alike.
- **ONE concurrency pool with the PR review** (`REVIEW_CONCURRENCY`, `registerReviewSlotPeer`).
  Lane order: a PR-review click > a ticket click > a PR-review auto run > a ticket auto run; each
  side pumps the other when a run ends. The claim key `acct:ident` is taken SYNCHRONOUSLY.
- **Cascade** (`sweep.ts`, every minute, only where auto review is on): a PR that opened, pushed or
  left re-queues the tickets it is on — ONE HOP, never transitive — under the same `autoReviewDue`
  rule (first run at once; a re-run at once when no run of the ticket started or finished in the 5
  min before the change, else 5 min quiet / 20 min max; NO CI hold), keyed `acct:ident` with the
  fingerprint as the head. A change seen while the ticket's run is in flight never cancels it — it
  opens the burst then (`HELD` key), so the 5 quiet minutes count from the LAST change seen while held (each one restarts the quiet clock; the burst start, and so the 20-minute ceiling, never moves), not the run's end. Its OWN per-workspace `TICKET_REVIEW_DAILY_CAP` (20), counted from rows (an automatic run
  writes its row when queued), charged to the starting workspace. A first run needs a member opened
  after auto review was switched on, or the kick an auto PR review sends (`onAutoReviewLaunched`).
  ⚠ A ticket whose run is queued or running WAITS (stays in `watching`), never is forgotten: the
  run's fingerprint was fixed at prepare time, so a member pushed meanwhile is judged again once it
  ends — the PR snapshot has already moved on, so nothing else would bring it back. ⚠ The same when
  the lane fills mid-tick: every candidate not yet reached waits. A refused attempt, one that ended
  without an answer (budget, turns) or a cancelled one on the same fingerprint is not retried; one
  that THREW or was cut off by a restart stores no fingerprint (`retryable`, the boot reconcile), so
  it is.
- **Posted by a click, or by AUTO-POSTING when the owner PR's workspace switched it on** (§
  Auto-posting — automatic runs only, owner PR only). ⚠ **THE GAPS GO AS ONE PR-LEVEL COMMENT PER
  (run, target PR)** (`ticket-review/post-item.ts` `postStoryGapsComment`, `POST
  /api/ticket-reviews/:id/post {viewedPrId, targetPrId}`) — never one comment per item, never inline.
  An item's target is `owner_pr_id` (Claude's `expectedIn` member), else the viewed PR; the SPA shows
  ONE "Post N gaps to <PR>" button per target (`lib/ticketReview.ts` `storyGapGroups`, the server's
  own selection, so N is what goes in), and the per-item Post buttons are GONE. Pinned to the head
  the run judged (`HeadMoved` otherwise). The body (`storyGapsCommentBody`): "**BMD-7 story check**
  on abc1234: 3 gaps." then one block per gap ("**AC2 · Not met:** <criterion>", the file line when it
  belongs in that PR, the explanation), then — auto only, when that kind is on — "#### Not asked for"
  with its entries; built under 60,000 characters, what does not fit COUNTED and left unposted. ⚠
  "Never twice" stays PER ITEM: after the 201 EVERY item in the comment is stamped with the one comment
  id (the posted_* columns); a later check posts a NEW collated comment of only the gaps not yet posted
  (nothing is ever edited). A re-raised item inherits its earlier posting (`prior_item_id`); only the
  ticket's latest succeeded run may post (`Superseded`). ⚠ The in-process claim (keyed `run:targetPr`
  AND holding every item id it may post) is taken BEFORE the "already posted?" check and the run is
  re-read inside it — a check made before the claim can be answered by a request that has since posted
  and released it. The SPA says "Already posted" only for `AlreadyPosted`; `HeadMoved` / `Superseded`
  keep the button and print the reason. The body ends with the footer (auto) + the finding marker, so
  it never triggers an auto PR review.
- **AI Fix**: a MANUAL review-seeded fix includes the items this PR owns from each ticket's latest
  succeeded run (refs `S<t>-AC<n>` / `S<t>-M<n>`); an AUTO fix never does. Those items are model
  text drawn from Jira and other people's PRs, and the fixer WRITES — so it, too, runs behind the
  path guard, rooted at its worktree (`coding/agent.ts`; § AI Fix).
- **Peers in a deep PR review.** A worktree PR review may read up to
  `TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW` (4) peers on the same ticket, read-only behind the same path
  guard, to catch cross-repo breakage — it never judges the ticket or reports criteria. The same cap
  covers the related repos' companion changes (§ Related repos).

## User stories — LEGACY (runs before the ticket review split)

⚠ Everything below describes how OLDER PR-review runs checked stories. Those rows still READ as
history in the old layout; nothing below is written any more (§ Ticket review).

Optional user stories — each a title, description and acceptance criteria — that the person running
the review pastes or fills from Jira. ⚠ **A review carries up to `CLAUDE_REVIEW_MAX_TICKETS` (5)
and Claude assesses EACH ON ITS OWN**; the screen renders one section per ticket.

- **Wire.** `GenerateReviewBody.tickets: ClaudeReviewTicketInput[]` (the legacy single `ticket` is
  read only when `tickets` is absent). `checkClaudeReviewTickets` (shared) runs each through
  `checkClaudeReviewTicket`, drops all-blank entries, and refuses over the count — `400
  {error:'TicketInvalid', index, field, message}`, `index` null for the count; never truncated. A
  ticket may carry `source: 'jira' | 'manual'` and, for Jira only, `key`, `url` (http/https) and
  `fetchedAt` — provenance, dropped when malformed, never a reason to refuse. A Jira ticket's
  `description` is MARKDOWN (the tracker converts Jira's wiki markup, `jiraWikiToMarkdown`), so the
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
  (`story_index` + `story_ref`, migration `0079`; wire `ClaudeFinding.story: {index,
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
    optional) and `findingCommentBody` / `prLevelFindingBody` put it FIRST —
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
  characters (other than tab/newline) are refused (a JSON column must never carry `\u0000`).
- **Stored at QUEUE time** on `claude_reviews.ticket`, so a failed or cancelled run still prefills
  the panel for the re-run.
- **Reconcile** (`ticket.ts` `reconcileTicketAssessment`): Claude's list in its order, renumbered
  AC1..n, rows with no text or an unknown status dropped, capped at 40, text clipped to 500. If
  criteria text was sent and Claude reported none, ONE `not_checked` row carries the pasted text —
  never an invented `met`, never a silent empty list; alignment `not_checked` when Claude reported
  nothing. Gap lists ("Asked for but
  not done", "Added but not asked for") are capped at 20 and clipped. Stored on
  `claude_reviews.ticket_assessment`.
- **Fill from Jira** (core `tracker/` since 2026-10; it was plugin `jira/`, migration `0035`). When the PR carries a Jira ticket the
  existing detection found AND its workspace has a saved Jira token, `PrDetail.tickets[i]
  .canFetchDetails` is true and the EXPANDED panel shows one "Fill from KEY" button per such
  ticket. `GET /api/prs/:id/tracker-ticket?key=` answers the STORED row the tracker's worker wrote
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
  (`defaultAcCandidate`, in `packages/shared/src/claude-review.ts`, applied by the tracker's
  `deriveAc`): the workspace's field for this issue type on this Jira site, when this ticket has it; else the best STRONG name match (an exact
  "Acceptance Criteria" first — a weak "AC" / "Definition of Done" match is listed near the top but
  never preselected, because a wrong prefill is worse than a blank); strong matches carry a ★ in the
  dropdown; else blank, leaving the box untouched. The chosen field fills the box at once. ⚠ **The token that counts is the one on the workspace that OWNS the
  PR's repo**, not the workspace being viewed (`?workspace=` is only the viewer's scope): when a Jira
  ticket is detected but that workspace has no token, the panel names it ("add a Jira API token in
  Settings for the BNG workspace") instead of silently showing no button. ⚠ The route re-runs detection and refuses a key the PR does not carry,
  so the saved token can read only tickets this workspace's PRs name. Settings, token storage and
  SSRF rules: [TRACKERS.md](TRACKERS.md) and [SECURITY.md](SECURITY.md).
- **Posted only on request**, as findings (above): nothing reaches GitHub until the reader posts a
  finding or submits the review.
- **Vocabularies** (shared): criteria Met / Partly met / Not met / Can't tell from the code /
  Not checked; alignment Matches the user story / Partly matches / Doesn't match / Can't tell /
  Not checked; follow-up Addressed / Partly addressed / Not addressed / No longer applies /
  Not checked. `'not_checked'` is in no model-facing enum: only the server writes it.

## Auto review (per workspace)

Settings → Workspace → **Auto Claude review** (shown wherever `MeResponse.ai.enabled` is; **OFF until switched on**, because it spends the user's own Claude in the background). When a
workspace switches it on, Claude reviews each **human-authored, non-draft PR OPENED at
or after that moment** — once per HEAD, plus once per burst of new review comments (see re-review below) — with the same model (`DEFAULT_CLAUDE_REVIEW_MODEL`) and
per-review budget as the Review button. Storage: CORE `workspaces.auto_review_enabled` +
`auto_review_enabled_at` (core `0074`; it lived on the plugin's
`pro_workspace_settings` (plugin `0036`) until Claude Review left the plugin, and plugin `0037`
copied each ON switch across once — those plugin columns are dormant). Read and written through
`GET`/`PUT /api/workspaces/:id/auto-review` (`claude-review/auto-settings.ts`, 404 for another
account's workspace; the PUT body takes `enabled`, `autoFixEnabled` and/or `autoDiagramsEnabled`
(§ Design diagrams → The trigger), at least one, a field
left out keeps its stored value); `setWorkspaceAutoReview` is the ONE writer of both switches. `enabled_at`
is re-stamped on every off → on (whole seconds, so the echo matches what SQLite stores), KEPT on a
repeated on, and cleared on off, so nothing opened while it was off is picked up. Runs carry `claude_reviews.trigger = 'auto'`
(core `0071`; `'manual'` is the default).

- **THE PIPELINE, AS ONE STATE DESCRIPTION.** Each minute the sweeper reads the candidates (first
  reviews, and re-reviews of a moved head or of new comments). A candidate is:
  1. **TRIGGERED** — a first review, a new head, or a new review-thread comment by a PERSON or a
     REVIEW bot (below);
  2. **WAITING** until `autoReviewDue` (`auto.ts`, pure) says go. A FIRST review: at once. A
     MOVED HEAD: at once ("on receipt", the next tick) when no run is in flight and none started or
     finished in the 5 min before this burst's first push was seen (`lastRunAtMs` on the candidate);
     otherwise, and always for NEW COMMENTS, `quiet ≥ 5 min OR burst ≥ 20 min`.
     *Quiet* = since the key (head, newest qualifying comment) last changed — every push or comment
     resets it (`AUTO_REREVIEW_SETTLE_MS`). *Burst* = since the FIRST trigger of this burst; a key
     change never resets it (`AUTO_REREVIEW_MAX_WAIT_MS`), and the burst ends when its run is
     QUEUED (the clocks are forgotten at enqueue — a comment landing while that run is in flight
     opens a NEW burst with its own 5-minute quiet, never inherits the old 20-minute clock) or when
     the PR stops being a candidate. ⚠ **A run in flight is NEVER cancelled**: a push made during it
     arrives as `inFlightMoved` (the candidate read), which only starts that head's clock, so once
     the run ends the head settles 5 quiet minutes after the PUSH, not after the run.
     ⚠ **NO CI HOLD** — the old "CI running and head < 30 min" wait (`AUTO_REVIEW_CI_WAIT_MS`) is
     gone, for code AND ticket reviews, and the candidate read carries no CI reading. While waiting,
     `autoReviewWaiting` says why (`comments` / `commits`; `ci` is never produced now) and the Claude
     Review header prints "…for comments to settle" / "…for pushes to settle".
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
- ⚠ **AN AUTO PR REVIEW CARRIES NO STORY** (since the ticket review split). `startAutoItem` no
  longer asks for a story (the plugin's `resolveReviewTicket` provider is gone — `registerAgenticProviders`
  left the contract when the tracker moved to core). Tickets are the ticket review's: its own sweeper re-checks them (§ Ticket review
  → Cascade), and the FIRST auto PR review of a PR kicks that sweeper (`onAutoReviewLaunched`) so the
  two start together. The ticket review reads Jira from core's STORED tickets only; a key the
  worker has not reached yet waits for it.
- ⚠ **RE-REVIEW ON NEW COMMITS.** The same candidate read returns `reReview: [{prId, headSha}]`:
  a PR of the same population (opened at/after the floor, human, open, not draft) that has a
  SUCCEEDED run (manual or auto), whose synced head matches NO run of any status (new commits or a
  rewritten history), and whose latest run is not queued/running. ONE RUN PER HEAD: any row at the
  new head settles it, and `startAutoItem` re-checks `hasReviewAtHead` before writing the row (a
  person may have reviewed it while it waited). ⚠ **DEBOUNCED IN THE SWEEPER**: a moved head must
  hold still for `AUTO_REREVIEW_SETTLE_MS` (5 min, first-seen time in memory) before it is queued,
  so a burst of pushes costs ONE run on the last head; a restart only restarts the wait. It is a
  FULL fresh review on the ordinary auto lane (same cap, slots, model); it carries the previous
  no story (stories are the ticket review's, § Ticket review), and the existing follow-up reads the
  earlier POSTED findings so they are not repeated. Switching auto review off stops it like any
  auto run. `AutoSweepResult.reQueued` counts them.
- ⚠ **RE-REVIEW ON NEW REVIEW COMMENTS.** The same read also offers a PR whose head has NOT moved
  but whose unresolved review threads gained a QUALIFYING comment — a PERSON's or a CODE-REVIEW
  bot's, never Limn's own (`isLimnPostedComment`, § Other reviewers' threads, so posting a review
  never re-triggers it) — newer than what every run at that head covered: its
  `claude_reviews.comments_through` (migration `0076`; the newest qualifying comment the run
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
- **THE COST GUARD**: a daily cap of auto runs per workspace per **UTC** day, counting
  today's auto rows plus items still waiting in the lane. The cap is SET PER WORKSPACE in Settings
  ("Up to N auto reviews a day", `workspaces.auto_review_daily_cap`, migration 0085):
  OVERRIDES ONLY — NULL is the default `AUTO_REVIEW_DAILY_CAP` = 20, folded by
  `resolveAutoReviewDailyCap` for both the wire and the sweeper's roster; the PUT bounds it 1..500.
  First reviews and re-reviews share it (one busy PR's pushes can use most of it). Past it, PRs wait for the next day.
- ⚠ **IT NEVER RUNS WHERE CLAUDE REVIEW IS OFF.** `autoReviewAvailable` = `config.aiEnabled`; under
  LIMN_AI_DISABLED neither the job nor the auto-review routes are registered.
- **Who hears about it.** ⚠ **OWNERSHIP IS PRIMARY**: an auto run raises the My Turn "Claude
  review ready" card for the account whose workspace switched it on, exactly like a manual run —
  there is NO author / requested-reviewer audience test (an earlier cut had one and dropped auto
  runs with no viewer). The ball rule still clears it (docs/BACKEND.md § the ball rule). The progress
  banner ignores auto runs (`ActiveReview.trigger`).
- **It says it was auto.** "Auto review" is printed on the Pending card's chip
  (`MyTurnCard.trigger`, `AUTO_REVIEW_LABEL` in `Activity/pendingLabels.ts`), the Slack Pending line
  (`pending-blocks.ts` — since 2026-10 the digest omits the personal tabs, so it no longer prints
  this), the Open PRs column's marker (`ClaudeReviewPrState.trigger`), and in the
  Claude Review tab's header, running row and History options
  (`ClaudeReview`/`ClaudeReviewSummary.trigger`). The Feed's Claude item is not labelled.

## The Slack "Claude Review ran" signal

When a run SUCCEEDS — manual or auto — `manager.ts`'s `launch` calls core
`emitClaudeReviewCompleted({ accountId, prId, reviewId, trigger })` (`platform/event-hooks.ts`):
fire-and-forget, after the run is stored, never thrown into the review. Failed and cancelled runs
emit nothing. The platform decides the rest: ⚠ **AUTO runs only** — a manual run (event or stored
trigger `'manual'`) never reaches Slack and is never claimed; then the workspace's `notify_reviews`
switch, a `skip`-routed run is silent, once per run: [PLATFORM.md](PLATFORM.md) § The Slack EVENT
signals. Ticket, CI and thread-check reviews do not emit.

**Nothing a MANUAL run does is posted or sent without a click.** Every automatic write re-reads the
stored run's trigger: PR auto-post, auto-resolve and auto-pushback (`review.trigger !== 'auto'`),
the CI review's auto-post (`'auto'` only), the ticket review's (`'auto'`/`'cascade'`, both sweeper
starts, never a click), the Slack review signal, and the auto fix (`maybeStartAutoFix` returns
`not_auto` for a manual review; auto-push needs `ai_fixes.trigger = 'auto'`). The SonarCloud
auto-post is called only from the manager's auto branch. Design diagrams follow a manual review
too, but post nothing.

## Auto-posting (per workspace)

Settings → Workspace → Auto Claude review → **Post Claude reviews to GitHub automatically**. OFF for
every workspace, existing and new, until someone switches it on (`workspaces.auto_post_enabled`,
NULL/false = off; `auto_post_settings` is OVERRIDES ONLY `{ scope?, kinds? }`, folded by
`resolveAutoPostSettings`; migration `0087`). Read and written through the auto-review route
(`autoPost` on `WorkspaceAutoReviewSettings` / `SetWorkspaceAutoReviewBody`; `setWorkspaceAutoReview`
is still the ONE writer). Like every agentic feature, the route and both hooks exist only
where `config.aiEnabled` registers them.

**Migration 0091 — the shared contract for the next batch** (types in `packages/shared`):
`AutoPostKinds.ciFailures` (default ON; record `ci_reviews.auto_post` = `CiAutoPostRecord`, one PR
comment per (PR, head, failing set)); `WorkspaceAutoPostSettings.autoVerdict` / `.autoResolve`
(default OFF, inside `auto_post_settings`; records `ClaudeAutoPostRecord.verdict` =
`ClaudeAutoVerdictRecord`, and per finding `claude_review_findings.auto_resolve` =
`FindingAutoResolveRecord` + `auto_resolved_at`); skip reason `'already_posted'`
(`alreadyPostedFindingIds`); `ci_review_items.confidence` (`ClaudeCiFailure.confidence`, 0-100);
`workspaces.auto_fix_settings` (`StoredAutoFixSettings` → `resolveAutoFixSettings` →
`AutoFixSettings {include, autoPush}`). `auto_fix_enabled` is OFF unless a stored true, in every
reader AND the writer. The verdict, resolve and push switches are under ⚠ the same rules as
auto-posting: claim before any GitHub write, never retried.

- **AUTO RUNS ONLY, AT ONCE.** `manager.ts` calls `maybeAutoPostReview` (`claude-review/auto-post.ts`)
  when an AUTO PR review SUCCEEDS, beside (not instead of) the auto fix; `ticket-review/manager.ts`
  calls `maybeAutoPostTicketReview` after an AUTOMATIC ticket review (`trigger` `auto` / `cascade`).
  No hold window. A run a person started is never auto-posted — it keeps the Post button (the
  Settings copy says so). The switch only matters while auto review is on, and is stored
  independently of it.
- **WHICH PRs** (`autoPostEligibility`, pure): open, not a draft, not bot-authored (the workspace's
  bot union, `isWorkspaceAutomationUser` over `hiddenBotUserIds`; an unmapped author counts as a bot),
  and under the DEFAULT scope `'mine'` the PR is the reader's own OR the reader is — or WAS — a
  requested reviewer: a `review_requests` row for the account's user, or a `requested` row in
  `review_request_events`. ⚠ The history arm is load-bearing: GitHub REMOVES a request the moment
  any review lands — our own COMMENT review included — so the outstanding row alone would make every
  re-run of an auto-posted PR ineligible. ALSO a PR the reader has reviewed or commented on (any
  synced `reviews`, `review_comments` or `pr_comments` row they wrote). ⚠ TEAM requests do not count: nothing models which teams the
  reader is in (My Turn's `reviewRequestedFromMe` is user-only too). `'all'` = every PR auto review
  covers. The LIVE PR is re-read before the claim (`deps.livePr`): merged / closed / draft there
  skips too.
- **WHICH KINDS** (`AutoPostKinds`, defaults `AUTO_POST_DEFAULT_KINDS`): blockers ON, warnings ON,
  nits OFF, questions ON → all in ONE GitHub review, questions included: `post-seam.ts` puts each on
  its line, else on its file's first change with the fallback note, else as a PR comment;
  story gaps ON (a ticket review's unmet / partly met criteria and missing pieces); "Not asked for"
  OFF. Praise never; a legacy story finding never (stories are the ticket review's).
- **THE REVIEW.** Event `'COMMENT'` unless AUTO VERDICT (below) lets a verdict through. Body = the
  summary's first plain sentence (else "N comments from Claude.") + `AUTO_POST_FOOTER` ("_Posted automatically
  by Limn’s Claude review._"); every comment ends with the same footer (`PostReviewFinding.footer`),
  then the hidden `<!-- pierre:claude-review` marker, so `isLimnPostedComment` classifies it as ours
  and an auto re-review is NOT triggered by it. It reuses `ctx.review.postReview` / `postFinding`
  (`post-seam.ts`): the same head pin, anchoring and off-diff fallback as the button.
- **AUTO VERDICT** (`autoVerdict`, OFF by default; `autoVerdictFor` + `verdictGate`, pure). Stricter
  than Claude, over the run's NON-STORY findings the reader did not ignore (`isReaderIgnoredFinding` —
  ⚠ a re-raise the server stored `included: false` because its comment is already on this commit
  still COUNTS), whatever the kind toggles say: any blocker ⇒
  REQUEST_CHANGES; APPROVE only when Claude approved AND there is no blocker and no warning; else
  COMMENT. A non-COMMENT verdict is sent only (a) off the reader's own PR (GitHub refuses
  self-approval → `own_pr`) and (b) when the reader has no STANDING verdict — read LIVE
  (`GET …/pulls/:n/reviews`, the synced table can lag; `ownStandingReview`): their latest DECISIVE
  review (APPROVED / CHANGES_REQUESTED / DISMISSED). ⚠ A COMMENTED review never supersedes one on
  GitHub, and EVERY thread reply — Limn's auto-resolve and pushback replies included — is a COMMENTED
  review, so the old "latest review of any kind" read let an automatic APPROVE out over a person's
  standing request for changes after a single reply. A latest DISMISSED stands for nothing (GitHub's
  meaning too — so a person's review the author dismissed no longer holds it). A person's standing
  verdict ⇒ `prior_review` ("…: your own review on GitHub still stands."); a failed
  read is `reviews_unreadable`, never a guess, and (c) for an APPROVE, when the workspace allows
  auto-approve at the PR's IMPACT level (`approveImpact: {high, medium, low}`, all on by default,
  overrides-only inside `auto_post_settings`; the level is the blast-radius chip's, read by
  `getPrImpactLevel` through the shared resolver + the account's config; UNKNOWN is held as HIGH; a
  failed read is unknown) — else `heldReason: 'impact'` with `impact` recorded ("Not approved: High
  impact."). The impact read comes FIRST, so a held approve costs no live review read;
  REQUEST_CHANGES is never held by it. Held ⇒ COMMENT. A sendable APPROVE / REQUEST_CHANGES
  goes out even with no new comment (body only); a held one with nothing to post is a skip. Recorded
  on `ClaudeAutoPostRecord.verdict`; the tab prints "Approved automatically." / "Not approved: …".
  ⚠ The verdict and the comments are ONE submission. A verdict GitHub REFUSES (a 4xx on the review
  POST other than 401/429 — repo policy, permissions; `isVerdictRefusal`) gets the ONE retry: the
  same review again as a COMMENT, leaving just the comments, recorded `heldReason: 'refused'` +
  `refusedError` ("Not approved: GitHub refused it, so the comments were posted on their own.").
  Safe because a refused POST created nothing (the seam posts PR-level comments only after the review
  lands). A 5xx / network / rate-limit failure is ambiguous and is NEVER retried; a refused bare
  verdict with no comments posts nothing more (`failed`).
- ⚠ **LIMN LIFTS ITS OWN AUTOMATIC BLOCK** (`loadLimnAutoBlockIds`, `LIFT_BLOCK_MESSAGE`). An
  automatic REQUEST_CHANGES is posted under the reader's account, so GitHub cannot tell it from the
  reader's own — and the gate used to hold every later APPROVE as `prior_review`, leaving a PR
  "changes requested" by Limn after Limn itself had judged the blockers fixed (PR 530, 2026-10-22). Now:
  - Limn's own block is identified EXACTLY by an earlier run's stored `auto_post.githubReviewId`
    whose `verdict.submitted` is REQUEST_CHANGES — ⚠ NEVER by the marker or body: a review the reader
    sent with the Post button carries the same marker and is THEIR judgement, never lifted.
  - While it is the reader's standing verdict: a wanted APPROVE goes out over it (GitHub supersedes
    the same user's request; `liftedBlock.how: 'superseded'`); a wanted REQUEST_CHANGES is held as
    `already_requested` ("Changes already requested by Claude’s earlier review.").
  - A run with NO blocker (`autoVerdictFor ≠ REQUEST_CHANGES`, computed whatever the auto-verdict
    switch says NOW — switching it off must not freeze a block Limn left) that does not land an
    APPROVE (held by impact, only warnings left, verdict switched off, a refused approve) DISMISSES it
    with "Claude's blocking findings are fixed." — after the run's review, inside the same claim, at
    the reviewed head, once, never retried. Success stamps the local review row `dismissed` and
    settles (`deps.settle`); a refusal (branch rules restrict dismissing) is recorded in GitHub's
    words (`dismiss_failed`). Recorded as `ClaudeAutoPostRecord.liftedBlock` (on the wire too); the
    tab prints "Lifted Claude’s earlier request for changes." / "Couldn’t lift …: <why>". A run whose
    only write is the lift (no review sent) is `posted` / `failed` by the dismissal alone.
  - ⚠ "No blocker IN THIS RUN" is not enough: every blocker BEHIND the block must be judged settled
    first. An earlier blocker this run's follow-up left `not_checked` (over the cap, unreported,
    carried — `unsettledEarlierBlockers`), or a blocker of the blocking run that never reached GitHub
    (only a posted finding is followed up, so nothing would ever judge it —
    `loadUnpostedBlockersOfBlock`), holds the lift: no dismissal, and a wanted APPROVE that would
    supersede the block is held as `already_requested`.
  - Cost: a DB pre-check (any earlier auto REQUEST_CHANGES on this PR?) gates the extra live review
    read, so an ordinary run reads nothing more.
- **AUTO RESOLVE** also answers an accepted REPLY (`reply_accepted`: the acknowledgement, then the
  resolve) and **AUTO PUSHBACK** posts one reply on a disputed one — § Replies to Limn's findings.
- **AUTO RESOLVE** (`autoResolve`, OFF by default; `claude-review/auto-resolve.ts`, called from
  `maybeAutoPostReview` after the post, whatever it did). ⚠ The ONE automatic resolve, a deliberate
  exception to bot-triage's "user-initiated only", scoped to LIMN'S OWN threads: an earlier finding
  posted INLINE whose thread root is by the account's login AND carries the marker (found by the stored
  comment id, else by path + the finding's text — a finding posted inside a review keeps no comment
  id), which THIS run's follow-up judged `addressed` / `no_longer_applies`, on an eligible PR. ⚠ The
  follow-up names the LATEST raise, and a re-raise is never posted itself, so the id is walked back
  along `prior_finding_id` (cycle-guarded) to the first inline-posted ancestor, whose row and thread
  are the ones claimed and resolved. Claim
  `claude_review_findings.auto_resolve` from NULL, reply "Addressed in abc1234." / "No longer applies
  as of abc1234." (footer + finding marker), THEN `setReviewThreadResolved` + `stampThreadResolved` +
  the PR change signal + settle. `auto_resolved_at` on success; a failure (reply or resolve) is
  recorded with GitHub's error and shown on the finding ("Couldn’t resolve automatically: …"), never
  retried. A thread not synced yet, or already resolved, records nothing.
- ⚠ **NEVER TWICE** (`selectFindingsToPost` + `alreadyOnGithub`, pure): a finding posts only when
  INCLUDED (an ignored one never does; the server's own `included: false` re-raise counts as
  `already_posted`), not already posted, and not on GitHub from ANY earlier run of
  the PR (manual or auto) — through the follow-up chain (`prior_finding_id`, walked back) or by
  fingerprint (same path, `similarTitles` — the settled-by-reply identity; it can over-match a new
  point with a similar title on the same file, which is the safe direction). An earlier run whose
  record is still `posting` (cut off by a restart) counts everything it tried as POSSIBLY POSTED,
  for good. Nothing left ⇒ `skipped` and no GitHub call: `already_posted` (+ `alreadyPostedFindingIds`,
  wire `alreadyPostedCount`) when the dedupe alone emptied it — shown as "Not posted automatically:
  all N comments are already on GitHub." — else `nothing_new`, shown nowhere.
- ⚠ **WHAT IS ALREADY ON GITHUB — ONE ANSWER FOR THE TAB, BOTH POST ROUTES AND AUTO-POSTING**
  (`claude-review/posted-state.ts`, applied inside `getClaudeReviewById`; DB-only). Measured on PR 4
  of DEFRA/bng-metric-template (2026-10-14): GitHub answered an auto post's review POST with **422
  "An internal error occurred" AND PUBLISHED THE REVIEW**, so the run read `failed`; and a re-raise
  (`prior_finding_id`) of an auto-posted nit, which auto-posting rightly skipped, showed a Post
  button. The reader posted both again by hand. Three nets now: (1) the seam reads a failed review
  POST back (`post-seam.ts` `findLandedReview`: a review at the commit with EXACTLY the sent body,
  new since the attempt — then it carries on as a 201; ⚠ the body's hidden marker carries a
  per-ATTEMPT nonce, `<!-- pierre:claude-review v=1 a=<hex> -->`, so an earlier review with the same
  body — every summary-less review was the bare marker — can never be adopted and have this attempt's
  findings stamped onto it; every marker reader matches the PREFIX), and a 422 "internal error" is never a
  verdict refusal (`isVerdictRefusal`), so it is never retried; (2) on read, an unposted finding
  whose text is on a comment of Limn's (own login + marker) made since its run started and owned by
  no posted finding is STAMPED posted — ⚠ matched on the ANCHOR too: an inline thread's current line
  must be the finding's (skipped when GitHub reports none, or the comment sat on the file's first change
  with the fallback note), a PR-level comment must name `path:line`, so the same words on another line
  ("Unused import." twice) are another finding — (auto when the comment has the footer), and a `failed` /
  `partial` record is corrected to what GitHub took (`landedAutoPosts`); (3) an unposted finding
  whose chain has a posted finding, or whose text AND anchor match an older comment of Limn's that no
  sibling in its own run owns, carries
  `ClaudeFinding.earlierPost` (derived, never stored — stamping a re-raise would hand two rows one
  thread): the SPA shows it posted and linked (`effectivePost`), single Post answers `409
  AlreadyPosted`, Post review leaves it out, auto-posting counts it `already_posted`. Pinned by
  `posted-state.test.ts` (the exact timeline) and `post-seam.test.ts`.
- **REMINDERS ARE ALLOWED, ALWAYS MARKED** (user decision 2026-10-14). A finding already on GitHub (its
  own post OR `earlierPost`) keeps its "Posted automatically · <ago>" / "Posted earlier" chip linking the
  earlier comment, and offers ONE post action: **"Post reminder"** (never the normal Post;
  `lib/autoPost.ts` `canPostReminder`, editable run only). The single route takes an explicit
  `{ reminder: true }`: WITHOUT it an already-posted finding still answers `409 AlreadyPosted` (nothing
  double-posts by accident); with it on an unposted finding → `409 NotPosted`. The reminder's comment
  opens on `**Reminder:** first raised [on 12 Oct 2026](<permalink of the earlier comment>).`
  (`posted-state.ts` `reminderLead` / `findingCommentUrl`, riding as the comment's LEAD before any story
  lead), then the finding's text, the footer when there is one and Limn's hidden marker — so
  `isLimnPostedComment` holds. It is RECORDED BESIDE the original, never instead of it:
  `claude_review_findings.reminder` (migration `0110`, `ClaudeFindingReminder`; the latest one,
  earlier reminders' comment ids kept in `earlierCommentIds`, stored only) → the tab adds "Reminder posted
  · <ago>" linking it. `posted_at` / `github_comment_id` / `earlierPost` are untouched, so the follow-up
  chain, auto resolve and pushback keep reading the original thread; ⚠ every reminder comment is CLAIMED
  in `posted-state.ts`, or it would be stamped as the next run's re-raise's "lost post" (same text, same
  line, made after that run started). Bulk "Post review" and auto-posting still skip the finding. A reply
  on the reminder's own thread is not followed up (Limn's marker keeps it out of "other reviewers'
  threads" too).
- ⚠ **THE CLAIM BEFORE ANY WRITE, AND NO RETRY.** `claude_reviews.auto_post` is written by a
  compare-and-set from NULL (`status:'posting'`, the finding ids it will try) before GitHub is
  touched, so a second call or a restart can never post the run twice. After a 201 nothing throws:
  findings are stamped through `markReviewPosted` with `posted_auto = true`
  (so the existing Post buttons read "Posted" and the manual route's `postedAt == null` filter never
  re-sends them), the record settles to `posted` / `partial` / `failed` + the FIRST error, then
  `settlePrAfterWrite` (no expectation — a comment changes no PR state). A failure is never retried:
  the Claude Review tab prints "Couldn’t post automatically: …" above the summary box and the Post
  button stays. While a run is `posting` (≤ `AUTO_POST_LOCK_MS`, 10 min, so a crash cannot lock it
  for good) both manual post routes answer `409 AutoPostInProgress`.
- **STORY GAPS** (`ticket-review/auto-post.ts`): posted ONLY on the member PR the run names as the
  owner (`owner_pr_id`, Claude's `expectedIn` — the manual button's target); NO owner ⇒ not posted.
  The owner's OWN workspace decides (switch, kind, scope) and it must pass the same PR rules. ONE
  collated comment per target PR — its gaps, then its "Not asked for" entries under their own heading
  — through `postStoryGapsComment` (`ticket-review/post-item.ts`, the manual route's own function): the
  SAME synchronous claim, the same in-claim re-read, `postedInChain` and the Superseded check, so a
  click and an auto post cannot both land; every item in it is stamped with the one comment id and a
  "Not asked for" entry records it too. Never twice across runs: the item's own / inherited
  posting (`prior_item_id`), plus any earlier run's item with the same `ticketItemMatchKey`. Only
  the ticket's LATEST succeeded run posts (`not_latest`). "Not asked for" items have no row: they post
  on the member that did them (`prId`), and their postings live on `ticket_reviews.auto_post.
  notRequested` keyed `prId|folded title`; an earlier run's entry is CARRIED onto the newer record,
  never re-posted. Story check shows "Posted automatically · 2 hours ago" and the failure line.
- **On screen.** A finding's / item's posted chip reads "Posted automatically · <time ago>"
  (`lib/autoPost.ts` `postedChipLabel`, `lib/ticketReview.ts` `postedLabel`); the Post to GitHub
  pill says "Posted automatically · …". Pinned by `claude-review/auto-post.test.ts`,
  `ticket-review/auto-post.test.ts`, `auto-settings.test.ts` and the SPA's `test/autoPost.test.ts`.
- ⚠ **Side effects worth knowing** (by design, not fixed here): the review is the reader's, so GitHub
  clears the reader's outstanding review request on that PR, and the reader's own comments count as
  the reader acting for My Turn's ball rule.

## Chat about a review

After a review **succeeds**, the reader can ask Claude about it: ONE **thread** per review
(the "Review chat" section, directly under Story check and OPEN by default), which covers every
finding. The per-finding
threads' route (`?findingId=`) still answers, for threads stored before the button was removed, but
nothing on screen opens a new one. Agentic like the rest of Claude Review. Host:
`review/chat-agent.ts`, reached as `ctx.review.chat` on the core `AgentContext`. Product:
`review/claude-review/chat.ts`. SPA: `components/ClaudeReviewChat.tsx` +
`hooks/useClaudeReviewChat.ts`. Table: `claude_review_chat_messages` (core `0073`).

- **AN AGENT THAT MIRRORS THE REVIEW'S MODE.** A worktree review's questions are answered with
  Read/Glob/Grep on a worktree checked out at the **REVIEWED** head (`review.headSha`), never the
  PR's current one; a diff-only review's are answered with **no tools**. The SDK's `tools` base set,
  `allowedTools` and the deny list all say the same thing, and **Bash is denied outright**
  (`chat-agent.test.ts` pins it). Same model as the review (a retired model falls back to the
  default), same credential ladder (`applyClaudeReviewAuth`; env mutation only under the review's
  own concurrency-1 rule AND no review in flight — `chatMayApplyAuthEnv`), its own per-turn budget
  `REVIEW_CHAT_BUDGET_USD` (default $1) and low turn caps (`REVIEW_CHAT_MAX_TURNS` 8,
  `REVIEW_CHAT_DIFF_ONLY_MAX_TURNS` 2). A plain answer is free text — no MCP tool (an "explain
  these" turn is the exception, below).
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
  `recordAiUsage({seam:'agent', feature:
  'claude_review_chat'})` for any turn that cost money — answered or not. Nothing is stored unless an
  answer came back; then the question and the answer are stored together.
- **Never carried across reviews**: a new review of the same PR starts with empty threads; an older
  review's threads stay readable when that review is picked from history.
- **SPA.** The review's thread is open by default, so its one DB read (the stored turns) runs on
  mount; Hide collapses it and nothing more is fetched while it is shut. ⚠ Every thread of a review shares ONE mutation
  key (`claudeReviewChatAskKey(reviewId)`) read through `useIsMutating`/`useMutationState`, so a tab
  switch mid-answer cannot offer a second billed POST, and the completed turn is written into the
  thread's cache in the hook-level `onSuccess`, never a `mutate()` callback. A thread reopened while
  the server is still answering polls every 4s until the answer lands. Ask EMPTIES the box at once
  and the question shows as the pending turn (read off the shared mutation's variables), with the
  shared `RegenProgressBar` easing under it while Claude answers.

### Send to chat — "explain these" (migration `0095`)

Every finding card (`FindingRow`, older story findings included) and every not-done / partly-done
story item of a ticket review (`TicketReviewParts.tsx` `ItemAction`, PR pane only) carries **Send to
chat**. It pins the item to the Review chat as a pill; Ask then sends the pins, and ONE agent run
answers with ONE CARD PER PIN (what it means, why it matters, where, what would fix it). Pure half:
`review/claude-review/chat-explain.ts`; SPA pins: `store/reviewChatPins.ts`.

- **THE CLIENT SENDS REFERENCES ONLY** — `{kind:'finding', findingId}` or `{kind:'story_item',
  ticketReviewId, itemId}` (`parsePinRefs`: ids and nothing else, duplicates collapse, more than
  `CLAUDE_REVIEW_CHAT_MAX_PINS` (10) REFUSES rather than cuts). The server reads each item's text
  itself (`resolveChatPins`): a finding must belong to THE review being chatted about; a story item
  must belong to one of the account's ticket reviews that this PR is on (a member, or the PR that
  started it). Anything else 404s before any agent call. Pins ride the GENERAL thread only.
- **STRUCTURED, VALIDATED ANSWER.** The run gets one extra in-process tool, `submit_explanations`
  (`mcp__chat__submit_explanations`; never in the `tools` base set, Bash still denied, 4 extra turns)
  and succeeds ONLY by calling it. The model answers each pin by its prompt handle `P1…Pn`;
  `validateExplanations` drops a card naming any other ref or a pin twice, keeps PIN order and
  stamps the SERVER's label (never model text). No surviving card = `502 NoAnswer`, nothing stored,
  the turn still metered. A pin with no card is said so under the cards.
- **STORED ON THE SAME ROWS.** The user row carries `pins` (refs + the server's label at ask time,
  so history reads the same after a finding or run is gone); the assistant row carries
  `explanations` AND a markdown rendering in `content`, which is what a later turn's transcript reads
  (`pairTurns` also appends the pins' labels to the question).
- **PINS LIVE IN MEMORY, PER PR** (never storage, the URL or the server until Ask). A finding pin
  also carries its review run and shows only on that run's chat (`pinsForChat`), so picking an older
  run hides — never mixes — them. The buttons render only while a Review chat is MOUNTED for the PR
  (`registerChat`), and a press opens + scrolls the chat (`focus` tick). Ask removes the sent pins at
  once; a failed send puts them back in the HOOK-level `onError` (it survives the panel closing).
- **EARLIER REVIEWS' CHATS** — a collapsed section under the thread, fetched only once opened:
  `GET /api/prs/:id/claude-review-chats` (read tier; 404 for another account's PR) returns every run
  of the PR with a general-thread chat, newest first; a select (short sha · date/time · mode) shows
  one run's turns read-only, cards included.

## AI Fix (the agentic fixer)

CORE since 2026-10 (`apps/backend/src/coding/ai-fix/`: `manager.ts`,
`routes.ts`, `review-seed.ts`, `pr-context.ts`, `prompts.ts`, `persist.ts`; the agent itself is
`coding/agent.ts`). Its table `ai_fixes` is core since migration `0074`; `trigger`,
`review_items` and `change_report` since `0078`. (The one-shot AI PR summary was removed
2026-10-18.)

- **The paths kept their historical `/api/pro/` prefix** — `GET|POST /api/pro/prs/:id/ai-fix`,
  `…/ai-fix/status`, `…/ai-fix/stream`, `…/ai-fix/cancel`, `GET /api/pro/ai-fixes/:fixId`,
  `POST /api/pro/ai-fixes/:fixId/push` — so the SPA client did not move. They register only through `registerAgenticRoutes`.
- **ONE ENTRY POINT IN THE SPA, TWO ON THE ROUTE** (`AiFixSeed`): `review` (the FIX PICKER in the
  AI Fix tab, reached also from the Claude Review tab) and `plain` (an instruction — the route still
  accepts it, the SPA no longer offers it; the tab's CI list, AI summary and text box are gone). With
  no succeeded Claude review the tab says so and offers "Open Claude Review". ⚠ The picked-comments
  basket (`comments`) and the old CI diagnosis (`ci_analysis`) were REMOVED as seeds: the route
  answers `400 SeedRemoved`, but rows stored under them still READ (`AiFixStoredSeed`) and render
  as history ("no longer offered"). Their `comment_targets` / `comment_verdicts` columns are dormant.
- **THE FIX PICKER** (`components/AiFix/FixPicker.tsx`, `GET /api/pro/prs/:id/ai-fix/preview
  ?sourceReviewId=` → `AiFixPickerPreview`, DB-only). The server lists every candidate (`buildPickerPreview`)
  with a STABLE key (`finding:<id>`, `thread:<id>`, `ci:<ciReviewItemId>`, `story:<ticketIndex>:<ref>`),
  its section, its default and its CARD (`AiFixPickerCard`: which Claude Review card draws it — a
  thread the review never judged gets a synthesized `not_checked` judgement, display only); the
  reader ticks cards; Start sends `include: <keys>` and the server
  builds the seed from exactly those (`SeedSelection`). Sections: Claude's findings (never an
  ignored one), earlier findings still open, threads Claude judged to fix, UNANSWERED threads
  (`derived_state = 'untouched'`, judged or not), CI failures, STYLE BOT threads (root author's
  role `quality_check` in the PR's workspace — the stored `workspace_reviewers` row first, then the
  login seed; `thread-candidates.ts`) and ticket gaps. Everything is ticked except style bots. A
  thread sits in ONE section: judged first, then style bot, then unanswered. ⚠ **Selection keys on
  the stable ids, never on refs** — refs are numbered AFTER selection, so a prompt reads F1, F2…
  with no holes. ⚠ **The budget is applied AFTER selection**: the preview's items come in priority
  order and `cutByBudget` names what the default selection loses; the SPA re-folds the same rule
  for the reader's ticks ("Won't fit"). An unknown key selects nothing; an empty list ⇒ `409
  NothingToFix` ("Nothing is ticked.").
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
  - `T<n>` other reviewers' threads `isThreadToFix` keeps, then (picker sections) unanswered and
    style-bot threads from the PR's open threads.
  - `S<t>-AC<n>` / `S<t>-M<n>` per user story: criteria `not_met` / `partly_met`, and `missing`
    pieces (`notRequested` is not a fix) — ⚠ ONLY those the review did NOT make a finding of (an
    older review, from before story findings). A story finding arrives as an `F` item and its `S`
    item is dropped, so each issue appears once; one the reader IGNORED is in neither. Refs keep
    their own numbering (the criterion's ref, the gap's position), so a dropped item moves no other.
  - `C<n>` the CI REVIEW's items (§ CI review) that are `diagnosed` with `fixableInPr === true`, from
    its latest succeeded run at the PR's current head — never the code review's legacy `ciFailures`.
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
- **`startReviewFix(ctx, { accountId, prId, reviewId, model, trigger, include? })`** (`manager.ts`) is THE
  entry the auto-review agent calls (`trigger: 'auto'`, `include` = the workspace's sections); the
  manual route goes through the same `startFix` — same single slot, claim, queue and worktree, and
  `trigger` is recorded on the row. Nothing is pushed until a person presses Push, except an AUTO
  fix under "Push automatically" (below).
- **AUTO FIX** (`coding/ai-fix/auto-fix.ts` `maybeStartAutoFix`, called fire-and-forget by the
  review manager after an AUTO run is saved as succeeded — a failure here never touches the
  review). ⚠ **ONLY THE READER'S OWN PR**: `pull_requests.author_id → users.github_login` equals
  `accounts.github_login` (case-insensitive); anyone else's PR gets nothing
  and records nothing. ⚠ **THE WORKSPACE SWITCH**: `workspaces.auto_fix_enabled` (core `0083`), **OFF by default** since core `0084` (which switched every existing workspace
  off; SQLite keeps 0083's DDL default of 1, so both workspace inserts write `false`), edited in
  Settings → Workspace → Auto Claude review as a second checkbox, "Auto AI Fix on your own PRs"
  (dimmed and inert while auto review is off; its value is kept), and carried on the same
  `GET`/`PUT /api/workspaces/:id/auto-review` as `autoReview.autoFixEnabled`. Read by
  `readWorkspaceAutoFixForPr` through the PR's repo membership (no membership row ⇒ the default, ON);
  OFF skips with reason **`off`** before the seed is loaded. Then the first of these that holds SKIPS it, logged and kept in memory per
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
  'auto', include})` — the same queue, slot and worktree. ⚠ **WHAT IT CARRIES** is the workspace's
  "Always include" sections (`workspaces.auto_fix_settings.include`, overrides only, resolved by
  `resolveAutoFixSettings`; default every section but style bots; never ticket items) — the same
  selection reaches the rule-6 seed and the start. ⚠ **PUSHED ONLY UNDER "PUSH AUTOMATICALLY"**
  (`auto_fix_settings.autoPush`, OFF by default): `coding/ai-fix/auto-push.ts` runs after an AUTO
  fix SUCCEEDS (off the fixer's slot) and re-checks at push time — auto + succeeded + non-empty +
  unpushed, auto fix and autoPush still on, the reader's OWN PR — then pushes through the Push
  button's own path (`push.ts` `pushFix`, target `'existing'`, never forced, HEAD_MOVED refused,
  write access re-checked, the PR settled). A failure is written to the succeeded row's `error`
  ("Automatic push failed: …", shown in the AI Fix tab) and NEVER retried; a later manual push
  clears it. Otherwise it waits for Push.
  ⚠ **LOOP SAFETY.** A pushed fix makes a new head → an auto re-review (which verifies it) → maybe
  another fix. Without Push automatically every turn needs a PERSON pressing Push (an unpushed fix
  blocks the next one); with it the bound is the cap (3 per PR per 24h) plus the auto-review daily
  cap. `already_tried` stops the push-free loop (a fix that
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
- A finished fix PUSHES AS-IS (no trunk step) and only when the reader presses Push — or, for an
  auto fix, under "Push automatically".

### Plan mode ("Plan first", manual fixes only)

A MANUAL fix may plan before it builds (2026-10-16; migration `0113`). The picker's "Plan
first" checkbox turns Start into **Make a plan** → `POST /api/pro/prs/:id/ai-fix/plan` (the SAME body
as the fix start, parsed by the same `parseStartBody`) → `manager.ts startPlan`.

- **ONE ROW, TWO STAGES.** The plan opens an `ai_fixes` row with `status = 'planned'` (a new
  `AiFixStatus` member: a plan open, no build yet) and `plan_status = 'planning'`. "Approve and
  build" moves the SAME row to `'queued'` / `'approved'` and the normal build runs on it; "Discard
  plan" ends it `'cancelled'` / `'discarded'`. `plan_status` is `planning | plan_ready | approved |
  discarded | failed`; NULL = the run never planned (every older row, every auto fix). Columns:
  `plan` (JSON `AiFixPlan`, the latest revision), `plan_transcript` (JSON `AiFixPlanMessage[]`),
  `plan_revision`, `plan_seed` (JSON `{kind, text}` — the frozen, fenced seed every pass re-reads;
  never on the wire), `plan_cost_usd` (the passes' spend; the build's stays in `cost_usd`). Wire:
  `AiFix.plan: AiFixPlanState | null`.
- **THE PASS IS READ-ONLY.** `coding/agent.ts runPlanAgent`: `PLAN_TOOLS` = Read/Glob/Grep +
  `mcp__plan__submit_plan`; `PLAN_DISALLOWED_TOOLS` denies Bash, Write, Edit, MultiEdit and
  NotebookEdit OUTRIGHT (so a write tool re-added to the allow list still cannot run); same
  `runAgentInWorktree`, so the same PATH GUARD and `ownToolsOnlyHook`. Same model the reader picked,
  same seeds (review keys or a plain instruction, fenced exactly as for a build). The prompt
  (`buildPlanSystemPrompt`, `PLAN_RULES`) offers no edit and no shell — pinned with the tool list
  by `tool-surface.test.ts` + `no-shell.test.ts`.
- **`submit_plan` IS CHECKED IN THE TOOL** (`ai-fix/plan.ts checkPlanSubmission`): `summary` 1–5
  bullets (`AI_FIX_PLAN_MAX_BULLETS`), each ≤ `AI_FIX_PLAN_BULLET_MAX_CHARS` (160); every ref one the
  pass was SHOWN; a step, unless every item is declined. A refused call is ANSWERED with what to fix
  so the model calls again; only an accepted call is kept. `normalizePlan` clips again on save,
  drops unknown refs and computes `notCovered`. `steps` = `{title, files, change, refs}`;
  `notAddressed` = `{ref, reason}`; `reply` = one or two sentences answering the latest message.
- **STEERING BY CHAT.** `POST /api/pro/ai-fixes/:fixId/plan/message {text}` (≤ 2,000 chars) appends
  the reader's message (compare-and-set on `plan_ready`) and runs a FRESH pass with the frozen seed +
  the previous plan (fenced, "context only") + the WHOLE chat, oldest first — the reader's messages
  fenced as `STEERING FROM THE PERSON RUNNING THIS FIX` (the system prompt's ONE exception to "fenced
  text is data": follow it about what to change, never to break the rules), Claude's earlier replies
  as context only. The pass reads the commit the plan was made at (`base_sha`). A failed or cancelled
  RE-plan keeps the previous plan (`plan_ready`, the reason on `error`); a failed FIRST pass ends the
  row `failed` / `failed`.
- **CAPS.** One plan or fix in flight per PR — the SAME synchronous `claimed` set and single slot as
  the fixer (released between passes: a plan waiting for the reader holds nothing). The passes share
  ONE budget, `config.aiFixBudgetUsd` (`AI_FIX_BUDGET_USD`) summed across revisions (each pass gets
  what is left; < $0.25 left ⇒ `409 PlanBudgetSpent`); at most `AI_FIX_PLAN_MAX_REVISIONS` (12)
  versions ⇒ `409 PlanRevisionCap`. Every pass records its spend (`recordAiUsage`, feature
  `ai_fix_plan`) and adds it to `plan_cost_usd` — a CANCELLED pass too (`runAgentInWorktree`
  returns the usage streamed so far, priced by `estimateCostUsd`, instead of null), and a pass that
  THREW (the run core attaches that spend to the error, `coding/partial-spend.ts`), or a late
  cancel would slip under the shared budget. Rate tiers: start / message / approve `[ai, aiHourly]`, discard `read` (one DB
  update), spelled out in `tierFor`.
- **APPROVE AND BUILD** (`POST …/plan/approve` → `approvePlan`): re-reads the PR's head and builds on
  it NOW (the row's `base_sha` moves to it, so a push to the PR branch checks against the head the
  build used), with the plan folded into `buildFixUserPrompt({ plan })` as the AGREED PLAN block
  (fenced — model-written text derived from the PR) and the SAME system prompt and `WORKTREE_RULES`.
  Refs in the change report are still validated against the shown refs (`shownRefsOf(review_items)`).
  The SPA shows "Built from your plan" with the bullets above the build's progress and its result;
  the header toast card follows from the approve.
- **⚠ AN AUTO FIX NEVER PLANS.** `startReviewFix` (the auto entry) has no plan option and
  `auto-fix.ts` never calls `startPlan`; and a person's OPEN plan (`planning` / `plan_ready`) skips
  an auto fix as `fix_in_progress`, so an auto build cannot bury it. Boot reconcile: a pass cut off by
  a restart returns a plan that has a revision to `plan_ready`, else fails the row.
- SPA: `components/AiFix/PlanPanel.tsx` (bullets, Details with steps / Will not fix / Not in the plan,
  the chat, Update plan · Approve and build · Discard plan, a progress bar + Cancel during a pass; the
  explanation is behind the ⓘ). A row with `status = 'planned'` is ALWAYS drawn by the plan panel,
  never as a build. Plan actions share ONE mutation key (`aiFixPlanMutationKey`); "Make a plan"
  shares the start's.
- **⚠ THE STREAM GAP.** The stream route ends on any snapshot that is not `running`/`queued`, and a
  plan row's PERSISTED status stays `'planned'` while a pass or an approve is being set up (GitHub
  calls). So `sendPlanMessage` and `approvePlan` set `fixIdByPr` (and `planPasses`) in the SAME tick
  as `claimed.add`, before any await — a snapshot then reads `queued` — and every bail path emits
  `done: planned` to the stream it may have opened. Client side, the tab does NOT open the stream
  while a plan POST is in flight (its refetch, reading `planning`/`queued`, opens it), and the
  banner holds a row's stream while EITHER the start key or the plan key is mutating ("Approve and
  build" notes the row before its POST).

### Merge conflicts — "Resolve with Claude"

A SEPARATE run from the fixer (`apps/backend/src/coding/ai-resolve/`), not a seed: the fixer edits
files and pushes a patch; this one answers in RESOLVER DECISIONS that the reader reviews in the
merge-conflict resolver and lands from there. It is reached from the resolver's split entry button,
from a "Resolve merge conflicts with Claude" card at the top of the AI Fix tab, and from an
OPTIONAL, default-off checkbox in the fix picker ("Also resolve merge conflicts with `<base>`"),
shown only when the PR conflicts. Ticked, both runs start; the fix and the merge are separate
results and separate commits. Same rules as every agentic run: `me.ai` + `AiRunGate`,
no shell (and here no write tools either), cost on the usage ledger as `ai_resolve`. Full contract:
[docs/MERGE-CI-TRUNK.md](MERGE-CI-TRUNK.md) § Resolve with Claude.

## Story issues (the one vocabulary)

`packages/shared/src/story-issues.ts`, pure, tested in `apps/backend/src/db/story-issues.test.ts`. THREE
issues, each SPECIFIC, folded in CODE — never a new model call — from four inputs built by ONE builder,
`db/story-issue-input.ts`: today's criteria (`extractCriteria`), the CURRENT label (§ Story labels),
the ticket's stored tracker links (`blocked_by_json`, docs/TRACKERS.md) and the stored tickets a label
names (`knownTicketsFor`, account-predicated, same tracker site):

| Issue | Raised when | Detail it carries |
|---|---|---|
| Unclear when done | no criteria (code), or a criterion not `testable` | the FIRST TWO flagged criteria (number + REASON), then "and N more"; the chip keeps "N of M criteria" |
| Blocked | a REAL blocker (`isRealStoryBlocker`): a ticket — tracker link, or a key the label reads as `depends_on` — not done (unknown status counts, reading "status unknown"), or a named DECISION nobody has made | what, who (owner), ticket key and status; links first, a named key that is linked shown once |
| Spec gaps | the label lists missing details | ≤ 3 gaps, each typed (rule, edge case, design, data, non-functional) |

- ⚠ **This sprint no longer raises the issues** (2026-10-12: the chips, findings, highlights and checks
  were "not actually useful" and left with the sprint GRAPH). They lived on in the story report's
  rates and points — REMOVED 2026-10-18, so nothing consumes them now (§ Story report).
- ⚠ **BLOCKED IS REAL BLOCKERS ONLY** (2026-10-11, the review of all 42 BNG sprint tickets: of 63
  dependency items, 13 were done tickets, 15 tickets of unknown status, 14 open and 21 had no ticket,
  mostly inputs — Figma nodes, spreadsheets, reference files). `isRealStoryBlocker` (shared) keeps an
  unfinished ticket or an open decision and drops done tickets and every other text kind with no ticket
  key. Nothing left = no Blocked issue (no chip, not counted, not in the order). The rubric is unchanged
  and the story report's linked-blocker rate does not use it.

- **"Too big" and "Scope not stated" were REMOVED** (2026-10-11): the first fired on 69 of 73 real
  stories and splitting is the BA's call, not the reader's; the second was too generic to act on. Old
  stored ids (story report points, assessment bodies, sprint checks) drop through `isStoryIssueId`,
  never render and never fail a read.
- A label is used only when CURRENT (the caller's text-hash check) AND it judged today's number of
  criteria (`usableStoryLabel`); without one only code is raised: no criteria, and open linked blockers.
- ⚠ **TWO QUESTIONS, TWO FOLDS.** "Is it blocked NOW" (`foldStoryIssues`: a blocker
  whose status category is done — a link, or a named key resolved through stored tickets — is RESOLVED:
  listed, never raised). The story report's picks are merged stories, so they carry their issues "AS
  WRITTEN" (`storyIssueMeasure` / `storyIssuesAsWritten`: any ticket or decision, `isStoryDependencyItem`,
  finished ones marked `resolved`; inputs are dropped there too).
- ⚠ **RATES over many stories (the story report's figures) are a THIRD rule,
  `storyIssueRateUnits`** (2026-10-11, after an agreement test showed story-level rates near 100%):
  "Criteria that can't be checked" = untestable CRITERIA of all criteria in the stories with a usable
  label (pooled like criteria met); "Stories with a linked blocker" = stories whose tracker links were
  read with ≥ 1 blocking link, ANY status (finished counts, or the series rises at the right edge by
  construction) — CODE only: a dependency named only in the text is not counted, two readings disagree on
  those; spec gaps = stories with a gap (HELD). A no-criteria story is counted apart (`noCriteria` /
  `noCriteriaFound`), never folded in.
- Every sentence (chip detail, bullet) is TEMPLATED (`storyIssueChipText`, `storyIssueBullet`): the
  label's short phrases sit inside them as data. Bullets show three items (two criteria), then "and N
  more": "Criterion 3: no expected result · …", "Waits on BMD-568 cookie banner (To Do) · BMD-9 (status
  unknown) · Sign-off on the copy, product owner, no ticket".

## Story report (Reports → Stories) — REMOVED 2026-10-18

The agentic story report (one Haiku 5.5 run across 10-20 code-picked stories, the narrative at the
top of Reports → Stories) is GONE: `StoryReportCard`, its hooks and client methods, the
`/api/story-reports*` routes, `src/review/story-report/`, `db/story-selection.ts`, its rate-limit tiers,
`STORY_REPORT_BUDGET_USD` / `STORY_REPORT_MAX_TURNS`, and its shared types. Reports → Stories keeps its
charts and lists (`GET /api/stories`, `db/stories.ts`). ⚠ The `story_reports` table (migration `0097`) is DORMANT — kept, never dropped, still in `accountScopedTables()` + erasure; nothing reads
or writes it (docs/DATA-MODEL.md). It had replaced the plugin's per-story notes (`pro_story_notes`,
deleted; a dev DB may still hold an orphan `pro_story_notes` table, which is harmless).

⚠ **What it leaves without a consumer** (kept, not deleted): the three story issues' folds (§ Story
issues — `foldStoryIssues`, `storyIssueRateUnits`, `storyIssuesAsWritten`, the chip/bullet text) and
`db/story-issue-input.ts`'s `buildStoryIssueInput`; and the story labels (§ Story labels), whose only
automatic trigger it was.

## Story labels (Reports → Stories)

The model half of the three story issues everywhere: Haiku 5.5 answers a FIXED rubric about each
story; code folds the answers into the issues (§ Story issues) — the story report's rates and points. Everything else is code. ⚠ The Story health charts that first used them are
DELETED (2026-10-11, "not adding anything"): no `GET /api/story-health`, no panel.

- **Where**: `src/review/story-labels/` — `prompt.ts`, `validate.ts`, `manager.ts`, `routes.ts`; the
  input (what is sent, and so which label is current) is core `db/story-label-input.ts`; the label read
  (`currentLabelRowsFor`) and the run's population are `db/story-health.ts` + `db/story-health-fold.ts`
  (names kept). Contract: `packages/shared/src/story-health.ts`. Routes: docs/API.md § The story label
  run. (This sprint no longer labels: its tickets get a BRIEF instead — § Sprint briefs.)
- **LABELLING WAS AUTOMATIC — NO BUTTON** (2026-10-11, after Story health's "Label N stories" went).
  ⚠ **Since the story report's removal (2026-10-18) NOTHING triggers it**: the route stays, no screen
  calls it, and `runStoryLabelsToEnd` has no caller but its tests. What it did: (1) a **story report
  run labelled first** — before its agent starts, the window's stories with
  criteria and no CURRENT label go through the label run (`runStoryLabelsToEnd`, which claims the
  account's label slot, waits ONCE for a run already in flight, reads its list AFTER the claim, and
  waits for its own run; picked stories first, then newest; ≤ `STORY_LABEL_RUN_CAP`, its own
  `STORY_LABEL_BUDGET_USD`). The run then re-reads the selection so the picks' issues and the rates see
  the new labels (picks never depend on labels), and the row's `costUsd` is agent + labels (each still
  recorded under its own feature). A cancel cancels the label pass too. A rubric bump therefore
  relabels on the next report, with no reader action.
- **Gating**: agentic — registered only through `registerAgenticRoutes`. With `config.aiEnabled` false no label
  is made or read; only what code knows is shown.
- **THE RUBRIC** (`STORY_RUBRIC_VERSION` 2, 2026-10-11): rubric 1's yes/no answers (`bundled`,
  `dependsOnOtherWork`, `outOfScopeStated`, `dependencyNamed`, `nonCodeWork`) were too vague to act on,
  so each answer now carries its DETAIL. Per criterion: `testable` (rubric 1's measured wording, κ
  0.67–0.85) + `reason` (≤ 80 chars, required when not testable, e.g. "no expected result"). Per story:
  `dependencies` (≤ 8, each `kind` ticket/api/design/data/environment/decision/other, `what` ≤ 80,
  `owner` ≤ 60 or null, `ticketKey` as written or null; only what the TEXT names) and `gaps` (≤ 3, each
  `type` rule/edge_case/design/data/non_functional + `text` ≤ 100, specific, never "more detail
  needed"). The new prompt has NOT yet been measured for agreement the way rubric 1 was. ⚠ ONE WORD
  CHANGED IS A NEW RUBRIC: bump `STORY_RUBRIC_VERSION` in the same commit (it is in the row's identity,
  so every story relabels and old rows stop counting — the ONE reader, `currentLabelRowsFor`, filters
  on it). The issues are folded from the answers on READ, so changing the fold needs no relabel.
- **RUBRIC 3** (`STORY_RUBRIC_VERSION` 3, 2026-10-11): every answer is ANCHORED. An untestable
  criterion also gives `rule` — one of `STORY_CRITERION_RULE_IDS` (shared `story-rules.ts`: the CLOSED
  vocabulary, each rule owned by one issue, with a templated label and one-line hover; `no_criteria` is
  code-only) — and `quote`; each dependency and gap gives `quote` (a gap about something the text never
  mentions gives null); gap types gain `error_handling` (`rule` maps to the `business_rule` rule,
  `STORY_SPEC_GAP_RULE`). ⚠ The `testable` line is still word for word rubric 1's (the agreement
  measures read it exactly as before). ⚠ **A QUOTE IS VERIFIED, NEVER TRUSTED**: `verifyStoryQuote`
  against the text SENT (whitespace-normalised, curly quotes read straight, case-sensitive then
  insensitive, ≤ `STORY_QUOTE_MAX` 120) and stored in the TICKET's spelling; a miss is stored null and
  the answer survives, unanchored — never a guessed position, never a refusal. A missing or foreign
  rule on an untestable criterion IS a refusal (`bad_rule`).
- **RUBRIC 4** (`STORY_RUBRIC_VERSION` 4, 2026-10-11): `story.references` — EVERY other ticket the text
  names (key or browse link), each `{ticketKey, relation, quote, owner}` with `relation` one of
  `depends_on` (cannot be finished until that one is), `concurrent` (built alongside — coordinate),
  `builds_on` (extends shipped work or uses an existing feature / page), `supersedes`, `out_of_scope`
  (a follow-up or sibling explicitly left out), `context` (related, see also, a destination page). One
  real story named fifteen tickets and rubric 3 made dependencies of all of them, so Blocked listed a
  ticket the text had put OUT OF SCOPE and "status not stated" for an existing page. ⚠ **ONLY
  `depends_on` CAN BLOCK** (`storyBlockers`; a tracker link still blocks whatever the text says); one
  ticket named in two roles keeps the higher one (`storyReferencesByKey`: depends_on › concurrent ›
  builds_on › supersedes › out_of_scope › context — "out of scope" + "build alongside" reads as
  coordinate). Validation: relations strict (`shape`), ≤ `STORY_LABEL_REFERENCES_MAX` 20 (`too_many`),
  a key that is not a key shape or that the SENT text never names is dropped, quotes verified like any
  other; a ticket-keyed DEPENDENCY must agree — dropped unless its key reads `depends_on`, and one no
  reference names adds that `depends_on` reference. Non-ticket dependencies (decisions, APIs, data,
  teams) stay in `dependencies`. Statuses come from `knownTicketsFor`, including the sprint read's
  referenced-ticket lookup (docs/TRACKERS.md § The sprint list read). `testable` is still rubric 1's
  wording; the examples are generic (no customer names). `maxTokens` max(4,000, 1,800 + 110 × criteria).
- **The input**: the criteria are `extractCriteria` over the criteria field, else the description's
  "Acceptance criteria" section — the SAME list `countCriteriaLines` counts (the count is defined as
  its length) — numbered, each clipped to 500 characters; the description is colour-stripped and
  clipped to 2,500. `text_hash` is sha256 of exactly that plus the provider's text rule. A story with
  no criteria is not labellable (never "0 criteria").
- **The call**: core `cheapComplete` (review/llm.ts) — one tool-less completion, `ISOLATED_MCP` +
  `ownToolsOnlyHook([])` already inside it; no new Agent SDK `query()`. Model `claude-haiku-5-5`,
  `maxTokens` max(4,000, 1,800 + 110 × criteria) (rubric 3's quotes, rubric 4's references). The ticket text sits inside a per-call NONCE fence
  (`pickReviewNonce` over every fenced string) and the prompt says it is data.
- **Validation** (`validateStoryLabels`): JSON; EXACTLY one criterion entry per numbered criterion with
  `n` = 1, 2, 3 … in order; booleans strict (`true`/`false` or exactly `"true"`/`"false"`); a reason on
  every untestable criterion (a testable one stores null); both story lists present, enums exact, list
  caps held; control characters stripped. ⚠ Text over its cap FAILS (`too_long`), never cut — the
  reader sees these phrases verbatim. Anything else FAILS — not stored, retried on the next press. Never
  repaired: a shifted criterion would point an issue at the wrong criterion. The one softening: a
  `ticketKey` that is not a ticket-key shape is stored as null and the dependency kept.
- **The run**: `POST /api/story-health/label {workspaceId}` (path kept; NO screen calls it since Story
  health went — labelling is automatic, above) labels the last 13 weeks' stories (an open or merged PR in the workspace, by created
  week, else first PR opened) with criteria and no current label, newest first, at most `STORY_LABEL_RUN_CAP` (150),
  `STORY_LABEL_CONCURRENCY` (4) calls at once. ONE run per ACCOUNT, claimed SYNCHRONOUSLY before the
  route's first await and released on every path. State is in MEMORY (`GET /api/story-health/label`
  polls it); the labels are the durable part, so a restart loses a progress bar, never a label.
  Cancel stops new calls; in-flight calls finish. A missing credential (`detectAuth`) fails the run at
  once (`stoppedBy: 'auth'`); a missing AI runtime stops it (`'runtime'`).
- **Spend**: every call is recorded (`recordAiUsage`, seam `summary`, feature `story_labels`), priced
  from tokens at Haiku's rates (the ambient path reports no dollar figure). The run stops STARTING
  calls once its recorded spend reaches `STORY_LABEL_BUDGET_USD` (default $1); at most
  CONCURRENCY − 1 small calls already in flight finish past it. Measured noise of the labels on a
  weekly rate: median 2–4 points, p90 7–12 (`STORY_LABEL_NOISE`).
- **Storage**: `story_labels` (migration `0099`; docs/DATA-MODEL.md), insert
  `ON CONFLICT DO NOTHING` on (account, ident, rubric version, text hash): the first answer stands.
- **Held rates**: a rate whose judgement has not passed an agreement test is HELD from the story
  report (`STORY_ISSUE_RATES_HELD`: Spec gaps — saturated, gap types κ 0.13–0.47); the cards still show
  it.

## Sprint assessment — REMOVED (2026-10-18)

"Check against code" (one Sonnet 5 run per ticket over default-branch checkouts, PLAN / VERIFY) was
REMOVED with the sprint drawer: `src/review/sprint-assess/`, its three routes, its rate-limit tiers, the
repo picker (`PUT /api/sprint-stories/repos`, `db/sprint-ticket-repos.ts`, `db/sprint-repo-suggest.ts`),
`SPRINT_ASSESS_*` and the SPA's `SprintAssessment` / `SprintCodeCheck` are gone. A ticket now opens in the
STORY VIEW (docs/FRONTEND.md § The story view), whose Story section shows the ticket review's result or
the sprint brief. Its tables `sprint_assessments` + `sprint_ticket_repos` are DORMANT (docs/DATA-MODEL.md;
no drop migration). Old `sprint_assess` rows in `ai_usage` stay as history.

## Sprint briefs (This Sprint)

A cheap Haiku 5.5 pass that turns every node of the sprint graph — each sprint ticket and each GHOST
(an outside ticket reached through an edge) — into a BRIEF: `{summary, oneLiner, criteria: [{n, text}],
criteriaDerived, references}`. The graph's text edges and its ghost chains come from it; the card face
shows `oneLiner` and the criteria count (plus "n of m met" from the TICKET CHECK — § Ticket review →
Started by a sprint refresh).

- **Where**: `src/review/sprint-briefs/` — `prompt.ts`, `validate.ts`, `manager.ts`, `index.ts`; the
  input and the store are core `db/sprint-briefs.ts`; the to-do list is `db/sprint-graph.ts`
  `sprintBriefTodo` (the graph's own fold). Table `sprint_briefs` (migration `0107`), one row per
  (account, workspace, ident), replaced by each new brief.
- **WHEN**: after every stored sprint read (`setAfterSprintRead`, set only by `registerAgenticRoutes`;
  it REPLACES the story-label trigger This sprint used to have — the story labels themselves are
  untouched) — `config.aiEnabled` and a credential. Never on a view. ONE pass
  per (account, workspace), claimed synchronously; a read landing mid-pass re-runs it once after.
- **WHAT**: graph nodes with no CURRENT brief — sprint first, then ghosts by depth, ≤
  `SPRINT_BRIEF_RUN_CAP` (120) per pass. ⚠ A ghost's references come from its brief, so after each round
  the pass asks the tracker side for the chain's NEXT hop (`expandGhostsAfterBriefs` → ref-status mode
  `missing`, docs/TRACKERS.md) and briefs what that stored: ≤ `SPRINT_GHOST_DEPTH_MAX` + 1 rounds,
  stopping when a round briefs nothing and stores nothing.
- **CURRENCY**: a brief counts while its `text_hash` = today's `sprintBriefInput` hash (title,
  colour-stripped description ≤ 4,000, the criteria as written — the ONE extractor, each ≤ 500 — the
  ticket's TRACKER LINKS (key, title, the tracker's phrase; never their status) and the provider's text
  rule) AND `brief_version` = `SPRINT_BRIEF_VERSION`. ⚠ `sprintBriefInput` REQUIRES `blockedByJson`: a
  caller that dropped it would hash a different input from the pass and read every brief as stale. ⚠ Changing one word of the prompt
  is a new version.
- **THE PROMPT** (`SPRINT_BRIEF_SYSTEM`): the summary (one or two sentences, ≤ 400); the **`oneLiner`**
  (version 5, 2026-10-20: one plain line ≤ `SPRINT_BRIEF_CAPS.oneLiner` 90 naming what the ticket
  delivers, no full stop, no key — the card face; column `one_liner`, migration `0123`; the bump
  re-briefs every sprint ticket and ghost ONCE, and the themes re-run only if a summary changed); the CRITERIA itemised
  in the Open PRs Story check's words ("one entry per testable requirement, whether written as bullets,
  numbered lists, Given/When/Then scenarios, tables or prose … the criterion in one short sentence", ≤
  200 each, ≤ 40) — DERIVED from the title and description when the ticket has none, and then
  `criteriaDerived` is set by the SERVER from the input, never the model; the REFERENCES are rubric 4's
  rule word for word (`STORY_REFERENCE_RULES`, exported from the story labels' prompt so the two can
  never drift), each plus a **`why`** (version 3/4): one plain sentence (≤ `SPRINT_BRIEF_CAPS.why` 160) on
  WHAT the ticket needs from / shares with the other — never a restatement of the relation ("Listed under
  Dependencies" was 3's failure, hence 4); null when the text says no more. The TRACKER LINKS are listed
  inside the fence too and come back as `links: [{ticketKey, why}]` — a reason only where the text or the
  linked title supports one, never invented from the link type. The ticket sits inside a per-call NONCE fence; the "has / has no criteria" note sits
  outside it.
- **VALIDATION** (`validateSprintBrief`): JSON with a non-empty summary, a non-empty `oneLiner` (one trailing
  full stop dropped) and both arrays; over a cap → refused, never cut; criteria renumbered 1..k, blanks dropped, a ticket WITH criteria must get ≥ 1 back;
  references through the story labels' OWN `reference` rule (relation from the vocabulary, a key the
  text never names dropped, every quote verified, (key, relation) repeats once). A `why` over the cap is
  DROPPED alone (null — never cut, never a refused brief); a link reason for a key the input did not list
  is dropped. Link reasons share `references_json`, tagged `link: true` (`SprintBriefStoredReference`, no
  migration); `sprintBriefOf` splits them into `linkReasons`. The graph's edges carry `why` (a tracker edge that wins over the text's reading of the same tie keeps its reason).
  ONE retry on a refused answer, both calls billed.
- **COST**: one `cheapComplete` per ticket (Haiku 5.5, tool-less, connectors isolated), 4 at a time,
  recorded under feature `sprint_briefs`; the pass stops STARTING calls at `SPRINT_BRIEF_BUDGET_USD`
  (env, default $1).
- **EDGES** (`db/sprint-graph-fold.ts`): a reference `depends_on` / `concurrent` / `builds_on` /
  `supersedes` draws an edge from the ticket to the named one; `out_of_scope` / `context` draw none. A blocking tracker link draws `depends_on` with `source: 'tracker'`.

## Sprint themes (This Sprint → Theme)

ONE sprint-wide Haiku 5.5 call that names 3–8 short shared THEMES for the sprint, writes each a one-to-two
sentence SUMMARY, and puts every sprint ticket in exactly one, so the Theme view can lay the sprint out by area of work rather than by epic (one
lane per theme, "Other" last; the Critical path view's count table rows too).

- **Where**: `src/review/sprint-themes/` — `prompt.ts`, `validate.ts`, `manager.ts`; the input and store
  are core `db/sprint-themes.ts`, the to-do is `db/sprint-graph.ts` `sprintThemeTodo` /
  `sprintThemeInputOf`. Table `sprint_themes` (migration `0108`): ONE row per (account,
  workspace), replaced by each pass.
- **WHEN**: right AFTER the brief pass, from the same after-read seam (`review/sprint-briefs/index.ts`;
  `config.aiEnabled`, a credential). A brief pass that answered `busy`
  starts none (the running one's caller themes after it). ⚠ It CALLS THE MODEL ONLY WHEN THE INPUT HASH
  CHANGED: the sprint tickets' keys + CURRENT brief summaries (a pending brief hashes its title in the
  summary's place, so the brief landing re-runs it) + `SPRINT_THEME_VERSION`. A read that changed nothing
  costs nothing. Fewer than `SPRINT_THEME_CAPS.minTickets` (6) sprint tickets → not themed. Ghosts never.
- **THE PROMPT** (`SPRINT_THEME_SYSTEM`): every ticket's key, title and summary inside ONE per-call nonce
  fence; 3–8 themes, each plain English ≤ 4 words with no keys or jargon, each with a SUMMARY of one or
  two short sentences: what the work involves and whether it is development work (code changes) or other
  work (design, analysis, content, testing, configuration) — no numbers, no keys, nothing about progress
  or who does it; every ticket in one theme by NUMBER. Answer shape
  `{"themes":[{"name","summary"}],"tickets":[{"key","theme"}]}`. ⚠ Changing one word is a new
  `SPRINT_THEME_VERSION` (2 since the summaries, 2026-10-19). ⚠ The model is NOT sent statuses or PRs
  (they would move the hash on every status change and re-bill the pass): PROGRESS on a theme row is
  CODE's — shared `sprintLaneSummary` (tickets by column, with / without a pull request), labelled apart
  from the model's sentence.
- **VALIDATION** (`validateSprintThemes`): JSON; names cleaned (control characters, whitespace, quotes, a
  trailing full stop), a blank or repeated name refused, over 4 words / 40 characters refused (never
  cut); a key that is not a sprint key DROPPED; a sprint key given twice with two themes → `duplicate`, a
  sprint key never given → `missing`, an unknown theme number → `shape`; unused themes dropped and what
  remains must number 3–8. ONE retry on a refused answer, both billed; a failed pass stores nothing. The
  SUMMARY never fails a pass: missing, over `SPRINT_THEME_CAPS.summaryChars` (240), or carrying ANY
  numeral (`\p{Nd}\p{No}\p{Nl}`, the D4 spelling — figures are code's, beside it) → `summary: null`.
- **COST**: one `cheapComplete` per changed sprint (tool-less, connectors isolated), recorded under
  feature `sprint_themes` — measured 2026-10-13 on workspace 1 (77 tickets): one call, 3,680 output
  tokens, US$0.0018 as recorded (the ambient-session path under-reports cached input tokens, as for the
  briefs).
- **READ**: `getSprintGraph` returns `themes` (`SprintTheme {name, summary}`; a stored row without a
  summary reads `null`, `sprintThemesOf`) and each node's `theme` only while the stored row is
  CURRENT for today's hash and version — otherwise null, and the SPA disables "Theme" with "Themes
  appear after Claude reads the sprint".

## Sprint code judgements (This Sprint → "Needs code")

A cheap batched yes/no per NOT-STARTED sprint ticket: will it most likely need code changes (work that
ends in a pull request)? It feeds the board's "Needs code" filter (docs/FRONTEND.md § This Sprint), which
keeps tickets with a pull request plus the Not started ones judged "code".

- **Where**: `src/review/sprint-code/` — `prompt.ts`, `validate.ts`, `manager.ts`; the input and store
  are core `db/sprint-code-judgements.ts`, the to-do is `db/sprint-graph.ts` `sprintCodeJudgeTodo`.
  Table `sprint_code_judgements` (migration `0132`): one row per (account, workspace, ident).
- **WHO IS ASKED**: shared `sprintCodeAsked` — a sprint ticket (never a ghost) whose bucket MEANS Not
  started and that has no pull request of ANY state. The graph fold sets `node.codeJudgement` only for
  those (`{state: 'code' | 'no_code' | 'pending' | 'off', reason}`); every other node carries `null`.
- **WHEN**: step 3 of the AFTER-READ CHAIN (`review/sprint-briefs/index.ts`: briefs → themes → needs code
  → paths), never on a view. ⚠ It CALLS THE MODEL ONLY FOR A TICKET WHOSE TEXT CHANGED: a row is current
  while its `text_hash` (title, issue type, description clipped to 1,500 characters, ≤ 12 criteria) and
  `judge_version` (`SPRINT_CODE_JUDGE_VERSION`) match. A status move or a new assignee costs nothing.
- **BUDGET**: an AUTOMATIC run asks `automaticRunAllowed` itself (besides the chain's own gate — it may
  run long after the chain began) and is SKIPPED (`over_budget`), never queued; after the reader's Refresh
  (`manual`) it is never refused.
- **THE CALL**: ≤ `SPRINT_CODE_JUDGE_BATCH` (12) tickets per `cheapComplete` on the ACTIVE provider (the
  brief model), ≤ `SPRINT_CODE_JUDGE_RUN_CAP` (60) per pass; each ticket inside ONE per-call nonce fence
  (the text is attacker-authorable; the system prompt says it is data). Answer
  `{"tickets":[{"key","code","reason"}]}`. ⚠ Changing one word of `SPRINT_CODE_SYSTEM` is a new
  `SPRINT_CODE_JUDGE_VERSION`.
- **VALIDATION** (`validateSprintCode`): per ticket, never repaired — an unknown key or a non-boolean
  `code` drops that entry; a key answered twice two ways drops it; the REASON never drops the entry
  (missing, over `SPRINT_CODE_JUDGE_REASON_MAX` (120) or carrying any numeral → `null`). Keys left
  unanswered are retried ONCE in a second call; still missing, they wait for the next read.
- **COST**: every call is recorded (`recordAiUsage`, feature `sprint_code`, the provider and model that
  ran); each stored row carries its share. AI off (`config.aiEnabled` false) → no pass, and every asked
  node reads `off`, so the filter keeps only tickets with a pull request.
- **SPA**: the card's button `title` and accessible name carry "Likely needs code: <reason>" / "Likely no
  code"; under the Needs code filter a pending ticket stays on the board with a muted "Not judged yet"
  beside its key (lib/laneBoard.ts `ticketCodeNote`).

## Sprint paths (This Sprint, the sprint builder)

ONE agentic Sonnet 5 run per changed sprint — the SPRINT BUILDER — that picks up to 5 **CRITICAL PATHS**
(ordered ticket chains, ranked by risk to the sprint, each with a ≤ 40-character title, ONE sentence of
advice and a risk level) and up to 3 **CALL-OUTS** (a title + the tickets worth a look). It REPLACED the
Haiku sprint story (2026-10-17): `review/sprint-story/`, `db/sprint-story.ts` and `SprintStoryStrip` are
deleted; table `sprint_story` and `sprint_reads.story_attempt_*` are DORMANT. ⚠ CODE BUILDS THE MAP AND
COUNTS EVERY NUMBER; the model picks and words, with NO digit anywhere in its text.

- **Where**: `src/review/sprint-paths/` — `prompt.ts`, `validate.ts`, `agent.ts` (the SDK half),
  `manager.ts`; the input, store, pace and people are core `db/sprint-paths.ts`; the to-do is
  `db/sprint-graph.ts` `sprintPathsTodo` (folds exactly as `getSprintGraph` does, WITHOUT stamping the view or
  kicking a read) / `sprintPathsInputOf` (the ONE builder both share). Table `sprint_paths` (migration `0120`), ONE row per (account, workspace). The SPA half is This Sprint's **Critical path** view
  (`components/Activity/SprintBoards.tsx` `SprintPathsView`, state fold `sprintPathsModel.ts`; one lane per
  path on the lane board — docs/FRONTEND.md § This Sprint); the stored paths also mark the
  critical cards and arrows on the Theme and People views.
- **WHEN — THE AFTER-READ CHAIN** (`review/sprint-briefs/index.ts` `runSprintAfterRead`;
  registered by `registerAgenticRoutes`, never on a view): briefs (Haiku — every sprint ticket and ghost gets
  a summary) → themes (Haiku) → paths. A brief pass that did not finish starts nothing after it. The page
  reads `queued` while the chain holds the workspace (`markSprintPathsQueued`, released on every path).
- **THE INPUT** (`sprintPathsInput`, inside a per-run NONCE fence): the sprint name; the COLUMNS left to
  right (`statusLayout.columns`, each with its meaning when the name does not say it); counts (tickets,
  complete, in product review, not complete, open dependencies, chains as "N found, M listed below"); every SPRINT
  ticket as one line — key, short title, issue type, epic (when it has one — so "design work" is a code fact,
  not a guess from a title), theme, column name + its meaning, assigned / unassigned (⚠ NO PERSON IS NAMED), PR states
  (open / draft / failing checks / merged), the CURRENT brief's summary; the OUTSIDE tickets a sprint ticket
  `depends_on` or `builds_on` (key, title, status, complete or not); those LINKS with the brief's `why` (else
  the quote); the dependency CHAINS code found (`sprintChains`, delivery order, each cut to its LONGEST RUN
  of listed tickets — an unlisted ghost may sit at either end — with each cut end marked "(more work outside
  the sprint)", ≤ 8 listed). Plus ONE day line ("Sprint day: 4 of 14;
  days left after today: 10", from `sprintTimingFor`).
- **THE HASH**: sha256 over `[SPRINT_PATHS_VERSION, everything sent EXCEPT the day line]`. ⚠ The day line is
  now-derived and stays OUT (CLAUDE.md: a dormant sprint must not re-bill every day); the stored text carries
  no digit, so an older day never shows through. PR states and CI ARE in it, so a merge moves it — the next
  sprint read re-runs, bounded by the daily cap. Current only while `input_hash` matches AND `paths_version`
  is `SPRINT_PATHS_VERSION` (2: issue type + epic joined the ticket lines).
- **THE RUN** (`agent.ts`): ONE in-process tool, `submit_paths` on the `paths` MCP server; `tools: []`, Bash
  and every file / web tool on the deny list, the PreToolUse PATH GUARD over a throwaway cwd plus the
  `ownToolsOnlyHook` backstop and `ISOLATED_MCP`, `settingSources: []`. Agentic only so a refused answer can be
  fixed in the same run — it reads nothing from disk. Effort: `sdkModelOptions(model, 'diff_only')`.
- **VALIDATION** (`validateSprintPaths`, inside the tool — a refusal lists EVERY problem and what to do, ≤
  `SPRINT_PATHS_CAPS.maxSubmits` 3 calls — and AGAIN before storing): ≤ 5 paths, ≤ 3 call-outs (empty lists
  are valid); every ticket a key the INPUT listed (sprint or outside ticket, case-blind, stored as the input
  spells it; an unlisted ghost of a ghost is refused), none twice in one list, no empty list, ≤ 12 per path /
  20 per call-out; titles 1–40 chars, advice 1–200; risk `high` | `medium` | `low`. ⚠ THE DIGIT GATE: titles
  and advice must match `/^[^\p{Nd}\p{No}\p{Nl}]*$/u` — no number, no ticket key, no date, no other Unicode
  numeral; spelled-out counts are a prompt-only rule. PLAIN TEXT: no Markdown / HTML characters, no links.
  Paths are re-ordered high → medium → low, the model's order kept within a level.
- **STORE + READ**: `paths_json` holds KEYS only; `getSprintGraph` resolves idents on read against today's
  nodes (else `identOfKey`), dropping a key that no longer resolves. The page shows the LAST paths written
  (any version, marked `stale`) — the hash is the RE-BILL gate, never the display gate.
- **THE ATTEMPT, THE BACKOFF, THE DAILY CAP**: every run records `attempt_at / _hash / _error` on its own
  row (`SprintPathsFailure`: `refused` · `no_submit` · `stopped` (turns / budget) · `error`; null = stored). A
  failure for TODAY's hash is never run again until the hash moves — never a retry loop. At most
  `SPRINT_PATHS_DAILY_CAP` (default 12) runs per workspace per UTC day (`runs_day` + `runs_today`, counted
  BEFORE Claude is called); over it the pass answers `capped` and the status reads `failed` / `daily_cap`.
- **STATUS** (`sprintPathsStatusOf`, the ONE fold → `pathsStatus`): `current` · `writing`
  (`claimSprintPathsPass`, claimed SYNCHRONOUSLY) · `queued` · `failed` (backoff or cap) · `waiting` · `none`
  (AI off, no credential — `pathsCanRun` from the route — or fewer than 4 sprint tickets).
- **COST**: `SPRINT_PATHS_BUDGET_USD` (default $1) and `SPRINT_PATHS_MAX_TURNS` (8) per run, env only; spend
  recorded under feature `sprint_paths`, seam `agent`.
- **THE PACE** (`SprintGraphResponse.pace`, `sprintPaceOf`; code only, AI off too): `daysElapsed` /
  `daysTotal` / `timeUsedPct` from the real sprint window (null without one), and over SPRINT tickets:
  `tickets`, `live` (not in a Complete bucket), `done`, `productReview` (drawn in a Product review column: placed there, or moved by the merge rule),
  `codeMerged` (≥ 1 merged PR, none open, any column), `openDependencies` (`depends_on` edges from a live
  sprint ticket onto anything not Complete), `chains`.
- **THE PEOPLE** (`SprintGraphResponse.people`, `sprintPeopleOf`): one entry per distinct sprint ASSIGNEE
  through the ONE assignee → GitHub mapping, shared `sprintMembers` (`sprint-members.ts` — the Members
  filter's: an exact name match after case, accents and `. _ -`, or the name run together; a login matching
  two assignees joins neither). `reviewsWaiting` = open PRs in this workspace's repos with an outstanding
  `review_requests` row for any mapped login (`reviewsWaitingByLogin` — the same "reviews waiting" population the removed
  People report used). ⚠ No mapped login → `null`, never 0. GitHub-only members are not assignees and are left out.
- **THE CODE CARDS** (`SprintGraphResponse.signals`, `db/sprint-signals.ts`; shared `SprintSignal`,
  `SPRINT_SIGNAL_LABEL`): NO model, templated sentences in digits over counts taken from
  the SAME folded graph, computed on every GET from the DB only (never a tracker or GitHub call), shown with
  AI off too. Each carries its idents, drawn as ticket-key buttons that open the story view. On the Critical
  path view they follow Claude's call-outs, in order **Since you last looked**, **Out of step**, **Blocked
  outside the sprint**; **Pace** is not repeated there (the pace strip draws `SprintGraphResponse.pace`).
  Each is omitted when it has nothing to say.
  - *Out of step* (`outOfStepSignal`): sprint tickets whose stage disagrees with their PRs — In review with
    open PR (said apart: "with their code already merged" vs "with no pull request" — on workspace 1, 11 of
    the 14 had merged code: that team moves a ticket to In review AFTER the merge, so one count read as 14
    problems) · Complete with a PR still open · Not started with a PR open (a draft-only one said apart).
    "3 tickets: 1 in review with no pull request, 1 in review with its code already merged, 1 complete with
    a pull request still open."
  - *Pace* (`paceSignal`): "Day 9 of 14" + "64% of the sprint's time has gone and 35% of its tickets are
    complete (27 of 77)." — time share = day / days of shared `sprintDayOf` (today counts), from the SAME
    real sprint window as the pace (`sprintTimingFor`); none → no card. NEUTRAL: no "behind" /
    "on track" verdict, so no threshold exists. idents = the unfinished sprint tickets.
  - *Blocked outside the sprint* (`blockedOutsideSignal`): unfinished sprint tickets with a `depends_on`
    edge (tracker blocking link or a current brief's reading) onto a GHOST that is not Complete (status
    unknown counts as not complete), and how many of those outside tickets have not started. idents = both
    sides.
  - *Since you last looked* (`sinceLastLookedSignal`): stage moves grouped by the new stage (Complete
    first), tickets added to the sprint, PRs merged on sprint tickets — against a per-(account, workspace)
    BASELINE in `sprint_view_snapshots` (migration `0112`). Two slots: CURRENT is refreshed on
    every view; ⚠ it rolls into BASELINE only when it is ≥ `SPRINT_VISIT_GAP_MS` (30 min) old, i.e. the
    previous VISIT ended — so the page's own refetches (every 5 s while a pass runs) never erase the diff,
    and a move that happened while the reader was looking is not news. The title is "Since 3 hours ago"
    (the baseline's time). No card on a first-ever visit, when nothing moved, or when the baseline shares
    no ticket with today's sprint (a new sprint). ⚠ The snapshot is recorded only once a sprint read has
    produced sprint tickets — an empty list must never become a baseline that makes every ticket "added".
    A store failure only loses this card (never throws).

## Ask about this sprint (This Sprint)

`POST /api/sprint-graph/ask` — one Haiku 5.5 answer per turn (`review/sprint-ask/`), registered by
`registerAgenticRoutes`; the SPA gates it on `me.ai`. Grounded ONLY in the stored graph
(`getSprintGraph`: tickets with stage, status, assignee, epic, brief summary, criteria count and PRs; the
links; the sprint builder's stored critical paths and call-outs), the whole map inside ONE nonce fence and the prior turns inside another — a previous answer is
model text over the same data. ⚠ The turn cap is SERVER-side (`capAskHistory`: the newest
`SPRINT_ASK_MAX_TURNS` − 1 pairs, each re-capped; `trimmedTurns` counts the rest). Short Markdown naming
ticket keys; no ranking of people. Spend: feature `sprint_ask`. Tier `ai` + `ai_hourly`.

## Moved from CLAUDE.md (2026-10-26)

Verbatim text taken out of CLAUDE.md to keep it under its size budget. CLAUDE.md keeps a
shorter form of each rule; this is the full wording.

### The agentic features (the CLAUDE.md section as of 2026-10-25)

Claude Review (+ follow-up, auto review, chat, the per-ticket TICKET review, the CI review,
design diagrams, Check threads), AI Fix (+ Plan first), Resolve with Claude, the reference-docs
library, sprint briefs/paths and every one-shot completion. Details:
[docs/CLAUDE-REVIEW.md](CLAUDE-REVIEW.md). Non-negotiables:

- **ONE switch, `config.aiEnabled` = `LIMN_AI_DISABLED !== 'true'`.** `registerAgenticRoutes`
  registers NOTHING when off. `MeResponse.ai` carries `enabled` / `runtime` / `auth`; no
  credential swaps the Run button for ONE line, never hides the feature.
- **ONE CREDENTIAL LADDER FOR EVERY MODEL CALL** (`ai/credentials.ts` `resolveAiCredential`): the
  reader's Claude Code login first (a `claude` session on disk or `CLAUDE_CODE_OAUTH_TOKEN`), else
  the environment's `ANTHROPIC_API_KEY`; `LIMN_AI_USE_API_KEY=true` puts the key first. Agent runs
  pass the ladder's environment as the query `env` (`agentAuthOptions()`, so a login run never
  sees the key); one-shot `cheapComplete` (review/llm.ts) takes the Agent SDK on the login and the
  Anthropic API on the key. **No caller picks its own credential, and nothing is stored.** Copy
  says "runs on your own Claude Code login or Anthropic API key", never promises subscription
  billing. Per-review budget: `REVIEW_BUDGET_USD` (default $6.75). Spend is recorded
  (`recordAiUsage`), never metered.
- **No AI SDK in the npm manifest** — downloaded on first use ("Set up AI" / `limn ai install`)
  and value-imported ONLY by `ai/runtime.ts` (`loadAgentSdk`/`loadAnthropicSdk`/`loadZod`);
  `build-release.mjs` asserts it.
- **THE CLAUDE SPEND BUDGET** (optional, per machine, `ai/budget.ts`): ⚠ **every AUTOMATIC model
  run asks the ONE gate first** (`review/budget-gate.ts` `automaticRunAllowed` / `ctx.aiBudget`) and
  is SKIPPED, never queued, when over; a reader's click is never refused (the SPA asks). On a
  subscription it is a share of the week and of the 5-hour session (Limn's own spend ÷ the estimated
  allowance; the 5-hour share follows the weekly one unless set) shown in PERCENTAGES ONLY — no US$
  on a subscription anywhere; the header item reads the SAME `['ai-budget']` query. Claude's usage
  reading (from the
  `loadAgentSdk` Query tap — never add per-runner forwarding) names the subscription and the reset,
  and NEVER blocks.
- **The agents' tools**: the reviewer and every chat are read-only with **`Bash` denied**; the
  fixer has Read/Glob/Grep + Write/Edit/MultiEdit + `submit_fix`, `DISALLOWED_TOOLS =
  ['Bash','NotebookEdit']` — **it builds and tests nothing**, and the SPA says "Not built or tested
  here." (templated) without promising CI. ⚠ `WORKTREE_RULES` and the tool list change together
  (`no-shell.test.ts`). Every agent run sits behind the PreToolUse PATH GUARD
  (`review/path-guard.ts`). Anything an agent reads from a PR is UNTRUSTED.
- **Nothing is posted or pushed until the reader presses the button**, except the per-workspace
  auto-post / Push automatically switches (OFF by default). Auto-posting is AUTO RUNS ONLY, under
  the reader's account, ONE review, `COMMENT` unless the OFF-by-default `autoVerdict` allows
  stricter; ⚠ the `auto_post` record is CLAIMED (compare-and-set) BEFORE any GitHub write, a
  failure is recorded and NEVER retried. Every posted body carries the hidden marker so
  `isLimnPostedComment` holds.
- **Auto review is OFF per workspace until switched on**; ONE start rule (`autoReviewDue`); it
  re-reviews once per new HEAD; only a PERSON's or a REVIEW bot's (`=== 'review'`) comments count,
  never Limn's own. A succeeded auto run on the reader's own PR may start an AUTO FIX (≤ 3 per PR
  per 24h, `workspaces.auto_fix_enabled` OFF by default).
- **Thread judgements**: "what Claude says now" is ONE fold, `currentThreadAssessmentsForPrs`
  (latest review + later Check threads, newer wins); words only from `lib/claudeThreadMarker.ts`.
- **Separate processes, never inside a PR review**: the CI review (`review/ci-review/`; one run per
  PR × head × failing set; the signed log URL never leaves the server), the TICKET review
  (`review/ticket-review/`; currency is a server FINGERPRINT; ONE story per ticket via
  `ticketStory`; the Jira apiRoot fold is ONE `jiraApiRoot`), design diagrams (`review/diagrams/`,
  only `diagram_type = 'design'` rows read). ⚠ `tracker/runtime.ts` opens the DB at import — keep
  review-side tracker imports LAZY.
- **AI Fix has TWO seeds**, `review` (built server-side from the stored run; items selected by
  stable key) and `plain`. `comments`/`ci_analysis` seeds 400 `SeedRemoved` but still read as
  history. Plan mode is MANUAL and READ-ONLY. URL paths kept (`/api/pro/prs/:id/ai-fix*`).
- **The moved modules take ONE `AgentContext`** (`review/agent-context.ts`), never the platform
  context.
- ⚠ **EVERY MODEL CALL GOES THROUGH `ai/provider.ts`** ([docs/CODEX-PLAN.md](CODEX-PLAN.md)
  § 3.1): runners call the run's provider's `runAgent` (`runProvider`), `cheapComplete` calls `.complete`. ONLY
  `ai/providers/claude.ts` (+ `ai/runtime.ts`) calls `query`/loads an SDK, and adds the path guard,
  own-tools hook and isolation to every run (`provider-seam.test.ts`). Budget folds filter
  `ai_usage.provider` (sqlite `0127`). ⚠ Codex: Phase 3 is complete (see § Codex, the second
  provider); a Codex change must leave Claude's prompts byte-identical (`prompt-golden.json`).
- **SonarCloud** ([docs/SONARCLOUD.md](SONARCLOUD.md)) and **reference docs**
  ([docs/REFERENCE-DOCS.md](REFERENCE-DOCS.md)): sealed write-only tokens; one stored Sonar
  snapshot per (PR, head) kept only when SonarCloud analysed THIS head; the docs library is
  server-written files, crawls same-host only with LINEAR scanners over untrusted text, and every
  doc link goes through `resolveDocLink`.
