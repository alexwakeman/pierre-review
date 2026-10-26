# Plan: bot-comment severity in Node (retire the severity-api service)

Status: PLAN, not started (2026-10-21). Background: [ML-SEVERITY.md](ML-SEVERITY.md).

## Goal

`npx limn-review` labels bot comments with severity and categories with no Python, no Docker and
no second process. `packages/ml` stays the TRAINING repo and publishes model files; the backend
runs them.

## What serving actually is today

The Python service's serving path (`packages/ml/src/bot_monitor`) is small:

| Piece | Python | Size |
|---|---|---|
| Two int8 ONNX ModernBERT heads | `serving_assets/modernbert-onnx/{severity,category}/model_quantized.onnx` | ~150 MB each |
| Tokenizer | `tokenizer.json` per head, via the Rust `tokenizers` lib | 3.5 MB each |
| Batching + padding | `_OnnxHead.logits`, `token_budget_chunks` (`models/taxonomy.py`) | ~100 lines |
| Decode | `_decode_severity` (softmax, `calibration.json` class weights, optional CRITICAL escalation), `_decode_categories` (sigmoid, 0.5, top-1 fallback) | ~60 lines |
| Input text | `strip_vendor_chrome` → `path [SEP] body [SEP] diff` (`input_format.json` has `path_in_text: true`) | — |
| Markers | `parse/markers.py`: chrome stripping, `is_summary`, the vendor's own badge, the category fallback | ~925 lines, mostly regex |

Two backend callers: `sync/ml-enrichment.ts` (via `ml/severity-client.ts` → `POST /score/comments`)
and `sync/reparse-vendor-badges.ts` (`POST /markers/vendor-severity`).

⚠ **The markers are NOT optional.** `strip_vendor_chrome` is the train/serve parity point (every
head was trained on stripped text), and `is_summary` + `vendor_severity` come from the marker
parse on every result. The marker port is the biggest piece of this work, not the model.

## Dependencies

| Package | Role | Size | Ships how |
|---|---|---|---|
| `onnxruntime-node` 1.30 | runs the `.onnx` files | **301 MB unpacked** (every platform's binaries) | first-use install, never in the manifest |
| `@huggingface/tokenizers` 0.2 | pure-JS reader for `tokenizer.json` | 0.36 MB | same install (keeps one pin list) |

Not `@huggingface/transformers`: it drags in `sharp` and `onnxruntime-web` for a tokenizer we can
load directly.

## Phases

### 0. Parity fixtures (do first; everything else is judged against them)

Add a `packages/ml` script, `export_parity_fixtures.py`, that writes for ~1,000 comments (gold-300 +
a stratified sample over vendors, plus edge cases: >512 tokens, lone surrogates, empty body,
CRLF, emoji badges, HTML `<details>`):

- the raw input (`body`, `diff_hunk`, `path`, `vendor`)
- `strip_vendor_chrome` output and the full `extract_markers` result
- token ids after truncation
- the batch composition it ran in, and the raw logits per head
- the final `ScoreCommentResult`

**Built** (`packages/ml/scripts/export_parity_fixtures.py`, tests in
`tests/test_export_parity_fixtures.py`; ~13 min on the Intel Mac). It builds the taxonomy through
production's own `_load_taxonomy` with `category_backend="marker"` and refuses to write if severity
is not the loaded ONNX head. Every row is decoded from its written logits and checked against the
served label before anything is written. Output in `packages/ml/data/parity/`: `rows.jsonl.gz` (reproducible gzip, 2.9 MB; gold-300 + 40 per
corpus vendor + 60 long bodies + 19 edge cases, ASCII-escaped so lone surrogates survive),
`manifest.json` (artifact sha256s, serving constants, `model_version`, the exact chunks, library
versions) and `coercion.json` (vendor string → Kind). ⚠ The corpus files Codex and DeepSource under
`in_house`/`unknown`; the sampler re-resolves the vendor from the login through pierre-review's
`REVIEW_BOTS`, because that is what the backend sends.

Acceptance for the port: markers and token ids **exactly equal**; logits within 1e-3 **when run in
the same batch composition** (the int8 export is not padding-invariant, so a different batch is a
different answer — compare like with like); final severity and category set agree on ≥ 99.5%.

### 1. Port the markers → `apps/backend/src/ml/markers.ts` (2–3 days)

Port `drop_lone_surrogates`, `normalize_body`, `strip_vendor_chrome`, `extract_markers` and the
per-vendor extractors, driven by the Phase 0 fixtures. Python → JS regex traps:

- ⚠ Python `\w`, `\d`, `\s`, `\b` are UNICODE on `str`; JS `\w`/`\b` stay ASCII even with `u`. Use
  `\p{L}\p{N}_` classes where a pattern meets non-ASCII text.
- Inline flags at a pattern's start (`(?m)^\s*…`) are not JS syntax — move them to the flags.
  `re.S` → `s`, `re.I` → `i`, `re.M` → `m`.
- Python `len()` and slicing count code points; JS counts UTF-16 units (`truncateOnCodePoint`
  already exists).
- Map the backend's vendor kinds onto the Python `Kind` values through ONE table (beside
  `vendorHint`).
- Several patterns are lazy `.*?` with `s` over bot bodies. They run in the worker (Phase 3), so a
  slow body cannot stall the API, but cap the body length before matching, as the HTTP boundary
  does today.

`reparse-vendor-badges.ts` switches to this module directly.

**Built** (`apps/backend/src/ml/markers.ts` + `markers.test.ts`; not yet wired to any caller). Every
pattern is kept in its exact PYTHON source (`matched` records sources verbatim) and compiled by a
small translator, `pyRe`, that restores Python's meanings: `\s` = `str.isspace()`, `\w`/`\b` =
Unicode word characters via lookarounds, `\d` = `\p{Nd}` (read by value), `.` excludes only `\n`,
and MULTILINE `^`/`$` break at `\n` only (JS's `m` also breaks at `\r`). `str.strip()` and NFC are
matched too. Vendor coercion is "lowercase, in the enum, else `unknown`": Python's login fallback is
unreachable from the backend, and that is pinned against all 120 strings in `coercion.json`.
The replay matches all 1,065 fixture rows exactly (markers, stripped text, surrogate strip,
coercion). The corpus barely exercises the Python-semantics shims, so Python-computed unit cases
pin each one, and every shim was mutation-checked (8 of 8 mutations fail a test). ⚠ The replay SKIPS,
with a console warning, when `packages/ml` is not checked out.

### 2. Inference core → `ml/onnx-head.ts` + `ml/decode.ts` (1–2 days)

- `ml/decode.ts` is PURE (no ONNX import): softmax, sigmoid, class weights, CRITICAL escalation
  (threshold default off, as `config.py`), the category top-1 fallback, `_BASE_PROB`,
  `CATEGORY_ORDER`, rounding to 4 dp. Unit-tested from the fixtures' stored logits, so CI tests it
  without the model.
- `ml/onnx-head.ts`: one `InferenceSession` per head (`intraOpNumThreads`,
  `graphOptimizationLevel: 'all'`, CPU provider), tokenizer from `tokenizer.json`, truncation to
  512 with the special tokens kept (verify against fixture token ids), `token_budget_chunks`
  ported exactly (sort by length, ≤ 4096 padded tokens, scatter back by index), `BigInt64Array`
  tensors. ⚠ Keep the "never fewer rows than inputs" throw: the enrichment worker zips by position.
- Verify the arena-shrink run option has a Node equivalent; if not, fall back to recreating
  sessions after a large batch (the hosted severity-api's memory incident is why this option exists).
- `model_version`: do NOT re-implement the blake2b digest (Node's `createHash` cannot produce
  blake2b-128). The publish step (Phase 4) writes Python's exact `compose_model_version` string
  into the model manifest and Node reads it, so existing stored labels keep their version.

**Built** (`ml/decode.ts`, `ml/onnx-head.ts`, `ml/model.ts`, `ml/blake2b.ts`). Deviations from
the plan above, each measured:
- **The tokenizer** is `@huggingface/tokenizers` 0.2 (pure JS, no truncation option), so the head
  truncates by hand, keeping the template's closing `[SEP]`. Ids match on all 1,065 rows.
- **onnxruntime-node is pinned to 1.23.2**, the service's onnxruntime version, so logits are
  compared like for like.
- **No arena.** The Node binding cannot set run options (`extra` is WebAssembly-only), so the
  session runs with `enableCpuMemArena: false` instead of shrinking an arena after each run.
  Memory is freed after every run.
- **`model_version` IS computed here**, which reverses the note above. A ported BLAKE2b (pinned to
  `hashlib` in `blake2b.test.ts`) gives `taxonomy-composite-v1.sev-93ad7af4-cal.cat-marker`,
  exactly the service's string, with no manifest needed.
- **Parity.** `decode.test.ts` replays all 1,065 rows from the stored logits: every wire field,
  the model text and the exact chunks. `model.test.ts` runs the real model on three whole
  recorded chunks (`LIMN_ML_PARITY_FULL=1` runs all 99): logits within 1e-3, same severity.

### 3. Worker thread + the one scorer seam (1 day)

- `ml/worker.ts` owns both sessions, the tokenizer and the marker parse. The main thread never
  tokenises or runs a regex over a bot body.
- Load LAZILY on the first tick with candidates; unload after ~10 idle minutes. A desktop-resident
  app should not hold ~0.5 GB for a feature that runs in bursts. Threads: `min(4, cpus/2)`.
- `ml/scorer.ts` exposes the same `scoreComments`/`health` shape `ml-enrichment.ts` already uses.
  It picks the LOCAL scorer when the runtime + models are ready, else the HTTP client when
  `SEVERITY_API_URL` is set (an opt-in: `PIERRE_ML_HTTP=1` in dev, or a rented endpoint), else
  nothing. `ml-enrichment.ts` changes
  its import and nothing else; the character budget, packing and `isMlScoring` stay as they are.

**Built** (`ml/scorer-process.ts`, `ml/local-scorer.ts`, `ml/scorer.ts`; `config.mlLocalEnabled`,
`LIMN_ML_SCORER`). ⚠ It started as a worker THREAD and became a child PROCESS: see "Not slowing
the machine" below.
- **Every former `isSeverityApiConfigured()` gate now asks `isMlScoringAvailable()`.** That covers
  the tick, `/api/me`, and the labels route. The cron registers on `isMlScoringPossible()`, so a
  "Set up" mid-session starts scoring without a restart.
- **The scorer runs `scorer-process.ts` through tsx's loader in dev and tests**, and
  `scorer-process.js` in a release.
- ⚠ **Pending requests are tracked PER PROCESS.** A retired one's `exit` used to reject the next
  one's request; that was caught by `local-scorer.test.ts`.
- **Still on HTTP:** `sync/reparse-vendor-badges.ts`, a dev maintenance CLI. Moving it to
  `ml/markers.ts` is Phase 6 cleanup.

### 4. Distribution (2 days)

**Runtime.** Generalise `ai/runtime.ts`'s installer into a NAMED runtime and add `ml`:
`~/.limn/ml-runtime`, pins generated by `build-release.mjs` into a new manifest field
`limnMlRuntime`, the same "only the loader may value-import it" build assertion (here
`ml/runtime.ts` for `onnxruntime-node`). Install with CUDA skipped
(`ONNXRUNTIME_NODE_INSTALL_CUDA=skip`, verify the flag on 1.30), then delete other platforms'
binaries under its `bin/` to cut the 301 MB to roughly a third.

**Models.** `packages/ml` gets `publish_models.py`: copy the two heads + `input_format.json` +
`calibration.json`, write `manifest.json` (`modelVersion`, file list, sha256s), tar, and attach to a
GitHub Release on the public repo (or the Hugging Face Hub). `build-release.mjs` writes
`limnMlModels: { version, url, sha256, size }` into the npm manifest. The app downloads to
`~/.limn/models/<version>/` (stream to a temp dir, verify sha256, atomic rename, never a partial
directory), so a model bump is a new directory and an old one is swept.

**Trigger.** `limn ml install` + a setup line in the SPA, with progress in the ONE header toast
strip. Decision below on whether to start it without a click.

**Built**, with three deviations from the plan above:
- **The installer was not generalised.** `ml/runtime.ts` is its own module and reuses the AI
  runtime's lifted `findPackageDir` / `esmEntryOf` / `resolveNpm` / `spawnNpm`.
- **The download is ~240 MB.** The onnxruntime-node tarball is 92 MB and the model 147 MB.
  `--ignore-scripts` skips onnxruntime-node's GPU fetch, and the other platforms' binaries are
  pruned after install.
- **The model is published as INDIVIDUAL FILES, not a tar.** Each file has its own URL, size and
  sha256 in `limnMlModels`. `scripts/ml-models-manifest.mjs --base-url …` writes
  `apps/backend/ml-models.json` from the serving assets. The model goes to
  `~/.limn/ml-models/<version>/`. The order a model directory is looked up in:
  `LIMN_ML_MODELS_DIR`, then the dev checkout (a Git LFS pointer is rejected), then the download.

**Published (2026-10-22)** as assets of the GitHub release `ml-models-sev-2560f333b0f3` on the
PUBLIC `alexwakeman/pierre-review` repo (`--latest=false`; the tag is not `v*`, so the release
workflow's version tagging never sees it). `pierre-ml`'s Git LFS copy could not serve npx users:
that repo is private, and LFS download links expire and spend the LFS bandwidth quota.
`apps/backend/ml-models.json` lists the five files; every public URL was downloaded and matched its
sha256, and the real installer downloaded them into a fresh data dir and reported `ready`.
⚠ **A retrained model is a NEW release**: run `scripts/ml-models-manifest.mjs` (the version is
content-derived), upload under the printed asset names to a release tagged `ml-models-<version>`,
then commit the regenerated JSON. Never replace an asset in place — a machine that already holds
that version would keep the old bytes. In dev nothing is downloaded: `pnpm dev` reads
`packages/ml/serving_assets` and no longer starts the Python service (`PIERRE_ML_HTTP=1` does).

### 5. Gate + SPA (0.5 day)

- `MeResponse.mlSeverity` becomes "the local scorer is ready OR the HTTP one is configured".
  Add `MeResponse.ml: { state: 'ready' | 'absent' | 'installing' | 'failed' }` for the setup line,
  top-level like `ai`.
- Everything downstream (badges, `isMlScoring`, the per-PR label index) is unchanged.

**Built.**
- **Backend:** `MeResponse.ml` (absent under LIMN_ML_DISABLED) and
  `POST /api/ml/install` (SSE, `sync` tier).
- **SPA:** Settings → "Bot comment scoring" (`BotScoringSection`). "Set up AI" chains into the same
  download when scoring is not set up, which is decision 3's single button.

### 6. Shadow run, then cut over (1 day + elapsed time)

Run both scorers on the real dev DB for a few days, writing the local result to a scratch table,
and report disagreement by vendor. Cut over when it matches the Phase 0 bar. Then:

- remove the `packages/ml` launch from `pnpm dev`, and `SEVERITY_API_DEFAULT_URL`;
- the hosted mode is retired (2026-10-22), so the HTTP branch (`ml/severity-client.ts`) survives
  only as an OPT-IN scorer — `SEVERITY_API_URL` / `LIMN_ML_SCORER=http`, e.g. a rented endpoint
  to drain a large backlog — never the default path;
- update ML-SEVERITY.md and the CLAUDE.md ML section.

## Shadow check on real data (2026-10-21)

I copied the dev DB, deleted 400 random stored labels, and ran ONE real enrichment tick against
the copy (local scorer, worker thread, real DB writes).

**It ran cleanly:** 397 of the 400 were re-scored, in 40 batches with 0 failures. The three that
were not had no candidate any more. Then I rebuilt the same 397 items exactly as the worker does
and scored each ONE AT A TIME in Node and in current Python:

| comparison | severity agrees |
|---|---|
| Node alone vs current Python alone | **397 / 397** (every wire field identical) |
| Node batched (the tick) vs Node alone | 368 / 397 |
| Stored labels (older service code, other batches) vs current, alone | 369 / 397 |

⚠ **FINDING: BATCH PADDING MOVES SEVERITY ON ~7% OF COMMENTS, IN BOTH IMPLEMENTATIONS.** The int8
export's activation scales see the padded positions, so a comment's label depends on WHICH OTHER
COMMENTS shared its batch. The probability moves by up to 0.84, enough to cross a class. The port
reproduces this faithfully: it is the Python behaviour, now measured. Scoring each comment ALONE
(no padding) makes a label a function of the comment only. That is the owner's decision, because
labels stored so far were batched.

**What explains the stored-label gap:** the old labels came from older service code (chrome
stripping has changed since) and from different batches. They are not evidence about the port.

## Not slowing the machine (2026-10-22)

Measured on the 2018 Intel i9-8950HK (6 cores / 12 threads, no int8 VNNI), over the real bot
comments from the shadow check (mean 1,913 characters, close to the 512-token cap).

**Throughput.** A fresh process, one thread, 120 comments:

| mode | comments/s | peak memory |
|---|---|---|
| one comment per run | **0.90** | **0.83 GB** |
| batched, as the service did | 0.71 | 1.51 GB |

Scoring ALONE is faster at every thread count (1, 2 and 4: by 8–18%), uses half the memory, and
removes the padding effect, so `model.score` runs one comment at a time. The cost is about **one
CPU-second per comment**: a fresh install that owes tens of thousands of comments owes hours of
CPU, and that is why the limits below exist.

**The limits** (`ml/throttle.ts`, `ml/local-scorer.ts`, `ml/power.ts`), stacked:
1. **A CHILD PROCESS at background priority.** macOS gets `taskpolicy -b` (background QoS); all
   platforms get nice 19 (Windows: `PRIORITY_LOW`). A worker thread could not get this, because
   macOS sets priority per process. A process that exits also returns its memory.
2. **One ONNX thread** (`LIMN_ML_THREADS`, 1–4).
3. **A duty cycle**: after each comment it rests in proportion to the work, so it averages at most
   `LIMN_ML_CPU_SHARE` (default 0.5) of one core.
4. **Paused on battery** (`LIMN_ML_ON_BATTERY=run` overrides). The tick skips and logs once; the
   badges stay on screen.
5. **Small local batches** (8 comments), so a tick's wall-clock budget is checked often.
6. **Unloaded after 10 idle minutes** (`LIMN_ML_IDLE_MS`).

**Impact on foreground work.** A fixed CPU job ran while scoring ran continuously:

| background | 1-thread job | 12-thread job | scored meanwhile |
|---|---|---|---|
| none (5 runs) | 2.01–2.19 s | 7.29–9.16 s | — |
| naive: 4 threads, normal priority (the service's shape) | 3.09 s | 11.66 s | 53 |
| **protected (the defaults)** (4 runs) | **2.07–2.15 s** | **8.11–8.42 s** | 8 |

Protected scoring has no measurable effect on single-threaded work. A job saturating all 12
logical cores runs ~4% slower, because inference already in flight still finishes on hyperthread
siblings. While the machine is busy it scores almost nothing (8 against the naive 53), which is
the intent.

**On an idle machine** it uses 0.33 cores on average and 528 MB, at **0.21 comments/s (~750 an
hour)**. The dev DB's 42k comments would take ~2.3 days of background trickle; new comments in
steady state are a few dozen a day. `LIMN_ML_CPU_SHARE=1` doubles the pace and still runs at
background priority.

## Tests

- CI (no model needed): marker fixtures exact, decode fixtures exact, `token_budget_chunks`, the
  row-count guard, manifest/sha256 verification, the scorer seam's three branches.
- Opt-in integration (`LIMN_ML_MODELS_DIR` set): real sessions over the fixtures. ⚠ It SKIPS in CI,
  so a green run is not proof it ran: print the skip loudly and check the skipped count.

## Decisions (taken 2026-10-21)

1. **No download without a click.** Offered on first run and in Settings, one click, plus
   `limn ml install`. Never silently on `npx`.
2. **Severity head only.** The category head TIES the marker lexicon on gold-300 micro-F1 and LOSES
   on macro and on security recall (Stage K2b), so v1 ships one 150 MB head and categories come from
   the marker port. The served composite is therefore `severity = ONNX, category = marker` — what
   `BOT_MONITOR_CATEGORY_BACKEND=marker` builds in Python today, and what the fixtures pin.
3. **Separate runtimes, one "Set up" button.** `LIMN_AI_DISABLED` does not turn off a non-LLM
   classifier.

## Effort

About 8–10 working days: markers 2–3, inference 1–2, worker + seam 1, distribution 2, gate 0.5,
shadow run 1 plus a few days elapsed. A shared-encoder two-head export (one ~150 MB file for both
axes) is a later `packages/ml` change and is not needed for this.

## Moved from CLAUDE.md (2026-10-26)

Verbatim text taken out of CLAUDE.md to keep it under its size budget. CLAUDE.md keeps a
shorter form of each rule; this is the full wording.

### `pnpm dev` and the scorer

**`pnpm dev` scores bot comments with the in-process Node port, reading the model from
`packages/ml/serving_assets`; `PIERRE_ML_HTTP=1` starts the Python severity-api instead**
(`PIERRE_ML_DIR`, `SEVERITY_API_PORT`, `PIERRE_ML_DISABLED=1`; it sets `LIMN_ML_SCORER=http`);
every "can't run it" path exits 0, so a clone without submodules still gets the dev loop. ⚠ It
exports `SEVERITY_API_DEFAULT_URL`, never `SEVERITY_API_URL` — `process.loadEnvFile` does NOT
overwrite an already-set variable, so a command-line `SEVERITY_API_URL` would BEAT your `.env`.
