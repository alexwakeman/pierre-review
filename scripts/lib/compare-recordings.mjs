#!/usr/bin/env node
// COMPARE TWO DEMO RECORDINGS, modulo time: `node scripts/lib/compare-recordings.mjs a.json b.json`.
//
// Two records are never byte-equal (each seeds "now" afresh), so this compares what matters: the set
// of answers (method + normalised path, the demo's own lookup key), each answer's status, and each
// body with time taken out — ISO-8601 timestamps, numbers under keys ending in At/Ms, date-only
// strings and the period keys built from them are replaced by placeholders. Prints the differences
// and exits 1 when there are any. `--order` also compares the entry ORDER (the demo's query-less
// fallback serves the first entry recorded for a path).
import { readFileSync } from 'node:fs';

const [aPath, bPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ORDER = process.argv.includes('--order');
const LIMIT = 40;

const TIME_PARAM_NAMES = new Set(['from', 'to', 'since', 'until', 'before', 'after', 'start', 'end', 'asOf', 'now', 'fromMs', 'toMs', 't', '_']);
const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_MS_VALUE = /^\d{12,13}$/;
function normalisePath(input) {
  const u = new URL(input, 'http://demo.invalid');
  const pairs = [];
  u.searchParams.forEach((value, name) => {
    if (!(TIME_PARAM_NAMES.has(name) || ISO_DATE_VALUE.test(value) || EPOCH_MS_VALUE.test(value))) pairs.push([name, value]);
  });
  pairs.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) : x[0] < y[0] ? -1 : 1));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`).join('&');
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}

const DATEISH = /\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/g;
/** Time out of a body: every date-like substring, and every number under an *At / *Ms / age-ish key. */
function untime(v, key = '') {
  if (typeof v === 'string') return v.replace(DATEISH, '<date>');
  if (typeof v === 'number') return /(At|Ms|Hours|Days|Minutes|Seconds|age|Age|ago|Ago)$/.test(key) || (v > 1e12 && v < 1e13) || (v > 1e9 && v < 2e9) ? '<n>' : v;
  if (Array.isArray(v)) return v.map((x) => untime(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(DATEISH, '<date>'), untime(x, k)]));
  return v;
}

/** The first path inside two values where they differ. */
function firstDiff(a, b, path = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) return `${path}: ${a.length} items vs ${b.length}`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}

function load(p) {
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  const map = new Map();
  const order = [];
  for (const e of rec.entries) {
    const key = `${e.method} ${normalisePath(e.path)}`;
    if (map.has(key)) continue;
    map.set(key, e);
    order.push(key);
  }
  return { rec, map, order };
}

const A = load(aPath);
const B = load(bPath);
const onlyA = A.order.filter((k) => !B.map.has(k));
const onlyB = B.order.filter((k) => !A.map.has(k));
const differ = [];
let same = 0;
for (const k of A.order) {
  if (!B.map.has(k)) continue;
  const a = A.map.get(k);
  const b = B.map.get(k);
  const ua = untime({ status: a.status, body: a.body ?? null, stream: a.stream ? a.stream.map((f) => f.data) : null });
  const ub = untime({ status: b.status, body: b.body ?? null, stream: b.stream ? b.stream.map((f) => f.data) : null });
  const d = firstDiff(ua, ub);
  if (d) differ.push(`${k}\n      ${d}`);
  else same++;
}
console.log(`${aPath}: ${A.order.length} answers · ${bPath}: ${B.order.length} answers`);
console.log(`same (modulo time): ${same} · bodies differ: ${differ.length} · only in first: ${onlyA.length} · only in second: ${onlyB.length}`);
const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length}):`);
  for (const x of list.slice(0, LIMIT)) console.log(`  ${x}`);
  if (list.length > LIMIT) console.log(`  … ${list.length - LIMIT} more`);
};
show('only in first', onlyA);
show('only in second', onlyB);
show('bodies differ', differ);
let orderDiffs = 0;
if (ORDER) {
  const common = new Set(A.order.filter((k) => B.map.has(k)));
  const oa = A.order.filter((k) => common.has(k));
  const ob = B.order.filter((k) => common.has(k));
  // How many answers would have to MOVE to turn one order into the other: n − longest common run.
  const posB = new Map(ob.map((k, i) => [k, i]));
  const seq = oa.map((k) => posB.get(k));
  const tails = [];
  for (const x of seq) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  orderDiffs = oa.length - tails.length;
  console.log(`\norder: ${orderDiffs === 0 ? 'identical' : `${orderDiffs} of ${oa.length} common answers out of order`}`);
}
process.exit(onlyA.length || onlyB.length || differ.length || orderDiffs ? 1 : 0);
