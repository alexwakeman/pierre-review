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

- **Opt-in, off by default, LOCAL-ONLY.** Gated behind `ENABLE_CLAUDE_REVIEW=true`
  (`config.claudeReviewEnabled`) — it spends real money per run. **Force-disabled in cloud**
  (`!isCloud && …`): the routes aren't even registered (`app.ts`), so the gh-CLI/clone-manager
  dep stays unreachable on Railway. When off, the frontend hides the tab (via `/api/me`).
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
  there is no "clear it" route). `review/local-settings.ts` survives for the still-live
  per-review BUDGET. Pinned by `review/auth.test.ts`, whose two ⚠ cases are exactly "a stored
  key never makes `detectClaudeAuth` say ok" and "a stored key is never written into the
  environment".
- **The code is SPLIT between core and the Pro plugin.** CORE `apps/backend/src/review/` owns
  the security-sensitive half, reached through the `ctx.review.*` seam: `agent.ts` (the SDK run:
  an in-process MCP `submit_review` tool — `schema.ts` — captures structured output; read-only
  tools, `cwd` = a worktree, `bypassPermissions`, `settingSources:[]`, `maxTurns`/`maxBudgetUsd`
  caps, `AbortController` cancel), `submit-map.ts` (anchors the submitted findings and passes
  `priorRef` / `followUp` / `ticket` through verbatim), `model-options.ts` (per-model effort +
  thinking, shared with `coding/agent.ts`), `prepare.ts` (`gh pr diff` + `NOISE_GLOBS` stripping +
  per-file metrics + cap), `clone-manager.ts` (partial clones under `config.cloneDir`, ephemeral
  per-run worktrees, LRU cleanup), `post-review.ts` + `post-seam.ts` (line-anchoring + the single
  review POST), `pricing.ts` (the live estimate). The PLUGIN
  `packages/pro/src/claude-review/` owns the product: `manager.ts` (in-memory queue, one
  review/PR, `PRO_REVIEW_CONCURRENCY`, startup reconcile of orphaned `running` rows),
  `routing.ts`, `prompts.ts`, `follow-up.ts`, `ticket.ts`, `persist.ts`, `routes.ts`. The
  `claude_reviews` / `claude_review_findings` tables stay CORE (both dialects); the plugin writes
  them through `ctx.db` / `ctx.schema`. (`review-manager.ts` / `prompt.ts` no longer exist in core.)
- **Deterministic routing** (`claude-review/routing.ts`, tested): BEFORE the agent runs, a pure
  diff-metrics gate (`config.reviewRouting`) picks a `reviewMode` — `skip` / `diff_only`
  (tool-less, no clone) / `worktree` (full clone as context) — stored on `reviewMode` +
  `routeReason` (migration 0013). Conservative: `diff_only` only within every size/spread
  ceiling AND touching no exported contract (`API_PATH_PATTERNS`/`EXPORT_MARKERS`); ambiguity
  → `worktree`. User can force a mode per run.
- **Line-anchoring is the load-bearing bug risk** (`buildAnchorIndex` in
  `post-review.ts`): a ticked finding posts inline on its `(path, line, side)` when that
  lands on an addable diff line; otherwise it **re-anchors to the file's first changed
  line** (so an off-by-a-line finding still posts inline) and only truly unplaceable
  ones fall back to the review body. Posting pins `commit_id` to the head SHA, 409s if
  it moved.
- **Frontend:** `ClaudeReviewTab.tsx` + `useClaudeReview.ts` (live progress over SSE,
  `…/stream`). Claude's output is **read-only** (Copy buttons); a separate "Your review"
  textarea + verdict is what posts. Re-reviewing the same head SHA **warns but is allowed**.
  The follow-up and user-story pieces live in `ClaudeReviewFollowUp.tsx` (three components, one
  mount each, pinned by `test/claudeReviewFollowUp.test.ts`) over the pure
  `lib/claudeReviewFollowUp.ts` (ordering, anchors, the draft ↔ request mapping, chip palette):
  - **Model picker** opens on `DEFAULT_CLAUDE_REVIEW_MODEL` and is NEVER re-seeded from the
    stored run (a run stored under a retired id, such as the old Opus 4.8, would otherwise be a
    select value with no option).
  - **"User story or task (optional)"** sits under the depth hint, COLLAPSED by default. Its
    header adds " · added" / " · needs a fix", so a closed panel
    never hides what Run will send. It runs the SAME `checkClaudeReviewTicket` the route runs:
    per-field counter past 80% of the cap (trimmed length, as the check measures), the check's
    message under the field, and Re-review plus the same-commit "Run anyway" are disabled while
    it fails. No `maxLength` on any input — it would silently cut a paste. The draft prefills from
    the LATEST run's stored ticket (any status, since it is stored at queue time); a draft the
    reader has typed wins, kept per PR for the session (`createTicketDraftStore`, 50 PRs). Only
    a valid, non-empty ticket is sent, as the check's normalised fields.
  - **In `ClaudesReview`** (latest AND historic runs): the templated `followUpSentence` sits above
    Claude's summary; then **Previous review** — open items first (Not addressed, Partly addressed,
    then Not checked in GREY, never amber: unknown is not "not addressed"), addressed / no longer
    applies in a collapsed disclosure. Each row's anchor prefers the re-raising finding's
    (current) path and line, else the earlier path with its line DROPPED once the code moved since
    THAT comment was raised (`itemHeadMoved`: the item's own `headMoved`, falling back to the
    record's on older rows — a carried comment is older than the previous review); a
    "Raised again below" button scrolls to `#claude-finding-<id>`. Then **User story or task**:
    alignment chip, `ticketCriteriaSentence`, one row per criterion in AC order (Not met / Partly
    met rows bordered), "Asked for but not done" and "Added but not asked for". A finding linked to
    a still-open earlier comment wears "Not addressed since last review" / "Partly addressed since
    last review" and sorts first within its severity; one that repeats a comment already posted on
    this same commit also wears a grey "Already posted" (`alreadyPostedReraiseIds`) and arrives
    ignored. Claude's explanations are prefixed
    "Claude:"; all model and user-story text renders as plain text (no Markdown, no href), and an
    anchor is a `<button>` into the Changes tab only when the file is in the PR.
- **Packaging (NO AI in npm):** the AI SDKs (`@anthropic-ai/claude-agent-sdk`,
  `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod` — used only by the AI tools'
  submit-review schemas) are **NOT** curated runtime deps in `build-release.mjs`; a guardrail
  assert fails the build if any leak into `release/package.json`. Every module that pulls one
  is reached **only** through a dynamic `await import()` — from the private `@pierre/pro`
  plugin's seams (`review/agent`, `coding/agent`, `review/prepare`, `review/post-seam`; since AI
  Fix's trunk reconciliation was removed, `coding/merge` imports no SDK) or lazily inside
  `review/llm.ts` — so the SDKs load **only when the plugin is present** (author/dev checkout),
  **never from npm** and **never in cloud** (`bind.ts` returns before any AI import when
  `!config.proEnabled`). The compiled-but-inert AI `.js`
  files still ship as dead code (harmless — nothing loads them). `@pierre-review/shared` is
  VENDORED into the release (`release/dist/shared`), so both core and the plugin may VALUE-import
  it — the plugin's generate route reads `CLAUDE_REVIEW_MODELS` and `checkClaudeReviewTicket`
  from it at runtime. `model-options.ts` and `submit-map.ts` import no SDK (`submit-map.ts` takes
  the zod payload type with `import type`), and both are reached only from the dynamically
  imported agents.

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
  (`packages/shared`, ONE spelling), read by the fixer picker (`AiFixTab`), the CI card's "Fix it"
  (`CiAnalysisCard`) and the plugin start route. "On medium" is the `PINNED_EFFORT` pin above,
  reached through `coding/agent.ts` → `sdkModelOptions(model, 'worktree')`; the constant carries no
  effort of its own. `POST /api/pro/prs/:id/ai-fix` checks `model` IN THE HANDLER — there is no ajv
  body schema, because `removeAdditional` would strip `seed`/`reviewText`/`commentTargets`: absent or
  null → the default; a string in `CLAUDE_REVIEW_MODELS` → that model; anything else →
  `400 {error:'ModelNotOffered'}`. No stored fix row's model is ever re-run. Only the FIXER moved:
  the pane's summary and CI analysis stay on Haiku. Opus 5.5 is about 1.33× Sonnet 5's
  per-token price, so `aiFixBudgetUsd` went from $3 to **$5**: the heaviest succeeded Sonnet 5 fix
  in the dev DB cost $2.34, about $3.12 at Opus 5.5 rates for the same tokens. An explicit
  `AI_FIX_BUDGET_USD` still beats the default. Pinned by `review/claude-review-ticket.test.ts`,
  `packages/pro/test/ai-fix-routes.test.ts` and `apps/frontend/test/aiFixModelDefault.test.ts`.
- Price (live estimate only; the recorded cost is the SDK's own): Opus 5.5 is $4 in / $20 out per
  MTok, cache write $5, cache read $0.20.

## Follow-up on the previous review

When a run starts for a PR that has an earlier succeeded review, the new run checks that review's
comments and says, for each one, whether the current code deals with it.

- **Which review.** The newest `claude_reviews` row for the same PR and account with
  `status='succeeded'`, an id below the current run's, and `review_mode IS NULL OR review_mode <>
  'skip'` (a skip run read no code). ⚠ The NULL arm is load-bearing: pre-routing rows have no
  mode, and `ne()` alone drops them. `persist.ts` `loadPriorReviewForFollowUp`, account-scoped
  through the repos join.
- **Which comments.** `(included || postedAt != null) && severity !== 'praise'` — `included=false`
  is the user's "Ignore" (and review-memory's `finding_dismissed`), but a posted comment is on the
  PR whatever the tick says. The prompt uses the body the user saw: `editedBody` when non-blank,
  else `body` (the routes' `resolvedBody` rule). ⚠ Known edge: rows from before findings were
  included by default carry `included=false` unless ticked, so they read as ignored.
- **CARRY-FORWARD.** Every item the previous run recorded as `not_checked` names an older finding;
  those are re-loaded (ids from our own stored JSON, re-scoped to this PR + account by the query),
  re-checked for eligibility and marked `carried`. Without it, a comment Claude skipped — or one
  over the cap — would silently drop out of the chain one review later. The same load also carries
  a still-open item (not / partly addressed) that no ELIGIBLE finding of that run raises again,
  when its earlier finding was POSTED — the re-raise saved ignored because it was already on the
  commit (below), or one the reader ignored while the original stays on the PR.
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
  tells the model the honest answer is mostly `not_addressed`. ⚠ The server does NOT coerce
  statuses on an unmoved head: the run's head comes from the synced DB while `gh pr diff` is live,
  so a model saying "addressed" there may have fresher evidence than we do. The prompt tells the
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

## Starting from the Open PRs tab

The Open PRs table (`OpenPrsTable`, the pinned "Open PRs" tab) carries a **Claude review** column
when — and only when — the `claudeReview` capability is on; without it there is no column and no
request.

- **ONE read for the whole table**: `POST /api/claude-review/states` with the listed PR ids
  (`useClaudeReviewStates`), never a request per row. It polls every 5s only while a listed PR is
  queued or running; a start, and the tab's SSE `done`, invalidate it.
- **Cells** (`lib/claudeReviewColumn.ts` `reviewCellFor`): no run → **Review**; queued → disabled
  **Queued**; running → disabled **Reviewing…**; succeeded → the verdict in words, a link that
  opens the PR's Claude Review tab (`openClaudeReview`), plus **Re-review** when the PR has new
  commits since that run; failed / cancelled → **Review** again. Every control stops propagation
  (the row opens the PR). Sortable, needs-a-review first.
- **A click starts a run through the SAME route and queue as the tab** (`POST
  /api/prs/:id/claude-review`, default model, `auto` mode, no picker): `REVIEW_CONCURRENCY` run at
  once and the rest queue, so many clicks are many queued runs. ⚠ **ONE MUTATION KEY PER PR**
  (`claudeReviewStartKey`) for both surfaces, read through `useClaudeReviewStarting`, so the button
  disables the moment it is pressed and the tab sees the list's start in flight (and the reverse).
  Both starts bump `claudeReviewKickoff`, so the same "Claude reviews" toast appears. A `409`
  (already running, queue full) or any error shows under the button and re-enables it.
- **The user story, on click only** (`resolveListTicket`): a RE-REVIEW reuses the previous run's
  stored ticket; otherwise the PR's first FILLABLE Jira ticket (`PrDetail.tickets`, read through the
  shared `['pr', id]` cache entry) is fetched and filled exactly as the panel's "Fill from KEY" does —
  ONE helper, `fillDraftFromJira` (title + description, then the criteria field remembered for this
  issue type on this site, else the best strong name match, else none). ⚠ **The run starts EITHER
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

## User story or task

Optional title, description and acceptance criteria the person running the review may paste.

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
- **The 400 contract.** `POST /api/prs/:id/claude-review` declares `ticket` in its body schema
  (ajv's `removeAdditional` would strip it otherwise) with no `maxLength`; over a cap it answers
  `400 { error: 'TicketInvalid', field, message }` and starts nothing. Never truncated. Control
  characters (other than tab/newline) are refused (pg jsonb cannot hold `\u0000`).
- **Stored at QUEUE time** on `claude_reviews.ticket`, so a failed or cancelled run still prefills
  the panel for the re-run. Fenced in the prompt (`---BEGIN TICKET TITLE <nonce>---`,
  `… DESCRIPTION …`, `… ACCEPTANCE CRITERIA …`).
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
  ticket. Click-gated (nothing fetches on mount): `GET /api/pro/prs/:id/jira-ticket?key=` reads the
  issue with every field (REST v2, `fields=*all&expand=names,schema`; wiki markup kept verbatim,
  ADF flattened) and the panel REPLACES title and description. Manual entry is unchanged and
  everything stays editable; nothing is truncated on the way in.
- ⚠ **THE ACCEPTANCE-CRITERIA FIELD IS CHOSEN PER TICKET, IN THE PANEL — not in Settings.** A
  site-wide picker shipped first and was unusable: real sites carry several fields named
  "Acceptance Criteria" and the one in use varies by issue type. The route returns `candidates` —
  every custom field with text on THIS ticket, strong name matches first (`/acceptance criteria/`),
  then weak ("AC", "definition of done"), then by name, capped at 50 — and the panel shows
  "Acceptance criteria from" (`Name (customfield_123) — preview`, blank first). The DEFAULT
  (`defaultAcCandidate`, in `packages/shared/src/claude-review.ts` so the server's auto review picks by the SAME rule): the viewer's remembered field for this issue type on
  this Jira site, when this ticket has it; else the best STRONG name match (an exact
  "Acceptance Criteria" first — a weak "AC" / "Definition of Done" match is listed near the top but
  never preselected, because a wrong prefill is worse than a blank); strong matches carry a ★ in the
  dropdown; else blank, leaving the box untouched. A preselected field fills the
  box at once; changing the dropdown refills it client-side with no refetch, and an EXPLICIT choice
  is remembered (blank forgets). ⚠ **The token that counts is the one on the workspace that OWNS the
  PR's repo**, not the workspace being viewed (`?workspace=` is only the viewer's scope): when a Jira
  ticket is detected but that workspace has no token, the panel names it ("add a Jira API token in
  Settings for the BNG workspace") instead of silently showing no button. The memory is per-viewer localStorage keyed
  `limn:jira-ac-field:v1:<site host>:<issue type id>`, every access wrapped — a convenience, never
  state anyone else sees. ⚠ The route re-runs detection and refuses a key the PR does not carry,
  so the saved token can read only tickets this workspace's PRs name. Settings, token storage and
  SSRF rules: [PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) § Jira API access and
  [SECURITY.md](SECURITY.md).
- **Shown in the app only, not posted.** The prompt tells the model to ALSO raise any concrete
  defect behind an unmet criterion as a normal finding, and findings are postable.
- **Vocabularies** (shared): criteria Met / Partly met / Not met / Can't tell from the code /
  Not checked; alignment Matches the user story / Partly matches / Doesn't match / Can't tell /
  Not checked; follow-up Addressed / Partly addressed / Not addressed / No longer applies /
  Not checked. `'not_checked'` is in no model-facing enum: only the server writes it.

## Auto review (per workspace)

Settings → Workspace → **Auto Claude review** (shown only when the `claudeReview` capability is
on). When a workspace switches it on, Claude reviews each **human-authored, non-draft PR OPENED at
or after that moment** — once per PR, ever — with the same model (`DEFAULT_CLAUDE_REVIEW_MODEL`) and
per-review budget as the Review button. Storage: `pro_workspace_settings.auto_review_enabled` +
`auto_review_enabled_at` (plugin `0036`); `enabled_at` is re-stamped on every off → on and cleared on
off, so nothing opened while it was off is picked up. Runs carry `claude_reviews.trigger = 'auto'`
(core `0071` / pg `0058`; `'manual'` is the default).

- **A PULL SWEEPER, NOT A HOOK** (`packages/pro/src/claude-review/auto.ts`, every minute on the host
  scheduler). `sync/upsert.ts` runs inside a transaction and sees every PR of a first sync or a
  90-day backfill as new, so it is the wrong place. Each tick asks core
  `ProHostQueries.getAutoReviewCandidates` (OPTIONAL seam, apiVersion stays 21): open, not draft,
  `opened_at >= enabled_at`, the author a PERSON under the workspace's own judgement
  (`hiddenBotUserIds`, the resolver behind `InsightPrRef.authorIsBot`; an unmapped author is
  skipped), and **no `claude_reviews` row of any kind** (manual, auto, failed). The DB is the queue:
  a waiting auto item has no row, so a restart loses nothing.
- **THE LANE** (`manager.ts`). Auto items wait in their own FIFO, capped by
  `PRO_REVIEW_AUTO_MAX_QUEUED` (default 20), and launch only when no manual item waits. The ONE
  `PRO_REVIEW_CONCURRENCY` is shared and unchanged. ⚠ Auto work can never make a click answer
  `busy` (the manual cap is untouched). The row is written when a slot opens, through the same
  `startReview` steps. ⚠ **Switching a workspace OFF drops its WAITING items** (`dropAutoReviews`,
  called by the settings PUT and again by every sweep against the roster): they have no row, so
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
- ⚠ **AN AUTO RUN ALWAYS TRIES JIRA** (`packages/pro/src/jira/resolve-ticket.ts`,
  `resolveAutoReviewTicket`, called by `startAutoItem` before the row is written). No browser is
  there to "Fill from KEY", so the server does the same fill: the PR's FIRST detected key (the one
  detection path, so the token still reads only tickets this workspace's PRs name), fetched through
  `jiraCall` → `jira/fetch.ts`, criteria from `defaultAcCandidate(candidates, null)` — a strong name
  match or none, never a weak one. Each field is CUT to its cap (and unstorable characters dropped)
  instead of refused: nobody is there to trim. It NEVER throws — no tracker, no token or a Jira
  error is `ticket: null` and the review runs without a story; a Jira failure logs account,
  workspace, PR and the error code only. Before this every auto run went out with no ticket. The
  manual paths are unchanged (an empty panel on a click still means "no story").
- **THE COST GUARD**: `AUTO_REVIEW_DAILY_CAP` = 20 auto runs per workspace per **UTC** day, counting
  today's auto rows plus items still waiting in the lane. Past it, PRs wait for the next day. An
  account whose agent credits are spent sits the tick out.
- ⚠ **IT NEVER RUNS WHERE CLAUDE REVIEW IS OFF.** `autoReviewAvailable` = the pro+ flag AND a local
  host; in cloud the job is never registered and the settings PUT drops the switch.
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

After a review **succeeds**, the reader can ask Claude about it: one **general thread** per review
("Ask Claude about this review", under the findings) and one **thread per finding** (the finding's
**Ask Claude** button). Pro+ and local-only like the rest of Claude Review. Host:
`review/chat-agent.ts` behind the OPTIONAL seam `ctx.review.chat` (apiVersion stays 21). Plugin:
`packages/pro/src/claude-review/chat.ts`. SPA: `components/ClaudeReviewChat.tsx` +
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

