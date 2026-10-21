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
  sessions after a large batch (the Railway memory incident is why this option exists).
- `model_version`: do NOT re-implement the blake2b digest (Node's `createHash` cannot produce
  blake2b-128). The publish step (Phase 4) writes Python's exact `compose_model_version` string
  into the model manifest and Node reads it, so existing stored labels keep their version.

### 3. Worker thread + the one scorer seam (1 day)

- `ml/worker.ts` owns both sessions, the tokenizer and the marker parse. The main thread never
  tokenises or runs a regex over a bot body.
- Load LAZILY on the first tick with candidates; unload after ~10 idle minutes. A desktop-resident
  app should not hold ~0.5 GB for a feature that runs in bursts. Threads: `min(4, cpus/2)`.
- `ml/scorer.ts` exposes the same `scoreComments`/`health` shape `ml-enrichment.ts` already uses.
  It picks the LOCAL scorer when the runtime + models are ready, else the HTTP client when
  `SEVERITY_API_URL` is set (transition and cloud only), else nothing. `ml-enrichment.ts` changes
  its import and nothing else; the character budget, packing and `isMlScoring` stay as they are.

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

### 5. Gate + SPA (0.5 day)

- `MeResponse.mlSeverity` becomes "the local scorer is ready OR the HTTP one is configured".
  Add `MeResponse.ml: { state: 'ready' | 'absent' | 'installing' | 'failed' }` for the setup line,
  top-level like `ai` (free feature; `entitledProCapabilities` must never zero it).
- Everything downstream (badges, `isMlScoring`, the per-PR label index) is unchanged.

### 6. Shadow run, then cut over (1 day + elapsed time)

Run both scorers on the real dev DB for a few days, writing the local result to a scratch table,
and report disagreement by vendor. Cut over when it matches the Phase 0 bar. Then:

- remove the `packages/ml` launch from `pnpm dev`, and `SEVERITY_API_DEFAULT_URL`;
- delete `ml/severity-client.ts` and the HTTP branch if cloud mode is retired too (the
  free-and-local decision), else keep it as the cloud path;
- update ML-SEVERITY.md and the CLAUDE.md ML section.

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
