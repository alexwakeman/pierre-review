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
    nothing; nothing is posted or pushed until the reader presses the button — EXCEPT what a
    workspace has switched AUTO-POSTING on for (§ Auto-posting; off by default). Never promise
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
  - **No Pro input.** The OPTIONAL plugin seam `ProContext.registerAgenticProviders?`
    (`review/plugin-providers.ts`) is GONE since apiVersion 23: the ticket review's members and
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
    "Posted" link and Copy remain. The post route matches it: `POST …/post` sends included findings
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
- ⚠ **SETTLED BY A REPLY ⇒ OUT OF THE FOLLOW-UP, AND NEVER RAISED AGAIN** (`settled-by-reply.ts`,
  pure; loader `persist.ts` `loadSettledByReplyFindings`, over EVERY earlier succeeded review of the
  PR, account-scoped). A posted finding is settled when, on SYNCED data only: (1) its inline
  comment's thread is found — the thread's first comment is by the account's own login and is the
  finding's `githubCommentId`, or (Post review stores no id) on the finding's path with a body that
  STARTS WITH the finding's resolved body; a PR-level comment has no thread and is never settled;
  (2) the thread is resolved; (3) a LATER comment in it is by a known login that is NOT the
  account's own and NOT automation (`users.isBot`, `github_type='Bot'`, the login seeds) — Limn
  posts AS the reader, so every comment under that login, every `isLimnPostedComment` one included,
  is ours and never settles anything; (4) the code did not move under it — the thread is not
  outdated and no synced commit dated after the finding's comment touched its file (a commit whose
  files were never synced counts as touching it). Then: the finding is filtered out of
  `loadPriorReviewForFollowUp` (own AND carried, after the carry bookkeeping), so it is never a P
  item, never on the stored `follow_up` record, never in the pane's "Previous review" list and never
  an AI Fix `P` seed item; the prompt lists it (up to 30) under **Settled in an earlier review**, one
  `---BEGIN SETTLED FINDING S<n> <nonce>---` fence each carrying the path, title and the reply as
  data (in the nonce-collision scan), telling the model not to raise it again; and the manager
  DROPS, in code, any new finding that repeats one (`dropSettledReraises`: same path, title equal
  once folded or word overlap ≥ `SETTLED_TITLE_SIMILARITY` 0.6). A finding LINKED to a still-open
  earlier one (`priorFindingId` set) is that one's re-raise and is kept. ⚠ **A thread resolved with
  NO reply is NOT settled** — resolving is a click, not evidence, so it is followed up and re-raised
  as before. ⚠ A finding fixed in code fails rule (4) and stays on the follow-up's own "addressed"
  path. Pinned by `settled-by-reply.test.ts` (the rule) and `settled-by-reply-pipeline.test.ts`
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
  wears "Already posted"; the reader can still un-ignore it. On a moved head the reminder is the
  point, so it stays included.
- **The sentence is TEMPLATED** (`followUpSentence` in shared, e.g. "Last review's 5 comments:
  3 addressed, 1 partly addressed, 1 not addressed.", or "Last review's 3 comments and 2 older
  ones: …" when some were carried — a carried comment is not the last review's) from the
  server-validated statuses — a
  code-derived figure; Claude's explanations are shown separately, as Claude's text. On the wire,
  each follow-up item carries a DERIVED `reraisedFindingId` (the finding whose `priorFindingId`
  matches), and findings carry `priorFindingId`.

### Replies to Limn's findings (accept, or push back once)

When someone REPLIES on the GitHub thread of one of Limn's own posted findings and the thread is
still open, the re-review judges the reply instead of re-raising the finding blind. Other
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
- **Accepted ⇒ settled from then on** — the SECOND rule feeding `loadSettledByReplyFindings`
  (`acceptedReplyFindings`, over every earlier succeeded run's `follow_up`): out of later
  follow-ups, listed under "Settled in an earlier review" ("Accepted: …"), and a re-raise is
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
  on the owner row's `claude_review_findings.pushback` (`FindingPushbackRecord`, sqlite `0092` / pg
  `0079`). ⚠ **AT MOST ONE PUSHBACK PER THREAD, EVER**: the record is claimed from NULL, and a
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

## CI review (why checks failed — its own process)

⚠ **THE PR REVIEW NO LONGER DIAGNOSES CI.** The split (2026-10) made the CI review its own Claude
process (`src/review/ci-review/`), modelled on the ticket review: own tables, own claim, own lane,
own cap, own budget. New PR-review runs read no logs, carry no "CI failures" prompt section, and
`submit_review` has no `ciFailures` field (a stray one is stripped). `claude_reviews.ci_failures`
(sqlite `0077` / pg `0064`) stays as READ-ONLY history: the SPA shows an old run's diagnosis only
when the PR has no CI review. ⚠ The SPA shows a CI diagnosis (either kind) ONLY for the PR's
CURRENT head — an earlier commit's is hidden whether the head is green or red
(`ciRunAtCurrentHead`, docs/FRONTEND.md). Wire contract: [API.md](API.md) § CI review.

- **Keyed per (PR, head commit, sorted failing check names).** `ci_reviews` (one row per run,
  history kept) + `ci_review_items` (one row per failing check), sqlite `0082` / pg `0069`. Two keys
  per run (`currency.ts`): `failing_key` = sha256 of the names the run READ live; `trigger_key` = the
  SYNCED names that started an automatic run. Currency and "is it due?" accept EITHER, so a lagging
  sync never re-runs the same failures nor reads a fresh run as stale. `job_id` is BIGINT on pg
  (Actions job ids are past 2^31). Tenancy is structural: composite FKs `(pr_id, account_id)` →
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
- **Tables** `ticket_reviews` / `ticket_review_members` / `ticket_review_items` (sqlite `0080`, pg
  `0067`), tenancy STRUCTURAL via named composite FKs. Deleting a PR prunes its member rows and drops
  a run left with none (`db/ticket-review-prune.ts`, in BOTH delete paths).
- **Currency is a fingerprint**: sha256 of `TICKET_REVIEW_VERSION`, the story hash and the sorted
  `prId:headSha:state` of the members, recomputed from synced columns on every read
  (`deriveTicketReviewState`) — `stale` names why (`story_edited`, `pr_added`, `pr_left`,
  `pr_pushed`, `pr_merged`). Core's `tracker_tickets.changed_at` (migration `0088`; plugin `0039` before apiVersion 23) moves only
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
- **CONTRIBUTION CARDS** (`cards.ts`, table `ticket_review_pr_cards`, sqlite `0086` / pg `0073`): a
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
  Auto-posting — automatic runs only, owner PR only). One Post button per unmet / partly met / missing item, targeting
  `owner_pr_id` (Claude's `expectedIn` member), else the viewed PR, pinned to the head the run
  judged (`HeadMoved` otherwise). A re-raised item inherits its earlier posting (`prior_item_id`), so
  nothing posts twice; only the ticket's latest succeeded run may post (`Superseded`). ⚠ The route
  takes its in-process claim BEFORE the "already posted?" check and re-reads the item inside it — a
  check made before the claim can be answered by a request that has since posted and released it.
  The SPA says "Already posted" only for `AlreadyPosted`; `HeadMoved` / `Superseded` keep the button
  and print the reason. The body
  carries the `<!-- pierre:claude-review` marker, so it never triggers an auto PR review.
- **AI Fix**: a MANUAL review-seeded fix includes the items this PR owns from each ticket's latest
  succeeded run (refs `S<t>-AC<n>` / `S<t>-M<n>`); an AUTO fix never does. Those items are model
  text drawn from Jira and other people's PRs, and the fixer WRITES — so it, too, runs behind the
  path guard, rooted at its worktree (`coding/agent.ts`; § AI Fix).
- **Peers in a deep PR review.** A worktree PR review may read up to
  `TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW` (4) peers on the same ticket, read-only behind the same path
  guard, to catch cross-repo breakage — it never judges the ticket or reports criteria.

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
- **Fill from Jira** (core `tracker/` since apiVersion 23; it was plugin `jira/`, migration `0035`). When the PR carries a Jira ticket the
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

Settings → Workspace → **Auto Claude review** (shown wherever `MeResponse.ai.enabled` is — local,
free; **OFF until switched on**, because it spends the user's own Claude in the background). When a
workspace switches it on, Claude reviews each **human-authored, non-draft PR OPENED at
or after that moment** — once per HEAD, plus once per burst of new review comments (see re-review below) — with the same model (`DEFAULT_CLAUDE_REVIEW_MODEL`) and
per-review budget as the Review button. Storage: CORE `workspaces.auto_review_enabled` +
`auto_review_enabled_at` (core `0074` / pg `0061`; it lived on the plugin's
`pro_workspace_settings` (plugin `0036`) until Claude Review left the plugin, and plugin `0037`
copied each ON switch across once — those plugin columns are dormant). Read and written through
`GET`/`PUT /api/workspaces/:id/auto-review` (`claude-review/auto-settings.ts`, 404 for another
account's workspace; the PUT body takes `enabled` and/or `autoFixEnabled`, at least one, a field
left out keeps its stored value); `setWorkspaceAutoReview` is the ONE writer of both switches. `enabled_at`
is re-stamped on every off → on (whole seconds, so the echo matches what SQLite stores), KEPT on a
repeated on, and cleared on off, so nothing opened while it was off is picked up. Runs carry `claude_reviews.trigger = 'auto'`
(core `0071` / pg `0058`; `'manual'` is the default).

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
  left the contract at apiVersion 23). Tickets are the ticket review's: its own sweeper re-checks them (§ Ticket review
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
- **THE COST GUARD**: a daily cap of auto runs per workspace per **UTC** day, counting
  today's auto rows plus items still waiting in the lane. The cap is SET PER WORKSPACE in Settings
  ("Up to N auto reviews a day", `workspaces.auto_review_daily_cap`, migration 0085 / pg 0072):
  OVERRIDES ONLY — NULL is the default `AUTO_REVIEW_DAILY_CAP` = 20, folded by
  `resolveAutoReviewDailyCap` for both the wire and the sweeper's roster; the PUT bounds it 1..500.
  First reviews and re-reviews share it (one busy PR's pushes can use most of it). Past it, PRs wait for the next day. An
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

## Auto-posting (per workspace)

Settings → Workspace → Auto Claude review → **Post Claude reviews to GitHub automatically**. OFF for
every workspace, existing and new, until someone switches it on (`workspaces.auto_post_enabled`,
NULL/false = off; `auto_post_settings` is OVERRIDES ONLY `{ scope?, kinds? }`, folded by
`resolveAutoPostSettings`; sqlite `0087` / pg `0074`). Read and written through the auto-review route
(`autoPost` on `WorkspaceAutoReviewSettings` / `SetWorkspaceAutoReviewBody`; `setWorkspaceAutoReview`
is still the ONE writer). Local-only like every agentic feature: the route and both hooks exist only
where `config.aiEnabled` registers them.

**Migration 0091 / pg 0078 — the shared contract for the next batch** (types in `packages/shared`):
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
  self-approval → `own_pr`) and (b) when the reader's own latest review — read LIVE
  (`GET …/pulls/:n/reviews`, the synced table can lag) — is none or COMMENTED (`prior_review`; a failed
  read is `reviews_unreadable`, never a guess). Held ⇒ COMMENT. A sendable APPROVE / REQUEST_CHANGES
  goes out even with no new comment (body only); a held one with nothing to post is a skip. Recorded
  on `ClaudeAutoPostRecord.verdict`; the tab prints "Approved automatically." / "Not approved: …".
  ⚠ The verdict and the comments are ONE submission. A verdict GitHub REFUSES (a 4xx on the review
  POST other than 401/429 — repo policy, permissions; `isVerdictRefusal`) gets the ONE retry: the
  same review again as a COMMENT, leaving just the comments, recorded `heldReason: 'refused'` +
  `refusedError` ("Not approved: GitHub refused it, so the comments were posted on their own.").
  Safe because a refused POST created nothing (the seam posts PR-level comments only after the review
  lands). A 5xx / network / rate-limit failure is ambiguous and is NEVER retried; a refused bare
  verdict with no comments posts nothing more (`failed`).
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
  The owner's OWN workspace decides (switch, kind, scope) and it must pass the same PR rules. Each
  item goes through `postTicketItem` (`ticket-review/post-item.ts`, extracted from the route): the
  SAME synchronous claim, the same in-claim re-read, `postedInChain` and the Superseded check, so a
  click and an auto post cannot both land. Never twice across runs: the item's own / inherited
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
- **SPA.** The review's thread is open by default, so its one DB read (the stored turns) runs on
  mount; Hide collapses it and nothing more is fetched while it is shut. ⚠ Every thread of a review shares ONE mutation
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
- **ONE ENTRY POINT IN THE SPA, TWO ON THE ROUTE** (`AiFixSeed`): `review` (the FIX PICKER in the
  AI Fix tab, reached also from the Claude Review tab) and `plain` (an instruction — the route still
  accepts it, the SPA no longer offers it; the tab's CI list, AI summary and text box are gone). With
  no succeeded Claude review the tab says so and offers "Open Claude Review". ⚠ The picked-comments
  basket (`comments`) and the Pro CI diagnosis (`ci_analysis`) were REMOVED as seeds: the route
  answers `400 SeedRemoved`, but rows stored under them still READ (`AiFixStoredSeed`) and render
  as history ("no longer offered"). Their `comment_targets` / `comment_verdicts` columns are dormant.
- **THE FIX PICKER** (`components/AiFix/FixPicker.tsx`, `GET /api/pro/prs/:id/ai-fix/preview
  ?sourceReviewId=` → `AiFixPickerPreview`, DB-only). The server lists every candidate (`buildPickerPreview`)
  with a STABLE key (`finding:<id>`, `thread:<id>`, `ci:<ciReviewItemId>`, `story:<ticketIndex>:<ref>`),
  its section and its default; the reader ticks cards; Start sends `include: <keys>` and the server
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
  `accounts.github_login` (case-insensitive), local and cloud alike; anyone else's PR gets nothing
  and records nothing. ⚠ **THE WORKSPACE SWITCH**: `workspaces.auto_fix_enabled` (core `0083` / pg
  `0070`), **OFF by default** since core `0084` / pg `0071` (which switched every existing workspace
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
