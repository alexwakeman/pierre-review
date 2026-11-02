# Docs retrieval benchmark

The harness behind the measurements in [docs/DOCS-RAG.md](../../docs/DOCS-RAG.md). It reads a local
library and DB, so no corpus or query file is committed (they hold the reader's documents).

```
python3 -I prep.py <pierre-review.sqlite> <…/library> corpus.json     # sections → ≤ 220-word chunks + real evals
# optional: add {"kind","synth":true,"query","gold":[path]} entries to corpus.evals (paraphrased queries)
node fts.mjs corpus.json fts.json                                      # real FTS5 (porter unicode61) rankings
node bench.mjs <modelsDir> <model> <threads> corpus.json out-<model>.json   # ms/chunk, query ms, peak RSS, vectors
FTS=fts.json node score.mjs corpus.json out-*.json                     # recall table + paired bootstrap
WHOLE=1 MIX=1 FTS=fts.json node score.mjs …                            # whole-library view, per-document round-robin
node scan.mjs                                                          # brute-force scan timing
```

`<modelsDir>/<model>/` holds `model_quantized.onnx`, `tokenizer.json` and `config.json` from the
model's Hugging Face `onnx/` export. Model names and pooling are in `bench.mjs` `SPECS`. Check
`uptime` first: another process's load inflates every timing.
