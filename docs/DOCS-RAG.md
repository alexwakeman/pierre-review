# Plan: hybrid retrieval for the reference-docs library (full-text search, then local embeddings)

Status: **phase 1 (full-text search, no model) BUILT 2026-11-01** — [REFERENCE-DOCS.md](REFERENCE-DOCS.md)
§ Retrieval. Embeddings (phase 2) deferred. On the dev library the shipped code finds the right section in
the top 8 for 0.79 of the paraphrased chat questions (0.61 before) and 0.93 of the story criteria (0.70),
in ~3 ms a query. Re-measured 2026-11-01 on an idle machine, over a second document and 129 queries; this
replaces the 2026-10-31 figures. Background: [REFERENCE-DOCS.md](REFERENCE-DOCS.md) (the
library, the chat, Check against the docs), [ML-NODE-PORT.md](ML-NODE-PORT.md) (the local ONNX
runtime this reuses). Harness: [`scripts/docs-rag-bench/`](../scripts/docs-rag-bench/README.md).

## Recommendation in one paragraph

**Ship full-text search first, with no model.** SQLite FTS5 over the section TEXT (not titles and
summaries) is the largest measured gain and needs no download. **Add embeddings second, and only
with snowflake-arctic-embed-m-v2.0** (int8, vectors kept at 256 dims). It is the only model measured
that adds anything over FTS5. The small 384-dim models planned on 2026-10-31 (arctic-embed-s,
bge-small, MiniLM) add nothing measurable once FTS5 searches the text, so they are dropped. The
medium model costs about 1.45 GB of memory while loaded and 0.6 CPU-seconds per chunk to index. That
is acceptable on the 2018 MacBook Pro as a background job that unloads when idle, but it ships only if
the in-repo eval confirms the gain.

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
| Check against the docs (`review/story-docs/manager.ts` → `shortlist.ts`) | Whole library inline when ≤ 48k chars (`wholeLibraryShortlist`); else `prefilterSections`: BM25 over each section's TITLE, trail, headings, one-line summary and document title (never the body) → top 30 → Haiku picks ≤ 8 | Body text is never searched. A story that shares no word with a title or summary scores nothing; then Haiku gets INDEX + every CONTENTS.md (≤ 60k chars) and guesses. |
| Docs chat (`reference-docs/chat.ts`) | The agent walks INDEX → CONTENTS → sections with Read/Glob/Grep (≤ 30 turns, $1) | Every answer pays for the walk in turns and tokens; Grep finds only exact words. |
| Reviews with the library on (`review-refs.ts`) | The same walk, inside the review run | The walk costs turns a diff-only review barely has (`DIFF_ONLY_DOCS_MIN_TURNS`). |

## Constraints

1. **No hosted embeddings.** Anthropic makes no embedding model (its docs point to Voyage, a
   separate account); a ChatGPT sign-in gives no embeddings endpoint. A key would also send the
   reader's documents to a third party. Embeddings are computed LOCALLY.
2. **The 2018 Intel MacBook Pro is the floor.** Indexing runs inside the ML posture (background
   priority, one thread, duty cycle, paused on battery); a query answers in well under a second on
   it, on a busy machine.
3. **Nothing new in the npm manifest.** The model rides the existing first-use ML runtime
   (`onnxruntime-node` + `@huggingface/tokenizers`, `ml/runtime.ts`, `limnMlModels`).
4. **SQLite only, one file.** No second store; the account erase, export and `verify:isolation`
   rules apply to the new tables.
5. **Retrieval is an aid, never a gate.** No model installed, an index still building, or a
   failure ⇒ the surface works with FTS5 alone, or as it does today. Unknown is never "nothing
   relevant".

## Measured on the 2018 MacBook Pro (2026-11-01)

Idle machine (load average 1.5–6 during the runs; no other benchmark or build). The backend's own
`onnxruntime-node` 1.23.2 and `@huggingface/tokenizers` 0.2.0, the scorer's session options (CPU,
`graphOptimizationLevel: 'all'`, no memory arena), one text per run, int8 (`model_quantized.onnx`)
exports.

**The corpus** is the dev library: two documents, 60 sections, 35k words, **210 chunks** of ≤ 220
words, each prefixed with `Document › trail › section` + the section's stored one-line summary.
- *The Statutory Biodiversity Metric — User Guide* (37 sections): reference material.
- *Rules & Flags* (23 sections): the import service's validation spec, from which the stories were
  written.

**The eval set** has 129 queries:
- **Real (15):** 10 succeeded Check against the docs runs (gold = the sections holding each VERIFIED
  quote) and 5 chat questions (gold = the cited sections). The gold predates Rules & Flags, so these
  are scored within the guide (see "Crowding" below). The set is small and favours today's method,
  which produced its gold.
- **Paraphrased chat (57):** one question per section, written to share no title, heading or
  distinctive phrase with it (3 boilerplate sections skipped). This is the set that separates the
  methods.
- **Paraphrased story criteria (57):** one per section. These are too easy (FTS5 already reaches
  0.93–1.00), so they show nothing between methods.

### Speed and memory (1 thread unless stated)

| Model (int8) | Licence | Download | Dims | ms / chunk | 4 threads | Short query | Story query | Peak memory |
|---|---|---|---|---|---|---|---|---|
| all-MiniLM-L6-v2 | Apache-2.0 | 23 MB | 384 | 50 | 18 | 3 ms | 27 ms | 210 MB |
| bge-small-en-v1.5 | MIT | 34 MB | 384 | 154 | 71 | 8 ms | 82 ms | 291 MB |
| snowflake-arctic-embed-s | Apache-2.0 | 34 MB | 384 | 158 | 64 | 9 ms | 89 ms | 315 MB |
| nomic-embed-text-v1.5 | Apache-2.0 | 137 MB | 768 | 520 | 182 | 34 ms | 284 ms | 820 MB |
| **snowflake-arctic-embed-m-v2.0** | **Apache-2.0** | **311 MB** | **768 (256 kept)** | **619** | **230** | **42 ms** | **321 ms** | **1,452 MB** |
| EmbeddingGemma-300m | Gemma terms | 309 MB | 768 | 1,285 | 777 | 583 ms * | 967 ms | 1,679 MB |
| Qwen3-Embedding-0.6B | Apache-2.0 | 614 MB | 1024 | 2,481 | 953 | 382 ms | 1,638 ms | 2,082 MB |

\* EmbeddingGemma's ONNX export costs about 0.6 s even for a one-line query.

arctic-embed-m-v2.0's memory does not move with session options: it peaked at 1,429–1,477 MB with
graph optimisation `all`, `basic` or `disabled`, and with the memory pattern on or off. It is the
cost of the model.

Other measurements:
- **FTS5** (`better-sqlite3`'s bundled SQLite 3.49.2, `porter unicode61`): **0.5–1 ms** per query
  over 210 chunks.
- **The similarity scan** (brute force in JS over a `Float32Array`, 384 dims): 4 ms at 5k chunks,
  41 ms at 50k and 148 ms at 200k. At 256 dims it is about a third less.

### Retrieval quality (section recall at k)

| Method | Para. chat R@3 | Para. chat R@8 | Para. chat MRR | Para. story R@8 | Real R@8 (guide) | Real R@30 (guide) | Real R@30 (whole library) |
|---|---|---|---|---|---|---|---|
| **Today**: BM25 over titles, trails, headings, summaries | 0.46 | 0.61 | 0.39 | 0.70 | 0.50 | 0.94 | 0.80 |
| **FTS5 over chunk text** | **0.68** | **0.82** | **0.59** | **0.93** | **0.59** | 0.94 | 0.85 |
| MiniLM + FTS5 (hybrid) | 0.63 | 0.81 | 0.60 | 0.98 | 0.66 | 0.99 | 0.85 |
| arctic-embed-s + FTS5 | 0.63 | 0.86 | 0.60 | 0.96 | 0.63 | 0.99 | 0.91 |
| bge-small + FTS5 | 0.67 | 0.88 | 0.64 | 0.95 | 0.66 | 0.96 | 0.90 |
| nomic v1.5 + FTS5 | 0.67 | 0.82 | 0.58 | 0.95 | 0.59 | 0.96 | 0.87 |
| arctic-embed-m-v2.0, vector alone | 0.68 | 0.86 | 0.66 | 0.96 | 0.75 | 0.99 | **0.96** |
| **arctic-embed-m-v2.0 + FTS5** | **0.74** | **0.93** | **0.69** | 0.98 | 0.68 | 1.00 | 0.92 |
| arctic-embed-m-v2.0 @256 dims + FTS5 | **0.75** | 0.91 | 0.66 | 0.98 | 0.68 | 0.99 | 0.91 |
| EmbeddingGemma + FTS5 | 0.72 | 0.89 | 0.63 | 1.00 | 0.62 | 0.99 | 0.89 |
| Qwen3-0.6B + FTS5 | 0.68 | 0.88 | 0.64 | 1.00 | 0.71 | 0.96 | 0.87 |

Hybrid = reciprocal rank fusion (k = 60) of FTS5's top 100 chunks and the vector top 100; a section
ranks by its best chunk. A paired bootstrap was run on the 114 paraphrased queries against text
BM25. Every hybrid's 95% interval for R@3 and MRR includes zero. arctic-embed-m-v2.0's is the only
one that is nearly all above it: R@3 +0.05 [−0.03, +0.10], MRR +0.06 [−0.01, +0.10]. The gain is
probable, not proven, which is why phase 2 is gated. Vectors ALONE are
significantly WORSE than text for every model except arctic-embed-m-v2.0 and EmbeddingGemma.

What it shows:
1. **FTS5 over the text is the big step**, and it needs no model: paraphrased-chat R@8 goes from 0.61
   to 0.82, story criteria from 0.70 to 0.93, and real queries from 0.50 to 0.59.
2. **The small models add nothing measurable once FTS5 searches the text.** The 2026-10-31 gain
   (0.65 → 0.74) came from 15 queries on one document and does not reproduce on 114 paraphrased
   ones. arctic-embed-s is dropped.
3. **arctic-embed-m-v2.0 is the only model with a consistent gain**: paraphrased chat R@3 rises from
   0.68 to 0.74–0.75 and R@8 from 0.82 to 0.91–0.93. It is the only model as good as text on its own.
   Keeping 256 of its 768 dims (it is trained for that) loses nothing measurable.
4. **The big models buy nothing more.** EmbeddingGemma and Qwen3 are 2–4× slower than
   arctic-embed-m-v2.0 per chunk, 10–30× slower per short query, use more memory, and do not score
   better.
5. **For Check against the docs, the 30 candidates already hold the gold** within one document (R@30
   0.94 today). The gain there is in a larger library (whole-library R@30: 0.80 today, 0.85 with
   FTS5, 0.92 hybrid) and in the order Haiku sees.
6. **Chat follow-ups need the conversation.** "What other edge cases like this exist?" retrieves
   nothing useful alone, so the query includes the previous user turn.

### Crowding: a spec in the library outranks the reference

When the library holds the spec a story was written from (*Rules & Flags*), that spec fills the top
of every ranking, because it repeats the story's own words. For the 10 real story checks, 4–8 of the
top 8 sections were Rules & Flags sections with every method, and guide recall at 8 fell to
0.14–0.34. That is correct retrieval: the spec IS relevant. But a check of a story against its own
spec mostly confirms itself.

A per-document round-robin (each document's best section, then each one's second best, and so on)
raised the guide's R@8 from 0.14 to 0.31 (FTS5) and from 0.17 to 0.48 (arctic-embed-s hybrid). It
also LOWERED R@30 (0.85 → 0.75 for FTS5), because it caps a large document's share. So:
- **Short lists** (the chat's inlined passages, the review pointer list) take at most half their
  places from one document when more than one document matches.
- **The story-check candidates** (30 for Haiku) stay in plain rank order.

The real-query eval needs gold that covers every document before this is tuned further (phase 0).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| First step | **FTS5 over chunk text, no model** (phase 1) | The largest measured gain; nothing to download; 1 ms a query. |
| Embedding model | **snowflake-arctic-embed-m-v2.0, int8**: CLS pooling, query prefix `query: `, no document prefix, the first **256** dims re-normalised. **Gated:** it ships only if the phase-0 eval shows ≥ +0.05 R@8 on chat over FTS5. | The only model measured that beats FTS5 and is as good as text on its own. 8k-token context, multilingual, Apache-2.0. The small models add nothing over FTS5; EmbeddingGemma and Qwen3 are 2–4× slower per chunk and score no better. |
| Store | Plain SQLite tables: chunks, an FTS5 index over them, and vectors as float32 little-endian BLOBs (normalised, 256 dims = 1 KB a chunk) | One file, the existing erase, export and isolation rules apply, and no native extension. |
| Similarity | Dot product of normalised vectors (= cosine) in JS, over a per-workspace `Float32Array` cached in memory | No index needed below ~200k chunks. |
| Keyword side | FTS5 `bm25()` over chunk text, `porter unicode61` | Built into the bundled SQLite. |
| Fusion | RRF, k = 60, chunk level → best chunk per section | No weights to tune; deterministic. |
| Short lists | At most half the places from one document when several match | Crowding (above). |
| Chunking | Within a section, paragraphs packed to ≤ 220 words; a block over 300 words cut by words; prefix `Document › trail › section` + the section's stored summary | The section stays the citation unit. The prefix gives the "contextual retrieval" benefit from text the build already wrote, with no extra model call. |
| Indexing | Chunks + FTS rows written in the same step as `saveDocBuilt` (`reference-docs/manager.ts` ~l. 587, the one place a build or wiki refresh lands). Vectors in the background ML child, after the build. | A document is searchable by text the moment it is ready; vectors follow without blocking it. |
| Query embedding | The same ML child, the query sent AHEAD of queued work; **2 s timeout → FTS5 only** | A query is 42–320 ms of work on one thread; on a busy machine background priority may stretch it. |
| Memory | The embed session has its OWN idle unload: **3 minutes** (the severity session keeps its 10) | 1.45 GB is acceptable while someone is using the docs, not as a resident cost. |

## Design

### Storage (one hand-written additive migration; read [MIGRATIONS.md](MIGRATIONS.md) first)

```
reference_doc_chunks
  id               integer pk
  account_id       integer not null            -- tenant anchor, as every docs table
  workspace_id     integer not null            -- composite FK (workspace_id, account_id) → workspaces, cascade
  doc_id           integer not null            -- composite FK (doc_id, account_id) → reference_docs, cascade
  built_at         integer not null            -- the reference_docs.built_at this chunk belongs to
  section_file     text not null               -- the section path (the citation unit)
  anchor           text                        -- the nearest heading anchor, for the deep link
  ordinal          integer not null            -- position in the document
  text             text not null               -- the chunk as indexed (prefix + body)
  index (account_id, workspace_id, doc_id)

reference_doc_chunks_fts   -- FTS5, content='reference_doc_chunks', tokenize='porter unicode61'
                           -- kept in step by AFTER INSERT/DELETE triggers in the same migration

reference_doc_chunk_vectors          -- phase 2's migration
  chunk_id         integer pk → reference_doc_chunks(id), cascade
  account_id       integer not null
  model            text not null               -- 'arctic-embed-m-v2-q8@<sha8>/256'; any other value is
                                               --   ignored and redone
  dim              integer not null
  vec              blob not null               -- float32 LE, L2-normalised (sqlite-vec's format too)
```

⚠ Drizzle cannot declare FTS5 virtual tables or their triggers. They live in the `.sql` migration only,
like the `isDefault` partial index. ⚠ Register the migration in `_journal.json`, or it SILENTLY SKIPS.
⚠ Every table carries `account_id` → join `accountScopedTables()` and `verify:isolation`. A rebuild
deletes the document's chunks and inserts the new ones in ONE `runTransaction` (DB work only); a
failed build keeps the old chunks, as it keeps the old files.

### The retrieval module (`reference-docs/retrieve.ts`, pure over DB + one embed call)

```
retrieve({accountId, workspaceId, query, docSlugs?, k, perDocCap?}) → {
  sections: [{path, anchor, docTitle, title, bestChunk, score}],   // ranked, ≤ k
  method: 'hybrid' | 'text',                                        // what actually ran
}
```

1. FTS5: the query's terms (the `prefilterTerms` stopword list, each term quoted and OR-joined;
   the query is UNTRUSTED and FTS5 syntax must never reach `MATCH` raw) → top 100 chunks by `bm25()`.
2. Vectors (phase 2): when the workspace has vectors for the current model, embed the query (2 s
   timeout) → dot against the cached matrix → top 100.
3. RRF → group by section (best chunk) → optional per-document cap → top k. Ties break by path, so
   the order is deterministic.

The matrix cache is keyed `(workspaceId, model, max(chunk id), count)`, rebuilt on change, and
dropped after 10 idle minutes.

### Surfaces

1. **Check against the docs** (`review/story-docs/manager.ts`; Implement story's docs pass used it too
   until it was removed, 2026-11-07): it called `prefilterSections`, and switches to
   `retrieve(..., k: 30)` behind one function in `shortlist.ts`. The
   query is the story title, description and criteria; the candidates stay in plain rank order;
   Haiku's pick is unchanged. The INDEX + CONTENTS fallback stays ONLY for a library with no chunks
   yet. The `wholeLibraryShortlist` short cut (≤ 48k chars) is unchanged.
   ⚠ **The fingerprint gains the retrieval id** (`fts-v1`, later `hybrid-v1:<model>`) in its
   `models` list. A field that changes the answer and is missing from the fingerprint serves a stale
   answer as current.
2. **Docs chat** (`reference-docs/chat.ts`): before the run, `retrieve` with the question plus the
   previous user turn, k = 6, at most 3 from one document. Each section's best chunk (≤ 12k chars in
   all) goes into the prompt in its own nonce fence, as untrusted data with its section link. The
   tools stay, and the prompt says to open a section when the passage is not enough. The citation
   and quote checks are unchanged: they re-read the section from disk.
3. **Reviews with the library on** (`review-refs.ts`): the docs block gains "Likely relevant
   sections": up to 8 links with their one-line summaries (never text), retrieved from the PR title,
   description and changed paths, at most 4 from one document. ⚠ Switch off ⇒ byte-for-byte
   unchanged (`review-refs.test.ts` pins it).
4. **Codex** gets all of this unchanged, because retrieval and inlining are server-side. A
   `search_library` TOOL (in-process for Claude; in `ai/codex/workspace-files.ts` for Codex) is a
   later, optional phase.

### The runtime (phase 2)

- **The model** is one more `limnMlModels` entry (311 MB model + 17 MB tokenizer, sha256-pinned),
  downloaded by the same "Set up" / `limn ml install` path, and only when the workspace has a built
  document. No manifest change; `ml/runtime.ts` stays the only importer.
- **The ML child** (`ml/scorer-process.ts`) gains an `embed` message beside `score`, with its own
  session and its own 3-minute idle unload. It keeps every existing limit: background priority, one
  thread, the duty cycle, paused on battery. Docs vectors go AHEAD of the bot-comment backlog,
  because there are few of them and someone is waiting.
- **Indexing cost on this Mac** at 0.62 CPU-s a chunk: the dev library (210 chunks) is about 2 CPU
  minutes, about 4½ minutes of wall time at the default 50% duty cycle. The largest document the
  build accepts (≈ 900 chunks) is about 9 CPU minutes, about 19 minutes of wall time. It is a one-off
  per build. Until it finishes, `method` is `text`.
- **Availability** is asked at run time, as for severity (the `isMlScoringAvailable` pattern). Not
  installed, paused or failed ⇒ `method: 'text'`. The SPA says nothing about it: retrieval is
  invisible, and the answer's citations are what the reader checks.
- `LIMN_AI_DISABLED=true` ⇒ no vectors are computed (retrieval serves only agentic features).
  Chunks and FTS are still written: they are cheap, and that keeps a later switch-on instant.

## Phases

| # | Work | Done when | Effort |
|---|---|---|---|
| 0 | **The eval, in repo.** A fixture under `reference-docs/__fixtures__/retrieval/` built from public text (the biodiversity guide is Crown copyright, Open Government Licence; add a second public reference document and a synthetic spec that restates its rules, to reproduce crowding): ≥ 100 paraphrased chat questions, ≥ 30 multi-section story checks with gold across EVERY document, and the stored chat questions with follow-ups. `scripts/docs-rag-bench/` reads it. | `score.mjs` prints the table above from the fixture alone | 1 day |
| 1 | **BUILT 2026-11-01.** **FTS5, no model.** Migration (chunks + FTS5 + triggers, journal, erase, isolation); the chunker; writing chunks next to `saveDocBuilt`; a bounded boot backfill of built documents (DB + disk only); `retrieve` text-only with the per-document cap; both story-docs callers switched; fingerprint `fts-v1`; chat pre-retrieval (k 6, previous turn). | Eval: paraphrased chat R@8 ≥ 0.80 and story R@8 ≥ 0.90; `pnpm test`, `typecheck`, `verify:isolation` green | 3 days |
| 1b | **Measure the chat** on the stored questions, before and after pre-retrieval: turns, tokens, time to answer, and citations that pass the quote check. | The numbers are written here | 0.5 day |
| 2 | **Embeddings, gated.** Re-run the phase-0 eval with arctic-embed-m-v2.0 @256. Go only if chat R@8 rises ≥ 0.05 over FTS5. Then: the model entry, the `embed` message and session (3-min unload), the vectors table, the background fill, the hybrid fusion, fingerprint `hybrid-v1:<model>`, and a re-measure on this Mac. | Eval gate met; a 900-chunk document indexes on battery-off background in < 30 min without the machine feeling it | 3 days |
| 3 | The review pointer list; then decide on the `search_library` tool, and on dropping the Haiku shortlist (only if retrieval's top 8 matches Haiku's pick on the eval) | — | 1–2 days |
| 4 | Demo: if any visible string or state changes, seed it (`seed-demo*.ts`), record, `demo:verify` | `demo:verify` green | 0.5 day |

Phase 1 alone delivers most of the measured gain. If phase 2's gate fails, the plan stops there with
nothing lost.

## Tests

- `retrieve.test.ts`: FTS query building never passes raw syntax (quotes, `NEAR`, `*`, `:`,
  parentheses, `AND`/`OR`/`NOT` in the query); RRF determinism and ties; a section ranked by its best
  chunk; the per-document cap; text-only when no vectors / wrong model / timeout.
- The chunker: packing, cuts, prefix, ordinal stability across a rebuild.
- Migration: triggers keep FTS in step on insert, delete and rebuild; erase leaves no chunk, FTS or
  vector row; `verify:isolation` covers every new table.
- Story docs and story build: the fingerprint changes with the retrieval id; the INDEX/CONTENTS
  fallback is used only with no chunks; both callers go through the one function.
- Opt-in integration (`LIMN_ML_MODELS_DIR` set): real embeddings over the eval fixture with a recall
  floor. ⚠ It SKIPS in CI, so check the skipped count.

## Rejected

- **Hosted embeddings (Voyage, OpenAI).** A new key and bill, and the reader's documents leave the
  machine. Neither Claude nor ChatGPT plans include them.
- **The small models (arctic-embed-s, bge-small, MiniLM).** Cheap (≈ 300 MB, 0.15 s a chunk), but
  no measurable gain over FTS5 on 114 paraphrased queries.
- **EmbeddingGemma and Qwen3-0.6B.** 2–4× arctic-embed-m-v2.0's indexing time, 1.7–2.1 GB, 0.4–0.6 s
  for a one-line query, and no better scores.
- **nomic v1.5.** Cheaper than arctic-embed-m-v2.0 (820 MB), but no better than FTS5.
- **Vectors alone.** Worse than text for every model but two, and no better for those.
- **sqlite-vec now.** The right extension if a library ever passes ~200k chunks, and its blob format
  is ours, so adopting it needs no data migration. Today it is pre-v1, it is a native extension per
  platform, and the measured scan does not need it.
- **sqlite-vss** (superseded by sqlite-vec), **LanceDB** (a second store beside SQLite),
  **`@huggingface/transformers`** (pulls in `onnxruntime-web` and `sharp`; we load ONNX directly),
  **Ollama** (a separate install).

## Open questions

1. Does arctic-embed-m-v2.0's lead hold on the phase-0 fixture? (The phase-2 gate.)
2. Should a story check leave out the document the story was written from, or label it ("the
   story's own spec")? Crowding shows retrieval cannot decide this alone.
3. Can the Haiku shortlist call go once candidates are good? It costs a share of the reader's plan
   on every check.
