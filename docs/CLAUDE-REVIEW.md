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
    stored run (a stored `claude-opus-4-8` would otherwise be a select value with no option).
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
  plugin's seams (`review/agent`, `coding/agent`, `coding/merge`, `review/prepare`,
  `review/post-seam`) or lazily inside `review/llm.ts` — so the SDKs load **only when the
  plugin is present** (author/dev checkout), **never from npm** and **never in cloud** (`bind.ts`
  returns before any AI import when `!config.proEnabled`). The compiled-but-inert AI `.js`
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
- **Opus 4.8 is no longer offered but stays READABLE**: it is still in the `ClaudeReviewModel`
  union, `CLAUDE_REVIEW_MODEL_LABELS` ("Claude Opus 4.8 (no longer offered)"), the price table and
  both schemas' `model` text enum, so the stored runs render and price. The generate route's
  schema enum is the OFFERED list, so a POST naming it is a 400. `claude_reviews.model` is plain
  `text` in both dialects (no CHECK, no pg enum), so the enum change needed no migration.
- **Effort is passed EXPLICITLY for Opus 5.5** — its API default is `medium`, one below Opus 5's
  `high`. It gets exactly what Sonnet 5 gets on the same path (`REVIEW_DIFF_ONLY_EFFORT`, default
  low, for a Quick review; `REVIEW_EFFORT`, default medium, otherwise). It also always gets
  `thinking: { type: 'adaptive' }`, which overrides any `MAX_THINKING_TOKENS=0` the environment
  might carry. ⚠ **Opus 5.5 400s on `thinking: {type:'disabled'}`, on a thinking budget
  (`budget_tokens` / `maxThinkingTokens`) and on a forced `tool_choice`** — nothing in the review,
  coding or llm paths sends any of them (the review relies on the model CHOOSING `submit_review`).
  One table, `review/model-options.ts`, holds the effort-capable and adaptive sets for both
  `review/agent.ts` and `coding/agent.ts`.
- The bundled Agent SDK is 0.3.162 (maps `thinking` → `--thinking adaptive`, `effort` →
  `--effort`). If a real Opus 5.5 run fails with an API 400, the contingency is to bump
  `@anthropic-ai/claude-agent-sdk` (regenerating `pnpm-lock.yaml` under the pinned pnpm).
- **AI Fix inherits the offered list** (Opus 5.5 listed, Opus 4.8 gone from its picker) but keeps
  its own `claude-sonnet-5` default; a stored AI Fix row naming Opus 4.8 still re-runs (its route
  validates no model, and 4.8 stays effort-capable).
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
- **Shown in the app only, not posted.** The prompt tells the model to ALSO raise any concrete
  defect behind an unmet criterion as a normal finding, and findings are postable.
- **Vocabularies** (shared): criteria Met / Partly met / Not met / Can't tell from the code /
  Not checked; alignment Matches the user story / Partly matches / Doesn't match / Can't tell /
  Not checked; follow-up Addressed / Partly addressed / Not addressed / No longer applies /
  Not checked. `'not_checked'` is in no model-facing enum: only the server writes it.


