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

That third row is not hypothetical: one PR comment in this repo's own dev database reliably
500s the severity-api (the 6 000-char `ML_BODY_MAX_CHARS` trim cuts it mid-markdown-fence), and
because a batch failure sets `hardFailure` and abandons the workspace for that tick, **that one
comment blocks its whole workspace's backlog**. A partial failure is still progress, though —
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
   anyway; this only bounds the request payload),
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
>    the whole corpus is re-scored against the currently served model (labels are
>    model_version-stamped; this is the supported "backfill against the new model" gesture).
>    Ordinary syncs — including a freshly added repo's initial backfill — also kick a tick on
>    completion, so new comments get labels without waiting for the cron.

| `is_summary` | PR walkthrough/summary rather than a specific finding |
| `backend`, `model_version` | verbatim from the service |
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
| `GET /api/prs/:id/ml-labels` | **THE per-PR index** → `PrMlLabelsResponse`. Every badge on the page reads this one query (React Query dedupes; `staleTime: Infinity`), so a 60-thread PR costs one request, not 60. A target with no label is simply absent. Ownership 404 via the getter. Rate tier `read` — recorded explicitly, not inherited, because it sits inside the `/api/prs/<id>/` family whose other members hydrate from GitHub |
| `GET /api/bot-severity?workspace&repoIds` | Bots-interface rollup → `BotSeverityResponse` (per-severity + per-category totals, one row per bot, coverage as `labelled`/`pending`, the distinct `backend` strings). `?workspace=` follows the read contract — unknown/foreign/garbage degrades to Default, never 404. ⚠ **Rate-limit tier `search` (60/min), not `read`**: DB-only, but it scans a workspace's whole label corpus (capped 50 k rows) plus three unlabelled-count joins — the same shape of cost as `/api/workspace-metrics/compare` |
| `GET /api/ml-status` | The worker's live state → `MlEnrichmentStatus`, so the sync UI can show the scoring pass (above). **NO scope parameter** — the worker walks every workspace, so a workspace-scoped backlog would under-report the work actually running. Same `search` tier as the rollup, for the same reason (its backlog half is those unlabelled-count joins, once per workspace) — plus a ~3 s per-account cache on the scan, because this one is POLLED and a tier bounds request count, not per-request work |

Both are **pure reads**. There is no generate endpoint and no mutating verb: the model is only
ever called by the background worker, so no request can spend anything.

---

## UI

- **`MlSeverityBadge`** (`components/MlSeverityBadge.tsx`) — a pill in a comment's header row,
  plus the category chip and a `summary` marker. Renders **nothing** without a label, and never
  fetches: the caller passes a label it already found in the shared index.
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
- **`BotSeverityPanel`** — the "What the bots are flagging" block on the Bots ROI tab: findings
  vs walkthroughs, high-severity share, nit share, top topic, and a per-bot severity-mix bar
  with top categories. States its own **coverage** (`527 of 626 scored (84%)`) rather than
  letting a half-labelled corpus read as complete, and calls out a marker-fallback deployment.

Store: `threadSeverityFilter` is a **global** field, so `PrDetail` applies it only when
`selectedPrId === prId` — the same guard `threadStateFilter` needs, for the same reason (a PR
opened via a pinned tab would otherwise inherit another PR's preset and silently hide threads).

**Deliberately NOT badged (yet):** `CommentCard` (the Pro theme drill-down) and the Feed's
PR-comment / review card bodies. Both are cross-PR lists, so a badge there would need one
per-PR index query *per card*. The feed's inline **threads** do get badges, because those go
through `ThreadCard` and each names a single PR.

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
| `PIERRE_ML_DISABLED=1` | run the app without it |

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

---

## Accuracy — what to tell users, and what the UI already says

Macro-F1 ≈ 0.66 against a three-source consensus. **CRITICAL is the class it under-recalls**, so
the product treats **major + critical together as "high"** everywhere (the panel's headline
number, the badge tooltip). Nothing auto-acts on a label: there is no gate, no auto-resolve, no
blocking. Categories are marker-derived (deterministic), not model output, and the list is never
empty — an unmatched comment falls back to a single low-probability best guess.

---

## Landmines

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
- **The badge must never fetch.** `ThreadCard` has eight mount sites; a per-target query behind
  an unconditional panel is how a 60-thread PR once became 60 requests drawing 60 empty boxes.
  Everything reads the one `['ml-labels', prId]` index and returns `null` when it finds nothing.
- **`threadSeverityFilter` is global** — `PrDetail` must guard on `selectedPrId === prId`.
- **`bot-severity` is a workspace-scoped query key** and therefore carries `ws:<id>`; it is also
  in `RECLASSIFY_INVALIDATE_KEYS`, because marking a login human changes who the rollup counts.
  The per-PR index deliberately is **not** — reclassification does not alter a stored label.
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
  GitHub-hydrating `pr_detail` bucket.
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
- **No re-scoring on a model upgrade.** Same mechanism, same fix — `model_version` is stored but
  not compared.
- **The rollup is unwindowed.** It covers every label in scope (bounded by the 180-day retention
  sweep), while the Bots panels around it are windowed. `target_created_at` is stored
  specifically so a window can be added without a migration.
- **Feed card bodies and `CommentCard` carry no badge** — see UI above.
- **pg `0034` has not been replayed against a real Postgres** (the unit suite is SQLite-only).
  Same status as pg `0031`–`0033`; the throwaway-container recipe is in
  `docs/SECURITY.md` § dependency posture.
- **One bad comment blocks a whole workspace's backlog, indefinitely.** A batch failure sets
  `hardFailure` and abandons that workspace for the tick — correct when the service is down (it
  stops N pointless round trips), but wrong for a single rejected comment: the candidate query
  is "has no label row", so that comment is re-selected on the next tick and blocks the same
  workspace again, forever. **Live example in this repo's own dev database:** `pr_comment` 151836
  in the `Erxes` workspace 500s the severity-api, and it alone is why that workspace sits at
  `pending: 4` permanently. Bisected: it scores fine at 5 000 chars and 500s at 6 000, i.e. the
  `ML_BODY_MAX_CHARS` trim cuts it mid-markdown-fence. Two independent fixes, neither done:
  the service should never 500 on input (pierre-ml), and the worker should quarantine a
  repeatedly-failing item — a per-item retry counter, or splitting a failed batch — instead of
  letting one poison pill hold a workspace. The sync UI already refuses to report this as
  progress, but that only stops it LYING about it.
- **Not exercised in CI.** The Docker image is not pushed anywhere and CI has no severity-api,
  so the enrichment path is only ever run locally or in cloud.
