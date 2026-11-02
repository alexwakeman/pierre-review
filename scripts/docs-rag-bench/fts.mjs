// node fts.mjs corpus.json out.json — real FTS5 (porter unicode61) ranking per eval, same chunks
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(new URL('../../apps/backend/package.json', import.meta.url));
const Database = req('better-sqlite3');
const [corpusPath, outPath] = process.argv.slice(2);
const C = JSON.parse(readFileSync(corpusPath, 'utf8'));
const db = new Database(':memory:');
db.exec(`create virtual table f using fts5(text, tokenize='porter unicode61')`);
const ins = db.prepare('insert into f(rowid, text) values (?, ?)');
C.chunks.forEach((c, i) => ins.run(i + 1, c.prefix + c.text));
const STOP = new Set('the and for are but not you all any can had her was one our out has have this that with from they will would there their what when which who how why into than then them these those been being were also its such may must should could about other only some more most very each does did doing done over under per via upon your yours shall within without where while whether given system'.split(' '));
const match = (q) => [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)))].map((w) => `"${w}"`).join(' OR ');
const sel = db.prepare('select rowid from f where f match ? order by bm25(f) limit 100');
let t = 0; const rankings = C.evals.map((e) => { const m = match(e.query); const t0 = performance.now(); const r = m ? sel.all(m).map((x) => x.rowid - 1) : []; t += performance.now() - t0; return r; });
console.log('fts avg ms/query', (t / C.evals.length).toFixed(2), 'sqlite', db.prepare('select sqlite_version() v').get().v);
writeFileSync(outPath, JSON.stringify(rankings));
