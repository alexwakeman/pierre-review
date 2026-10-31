# Plan: hybrid retrieval for the reference-docs library (embeddings + full-text search)

Status: PLAN, not started (2026-10-31). Background: [REFERENCE-DOCS.md](REFERENCE-DOCS.md) (the
library, the chat, Check against the docs), [ML-NODE-PORT.md](ML-NODE-PORT.md) (the local ONNX
runtime this reuses).

## Goal

Find the passages that bear on a question or a story by MEANING as well as by word, on the reader's
machine, with no new account, key or service, and comfortably on the 2018 Intel MacBook Pro
(i9-8950HK, 6 cores / 12 threads, AVX2, no int8 VNNI, 32 GB). The model still reads and judges;
retrieval only decides WHAT it reads first.

What does not change: the INDEX → CONTENTS → section tree, the strict path grammar, and grounding.
Every reference and citation is still checked by `validateDocReferences` / the quote checks. A
similarity score is never evidence.

## Where retrieval falls short today

| Surface | How it finds text now | The gap |
|---|---|---|
| Check against the docs (`review/story-docs/shortlist.ts`) | `prefilterSections`: BM25 over each section's TITLE, trail, headings, one-line summary and document title (never the body) → top 30 → Haiku picks ≤ 8 | A story that shares no word with a title or summary scores nothing; then Haiku gets INDEX + every CONTENTS.md (≤ 60k chars) and guesses. Body text is never searched. |
| Docs chat (`reference-docs/chat.ts`) | The agent walks INDEX → CONTENTS → sections with Read/Glob/Grep (≤ 30 turns, $1) | Every answer pays for the walk in turns and tokens; Grep only finds exact words. |
| Reviews with the library on (`review-refs.ts`) | The same walk, inside the review run | The walk costs turns a diff-only review barely has (`DIFF_ONLY_DOCS_MIN_TURNS`). |

## Constraints

1. **No hosted embeddings.** Anthropic makes no embedding model (its docs point to Voyage, a
   separate account); a ChatGPT sign-in gives no embeddings endpoint. A key would also send the
   reader's documents to a third party. Embeddings are computed LOCALLY.
2. **The 2018 Intel MacBook Pro is the floor.** Indexing must run inside the ML posture
   (background priority, one thread, duty cycle, paused on battery); a query must answer in well
   under a second on it, on a busy machine.
3. **Nothing new in the npm manifest.** The model rides the existing first-use ML runtime
   (`onnxruntime-node` + `@huggingface/tokenizers`, `ml/runtime.ts`, `limnMlModels`).
4. **SQLite only, one file.** No second store; the account erase, export and `verify:isolation`
   rules apply to the new tables.
5. **Retrieval is an aid, never a gate.** No model installed, an index still building, or a
   failure ⇒ the surface works as it does today (or with full-text search alone). Unknown is never
   "nothing relevant".

## Measured on the 2018 MacBook Pro (2026-10-31)

Run on the i9-8950HK with the desktop apps open (load average ≈ 4.7 before the runs started), using the
backend's own `onnxruntime-node` 1.23.2 and `@huggingface/tokenizers` 0.2.0, with the scorer's session
options (CPU, `graphOptimizationLevel: 'all'`, no memory arena) and one text per run (never a padded
batch, for the same int8 reason as the severity head). All models are the int8 (`model_quantized.onnx`)
exports.

**The corpus** is the dev library: one document (*The Statutory Biodiversity Metric — User Guide*,
37 sections, 20k words), cut into **113 chunks** of ≤ 220 words. Each chunk is prefixed with
`Document › trail › section` plus the section's stored one-line summary.

**The eval set** is 15 real queries with **45 verified gold sections**: 10 succeeded Check against the
docs runs (query = the criteria text; gold = the section holding each VERIFIED quote in the result)
and 5 chat questions (gold = the cited sections). ⚠ It is small, has one document, and its gold came
from today's pipeline (BM25 on titles → Haiku), so it FAVOURS today's method. A gain here is a
conservative estimate. A difference of < 0.1 between two models is noise.

### Speed and memory

| Model (int8) | Licence | Download | Dims | Max tokens | ms / chunk, 1 thread | 4 threads | Short query | Story query | Peak memory |
|---|---|---|---|---|---|---|---|---|---|
| all-MiniLM-L6-v2 | Apache-2.0 | 23 MB | 384 | 256 | 79 | 36 | 5 ms | 46 ms | 206 MB |
| bge-small-en-v1.5 | MIT | 34 MB | 384 | 512 | 249 | 124 | 11 ms | 130 ms | 328 MB |
| **snowflake-arctic-embed-s** | **Apache-2.0** | **34 MB** | **384** | **512** | **210** | **115** | **11 ms** | **113 ms** | **312 MB** |
| nomic-embed-text-v1.5 | Apache-2.0 | 137 MB | 768 | 512* | 641 | 383 | 38 ms | 356 ms | 729 MB |
| snowflake-arctic-embed-m-v2.0 | Apache-2.0 | 311 MB | 768 | 512* | not measured † | | | | |
| EmbeddingGemma-300m | Gemma terms | 309 MB | 768 | 512* | 1,757 ‡ | 1,354 ‡ | 820 ms ‡ | 1,370 ms ‡ | 1,623 MB |
| Qwen3-Embedding-0.6B | Apache-2.0 | 614 MB | 1024 | 512* | not measured † | | | | ≥ 1.25 GB (seen mid-run) |

\* capped at 512 here; the model accepts more.
† Stopped: partway through the runs, another session on the machine (the `recorder` worktree:
headless Chromium + ~50 node processes) pushed the load average to 224, and Qwen3 was getting 15% of
one core. Rerun both on an idle machine before quoting them.
‡ Probably INFLATED by that load: the load rose during this run, and 4 threads were barely faster
than 1. Even halved, it is 4× arctic-embed-s per chunk and 5× its memory. The three small models,
MiniLM, bge-small and arctic-embed-s, ran first, at a load average of about 5, and are clean. "Short query" is a one-line question; "story query" is a
full set of acceptance criteria (≈ 150–400 tokens).

What it means on this machine:
- **Indexing** with arctic-embed-s takes about 0.2 CPU-seconds per chunk. The dev document (113
  chunks) is about 24 s of CPU. The largest document the build accepts (200k words ≈ 900 chunks) is
  about 3 CPU-minutes, so about 6 minutes of wall time at the default 50% duty cycle. That is a
  one-off cost per build.
- **A query** costs 11–130 ms. EmbeddingGemma measured 0.8–1.4 s per query and 1.6 GB of
  memory (under load, ‡), which is not comfortable on this Mac.
- **The similarity scan** is brute force in JS over a `Float32Array`. It takes **4 ms** for 5k
  chunks, **41 ms** for 50k and 148 ms for 200k (384 dims, best of 5, measured while a benchmark ran
  alongside). 50k chunks hold 77 MB in memory. The scan does not need an index.
- `better-sqlite3`'s bundled SQLite (3.49.2) has **FTS5** (`porter unicode61` tokenizer checked).

### Retrieval quality (section recall at k, 15 queries)

| Method | R@3 | R@5 | R@8 | MRR | Story R@8 | Chat R@5 |
|---|---|---|---|---|---|---|
| **Today**: BM25 over titles, trails, headings and summaries | 0.29 | 0.35 | **0.51** | 0.52 | 0.46 | 0.40 |
| BM25 over chunk TEXT (FTS5-equivalent) | 0.44 | 0.53 | 0.65 | 0.57 | 0.73 | 0.50 |
| MiniLM: vector / **hybrid** | 0.37 / 0.50 | 0.58 / 0.62 | 0.67 / 0.65 | 0.60 / 0.67 | 0.76 / 0.73 | 0.50 / 0.50 |
| bge-small: vector / **hybrid** | 0.37 / 0.40 | 0.45 / 0.63 | 0.63 / **0.73** | 0.54 / 0.67 | 0.59 / 0.74 | 0.20 / 0.50 |
| **arctic-embed-s**: vector / **hybrid** | 0.36 / 0.39 | 0.44 / 0.60 | 0.59 / **0.74** | 0.52 / 0.58 | 0.64 / 0.76 | 0.30 / 0.50 |
| nomic v1.5: vector / hybrid | 0.37 / 0.55 | 0.48 / 0.55 | 0.70 / 0.67 | 0.57 / 0.68 | 0.64 / 0.66 | 0.50 / 0.50 |
| EmbeddingGemma: vector / hybrid | 0.39 / 0.49 | 0.49 / 0.63 | 0.69 / 0.69 | 0.63 / 0.59 | 0.68 / 0.69 | 0.40 / 0.70 |

Hybrid = reciprocal rank fusion (k = 60) of the BM25-on-text ranking and the vector ranking. A
section's score is its best chunk's.

What it shows:
1. **The biggest single gain needs no model.** Searching the TEXT instead of titles and summaries
   moves R@8 from 0.51 to 0.65.
2. **Hybrid adds to that.** With either small 384-dim model it reaches 0.73–0.74 R@8, with better
   top-3/top-5 ranks than either half alone. Vectors alone are not better than text BM25 here (the
   guide is full of exact terms such as "Rule 4" and "strategic significance"). That is why the plan
   is hybrid and never vectors alone.
3. **The bigger models measured (nomic, EmbeddingGemma) buy nothing** on this set, at 3–8× the
   indexing time and 2–5× the memory. Quality does not depend on machine load, so these rows stand.
   Qwen3 and arctic-m-v2 were not scored.
4. **Chat follow-ups need the conversation.** "What other edge cases like this exist?" retrieves
   nothing useful alone. The query must include the previous user turn.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Embedding model | **snowflake-arctic-embed-s, int8** (CLS pooling; queries prefixed `Represent this sentence for searching relevant passages: `). Fallback if it disappoints on the larger eval: bge-small-en-v1.5 (same shape and cost). | The fastest 512-token model measured; 34 MB; Apache-2.0; ~310 MB while loaded; quality ties the best on this set. MiniLM is 3× faster but cuts at 256 tokens (trained on 128), so it truncates our chunks. |
| Store | Plain SQLite tables: chunks, an FTS5 index over them, and vectors as float32 little-endian BLOBs (normalised) | One file, the existing erase, export and isolation rules apply, and no native extension. The scan is 41 ms at 50k chunks on this Mac. |
| Similarity | Dot product of normalised vectors (= cosine) in JS, over a per-workspace `Float32Array` cached in memory | No index needed below ~200k chunks. |
| Keyword side | FTS5 `bm25()` over chunk text, `porter unicode61` | Built into the bundled SQLite; it alone is most of the measured gain. |
| Fusion | RRF, k = 60, chunk level → best chunk per section | No weights to tune; deterministic. |
| Chunking | Within a section, paragraphs packed to ≤ 220 words; a block over 300 words cut by words; prefix `Document › trail › section` + the section's stored summary | The section stays the citation unit. The prefix gives the "contextual retrieval" benefit from text the build already wrote, with no extra model call. |
| Indexing | Chunks + FTS rows at the build's `indexing` stage (DB only, inside the build's transaction). Vectors in the background ML child, after the build. | A document is searchable by text the moment it is ready; vectors follow without blocking the build. |
| Query embedding | The same ML child, with the query sent AHEAD of queued work; **2 s timeout → text-only** | One model load, one process. A query is 11–130 ms of work; on a busy machine background QoS may stretch it, and then the run proceeds on FTS alone. |

## Design

### Storage (one hand-written additive migration; read [MIGRATIONS.md](MIGRATIONS.md) first)

```
reference_doc_chunks
  id               integer pk
  account_id       integer not null            -- tenant anchor, as every docs table
  workspace_id     integer not null            -- composite FK (workspace_id, account_id) → workspaces, cascade
  doc_id           integer not null            -- composite FK (doc_id, account_id) → reference_docs, cascade
  built_at         integer not null            -- the reference_docs.built_at this chunk belongs to
  section_file     text not null               -- NN-name.md (the citation unit)
  anchor           text                        -- the nearest heading anchor, for the deep link
  ordinal          integer not null            -- position in the document
  text             text not null               -- the chunk as embedded (prefix + body)
  index (account_id, workspace_id, doc_id)

reference_doc_chunks_fts   -- FTS5, content='reference_doc_chunks', tokenize='porter unicode61'
                           -- kept in step by AFTER INSERT/DELETE triggers in the same migration

reference_doc_chunk_vectors
  chunk_id         integer pk → reference_doc_chunks(id), cascade
  model            text not null               -- e.g. 'arctic-embed-s-q8@<sha8>'; a row whose model
                                               --   is not the current one is ignored and redone
  dim              integer not null
  vec              blob not null               -- float32 LE, L2-normalised (sqlite-vec's format too)
```

⚠ Drizzle cannot declare FTS5 virtual tables or their triggers. They live in the `.sql` migration only,
like the `isDefault` partial index. ⚠ Register the migration in `_journal.json`, or it SILENTLY SKIPS.
⚠ Both tables carry `account_id` → join `accountScopedTables()` and `verify:isolation`. A rebuild
deletes the document's chunks and inserts the new ones in ONE transaction; a failed build keeps the
old chunks (as it keeps the old files).

### The retrieval module (`reference-docs/retrieve.ts`, pure over DB + one embed call)

```
retrieve({accountId, workspaceId, query, docSlugs?, k}) → {
  sections: [{path, anchor, docTitle, title, bestChunk, score}],   // ranked, ≤ k
  method: 'hybrid' | 'text',                                        // what actually ran
}
```

1. FTS5: the query's terms (the same stopword list as `prefilterTerms`, OR-joined and quoted, since
   the query text is UNTRUSTED and FTS5 syntax must never reach `MATCH` raw) → top 100 chunks by
   `bm25()`.
2. Vectors: when the workspace has vectors for the current model, embed the query (2 s timeout) →
   dot against the cached matrix → top 100.
3. RRF → group by section (best chunk) → top k. Ties break by path, so the order is deterministic.

The matrix cache is keyed `(workspaceId, model, max(chunk id), count)`, rebuilt on change, and dropped
after 10 idle minutes (like the ML child).

### Surfaces

1. **Check against the docs** (`review/story-docs/shortlist.ts`): `prefilterSections` →
   `retrieve(...)` with the story title, description, acceptance-criteria text and criteria as the
   query; top 30 are the candidates Haiku picks from (unchanged). The INDEX + CONTENTS fallback stays
   ONLY for a library with no chunks yet (built before this ships, until the backfill reaches it).
   ⚠ **The fingerprint gains the retrieval id** (`fts-v1` or `hybrid-v1:<model>`) in its `models`
   list. A field that changes the answer and is missing from the fingerprint serves a stale answer as
   current. The `wholeLibraryShortlist` short cut (≤ 48k chars) is unchanged.
2. **Docs chat** (`reference-docs/chat.ts`): before the run, `retrieve` with the question plus the
   previous user turn. The best 6 sections' best chunks (≤ 12k chars), each in its own nonce fence
   as untrusted data with its section link, go into the prompt. The tools stay, and the prompt says
   to open a section when the passage is not enough. The citation and quote checks are unchanged:
   they re-read the section from disk.
3. **Reviews with the library on** (`review-refs.ts`): the docs block gains "Likely relevant
   sections": up to 8 links with their one-line summaries, never text, retrieved from the PR title,
   description and changed paths. ⚠ Switch off ⇒ byte-for-byte unchanged (`review-refs.test.ts`
   pins it).
4. **Codex** gets all three unchanged, because retrieval and inlining are server-side. A
   `search_library` TOOL (in-process for Claude; in `ai/codex/workspace-files.ts` for Codex) is a
   later, optional phase.

### The runtime

- **The model** is one more `limnMlModels` entry (34 MB, sha256-pinned), downloaded by the same "Set
  up" button / `limn ml install`. No manifest change; `ml/runtime.ts` stays the only importer.
- **The ML child** (`ml/scorer-process.ts`) gains an `embed` message beside `score`, with its own
  session. It keeps every existing limit: background priority, one thread, the duty cycle, paused
  on battery, unloaded after 10 idle minutes. Docs vectors go AHEAD of the bot-comment backlog: they
  are few and someone is waiting for them.
- **Availability** is asked at run time, as for severity (`isMlScoringAvailable` pattern). Not
  installed, paused or failed ⇒ `method: 'text'`. The SPA says nothing about it: retrieval is
  invisible, and the answer's citations are what the reader checks.
- `LIMN_AI_DISABLED=true` ⇒ no vectors are computed (retrieval serves only agentic features).
  Chunks and FTS are still written: they are cheap, and that keeps a later switch-on instant.

## Phases

| # | Work | Effort |
|---|---|---|
| 0 | Commit the benchmark harness (prep, bench, score scripts) under `scripts/`; rerun the † rows on an idle machine. **A bigger eval** in-repo (`reference-docs/__fixtures__/retrieval/`): ≥ 60 queries over ≥ 3 documents, gold = verified quotes, plus paraphrased queries that share no title word. A script prints the recall table above. Every later phase is judged on it. | 1 day |
| 1 | Chunks + FTS5 + `retrieve` text-only; story-docs prefilter switched; fingerprint id; backfill of built documents at boot (DB + disk only, bounded) | 2 days |
| 2 | The embedding model in the ML runtime; the `embed` message; vectors table + background fill; hybrid fusion; re-measure on this Mac | 2–3 days |
| 3 | Chat pre-retrieval (with the previous turn); measure turns, tokens and time-to-answer before/after on the stored questions | 1–2 days |
| 4 | Review pointer list; then decide on the `search_library` tool and on skipping the Haiku shortlist (only if hybrid top-8 ≥ Haiku's pick on the eval) | 1–2 days |
| 5 | Demo: if any visible string or state changes, seed it (`seed-demo*.ts`), record, `demo:verify` | 0.5 day |

## Tests

- `retrieve.test.ts`: FTS query building never passes raw syntax (quotes, `NEAR`, `*`, `:`,
  parentheses in the query); RRF determinism and ties; a section ranked by its best chunk; text-only
  when no vectors / wrong model / timeout.
- The chunker: packing, cuts, prefix, and ordinal stability across a rebuild.
- Migration: triggers keep FTS in step on insert, delete and rebuild; erase leaves no chunk, FTS or
  vector row; `verify:isolation` covers both tables.
- Story docs: the fingerprint changes with the retrieval id; the fallback is used only with no chunks.
- Opt-in integration (`LIMN_ML_MODELS_DIR` set): real embeddings over the eval fixture with a
  recall floor. ⚠ It SKIPS in CI, so check the skipped count.

## Rejected

- **Hosted embeddings (Voyage, OpenAI).** A new key and bill, and the reader's documents leave the
  machine. Neither Claude nor ChatGPT plans include them.
- **sqlite-vec now.** The right extension if a library ever passes ~200k chunks, and its blob format
  is ours, so adopting it needs no data migration. Today it is pre-v1 (v0.1.9; its approximate
  indexes are alpha in 0.1.10), it is a native extension per platform, and the measured scan does
  not need it.
- **sqlite-vss** (superseded by sqlite-vec), **LanceDB** (a second store beside SQLite),
  **`@huggingface/transformers`** (pulls in `onnxruntime-web` and `sharp`; we load ONNX directly),
  **Ollama** (a separate install).
- **EmbeddingGemma and nomic** on this Mac: 3–8× the CPU per chunk and up to 1.6 GB, with no measured
  gain. **Qwen3-0.6B and arctic-m-v2** (2–4× EmbeddingGemma's download) are untested; they are
  rejected on size for this machine. Revisit only if the phase-0 eval shows the small model missing
  paraphrases.
- **Vectors alone.** Below text BM25 on this library's exact-term questions.

## Open questions

1. Does the larger eval keep the hybrid's lead and the small model's tie? (phase 0)
2. Can the Haiku shortlist call go, once candidates are good? It costs a share of the reader's plan
   on every check.
3. Storing int8 instead of float32 would make vectors 4× smaller. That is not needed at measured
   sizes, so the decision is deferred.
