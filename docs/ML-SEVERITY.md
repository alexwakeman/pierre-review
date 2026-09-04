# ML severity + category enrichment of bot comments

**CORE. Free tier. No LLM, no GitHub quota, nothing billed.**

Every comment an AI review bot leaves gets two machine-read labels — a **severity**
(`nit` · `minor` · `major` · `critical`) and one or more of **nine fixed categories** — so a
wall of CodeRabbit/Copilot/Sonar output can be triaged without reading all of it. The labels
render on the comments themselves and roll up on the Bots interface.

The classifier is its own repo, **[`pierre-ml`](https://github.com/alexwakeman/pierre-ml)**,
vendored here as the **`packages/ml`** submodule: a fine-tuned ModernBERT (ONNX int8, CPU)
severity model plus a deterministic marker-based category parser, exposed as the
**`severity-api`** microservice. It is stateless — text in, labels out — and this repo owns all
persistence. It builds, versions and deploys on its own; the submodule is a pinned pointer, not
a merge of the two codebases.

> Read `packages/ml/docs/SEVERITY_API_INTEGRATION.md` for the service's own contract
> (endpoints, response fields, the eight categories, accuracy limits) and
> `packages/ml/docs/RUN_LOCALLY.md` for how to run it. This document is the pierre-review
> side: where it plugs in, why it plugs in there, and what will bite you.

---

## Availability — and why `npx` doesn't get it

| | severity-api | Enrichment |
|---|---|---|
| **cloud** (Railway) | `severity-api` service, private DNS | on |
| **local dev** (this checkout + the sibling repo) | `127.0.0.1:8799` via `serve_local.sh` | on |
| **`npx pierre-review`** | none — the published package ships no model | **off** |

**The gate is one env var: `SEVERITY_API_URL`.** Unset ⇒ no worker is scheduled, `/api/me`
reports `mlSeverity: false`, and the SPA issues zero ML queries. That is also what keeps it
dark under `npx`: the npm package contains no model, no Python, and no service — and
`config.ts` resolves its `.env` search paths against the **install** directory, so an npx user
has nowhere to put the variable even if they knew it (the README tells npx users to pass vars
inline, which is why this is a soft gate rather than a hard packaged-build check).

`ML_SEVERITY_DISABLED=true` is the kill switch for a deployment that has the URL set.

The two read routes stay **registered in every mode** and answer honestly when the service is
absent (`enabled: false`, empty label sets) rather than 404ing, so a deployment that gains the
service later needs no client change. The SPA's gate is `MeResponse.mlSeverity`, never a 404.

---

## Where it hooks in: a background worker, not a sync step

Enrichment is a **pull**. Nothing enqueues it. Each tick (`sync/ml-enrichment.ts`, its own
cron, default `*/2`) re-derives *"bot-authored text in this workspace with no label yet"*
straight from the database, newest-first, and drains as much of it as its wall-clock budget
allows.

**Why not inline in `persistPr`.** Measured, not assumed. The model is int8 ModernBERT on CPU
and its cost tracks **total text**, not item count:

| batch (Intel i9, local ONNX) | wall clock | per item |
|---|---|---|
| 32 short bot comments | 2.7 s | 85 ms |
| 32 mixed, truncated to 2 000 chars | 16.1 s | 504 ms |
| 32 long (~1.4 k chars each) | 28.4 s | 887 ms |

A real account's bot corpus in this repo's own dev database is ~17.5 k items ≈ 7 M chars — over
an hour of inference locally, perhaps 15–25 min on the deployed service. Two things make that
fatal inline:

- `persistPr` runs **entirely inside `runTransaction`**, which on SQLite is a manual
  `BEGIN`/`COMMIT` on the one shared `better-sqlite3` connection. Its correctness argument
  (`db/client.ts`) is explicitly *"no other macrotask interleaves, because the callback only
  awaits in-process SQLite work"*. An awaited `fetch` there holds the global write lock open
  across network latency.
- `sync-repo.ts` awaits `persistPr` **per PR, serially**. An N-PR page would become N external
  round trips before the next page is even fetched.

**What the pull buys, beyond not being slow:**

- **No hook on the real-time paths.** A webhook-delivered comment and a just-posted one are
  simply the newest unlabelled rows; they are picked up within a tick. No enqueue in
  `sync-one-pr.ts`, and nothing added to the latency of
  `POST /api/prs/:id/review-comment` (whose caller *awaits* the resync tail).
- **A bot classified later brings its backlog with it.** See the timing trap below.
- **A restart loses nothing** — there is no in-memory queue to drop.

The cost is latency: a brand-new bot comment is unlabelled for up to one tick (~2 min). That is
the deliberate trade.

### The sync UI has to represent this pass — and the ordering that makes it possible

A sync has **two halves**. The GitHub walk stores the text; this pass produces the badges the
board actually renders. The second cannot run inside the first (that is the whole argument
above), so it always FOLLOWS it — which means a progress indicator that ends with the walk
announces "complete" while the model is still working.

That was not just a copy problem, it was structural. `runSyncForRepo`'s `finally` used to clear
the repo's progress and release it, and only THEN kick the tick:

```ts
running.delete(repoId); clearSyncProgress(repoId);   // ← client can now observe "all idle"
if (isSeverityApiConfigured()) void runMlEnrichmentTick(log);   // ← …and only now does it start
```

A client polling both halves could land in that window, see every repo idle and no scoring in
flight, and correctly conclude the sync was over. **The kick now comes first**, which works
because `runMlEnrichmentTick`'s guards and its `running = true` all sit **before its first
`await`** — so by the time `void …` returns, `/api/ml-status` already reports the scoring phase
and the window does not exist. ⚠ Introducing an `await` above that assignment silently reopens
it; `sync-manager.test.ts` pins the ordering (and was mutation-tested against the old order).

**`GET /api/ml-status`** (account-wide — the worker's own grain) is what the SPA polls. The
client-side predicate is `isMlScoring` in `hooks/useMlLabels.ts`, and its whole job is that
**backlog is not the same as work in flight**. `pending > 0` alone spins an indicator forever in
four real states, each a worse lie than the premature "done" this replaced:

| state | signal |
|---|---|
| URL set, nothing listening (a dev box without the sibling repo running) | `serviceHealthy: false` |
| worker backed off after 5 failing ticks | `pausedUntil` |
| **a comment the service rejects** — the candidate query is "has no label row", so a batch it 500s on is re-selected every tick forever | last tick `failuresThisRun > 0` **and** `scoredThisRun === 0` |
| genuinely drained | `pending === 0` |

That third row was not hypothetical: one PR comment in this repo's own dev database reliably
500'd the severity-api — the 6 000-char `ML_BODY_MAX_CHARS` trim cut it **mid-emoji**, leaving a
lone UTF-16 surrogate — and because a batch failure sets `hardFailure` and abandons the workspace
for that tick, **that one comment blocked its whole workspace's backlog**. Both ends are fixed
now (`truncateOnCodePoint` here, input sanitising in the service), but the predicate stays: any
input the service rejects has the same shape. A partial failure is still progress, though —
a tick that scored 300 and lost one batch keeps its indicator, or one bad comment anywhere in a
large corpus would suppress the indicator for the entire sync.

`serviceHealthy` tracks **reachability only**. `severity-client.ts` throws `SeverityApiError`
carrying a `status` (`null` = never answered), because "the service is down" and "the service
rejected this batch" have different consequences and a bare `Error` made them indistinguishable
— conflating them made a healthy service read as down the moment one comment 500'd.

UI surfaces, all in `SyncStatus.tsx` / `SyncProgressModal.tsx`:

- the header refresh glyph **spins for both halves**,
- the sync menu says `scoring bot comments — N to go` once the walk is done,
- the modal grows a **Scoring bot comments** row with its own bar (denominated by the
  high-water mark of `pending` this round, since the backlog is only known once it exists and
  then SHRINKS), and its header says "Scoring bot comments…" rather than "Sync complete",
- the modal auto-closes only when BOTH halves are idle — but once every repo is done its footer
  button becomes **"Continue in background"**, because a first backfill's scoring pass can run
  for the better part of an hour and the board is already usable.

### Batching: the character budget is the real one

The model truncates at **512 tokens**, and a batch **pads to its longest member**. So one 6 k-char
walkthrough dropped into a batch of 128 short comments makes all 128 cost like the walkthrough.
The worker therefore:

1. pulls a **pool** (≥512 candidates) newest-first,
2. trims each body to `ML_BODY_MAX_CHARS` (6 000 — past ~2.5 k chars the server discards it
   anyway; this only bounds the request payload) via **`truncateOnCodePoint`, never a bare
   `slice`** — see the landmine below,
3. **sorts the pool by body length** so each batch is internally uniform,
4. fills batches to `ML_BATCH_MAX_CHARS` (24 000) **and** `ML_BATCH_MAX_ITEMS` (128, service
   cap 256),
5. runs `ML_CONCURRENCY` (2 — the deployed service runs 2 uvicorn workers; more just queues)
   requests at a time until `ML_TICK_BUDGET_MS` (90 s) is spent.

Measured effect of step 3 on the dev corpus: **482 labels in 71 s** (≈6.8 items/s) versus the
~3 items/s an unsorted batcher gets on the same machine.

**Tenant fairness.** A tick's budget is finite and one workspace can eat a whole pool of it, so
the account list is walked from a **rotating cursor** rather than always from account 1 —
otherwise a busy tenant at the front starves everyone behind it not just this tick but every
tick. Same reasoning as the auto-merge runner's least-recently-checked ordering; the cursor is
process-local and a restart resetting it is harmless.

Failure handling: a batch failure aborts that workspace for the tick and counts once; five
consecutive failing ticks pause the worker for 10 minutes. Nothing is written on failure, so a
retry costs only the round trip. The tick **never throws** — the service being down (the normal
state of a dev machine without the sibling repo running) must not disturb anything else.

---

## Who counts as a bot

`automatedReviewerUserIds(accountId, workspaceId, 'all')` — the one workspace-grain answer,
which already honours known vendor logins, auto-classification and **manual user-defined bots**
(and a manual "this is actually a human", which removes even a known vendor login).

- **Role `'all'`, not `'review'`**, on purpose. A quality check (SonarQube, Codecov, Hound)
  posts exactly the kind of finding a severity label is *for*. The role split exists to stop a
  linter's volume distorting a *reviewer's* ROI numbers, which is a different question from
  "how bad is this comment".
- **Per workspace.** A repo lives in exactly one workspace, so the comment's bot-ness is
  determined by the workspace that owns its repo. The same login can be a bot in one workspace
  and a person in another; nothing reconciles them.
- The `kind` (vendor identity) is passed to the service as its optional `vendor` hint, but only
  for the 16 real vendor names — `in_house` / `pierre` / `vendor` are not vendor names and are
  filtered out (the `vendorKindOf` predicate's shape).

### ⚠ The timing trap

`workspace_reviewers` rows are written **LAZILY, on a read of the Bots tab**
(`listDetectedReviewers`) — *never* by sync. So at the moment a comment is stored, only a
**known vendor login** is automated with zero stored rows.

Because this is a pull-based worker that re-derives the bot set every tick, that resolves
itself: CodeRabbit/Copilot/Sonar et al. are candidates from the first sync, and a purely
in-house or service-account bot becomes a candidate — **with its entire backlog** — on the next
tick after someone opens the Bots tab once or marks it manually. No backfill trigger, no
catch-up path, nothing to remember.

A push-based hook in `persistPr` would have had the opposite property: it would silently skip
exactly the user-defined bots the feature is meant to cover.

---

## Data model

One new core table, **`ml_comment_labels`** (schema.sqlite.ts / schema.pg.ts;
migrations `0047` / pg `0034`). One row per classified target.

| column | notes |
|---|---|
| `account_id`, `repo_id`, `pr_id` | denormalised; all three FKs **cascade** |
| `target_kind` | `review_comment` \| `pr_comment` \| `review` (the review **body**) |
| `target_id` | the target's own PK **within its kind** — three different id spaces |
| `author_user_id` | the bot (`users.id`) |
| `severity`, `severity_ord`, `severity_prob` | `nit`…`critical`; ord 0–3; confidence 0–1 |
| `categories`, `category_probs` | multi-label list + the full 9-key probability map |

> **severity-api v2 (2026-08).** Three integration changes shipped together:
> 1. **`praise` is the 9th category** — a NON-finding (the bot acknowledging a fix, confirming
>    a resolution, withdrawing a concern, or pure thanks). Praise rows are stored like any
>    label but excluded from every severity-weighted rollup number, exactly like summaries
>    (`totals.praise` / `row.praise` count them).
> 2. **`path` + `diff_hunk` are sent when available.** The v2 model's input is
>    `path [SEP] body [SEP] diff`; path comes from the review thread, hunks exist only when
>    `PERSIST_BODIES=true` (set it, then run a Deep re-sync so the re-fetch stores hunks).
>    Both fields are optional — older artifacts ignore them.
> 3. **Deep re-sync purges the repo's ML labels** and kicks an immediate enrichment tick, so
>    the whole corpus is re-scored against the currently served model — the supported
>    "backfill against the new model" gesture. ⚠ It was for a while the ONLY way to know what
>    scored a row: the `model_version` stamp was a constant through an artifact swap (landmine
>    below), so re-scoring is what *makes* a corpus one model's, not the stamp.
>    Ordinary syncs — including a freshly added repo's initial backfill — also kick a tick on
>    completion, so new comments get labels without waiting for the cron.

| `is_summary` | PR walkthrough/summary rather than a specific finding |
| `vendor_severity`, `vendor_severity_confidence` | **the bot's OWN badge**, read off its markup by the service's deterministic marker parser (`nit`…`critical`; `high`/`medium`/`low`). Both **nullable** — most comments carry no badge, and an older severity-api omits the fields entirely, so the client reads them defensively. Stored to be SHOWN BESIDE ours and for nothing else; see the landmine. Recoverable for old rows without re-scoring anything — `pnpm ml:reparse-badges`, above |
| `backend`, `model_version` | verbatim from the service — and a `model_version` is worth something only if it MOVES when the artifact does; see the landmine |
| `body_hash` | sha256 of the text **actually sent** (trimmed + capped) |
| `target_created_at` | the source comment's timestamp |

Indexes: `mcl_account_target` (**unique** `account_id, target_kind, target_id` — the conflict
target for every writer), `mcl_account_pr_idx` (the per-PR badge index),
`mcl_account_repo_author_idx` (the rollup).

**Why the row denormalises four ids it could join for.** `target_kind` is polymorphic across
three tables, so every scoped read would otherwise be a three-way UNION of joins — including
the rollup, which groups by author across a whole workspace. These are *snapshot* facts about
an immutable parent (a comment never changes PR or author), not a second writable copy of a
live fact, so the "one fact, one grain" rule is not in play.

**`target_id` is not a foreign key** — it lives in three id spaces, so no single FK can express
it (the same shape the plugin's `pr_comment_annotations` uses). Cleanup rides the cascading
`pr_id` FK, which is why this table is deliberately **absent from `deleteRepo` and
`deletePrSubtree`** (the `search_index` precedent). It **is** in `accountScopedTables()` and is
deleted explicitly in `eraseAccountData`, because erasure must not depend on which dialect
enforces FKs.

---

## API

| Method & path | Purpose |
|---|---|
| `GET /api/prs/:id/ml-labels` | **THE per-PR index** → `PrMlLabelsResponse`. Every badge on the page reads this one query (React Query dedupes; `staleTime: Infinity`), so a 60-thread PR costs one request, not 60. A target with no label is simply absent. Ownership 404 via the getter. Carries the vendor's own badge (`vendorSeverity` / `vendorSeverityConfidence`, both nullable) alongside ours, purely so the client can render the disagreement. Rate tier `read` — recorded explicitly, not inherited, because it sits inside the `/api/prs/<id>/` family whose other members hydrate from GitHub |
| ~~`GET /api/bot-severity`~~ | **DELETED** (the consolidation cut list). The Bots rail's severity surface lives entirely on `/api/bot-analytics` (the WINDOWED `ml` block + per-vendor `ml*` fields, computed by `getMlWindowAggregates`); a corpus-wide, unwindowed twin with no SPA consumer was one more predicate to hold in parity for zero renderers. `getBotSeverityRollup` STAYS in `db/ml-labels.ts` as the documented reference for the findings-only exclusion semantics the merged fold mirrors; `useBotSeverity`/`botSeverityKey` and the client method are gone with the route |
| `GET /api/bot-analytics/vendor/:key/comments?window&workspace&repoIds[&fromMs&toMs]` | The per-bot COMMENTS drill-down → `BotVendorCommentsResponse`: everything one automated reviewer said in the ROI window (inline review comments with path + thread state, PR comments, non-empty review bodies), each row's `MlLabel` shipped **INLINE** via a LEFT JOIN on `(account_id, target_kind, target_id)` — one request, never the per-PR index per row. Capped 3 000/source, newest-first, `truncated` flag. `key` = `u<userId>` \| `'pierre'` (the sentinel answers empty — verbatim reviews are human-posted); anything else 400s. Lives in `db/ml-labels.ts` (`getBotVendorComments`) — deliberately NOT a re-export of `getBotReviewComments`, whose row shape is lockstepped into `packages/pro` and which is role-`'review'` while this also serves quality-check rows. Its `window` parameter was widened to the `getBotAnalytics` form (`BotWindowKind | {kind, fromMs, toMs}`) so the People report's per-bot evidence cards can cover a COMPLETED period; the optional `fromMs`/`toMs` query pair is route-validated (only-together, ordered, span ≤ 200d, else **400**) and applied under the `toBound` rule below. ⚠ **Rate tier `search`** (bodies + a three-way label join); its `/prs` sibling stays `read` (metadata only). Pinned in `rate-limit.test.ts` |
| `GET /api/ml-status` | The worker's live state → `MlEnrichmentStatus` (incl. `unscorable`, the NULL-body legacy population — never part of `pending`), so the sync UI can show the scoring pass (above). **NO scope parameter** — the worker walks every workspace, so a workspace-scoped backlog would under-report the work actually running. Same `search` tier as the rollup, for the same reason (its backlog half is those unlabelled-count joins, once per workspace) — plus a ~3 s per-account cache on the scan, because this one is POLLED and a tier bounds request count, not per-request work |

Both are **pure reads**. There is no generate endpoint and no mutating verb: the model is only
ever called by the background worker, so no request can spend anything.

### ⚠ The windowed fold's UPPER bound is conditional — `toBound`

`getMlWindowAggregates` and `countBotText`/`countUnlabelledBotText` gained a `to: Date | null`
parameter alongside `from`, threaded from `getBotAnalytics`. **It is a `Date` ONLY when the
caller holds EXPLICIT bounds** (the People report's completed period), and is then applied
half-open (`lt`, the routes' stated `[fromMs, toMs)` contract, matching `person-period.ts`'s
spelling so a boundary-ms row lands in exactly one period). Under the ENUM window form it is
`null` and the scan carries **no upper predicate at all**.

Both halves of that rule are load-bearing, and each was learned the hard way:

- **Without any upper bound**, a bot still labelling after a completed period leaked those rows
  into that period's counts, weekly buckets and cap budget — the "one row must never mix two
  populations" defect at the bot grain. The same one-sided predicate was in the automated thread
  scan and `mergedPastRows` on the `getBotAnalytics` side.
- **With an UNCONDITIONAL upper bound**, the enum form (whose `to` ≡ `Date.now()`) excluded rows
  written in the CURRENT SECOND — these columns are second-granular on sqlite — which flaked
  `verify:isolation` non-deterministically. It also broke byte-identity between this scan's
  `WHERE` and `foldBotFlaggingPopulation`'s, and that identity is what makes "an Inflation count
  IS the flagging drill-down's `filteredTotal`" true (the drill-down only ever serves enum
  windows).

Newest-first ordering still holds under either form, so the in-window rows remain a prefix of
any widened (`trendFrom`) scan.

`toWireLabel` is now EXPORTED from `db/ml-labels.ts` for the person-period evidence fold, which
attaches stored labels to a handful of capped comment rows — same coercions, one spelling.

---

## UI

- **`MlSeverityBadge`** (`components/MlSeverityBadge.tsx`) — a pill in a comment's header row,
  plus the category chip and a `summary` marker. Renders **nothing** without a label, and never
  fetches: the caller passes a label it already found in the shared index.
- **The vendor's verdict, shown only when it DIFFERS.** `vendorSeverity` rides the same per-PR
  index; agreement stays silent (two pills saying the same thing is noise). The point is to make
  the contradiction legible where the user is already looking — a badge reading `minor` under a
  comment CodeRabbit itself headed `🟠 Major` otherwise reads as our bug, when it is our answer
  and the better one (Accuracy above). It is a display of the vendor's claim, never a correction
  of ours.
- **`CommentBlock`** — the per-comment badge on a review-thread comment. Covers **all eight
  `ThreadCard` mount sites** for free (Threads tab, feed inline threads, attention cards, theme
  drill-down, search results, both diff-view mounts).
- **`ThreadCard` header** — the thread's **worst non-summary severity**, so a conversation can
  be triaged collapsed. Summaries are excluded: a vendor walkthrough scored `major` would
  otherwise flag every thread it sits in.
- **`PrDetail` conversation** — PR comments (`pr_comment`) and review bodies (`review`) in one
  list. The lookup **must** key on `it.kind`: those are separate id spaces on separate tables,
  and a badge that assumed one kind would find a different row's label and be confidently wrong.
- **`ThreadList` severity pills** — filter the Threads tab. A thread matches when **any** of its
  non-summary comments carries a selected severity (not when its *worst* equals it — filtering
  to "major" should surface the thread with one major among five nits). The row hides itself
  entirely when nothing on the PR is labelled.
- **The merged Bots ROI table (`BotRoiPanel`) — PAID (`botDepth`)** — the severity surface on the
  Bots rail. ⚠ **THIS IS WHERE THE TIER LINE FALLS, AND IT IS A GRAIN LINE, NOT A FEATURE LINE.**
  Everything ABOVE this bullet — the per-COMMENT badge, `ThreadList`'s severity pills, the per-PR
  `BotTriageCard` grade, all served by the untouched, free `GET /api/prs/:id/ml-labels` — stays
  FREE ON EVERY TIER: the ruler is free. Everything in THIS bullet is the workspace-grain
  SCOREBOARD folded from those labels, and it is paid: the `MlTotalsStrip`, the per-vendor `ml*`
  columns, the Inflation column *counts included*, and the flagging drill-downs behind them. An
  unentitled `/api/bot-analytics` carries no `ml` block and no `vendors[]` at all. The
  old standalone `BotSeverityPanel` (its own `/api/bot-severity` fetch, corpus-wide while every
  panel around it was windowed) is RETIRED; what survives, all computed from the ONE windowed
  `/api/bot-analytics` response (`ml` block + per-vendor `ml*` fields), is:
  - the **"What the bots are flagging" totals strip** (`MlTotalsStrip`): findings vs
    walkthroughs, high-severity share, nit share, top topic, top-category chips, the severity
    legend. States its own windowed **coverage** ("527 of 626 bot comments in this window
    scored (84%)"), announces a truncated scan, and calls out a marker-fallback deployment.
    Its fifth tile, **"Same-line overlap"**, is the one number on this strip that is NOT model
    output: `totals.overlapClusters` counts the window's ±3-line clusters that more than one
    review bot flagged (`db/line-overlap.ts`; quality checks and null-line threads excluded).
    It rides `totals`, not the `ml` block, for exactly that reason — and it is **not** the sum
    of the rows' `overlapThreads`, since a cluster credits every bot in it.
  - **three ML columns on the VendorTable** (severity-mix `SeverityBar` — now exported from
    `MlSeverityBadge.tsx` — plus High % and Nit %), hidden entirely when `mlSeverity` is false
    or nothing in the window is labelled. ⚠ A bot with no in-window labels ships the `ml*`
    fields **ABSENT** and renders **blanks, never zeros** — "not scored" and "zero findings"
    are different claims. Every rate divides by FINDINGS (the phantom-gap rule).
  - **four more columns under a grouped "Not addressed by severity" header**
    (`notAddressedBySeverity`, same `showMl` gate, zeros blanked): the untouched threads split
    by the severity of the finding that OPENED each one — the label on the thread's FIRST
    comment by its own bot (`review_comment` targets; addressed threads, praise and summaries
    excluded). ⚠ **They need not sum to the "Not addressed" column** and must never be
    presented as if they did: a thread whose opening comment was never scored counts in that
    total and in none of these four. One query over the whole scope (the ids are collected
    during the human-follow pass), never a per-vendor fan-out.
  - the **nit-ratio tuning suggestion**: findings ≥ 20 AND nit share ≥ 0.7 → a
    `BotTuningSuggestion` filling its (previously always-null) `severity` slot; skipped for
    quality checks.
  - ⚠ **THE VERDICT IS NO LONGER ML-FREE**, and this is the one place a label changes a
    judgement. A bot past those SAME two gates (`ML_NIT_MIN_FINDINGS` / `ML_NIT_MIN_SHARE` —
    ONE pair of constants shared by the suggestion and `botVerdict`, so the chip and the
    advisory under the table cannot contradict each other) is **escalated `keep` → `tune`**.
    Escalation ONLY: `tune` and `noisy` are never softened, and nothing about a label can
    produce `noisy` — "mostly nits" is a tuning fact, not evidence the bot is being ignored.
    The gate reads the RAW share, not the rounded `mlNitPct` the column shows, and never
    `vendorSeverity`. Matrix pinned by `bot-analytics-verdict.test.ts`; the fold, the split and
    the overlap count by `bot-analytics-ml.test.ts`.
- **The workspace ML charts moved to the PAID depth tier and the ROI table** (the
  consolidation's C2/P1.2). `BotBehaviourPanel` and the Bots "Behaviour" tab are DELETED;
  `/api/bot-behaviour` moved into the plugin as `GET /api/pro/bot-behaviour` (`botDepth`), still
  carrying the additive `ml` block (`BotBehaviourMl`) with its two grains — flat counts describe
  the SELECTED WINDOW, `weekly` covers the 84-day trend span on the SAME `weekStarts` boundaries
  as `trend` (a second copy of that arithmetic is how two charts come to disagree by a week with
  nothing failing) — and the same role-`'review'` bot set. Where the seven charts went:
  - **The severity INFLATION INDEX is now the ROI table's Inflation column** (`mlInflation` on
    the same `/api/bot-analytics` vendor row). ⚠ **THE WHOLE COLUMN IS PAID NOW, counts included** —
    it used to be a split tier (current-window `overCall`/`underCall` COUNTS free, history paid),
    but the cell is a cell of the vendor table and that table went behind `botDepth` in one piece,
    so an unentitled account receives no `vendors[]` to draw it in. The ≤12-week `weekly` sparkline
    keeps its own absent/present flag anyway (`inflationHistory` in `getBotAnalytics` — absent,
    never an error), because it is an extra scan WIDTH rather than just a field to drop.
    The semantics travelled unchanged: `vendorAgree`/`vendorOverCall`/`vendorUnderCall` partition
    the bot's BADGED findings on the `vendorDeclared` denominator (`agree + over + under ===
    vendorDeclared`, exactly as `SeverityAgreementMatrix` has it); an unbadged finding is SILENCE
    and counts in none; direction comes from the ONE exported `vendorAgreementOf`
    (`db/ml-labels.ts`), shared with the confusion matrix and the flagging drill-down's
    `disagree` refinement. ⚠ **COUNTS, never shares — and a bot that badges nothing renders a
    DASH ("no badge is silence, not agreement"), NEVER a zero**: it has no over-calls because it
    makes no calls, and a 0 would read "never inflates" (within a badged bot a 0 IS real). Each
    count is a CLICK-THROUGH to `BotFlaggingDetail` on `{kind:'findings'}` + `disagree` + this
    bot as a ONE-MEMBER set — the exact opener the removed charts used — so the number clicked IS
    the list's `filteredTotal`. ⚠ The bot set and the direction still ride the STORE SEED (two
    cells open the same selector; `refineQueryKey` carries the numerically-sorted set in its own
    `|bot:<id>|` slot — the narrowing is server-side, so a key without it serves one bot's list
    from another's cache entry). Nothing here corrects, seeds or breaks a tie for our severity;
    the vendor badge is the thing being MEASURED, never an input (0.474 vs 0.700 exact — see
    Accuracy).
  - **§ The enlarged inflation chart** — `InflationHistoryChart`
    (`components/Activity/InflationHistoryChart.tsx`), a fourth full-width `ChartCard` in
    `BotRoiPanel`'s existing chart row, gated on the SAME `showMlColumns` flag as the column it
    enlarges. The 52×14px cell sparkline is `aria-hidden` and stays that way; this card is the same
    `mlInflation.weekly`, same two direction hues, at a size that can carry a **key**, an **axis**
    and a **hover**. It costs no request — the panel already holds the rows. What it must keep:
    ⚠ **it plots COUNTS, never a rate** (there is no weekly `badged`/`agree` on the wire — the
    server buckets only disagreements — so a weekly share has no denominator to be computed from);
    ⚠ **it is ONE SMALL PANEL PER BOT, two lines each**, because direction already owns the amber/
    violet channel and 2N lines in two hues would leave vendor identity with nothing to ride on
    (the bot's own hue appears on the panel's NAME DOT only); ⚠ **each panel keeps its own y-scale**
    exactly as each row's sparkline did, which the axis now makes visible, so the caption says to
    read heights within a bot and never across; ⚠ **it states its own span** — a fixed 12 weeks
    (84 d, `trendFrom = min(from, now − 84d)`) beside a table whose Inflation counts follow the
    7/14/30-day picker, two grains on one panel that the sparkline could hide only because it had
    no axis; ⚠ **the marks are NOT clickable** — `/api/bot-analytics/flagging`'s `refine` has no
    week narrowing, so a per-point click could only open the whole 84-day list under a caption
    naming one week, breaking the "the number clicked IS the list's `filteredTotal`" identity the
    cell's counts hold; and ⚠ **the three absences are three different sentences** — no
    `mlInflation` at all (no in-window labels ⇒ absent and unnamed), `badged === 0` (⇒ **omitted and
    NAMED**, never a flat zero line, the cell's dash rule one grain over), and a badged bot whose
    `weekly` the server dropped for being all-zero (⇒ named as a MEASUREMENT: it made calls and we
    agreed with every one). Pure fold + its rules: `apps/frontend/test/inflationHistory.test.ts`
    (hand-run; the frontend suite is not in CI).
  - **The per-bot severity-over-time slice + category mix live on the per-bot DEPTH tab**
    (`BotDetailPanel`, the `bot-detail` pinned drill-down, Pro `botDepth`): `MlSeverityTrendChart`
    over a single-bot view — the nit(1)…critical(4) `yDomain` survives (the default 0→niceMax
    scale ticks at 0 and 5, two values a severity cannot take), and **a week with no findings is
    a GAP, never 0** — there is nothing below `nit`. `WorkspaceBotCharts` keeps exactly what that
    tab imports (`MlBotView`, `MlSeverityTrendChart`, `useBotSubset`).
  - **CUT with no successor**: both "Severity mix per bot" chart twins, "Categories per vendor"
    and "Category activity over time". ⚠ **The two standalone inflation ChartCards are NO LONGER on
    this list**, and the sentence that used to put them here is retired with the claim. What P1.2/C2
    cut was two *workspace-grain* cards on `WorkspaceBotCharts`, and nothing has returned there —
    that surface is fed by `/api/pro/bot-behaviour`, whose weekly points carry severity and category
    only. Inflation history came back one grain in, as **`InflationHistoryChart` in `BotRoiPanel`'s
    own chart row** (§ The enlarged inflation chart, below). The `inflationSummary` fold in
    `lib/botMlSeries.ts` still survives with its tests, unrelated and unused by that card.
  - ⚠ **The two exclusions still differ, deliberately**: severity counts are FINDINGS-ONLY
    (summaries and praise out, the phantom-gap rule) while CATEGORY counts cover every
    non-summary row, so `praise` is a category in its own right. Pinned by
    `db/bot-behaviour-ml.test.ts`; the pure series maths is `lib/botMlSeries.ts` +
    `apps/frontend/test/botMlSeries.test.ts`.
- **The Comments drill-down (`BotPrsDetail`)** — a PRs | Comments sub-view toggle on the bot
  drill-down tab (state local to the tab; window/scope shared with the panel; the visible view
  is DERIVED for the 'pierre' sentinel, never written back). Rows: severity badge from the
  label shipped **inline** on the response row, category chips, full-markdown body, path +
  thread-state chip, PR link; sortable Newest | Severity (worst first; summaries and unscored
  rows sink — the `worstSeverity` rule). Client-windowed rendering (full markdown × 3 000 rows
  is a paint stall). Severity chrome hides when `mlSeverity` is false; the list still renders.

Store: `threadSeverityFilter` is a **global** field, so `PrDetail` applies it only when
`selectedPrId === prId` — the same guard `threadStateFilter` needs, for the same reason (a PR
opened via a pinned tab would otherwise inherit another PR's preset and silently hide threads).

**Deliberately NOT badged (yet):** `CommentCard` (the Pro theme drill-down) and the Feed's
PR-comment / review card bodies. Both are cross-PR lists, so a badge there would need one
per-PR index query *per card*. The feed's inline **threads** do get badges, because those go
through `ThreadCard` and each names a single PR. The sanctioned cross-PR pattern is the
Comments drill-down's: ship the label INLINE on each row of ONE response, server-side.

---

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `SEVERITY_API_URL` | *(unset)* | **The gate.** Base URL of the severity-api. Cloud: `http://severity-api.railway.internal:8080`. Local: `http://127.0.0.1:8799`. Unset ⇒ the whole feature is inert |
| `ML_SEVERITY_DISABLED` | `false` | Kill switch for a deployment that has the URL set |
| `ML_ENRICHMENT_CRON` | `*/2 * * * *` | The worker tick |
| `ML_TICK_BUDGET_MS` | `90000` | Wall-clock ceiling per tick (kept under the cron period) |
| `ML_BATCH_MAX_ITEMS` | `128` | Items per request (service hard cap 256 → 422) |
| `ML_BATCH_MAX_CHARS` | `24000` | **The budget that matters** — see batching above |
| `ML_CONCURRENCY` | `2` | In-flight requests (matches the deploy's 2 uvicorn workers) |
| `ML_REQUEST_TIMEOUT_MS` | `120000` | Generous: cold start loads a ~150 MB model |
| `ML_BODY_MAX_CHARS` | `6000` | Client-side trim; the model truncates at 512 tokens regardless |

Cloud wiring: set `SEVERITY_API_URL` on the **backend** service to the severity-api's private
DNS name. Both services must sit in the **same Railway project + environment** for private
networking to resolve, and severity-api must **not** get a public domain (it is unauthenticated
by design).

---

## Running it locally

**`pnpm dev` starts it for you.** With the two repos as siblings there is nothing to configure:

```bash
pnpm dev     # severity-api (:8799) + backend (:4000) + frontend (:5173)
```

`scripts/dev.mjs` decides ONCE whether the service can be started (sibling repo present, `uv`
installed, not disabled) and uses that one answer for two things: whether to launch it, and
whether to point the backend at it. Those must not be able to disagree — a backend aimed at a
severity-api that is not running would report `mlSeverity: true` and show a scoring backlog
nothing is draining, which is worse than the feature being quietly off. `scripts/dev-ml.mjs`
runs the sibling's own `scripts/serve_local.sh` (which hydrates the Git-LFS model on first run);
`pnpm dev:ml` runs just the service in its own terminal.

**Every "can't run it" path prints one line and exits 0** — the submodule is optional, and a
clone without `--recurse-submodules` must get exactly the dev loop it always had.

| Var | Effect |
|---|---|
| `PIERRE_ML_DIR` | override the submodule location (default `packages/ml`) |
| `SEVERITY_API_PORT` | port to serve on (default 8799) |
| `SEVERITY_API_WORKERS` | uvicorn worker processes (default **2**, to match `ML_CONCURRENCY`) |
| `PIERRE_ML_DISABLED=1` | run the app without it |

⚠ **`SEVERITY_API_WORKERS` and `ML_CONCURRENCY` are two halves of one number.** The client sends
`ML_CONCURRENCY` (2) requests at once *because the deployed service runs two uvicorn workers* — so
a one-worker local service is the single topology the shipped defaults do not fit. Both batches
serialize on the one worker, and since the category axis moved to a model head each batch costs
**two** ONNX forwards rather than one, so the second batch reliably outran the client's 120 s
`ML_REQUEST_TIMEOUT_MS`. The failure reads as a lie from both ends: the client reports
`severity-api unreachable`, while the server logs **nothing at all** — it never finished the
request it was still working on, and uvicorn only logs on completion. `serve_local.sh` therefore
defaults to 2. Raise both together to drain a large backlog; lower both together on a memory-tight
box (each worker resident-loads both ~150 MB int8 heads).

⚠ **The URL is exported as `SEVERITY_API_DEFAULT_URL`, never as `SEVERITY_API_URL`**, and
`config.ts` reads it only as a fallback. `process.loadEnvFile` does **not** overwrite an
already-set variable, so putting `SEVERITY_API_URL` on the dev command line would have BEATEN
whatever is in your `.env` — the exact inverse of what a default should do. An explicit
`SEVERITY_API_URL` (shell or `.env`) always wins, and nothing but the dev script sets the
fallback. A custom `SEVERITY_API_PORT` therefore needs an explicit `SEVERITY_API_URL` too;
`dev.mjs` prints the URL it chose so a mismatch is visible.

Prereqs on the machine: [`uv`](https://docs.astral.sh/uv/) and `git-lfs`
(`brew install git-lfs && git lfs install`) — the 150 MB ONNX model is LFS-tracked.
`db: "unavailable"` in `/health` is expected locally; `/score/*` needs no database.

Doing it by hand (or against a service you host elsewhere) is unchanged:

```bash
SEVERITY_API_PORT=8799 packages/ml/scripts/serve_local.sh &
until curl -sf http://127.0.0.1:8799/health | grep -q '"taxonomy":true'; do sleep 1; done
echo 'SEVERITY_API_URL=http://127.0.0.1:8799' >> .env
pnpm dev
```

**Check you are on the real model, not the fallback.** `models_loaded.taxonomy: false` means the
ONNX model did not load and the service is answering from the marker heuristic — it still
answers, so nothing errors, it is just materially worse. Three places surface it: the backend
logs it once at boot, every stored row carries the `backend` string, and the Bots panel shows a
banner when every label in scope came from the fallback. The fix is `git lfs pull` in
`packages/ml` and a restart.

**If you do want Docker** (not wired into this repo's dev loop): the ML repo's `serving` stage
already loads the real model — `serving_assets/` is deliberately *not* in its `.dockerignore`
and the image sets `BOT_MONITOR_MODELS_DIR=/app/serving_assets`. Build it directly rather than
via `docker compose up api`, which pulls in a Postgres the `/score` endpoints do not need:

```bash
docker build --target serving -t severity-api packages/ml
docker run --rm -p 8799:8000 -e PORT=8000 severity-api
```

Verify with `/health` exactly as above; if it reports `taxonomy:false`, run `git lfs pull` in
`packages/ml` **before** building — the image copies whatever is in the working tree, and a fresh
clone has only the LFS pointer.

### Draining the backlog / re-labelling everything

```bash
pnpm ml:enrich            # keep running ticks until the backlog is drained
pnpm ml:enrich --once     # one tick
pnpm ml:enrich --reset    # DELETE every stored label first, then refill
```

`--reset` is the **full-refresh** lever. A stored label has no other invalidation path (see
"Known gaps"), so re-labelling after a model upgrade means clearing and refilling. The script
drives the same worker the scheduler runs; it needs `SEVERITY_API_URL` set and refuses to start
without it.

### Backfilling the vendor's own badge (no model, nothing else moves)

```bash
pnpm ml:reparse-badges            # fill in every missing vendor badge
pnpm ml:reparse-badges --dry-run  # report what WOULD change, write nothing
pnpm ml:reparse-badges --all      # also re-parse rows that already carry a badge
```

**The gap it closes.** `vendor_severity` arrived after ~23 k rows already existed, and three
high-volume vendors got a marker parser later still — so a large share of the corpus reads
"no badge" for comments that visibly carry one. Measured in this repo's dev DB before the
sweep:

| vendor | labelled | badged | what the body actually carries |
|---|---|---|---|
| `deepsource-io` | 4 655 | 0 | `severity_indicator_<name>.svg` in the header `<picture>` |
| `chatgpt-codex-connector` | 518 | 0 | a shields.io `![P2 Badge]` (P0→critical … P3→nit) |
| `cursor` | 329 | 0 | `**High Severity**` (High/Medium/Low → major/minor/nit) |

**Why it is not `--reset`.** A reset re-scores everything against whatever artifact is served
today, which moves *every* number on screen — severities, the category mix, the Bots table's
verdicts, the agreement matrix — as a side effect of wanting one missing badge. This command
calls `POST /markers/vendor-severity`, the service's marker-only endpoint: it takes no
`Services` dependency, never loads the model, and its response carries **only** the two vendor
fields, so a caller physically cannot write anything else. Host-side it writes exactly
`vendor_severity` + `vendor_severity_confidence` — not even `updated_at`, which means "when
this label was produced" and no label was produced. `sync/reparse-vendor-badges.test.ts`
asserts every other column is byte-identical before and after.

Four rules worth knowing before running it:

- **The vendor is derived from the GitHub LOGIN, never `workspace_reviewers.kind`.** That column
  is written once, lazily, and never re-derived — `deepsource-io` and `chatgpt-codex-connector`
  both sit at `kind='in_house'` in this very database, which maps to no hint at all, so a sweep
  reading the stored kind would recover nothing while looking like the parser is broken. It goes
  through `vendorHint()` (exported from `sync/ml-enrichment.ts`) so it dispatches on the same
  string the enrichment worker scores under.
- **A null parse never clears an existing badge.** The endpoint answers null both for "this
  vendor declared none" and for "I have no parser for this vendor" — indistinguishable from
  here — so clearing on null would let a parser regression or a rolled-back service silently
  erase the column. `--reset` remains the deliberate way to clear one.
- **A null answer is a normal, final result.** `sonarqubecloud`, `greptile-apps`,
  `github-code-quality` and Copilot's prose comments genuinely declare no severity, and so does
  a badge vendor's un-badged comment (Cursor's `<!-- BUGBOT_REVIEW -->` roll-up). Nothing
  synthesizes one — the stored value is rendered as *that vendor's own call* next to ours, so
  inventing it would put words in a third party's mouth.
- **Re-runnable rather than incremental.** There is no persisted "already re-parsed" marker,
  because the only place to keep one is a column this command may not write. A completed sweep
  re-run reports `updated: 0`, and the rows that legitimately declare nothing are simply
  re-read; the default (NULL-only) selection keeps that cheap, and no model time is spent
  either way. If this ever becomes a background worker rather than a one-off, that is when it
  needs a `vendor_parse_version` column.

It prints a per-vendor summary — scanned / gained / changed / unchanged / no claim — which is
the coverage jump, and exits non-zero if any batch failed.

---

## Accuracy — and who is right when we contradict the bot

Two questions. The second is the one that arrives as a bug report.

### How good is the label

Macro-F1 ≈ 0.66 against a three-source consensus. **CRITICAL is the class it under-recalls**, so
the product treats **major + critical together as "high"** everywhere (the panel's headline
number, the badge tooltip). Nothing auto-acts on a label: there is no gate, no auto-resolve, no
blocking. The single judgement a label moves is the Bots table's own advisory chip — the
`keep → tune` nit escalation above — which changes a word on a row and nothing else. Categories are marker-derived (deterministic), not model output, and the list is never
empty — an unmatched comment falls back to a single low-probability best guess.

The sharper measurement is `packages/ml/data/gold/gold_v2_sample.jsonl` +
`fable_gold_labels.jsonl`: **300 comments adjudicated fresh with every existing label hidden**,
drawn from repos we know (including `erxes/erxes`) and **marker-stratified so CodeRabbit's own
verdicts are evenly represented** — 76 critical / 76 major / 76 minor / 72 none. What the
adjudication found: minor 144 (48%), major 99 (33%), nit 55 (18%), **critical 2 (0.7%)**.

Scored with the **served int8 ONNX artifact**, split-half — each half's calibration prior is fit
on the other, so the prior is not grading its own homework:

| rater | exact | ordinal MAE |
|---|---|---|
| **v2 + calibration (what ships)** | **0.700** | **0.303** |
| v2, calibration off | 0.610 | 0.440 |
| CodeRabbit's own badge | 0.474 | 0.697 (n = 228) |
| human ↔ referee ceiling | 0.700 | 0.320 |

Two things fall out of that table and both are load-bearing:

- **We are AT the human ceiling on exact agreement and inside it on MAE.** There is no headroom
  left to chase against this gold set; a better number now means a better gold set, not a better
  model.
- **The vendor is the worst of the three raters, by a distance.** On the same 300 comments
  CodeRabbit declared **76 critical**; the adjudication found **2**. This question is settled.

### ⚠ Agreement with the vendor is an ANTI-METRIC

Turning calibration off moves us sharply TOWARDS CodeRabbit — `major` agreement 28% → 48% — and
sharply AWAY from ground truth: 0.700 → 0.610 exact, 0.303 → 0.440 MAE. The two move in opposite
directions, which makes "users see fewer contradictions" a direct proxy for "the product got
worse".

**Standing rule: no change to the model, the calibration prior or the served artifact may be
justified by reducing visible disagreement with a vendor badge.** The contradictions are the
feature. They are also what gets reported as a bug, which is exactly why this is written down.

### The disagreement at scale

Live corpus, the 2 967 CodeRabbit comments carrying a HIGH-confidence vendor badge:

| what scored it | our mix (nit/minor/major/crit) | agree | we downgrade | we upgrade |
|---|---|---|---|---|
| the stored labels (a two-model blend — see the landmine) | 6/21/66/5 | 54% | 27% | 19% |
| the current v2 artifact | 3/70/22/3 | 44% | 51% | 5% |
| current v2, calibration off | 25/28/39/6 | 42% | 47% | 11% |

Per vendor class, stored labels: CR-`minor` 35% agree (we UPGRADE 52% of them), CR-`major` 73%,
CR-`critical` 16% (we downgrade 83%). Under the current artifact CR-`major` agreement collapses
to 28% — **1 080 of 1 639 CodeRabbit Majors become `minor`**. Calibration alone changes the
verdict on **44%** of comments (1 314 / 2 967), and the stored labels disagree with the current
artifact on **58%** (1 741 / 2 967).

**Why the vendor inflates** is visible in CodeRabbit's own `_Source:_` provenance footer:

| footer | n | CR says Major | we agree | we downgrade | → `nit` |
|---|---|---|---|---|---|
| (none) | 2 635 | 56% | 55% | 23% | 5% |
| `Coding guidelines` | 245 | 50% | 36% | 56% | 24% |
| `Linters/SAST tools` | 59 | 50% | 45% | 28% | 8% |

Half of its house-style-rule findings are Major. **CodeRabbit's severity conflates
rule-confidence with impact** — "I am certain this violates your style guide" and "this will
hurt" come out as the same badge. Ours does not, and that is the entire disagreement in one line.

### `severity_prob < 0.25` is an IDENTITY, not a heuristic

`severity_prob` is the RAW probability of the CHOSEN class, and the argmax of a 4-class softmax
is **always ≥ 0.25**. So **any stored label under 0.25 is one the model did not pick** — the
calibration prior overrode it. That is a free, exact "the model itself disagreed with this label"
flag, and **15% of the CodeRabbit corpus (447 / 2 967) sits in that state** under the current
artifact. We compute it, store it, and currently do nothing with it (see Known gaps).

Confidence carries signal on its own, too — agreement with the vendor rises monotonically with it:

| `severity_prob` | n | agree with vendor |
|---|---|---|
| < 0.40 | 257 | 39.3% |
| 0.40 – 0.50 | 600 | 44.2% |
| 0.50 – 0.60 | 606 | 48.7% |
| 0.60 – 0.75 | 833 | 58.6% |
| ≥ 0.75 | 548 | 70.4% |

### One worked example, end to end

`review_comments.id = 366949` — erxes/erxes #8917,
`frontend/core-ui/src/modules/search/graphql/queries/globalSearch.ts`. CodeRabbit's own header:
`_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_`. Stored label: `minor`, prob `0.4433`.
Re-scored live on the same body, the v2 artifact returns raw NIT 0.568 / MINOR 0.189 /
MAJOR 0.230 / CRITICAL 0.014 — **argmax `nit`** — and calibration lifts MINOR to 0.558.

So the shipped answer (`minor`) is the defensible one, and it is defensible for the wrong reason:
the model wanted `nit` and the prior moved it. Say that out loud, because "right answer, wrong
mechanism" is exactly the state in which the next regression is invisible — the number on screen
stays plausible while the thing producing it has changed underneath.

### What we do about it: show the disagreement, never fold it

`vendor_severity` + `vendor_severity_confidence` are stored beside our label and rendered when
the two differ. That is the whole intervention. The vendor's claim never corrects ours, never
breaks a tie, never becomes a low-confidence fallback, and never reaches the model.

---

## Landmines

- **The vendor's own badge must NEVER be an input to the model — in any form.** Not a feature,
  not a tie-break, not a fallback when our confidence is low, not a training target.
  `strip_vendor_chrome` (`packages/ml`, `parse/markers.py`) exists precisely so the model cannot
  shortcut to it, and the gold-300 adjudication says why: the vendor is the WORST of the three
  raters (0.474 exact vs our 0.700), and tuning towards agreement with it measurably degrades us
  (0.700 → 0.610). `vendor_severity` is a DISPLAY column that the scoring path never reads. See
  Accuracy above — this is settled, not open.
- **A stored model output needs a version stamp that actually CHANGES, or the corpus becomes
  un-auditable.** 17 911 of 18 662 stored labels (96%) predate the gold-calibrated v2 artifact
  that landed 2026-08-05, and the daily severity mix moved from 51/10/38/1.5
  (nit/minor/major/crit) on 08-02 to 17/80/3/0 on 08-06 — a different product, silently.
  **Every one of those rows was stamped `model_version = "taxonomy-composite-v1"`**: the literal
  was a default argument in the service (`models/taxonomy.py`), so it did not move when the
  artifact did, and the running dev service even swapped artifacts mid-day — visible only as the
  `category:marker` → `category:modernbert-onnx` split *within* 08-06. With no re-scoring path,
  the corpus was a blend of two models that no query could separate. Fixed at the source (the
  service now DERIVES `model_version` from the loaded artifact) and the corpus was re-labelled
  with `pnpm ml:enrich --reset`. The stamp is now evidence; it is still not a mechanism (Known
  gaps).
- **Vendor RESOLUTION footers are input contamination, not chrome you can leave in.** CodeRabbit
  **edits its comment in place** when a finding gets fixed, appending
  `✅ Confirmed as addressed by @user` / `✅ Addressed in commit <sha>` — so the model was scoring
  the RESOLVED comment rather than the finding. Ablation on `review_comments.id = 366949`: with
  the footer the raw argmax is NIT (0.57), without it MINOR (0.50). **802 labelled review comments
  carry one — 16% of CodeRabbit's 5 002.** Fixed in `strip_vendor_chrome`. The general shape:
  anything a vendor appends AFTER the fact is a statement about the comment's lifecycle, and
  feeding it to a severity model asks a different question than the one you meant.
- **`severity_prob < 0.25` is an identity, not a threshold anyone chose.** It is below the 4-class
  argmax floor, so it means the calibration prior overrode the model's own pick — 15% of the
  CodeRabbit corpus. Read it, don't "tune" it.
- **NEVER trim text for the model with a bare `String.prototype.slice`.** It counts UTF-16 code
  units, so a cut can land between the halves of an astral character and leave a lone surrogate —
  the one thing UTF-8 cannot encode. `JSON.stringify` emits it as a bare `\ud83d` escape, so it
  travels fine and detonates at the far end. This cost a workspace its entire backlog, from a
  single character. Go through **`truncateOnCodePoint`** (`sync/ml-enrichment.ts`), which drops
  at most one code unit and is pinned by `ml-enrichment.test.ts` (mutation-tested against the
  naive cut). Applies to `body` AND `diffHunk`; `path` is sent untrimmed.
- **The enrichment kick must stay ABOVE `clearSyncProgress` in `runSyncForRepo`'s `finally`.**
  It works only because `runMlEnrichmentTick` sets its `running` flag before its first `await`;
  an `await` added above that assignment reopens the window where a client sees both halves idle
  and declares a sync complete that has not scored anything yet. Pinned by `sync-manager.test.ts`.
- **`pending > 0` is NOT "scoring in progress".** Four states have backlog with nothing draining
  it (service unreachable, worker backed off, a batch the service rejects, drained) — go through
  `isMlScoring`, never the raw count, or the fix for a premature "done" becomes a spinner that
  never stops. `apps/frontend/test/mlScoring.test.ts` pins all four.
- **`serviceHealthy` means REACHABLE, not "working".** A 500 on one batch is an answer; treating
  it as "down" hid the scoring phase on a perfectly healthy service. The distinction lives in
  `SeverityApiError.status` (`null` = never answered) — do not collapse it back into a bare Error.
- **Never call the service inside `persistPr`'s transaction.** SQLite's `runTransaction` is a
  manual `BEGIN`/`COMMIT` on one shared connection whose stated invariant is that the callback
  only awaits in-process SQLite work.
- **Positional zipping is the whole batch contract.** `scoreComments` throws if the service
  returns a different number of results than items sent — a short array would attach one
  comment's severity to a different comment, which is worse than no label.
- **The unique is `(account_id, target_kind, target_id)`.** A stale `onConflictDoUpdate` target
  type-checks perfectly and fails only at runtime, only when a row is actually written.
- **Nothing inside the concurrency workers may throw.** Two run under one `Promise.all`; a throw
  rejects the whole thing, propagates past the `finally` that clears the re-entrancy flag, and
  leaves the SIBLING running detached — still POSTing and writing while the next tick believes
  it is alone. The DB write is inside the same try as the HTTP call for exactly this reason.
- **A label that is never WRITTEN is a poison pill.** The candidate query is "has no label row",
  so any target the worker declines to store is re-selected on every tick forever. That is why an
  unrecognised severity word falls back to the numeric ordinal instead of being dropped, and why
  SQL — not JavaScript — decides candidacy.
- **Severity counts are FINDINGS-ONLY.** `is_summary` is a separate axis, so a walkthrough still
  carries a severity. Counting those in `bySeverity` while every rate divides by `findings` let
  "high severity" exceed 100% — a vendor posting one MAJOR-scored walkthrough per PR reaches it
  reliably. Summaries have their own counter and nothing divides by `labelled`.
- **The rollup's 50 k scan cap needs an ORDER BY and must announce itself.** Without the order,
  a truncated scan returns storage-engine order — which differs by dialect and shifts on Postgres
  after an UPDATE, so the same workspace reports different totals run to run. `truncated: true`
  is what stops a capped sample being read as a total.
- **Every store action that resets `threadStateFilter` must reset `threadSeverityFilter` too.**
  They are two halves of one preset. `openPrThreadsFiltered` seeds one and moves `selectedPrId`,
  so anything it does not name survives from the previous PR and passes the
  `selectedPrId === prId` guard on the new one — and if that PR has no labels, the severity pill
  row (including its Clear button) is hidden, leaving no way to undo it.
- **`target_id` is not globally unique.** Three id spaces. Any lookup — server or client — must
  carry the kind. `PrDetail` renders PR comments and review bodies in *one list*, which is where
  this is easiest to get wrong.
- **`IS NOT NULL` IS NOT "HAS TEXT", and the difference is a permanent discrepancy.** An
  approval with no comment is a `reviews` row whose body is the **empty string** — 5 378 of them
  in this repo's own dev database. The first cut filtered candidates with `IS NOT NULL` and then
  dropped empties in JavaScript, while the `pending` count did only the `IS NOT NULL` half, so
  the worker skipped those rows every tick while the panel reported them as "still being
  processed" and coverage could never reach 100%. Both sides now share one `hasText()`
  predicate — and **SQL is the sole authority on candidacy; the JS loop drops nothing**, because
  SQL's `trim()` strips spaces only in both dialects while JavaScript's strips all whitespace, so
  any JS-side filter reintroduces exactly the same class of drift. Pinned by
  `db/ml-labels.test.ts`.
- **`body IS NULL` is a THIRD population, and it is not pending — it is `unscorable`.** Rows
  synced during the lean-storage window (2026-06-07 → 2026-07-01, when comment/review bodies
  were not persisted) hold NULL bodies forever on their own: incremental sync only re-walks PRs
  whose GitHub `updatedAt` moves, and these live on old closed PRs. They are invisible to the
  candidate query AND the pending count by the same `isNotNull` predicate, so coverage read
  100% while hydration showed the user the full text with no badge — the exact reported
  symptom (48 bevy review comments, ~190 pr_comments, 26 review bodies in this dev DB). Three
  repairs now exist: **(1)** `hydratePrDetail` writes hydrated bodies back over NULLs (only a
  real string, only over NULL — `graphqlTolerant` nulls forbidden selections, so a positive
  statement is required; `diffHunk` stays lean-gated; plain awaited UPDATEs, never inside a
  transaction), **(2)** `pnpm ml:backfill-bodies` sweeps every PR still carrying bot-authored
  NULL-body targets through the same hydration path (~1 GraphQL call per PR, idempotent), and
  **(3)** the counts are honest: `unscorable` (the same three counts with `isNull(body)`) rides
  `MlEnrichmentStatus`, `BotSeverityResponse` and `MlBacklog` beside `pending`, and the sync
  menu/modal show it quietly when non-zero. ⚠ `unscorable` must NEVER feed `isMlScoring` —
  nothing drains it, so counting it as pending is the permanent-spinner lie again. And expect
  `pending` to JUMP right after a backfill run: silently missing work becoming visible work is
  the honest direction. Pinned by `sync/hydrate-backfill.test.ts`.

  The first live run (2026-08-07, this dev DB) wrote 801 bodies across 143 PRs and moved the
  counted backlog `pending 0 / unscorable 266` → `pending 127 / unscorable 133`. What REMAINS
  is rows whose comment GitHub itself no longer has — delete-and-repost bots (SonarQube's
  quality-gate comment, verified by node-id lookup returning `NOT_FOUND`) — i.e. genuinely
  unscorable forever, which is exactly what the count is for. A `+0 bodies` PR in the script's
  log is therefore normal, not a failure.
- **The candidate query's `reviewThreads` join is LEFT, and must stay LEFT.** `path` is only a
  hint to the model, but the pending count does not join threads at all — an INNER join there
  means a review comment whose thread row is missing is counted as pending forever while never
  being offered to the worker (phantom backlog, the drift `isMlScoring` cannot see through).
  The schema's FKs make the orphan unreachable today; `db/ml-labels.test.ts` still pins it with
  a `foreign_keys=OFF` fixture because the failure is silent and FK enforcement is a pragma,
  not a property of the data.
- **The badge must never fetch.** `ThreadCard` has eight mount sites; a per-target query behind
  an unconditional panel is how a 60-thread PR once became 60 requests drawing 60 empty boxes.
  Everything reads the one `['ml-labels', prId]` index and returns `null` when it finds nothing.
- **`threadSeverityFilter` is global** — `PrDetail` must guard on `selectedPrId === prId`.
- **The `bot-severity` query key left with its route** (`useBotSeverity`/`botSeverityKey`
  deleted; the fold rides the `bot-analytics` key, which is in `RECLASSIFY_INVALIDATE_KEYS` —
  marking a login human changes who the fold counts). The per-PR index deliberately is **not**
  invalidated on reclassify — reclassification does not alter a stored label.
- **The rollup only counts actors the workspace currently calls bots.** A label whose author has
  since been marked human is stored but excluded — correct, and the reason a naive isolation
  fixture for it passes vacuously (see below).
- **`MeResponse.mlSeverity` is top-level, not inside `pro`.** `entitledProCapabilities` zeroes
  the whole `pro` object for a cloud account on the free plan — i.e. exactly this feature's
  audience.
- **A running `tsx watch` dev server applies migrations at every restart.** Editing a migration
  `.sql` *after* the watcher has already applied it leaves the dev DB on the old DDL with the
  new file's hash unrecorded. Drop the table, delete its `__drizzle_migrations` row, re-run
  `pnpm db:migrate`. (This bit during development of this feature.)

---

## Tests

- `rate-limit.test.ts` pins both tiers, including that the label index is **not** swept into the
  GitHub-hydrating `pr_detail` bucket — and that the comments drill-down sits on `search` while
  its `/prs` sibling stays on `read`.
- `db/bot-analytics-ml.test.ts` pins the windowed fold on a throwaway SQLite DB: same-window
  aggregation (out-of-window labels invisible), findings-only rates, absent-not-zero fields for
  a bot with no in-window labels, both nit-suggestion gates plus the quality-check skip, a
  verdict untouched by an 88%-nits mix, windowed `pending`, and `getBotVendorComments`
  (inline labels, unbadged unscored rows, the empty pierre/unclassified answers).
- `verify:isolation` covers `getPrMlLabels` (both directions) and `getBotSeverityRollup`. Note
  the "B asks for A's repo" rollup check is **vacuous on its own** — `resolveWorkspaceScope`
  intersects with B's membership, the scope comes back empty and the rollup short-circuits. The
  binding assertion is the one where **B has its own label**, on its own repo, authored by the
  same global user, and must count exactly one. Both were mutation-tested by deleting the
  `accountId` predicate and confirming the checks fail.
- `erase-account.test.ts` picks the table up automatically (it derives the expected set from the
  live schema module).
- `db/ml-labels.test.ts` runs the candidate query and the rollup against a throwaway SQLite DB,
  seeding an **empty-string approval** so the candidates ≡ `pending` invariant is non-vacuous,
  and writes the same target twice so the `onConflictDoUpdate` target is actually exercised (an
  insert-only test never reaches that branch).
- `sync/hydrate-backfill.test.ts` runs the NULL-body write-back on a throwaway SQLite DB with
  only the GitHub boundary mocked: fills exactly the NULLs GitHub has text for, never overwrites
  a stored body, never writes a nulled selection, leaves `diffHunk` lean-gated, moves repaired
  rows `unscorable` → `pending`, and is idempotent.
- `sync/reparse-vendor-badges.test.ts` runs the vendor-badge backfill on a throwaway SQLite DB
  with the marker endpoint stubbed at `fetch`, seeded with the three vendors' REAL body shapes
  across all three target kinds. The load-bearing assertion is not "the badge arrived" but that
  **every other column on every row is byte-identical** before and after — mutation-tested by
  adding one extra column to the UPDATE, which fails it. Also pinned: the vendor comes from the
  login even though the fixture carries the real `kind='in_house'` staleness for `deepsource-io`
  (mutation-tested by reading the stored kind instead — the request log then loses `deepsource`),
  a null parse never clears a stored badge (mutation-tested by enqueueing a clearing write), a
  second run writes nothing, `--dry-run` writes nothing, an in-house bot is never sent at all,
  an unreachable service is reported rather than thrown, and an answer missing its id leaves the
  row untouched.
- `sync/ml-enrichment.test.ts` pins `packBatches`: the character budget, the item cap, that an
  over-budget item gets its own batch rather than being dropped, and that nothing is lost or
  duplicated — plus `severityApiAnswered`, so "the service rejected this batch" and "the service
  is not there" stay distinguishable.
- `sync/sync-manager.test.ts` pins the ORDERING: the enrichment tick is kicked while the repo is
  still marked running. Mutation-tested by moving the kick back below `clearSyncProgress`, which
  fails the assertion.
- `db/ml-labels.test.ts` additionally pins that `getMlBacklogForAccount` (the account-wide
  backlog behind `/api/ml-status`) agrees with the per-workspace rollup rather than quietly
  reporting nothing — a zero there would make the sync indicator go dark with work outstanding.
- `apps/frontend/test/mlScoring.test.ts` pins `isMlScoring` across all four stalled states plus
  the partial-failure case that must KEEP its indicator. ⚠ Frontend tests do not run in CI —
  `./apps/backend/node_modules/.bin/vitest run --root apps/frontend`.

---

## Known gaps

- **No re-scoring of an edited body.** `body_hash` is stored but nothing compares it: the
  candidate query is "has no label row". Bot comments are rarely edited, but a vendor that
  rewrites its walkthrough in place keeps its first label. `pnpm ml:enrich --reset` is the
  blunt fix; a staleness sweep over `body_hash` is the targeted one.
- **Nothing AUTO-invalidates a label when the model changes.** Half closed: `model_version` now
  moves when the served artifact does (it used to be a constant across an artifact swap — see the
  landmine), so a stale row is at least *identifiable* for the first time. Nothing compares it:
  the candidate query is still "has no label row", so an upgrade leaves the whole corpus on the
  old model until someone runs `pnpm ml:enrich --reset`. The targeted fix — a sweep that deletes
  labels whose `model_version` ≠ the service's current one — is now actually possible.
- **~~`vendor_severity` is only populated for rows written after the service started returning
  it.~~ CLOSED** — `pnpm ml:reparse-badges` (above) re-reads the badge off stored bodies through
  the marker-only endpoint and writes those two columns and nothing else, so a NULL after a sweep
  really does mean "this bot posted no badge". Two caveats survive: the sweep is a MANUAL one-off
  (nothing runs it on a schedule, so rows written before a new vendor's parser lands stay NULL
  until someone runs it again), and an actor a human identified as a vendor whose *login* is not
  in `REVIEW_BOTS` gets no hint and keeps its NULL — deliberate under-recovery, since the
  alternative is guessing a parser and writing a wrong claim into a column shown as the vendor's
  own.
- **The "the model did not pick this" flag is computed, stored and ignored.** `severity_prob <
  0.25` is an exact statement that calibration overrode the argmax (Accuracy above), true of 15%
  of the CodeRabbit corpus. Nothing surfaces it, no rollup weights by it, and no evaluation
  reports it as its own slice.
- ~~The `/api/bot-severity` rollup is still unwindowed~~ **CLOSED by deletion** — the candidate
  for removal was removed (no external consumer materialised). The Bots severity surface is
  `/api/bot-analytics`'s WINDOWED `ml` fold (`getMlWindowAggregates`, exactly the read
  `target_created_at` was stored for); `getBotSeverityRollup` survives in `db/ml-labels.ts` as
  the exclusion-semantics reference only.
- **Feed card bodies and `CommentCard` carry no badge** — see UI above.
- **pg `0034` has not been replayed against a real Postgres** (the unit suite is SQLite-only).
  Same status as pg `0031`–`0033`; the throwaway-container recipe is in
  `docs/SECURITY.md` § dependency posture.
- **One bad comment blocks a whole workspace's backlog, indefinitely.** A batch failure sets
  `hardFailure` and abandons that workspace for the tick — correct when the service is down (it
  stops N pointless round trips), but wrong for a single rejected comment: the candidate query
  is "has no label row", so that comment is re-selected on the next tick and blocks the same
  workspace again, forever. **This actually happened:** `pr_comment` 151836 in the `Erxes`
  workspace 500'd the severity-api, and it alone pinned that workspace at `pending: 4`
  indefinitely. Bisected to a single character — it scored fine at 5 000 chars and 500'd at
  6 000, because the trim's 6 000th code unit landed inside a 💡 and left the orphaned high
  surrogate, which UTF-8 cannot encode and the tokenizer rejects.

  **Two of the three fixes have landed**: the trim is now surrogate-safe
  (`truncateOnCodePoint`), and the service sanitises its own input rather than 500ing
  (pierre-ml `0af0408`). The third has NOT: the worker still has no quarantine, so any future
  input the service rejects will hold its workspace exactly the same way. A per-item retry
  counter, or splitting a failed batch to isolate the offender, is the durable fix — the sync
  UI's stalled-detection only stops it LYING about the situation.
- **Not exercised in CI.** The Docker image is not pushed anywhere and CI has no severity-api,
  so the enrichment path is only ever run locally or in cloud.

---

## `packages/ml` is a SUBMODULE and a PYTHON repo — not a pnpm workspace, not an import

Worth stating flatly, because every other directory under `packages/` is a pnpm workspace and
the assumption costs time:

- **It is PYTHON.** No TypeScript, no build step in this repo's toolchain.
- **It is NOT a pnpm workspace.** The root `pnpm-workspace.yaml` globs `apps/*` + `packages/*`,
  but `packages/ml` **has no `package.json`**, so the glob simply skips it. `pnpm install`,
  `pnpm build`, `pnpm typecheck` and `pnpm test` never see it. Do not add one.
- **It is NEVER IMPORTED.** The backend talks to it **over HTTP only** (`SEVERITY_API_URL` →
  `POST /score/*`). There is no code path from a `.ts` file into this directory; the only
  in-repo references are the dev script's spawn (`scripts/dev-ml.mjs` → the sibling's own
  `scripts/serve_local.sh`) and this documentation.
- **It builds, versions and DEPLOYS INDEPENDENTLY.** The submodule is a **pinned pointer, not a
  merge of the two codebases** — its own repo
  ([`pierre-ml`](https://github.com/alexwakeman/pierre-ml)) owns its release cycle, and cloud runs
  it as a separate Railway service. Bumping the gitlink here changes which commit you get
  locally; it does not deploy anything.
- **Absent ⇒ the labels are simply dark.** A clone without `--recurse-submodules` is a fully
  working checkout; `git submodule update --init` fetches it.

⚠ **`pnpm dev` handles the absence by EXITING 0, never by failing.** `scripts/dev.mjs` decides
**ONCE** whether the service can be started (sibling present, `uv` installed, not disabled) and
uses that one answer for **two** things: whether to launch it, **and** whether to point the
backend at it. Those must not be able to disagree — a backend aimed at a severity-api that is not
running would report `mlSeverity: true` and show a scoring backlog nothing is draining, which is
worse than the feature being quietly off. **Every "can't run it" path prints one line and exits
0**, so a clone without the submodule gets exactly the dev loop it always had.

⚠ **`SEVERITY_API_DEFAULT_URL`, never `SEVERITY_API_URL`** — `dev.mjs` exports the *fallback*
name, and `config.ts` reads it only as a fallback. **`process.loadEnvFile` does NOT overwrite an
already-set variable**, so exporting `SEVERITY_API_URL` from the dev script would have **BEATEN
whatever is in your `.env`** — the exact inverse of what a default should do. An explicit
`SEVERITY_API_URL` (shell or `.env`) always wins; nothing but the dev script sets the fallback.
A custom `SEVERITY_API_PORT` therefore needs an explicit `SEVERITY_API_URL` too, and `dev.mjs`
prints the URL it chose so a mismatch is visible. (Full env table + the
`SEVERITY_API_WORKERS`/`ML_CONCURRENCY` pairing: § Running it locally.)

## The batch budget is CHARACTERS, not items — the `config.*` field names

Full mechanics are in **§ Batching: the character budget is the real one**; this is the
name-mapping an agent editing `sync/ml-enrichment.ts` needs, plus the one-line statement of the
rule.

**The rule: a batch pads to its LONGEST member**, so one 6 k-char walkthrough dropped into a
batch of 128 short comments makes all 128 cost like the walkthrough. Inference cost tracks
**total text**, not item count — which is why the item cap is a safety rail and the **character
budget is the real budget**.

| Env var | `config.ts` field | Default | Role |
|---|---|---|---|
| `ML_BATCH_MAX_CHARS` | **`config.mlBatchMaxChars`** | `24_000` | **THE budget.** Fills each batch |
| `ML_BATCH_MAX_ITEMS` | `config.mlBatchMaxItems` | `128` | Item cap — **service hard cap is 256** (over it, a 422) |
| `ML_BODY_MAX_CHARS` | `config.mlBodyMaxChars` | `6_000` | Per-body trim, via `truncateOnCodePoint` |
| `ML_CONCURRENCY` | `config.mlConcurrency` | `2` | In-flight requests |
| `ML_TICK_BUDGET_MS` | `config.mlTickBudgetMs` | `90_000` | Wall-clock ceiling per tick |
| `ML_REQUEST_TIMEOUT_MS` | `config.mlRequestTimeoutMs` | `120_000` | Cold start loads a ~150 MB model |

**Candidates are SORTED BY BODY LENGTH before packing**, so each batch is internally uniform and
the padding waste collapses. Measured on the dev corpus: **482 labels in 71 s (≈6.8 items/s)**
versus the **~3 items/s** an unsorted batcher gets on the same machine — a >2× throughput
difference from a `sort`.

⚠ **Results are zipped POSITIONALLY, and `scoreComments` THROWS on a length mismatch.** If the
service returns a different number of results than items sent, a short array would attach one
comment's severity to a **different comment** — a silently wrong label on the wrong text, which
is worse than no label at all. The throw is the contract, not defensive noise: do not "handle" it
by zipping what came back.
