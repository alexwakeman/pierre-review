// Docs-retrieval benchmark (docs/DOCS-RAG.md). Embeds a corpus.json from prep.py with one ONNX model.
// node bench.mjs <modelsRoot> <model> <threads> <corpus.json> <out.json> [fp32]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const req = createRequire(new URL('../../apps/backend/package.json', import.meta.url));
const ort = req('onnxruntime-node');
const { Tokenizer } = await import(req.resolve('@huggingface/tokenizers').replace(/[^/]+$/, 'tokenizers.mjs'));
const [root, name, threadsS, corpusPath, outPath, prec] = process.argv.slice(2);
const BGEQ = 'Represent this sentence for searching relevant passages: ';
const SPECS = {
  minilm:   { pool: 'mean', q: '', d: '', max: 256 },
  'bge-small': { pool: 'cls', q: BGEQ, d: '', max: 512 },
  'arctic-s':  { pool: 'cls', q: BGEQ, d: '', max: 512 },
  nomic:    { pool: 'mean', q: 'search_query: ', d: 'search_document: ', max: 512 },
  'arctic-m2': { pool: 'cls', q: 'query: ', d: '', max: 512 },
  gemma:    { pool: 'sentence', q: 'task: search result | query: ', d: 'title: none | text: ', max: 512 },
  qwen3:    { pool: 'last', q: 'Instruct: Given a question or a user story, retrieve passages of reference documentation that bear on it\nQuery:', d: '', max: 512 },
};
const spec = SPECS[name];
const dir = join(root, name);
const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const tok = new Tokenizer(JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')), {});
const t0 = performance.now();
const sess = await ort.InferenceSession.create(join(dir, prec === 'fp32' ? 'model.onnx' : 'model_quantized.onnx'), {
  executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Number(threadsS), interOpNumThreads: 1, enableCpuMemArena: false,
});
const loadMs = performance.now() - t0;
const inputs = sess.inputNames;
const EOS = 151643;
let maxTok = 0;
async function embed(text) {
  let ids = tok.encode(text).ids.map(Number);
  if (spec.pool === 'last' && ids[ids.length - 1] !== EOS) ids.push(EOS);
  if (ids.length > spec.max) ids = [...ids.slice(0, spec.max - 1), ids[ids.length - 1]];
  maxTok = Math.max(maxTok, ids.length);
  const n = ids.length;
  const feeds = {};
  const big = (a) => new ort.Tensor('int64', BigInt64Array.from(a.map(BigInt)), [1, a.length]);
  for (const k of inputs) {
    if (k === 'input_ids') feeds[k] = big(ids);
    else if (k === 'attention_mask') feeds[k] = big(ids.map(() => 1));
    else if (k === 'token_type_ids') feeds[k] = big(ids.map(() => 0));
    else if (k === 'position_ids') feeds[k] = big(ids.map((_, i) => i));
    else if (k.startsWith('past_key_values')) {
      const hd = cfg.head_dim ?? cfg.hidden_size / cfg.num_attention_heads;
      feeds[k] = new ort.Tensor('float32', new Float32Array(0), [1, cfg.num_key_value_heads, 0, hd]);
    } else throw new Error('unknown input ' + k);
  }
  const out = await sess.run(feeds);
  let v;
  if (spec.pool === 'sentence' || out.sentence_embedding) v = Array.from(out.sentence_embedding.data);
  else {
    const h = out.last_hidden_state; const D = h.dims[2]; const d = h.data;
    if (spec.pool === 'cls') v = Array.from(d.subarray(0, D));
    else if (spec.pool === 'last') v = Array.from(d.subarray((n - 1) * D, n * D));
    else { v = new Array(D).fill(0); for (let t = 0; t < n; t++) for (let j = 0; j < D; j++) v[j] += d[t * D + j]; for (let j = 0; j < D; j++) v[j] /= n; }
  }
  const norm = Math.hypot(...v); return v.map((x) => x / norm);
}
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
for (const c of corpus.chunks.slice(0, 2)) await embed(spec.d + c.prefix + c.text); // warm-up
const docT = performance.now();
const docVecs = [];
for (const c of corpus.chunks) docVecs.push(await embed(spec.d + c.prefix + c.text));
const docMs = (performance.now() - docT) / corpus.chunks.length;
const qT = performance.now();
const qVecs = [];
for (const e of corpus.evals) qVecs.push(await embed(spec.q + e.query));
const qMs = (performance.now() - qT) / corpus.evals.length;
const shortT = performance.now();
for (let i = 0; i < 10; i++) await embed(spec.q + 'how is a lowering of hedgerow condition recorded?');
const shortQMs = (performance.now() - shortT) / 10;
const res = { name, prec: prec ?? 'q8', threads: Number(threadsS), dim: docVecs[0].length, loadMs, docMsPerChunk: docMs, storyQueryMs: qMs, shortQueryMs: shortQMs, maxTok, maxRssMB: process.resourceUsage().maxRSS / 1024 };
writeFileSync(outPath, JSON.stringify({ ...res, docVecs, qVecs }));
console.log(JSON.stringify(res));
