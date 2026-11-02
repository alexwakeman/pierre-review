// node score2.mjs corpus.json out-*.json  — groups: real (story checks + chat), synth chat, synth story
import { readFileSync, existsSync } from 'node:fs';
const [corpusPath, ...outs] = process.argv.slice(2);
const C = JSON.parse(readFileSync(corpusPath, 'utf8'));
const STOP = new Set('the and for are but not you all any can had her was one our out has have this that with from they will would there their what when which who how why into than then them these those been being were also its such may must should could about other only some more most very each does did doing done over under per via upon your yours shall within without where while whether'.split(' '));
const terms = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
function bm25(docs, q) {
  const toks = docs.map(terms); const N = docs.length; const avg = toks.reduce((a, t) => a + t.length, 0) / N;
  const df = new Map(); toks.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
  const qt = [...new Set(terms(q))];
  return toks.map((t) => { const tf = new Map(); t.forEach((w) => tf.set(w, (tf.get(w) ?? 0) + 1));
    let s = 0; for (const w of qt) { const f = tf.get(w); if (!f) continue; const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * t.length / avg)); } return s; });
}
const secPaths = C.sections.map((s) => s.path);
const titleDocs = C.sections.map((s) => [s.title, s.title, ...(s.trail ?? []), ...(s.headings ?? []).map((h) => h.title ?? h), s.summary, s.doc].join(' '));
const chunkDocs = C.chunks.map((c) => c.prefix + c.text);
const order = (scores) => scores.map((s, i) => [i, s]).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
const sectionsOfChunks = (idxs) => { const seen = new Set(); const out = []; for (const i of idxs) { const p = C.chunks[i].section; if (!seen.has(p)) { seen.add(p); out.push(p); } } return out; };
const rrfIdx = (...lists) => { const s = new Map(); for (const l of lists) l.forEach((x, r) => s.set(x, (s.get(x) ?? 0) + 1 / (60 + r + 1))); return [...s.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]); };
const GROUPS = { real: (e) => !e.synth, 'synth-chat': (e) => e.synth && e.kind === 'chat', 'synth-story': (e) => e.synth && e.kind === 'story', all: () => true };
const docOf = (p) => p.split('/')[0];
const WHOLE = process.env.WHOLE === '1';
const view = (e, rk) => (e.synth || WHOLE ? rk : rk.filter((p) => docOf(p) === docOf(e.gold[0])));
// round-robin across documents: each document's best, then each one's second best, …
const mix = (rk) => { const by = new Map(); for (const p of rk) { const d = docOf(p); if (!by.has(d)) by.set(d, []); by.get(d).push(p); } const out = []; for (let r = 0; out.length < rk.length; r++) for (const l of by.values()) if (l[r]) out.push(l[r]); return out; };
const recall0 = (e, rk, k) => e.gold.filter((g) => rk.slice(0, k).includes(g)).length / e.gold.length;
const rr0 = (e, rk) => { const r = rk.findIndex((p) => e.gold.includes(p)); return r < 0 ? 0 : 1 / (r + 1); };
const recall = (e, rk, k) => recall0(e, view(e, rk), k);
const rr = (e, rk) => rr0(e, view(e, rk));
const perQ = (rks, k) => C.evals.map((e, i) => (k === 'mrr' ? rr(e, rks[i]) : recall(e, rks[i], k)));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const rows = [];
const bmTitle = C.evals.map((e) => order(bm25(titleDocs, e.query)).map((i) => secPaths[i]));
const bmChunkIdx = C.evals.map((e) => order(bm25(chunkDocs, e.query)));
rows.push(['today: BM25 titles+summaries', bmTitle]);
rows.push(['BM25 chunk text (JS)', bmChunkIdx.map(sectionsOfChunks)]);
const ftsIdx = process.env.FTS ? JSON.parse(readFileSync(process.env.FTS, 'utf8')) : null;
if (ftsIdx) rows.push(['FTS5 real (porter)', ftsIdx.map(sectionsOfChunks)]);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const trunc = (v, d) => { const x = v.slice(0, d); const n = Math.hypot(...x); return x.map((y) => y / n); };
for (const f of outs) {
  if (!existsSync(f)) continue;
  const O = JSON.parse(readFileSync(f, 'utf8'));
  if (O.docVecs.length !== C.chunks.length || O.qVecs.length !== C.evals.length) { console.error('skip (corpus mismatch)', f); continue; }
  for (const d of [O.dim, ...(['nomic', 'gemma', 'arctic-m2', 'qwen3'].includes(O.name) && O.dim > 256 ? [256] : [])]) {
    const dv = O.docVecs.map((v) => (d === O.dim ? v : trunc(v, d))); const qv = O.qVecs.map((v) => (d === O.dim ? v : trunc(v, d)));
    const vecIdx = C.evals.map((_, i) => order(dv.map((v) => dot(v, qv[i]))));
    const label = `${O.name}${d !== O.dim ? ' @' + d : ''}`;
    rows.push([label + ' vector', vecIdx.map(sectionsOfChunks)]);
    rows.push([label + ' hybrid', C.evals.map((_, i) => sectionsOfChunks(rrfIdx(bmChunkIdx[i].slice(0, 100), vecIdx[i].slice(0, 100))))]);
    if (ftsIdx) rows.push([label + ' hybrid FTS5', C.evals.map((_, i) => sectionsOfChunks(rrfIdx(ftsIdx[i], vecIdx[i].slice(0, 100))))]);
  }
}
if (process.env.MIX === '1') for (const r of rows.splice(0)) rows.push([r[0] + ' +mix', r[1].map(mix)]);
const hdr = Object.keys(GROUPS).map((g) => `${g}(${C.evals.filter(GROUPS[g]).length}) r3/8/30/mrr`.padEnd(26)).join('');
console.log('method'.padEnd(34), hdr);
for (const [n, rks] of rows) {
  const r3 = perQ(rks, 3), r8 = perQ(rks, 8), r30 = perQ(rks, 30), m = perQ(rks, 'mrr');
  console.log(n.padEnd(34), Object.values(GROUPS).map((g) => { const ix = C.evals.map((e, i) => i).filter((i) => g(C.evals[i])); const f = (a) => mean(ix.map((i) => a[i])).toFixed(2); return `${f(r3)} ${f(r8)} ${f(r30)} ${f(m)}`.padEnd(26); }).join(''));
}
// paired bootstrap, synthetic set, R@8 and MRR: each row minus the BM25-chunk row
const base = rows[1][1]; const ix = C.evals.map((e, i) => i).filter((i) => C.evals[i].synth);
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
console.log('\npaired bootstrap vs BM25 chunk text, synthetic set (95% CI)');
for (const [n, rks] of rows.slice(2)) {
  const out = [];
  for (const k of [3, 'mrr']) {
    const a = perQ(rks, k), b = perQ(base, k); const diffs = [];
    for (let t = 0; t < 2000; t++) { let s = 0; for (let j = 0; j < ix.length; j++) { const i = ix[Math.floor(rnd() * ix.length)]; s += a[i] - b[i]; } diffs.push(s / ix.length); }
    diffs.sort((x, y) => x - y); out.push(`${k === 'mrr' ? 'MRR' : 'R@3'} ${mean(ix.map((i) => a[i] - b[i])).toFixed(3)} [${diffs[50].toFixed(3)}, ${diffs[1949].toFixed(3)}]`);
  }
  console.log(n.padEnd(34), out.join('   '));
}
