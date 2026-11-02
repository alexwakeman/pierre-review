import { createRequire } from 'node:module';
const Database = createRequire(new URL('../../apps/backend/package.json', import.meta.url))('better-sqlite3');
const db = new Database(':memory:');
db.exec("create virtual table t using fts5(body, tokenize='porter unicode61')");
console.log('fts5 ok', db.prepare('select sqlite_version() v').get());
for (const [N, D] of [[5000, 384], [50000, 384], [50000, 256], [200000, 384]]) {
  const m = new Float32Array(N * D); for (let i = 0; i < m.length; i++) m[i] = Math.random() - 0.5;
  const q = new Float32Array(D).map(() => Math.random() - 0.5);
  const s = new Float32Array(N);
  let best = Infinity;
  for (let r = 0; r < 5; r++) { const t = performance.now(); for (let i = 0; i < N; i++) { let a = 0; const o = i * D; for (let j = 0; j < D; j++) a += m[o + j] * q[j]; s[i] = a; } best = Math.min(best, performance.now() - t); }
  console.log(N, D, 'scan ms', best.toFixed(1), 'MB', (N * D * 4 / 1e6).toFixed(0));
}
