// THE DEMO RECORDER — `pnpm demo:record`.
//
// Seeds the fictional acme/* data into a scratch database, boots an ISOLATED backend + the SPA on
// spare ports, drives the real SPA with Playwright through every step of record-demo-steps.mjs —
// several browser pages at once — and writes every /api answer it saw to
// apps/frontend/src/demo/data/recording.json, the file the static demo at /demo/ replays (format:
// apps/frontend/src/demo/README.md), plus recording-steps.json beside it: which steps recorded which
// answer, and how long each step took (docs/DEMO.md § 2).
//
//   pnpm demo:record                     seed → boot → record every step → write → teardown
//   pnpm demo:record --only=<names>      re-record only these steps and MERGE them into the existing
//                                        recording (comma list; `*` globs; a plain name also takes
//                                        its `name:…` children, so `pr:113` is every pr:113:* step)
//   pnpm demo:record --changed[=<base>]  re-record the steps the changed files touch (git diff
//                                        against <base>, plus the working tree); a full record when
//                                        a change cannot be placed (seed, schema, wire types, …)
//   --concurrency=<n>   pages at once (default 6; 1 = one page, the old serial walk)
//   --backends=<n>      backend processes the pages share (default 3, at most the concurrency)
//   --dev               serve the SPA from the Vite dev server instead of a production build
//   --api-port=<p> --web-port=<p>   ports (default 4310 / 5383; or RECORD_BACKEND_PORT / RECORD_FRONTEND_PORT)
//   --settle-scale=<x>  multiply every quiet window (default 0.5; 1 = the old timings)
//   --out=<file>        write the recording somewhere else (its steps file goes beside it)
//   --no-seed           reuse the scratch DB from the last run
//   --keep              leave the servers running afterwards (Ctrl-C stops)
//   --probe             also write /tmp/limn-record-probe.json (every response, by step)
//   RECORD_VERBOSE=1 prints the servers' logs; RECORD_DEBUG_SETTLE=1 names what a slow settle waited for.
//
// ⚠ THE OUTPUT DOES NOT DEPEND ON THE CONCURRENCY. Each step records into its own bucket; an answer
// belongs to the FIRST step (in declared order) that recorded it, and entries are written sorted by
// (that step, method + normalised path). The demo's query-less fallback serves the first entry for a
// path, so the declared order still decides it — the default workspace's steps come first.
// ⚠ EVERY STEP STARTS FROM A CLEAN BROWSER (storage and IndexedDB cleared), so a step records the
// same answers whichever page runs it, and after whichever step.
// ⚠ AN INCREMENTAL RECORD RUNS AS OF THE OLD RECORDING'S `capturedAt`: the seeder, the backend and
// the browser have their clocks moved back (scripts/lib/demo-clock.mjs), so fresh answers carry the
// same sprint keys, ages and windows as the answers they sit beside.
//
// ⚠ NO MODEL IS EVER CALLED. The backend runs with HOME and LIMN_DATA_DIR in a scratch
// directory (no Claude Code sign-in is found there), no ANTHROPIC_API_KEY, a placeholder
// CLAUDE_CODE_OAUTH_TOKEN (so the routes report Claude as set up and the recording carries the Run
// buttons the demo replays) and ANTHROPIC_BASE_URL pointing at a closed loopback port. The recorder
// never presses a Run, Generate, Post, Merge or Push button: every finished agentic run in the
// recording is a row the seeder wrote.
//
// ⚠ NOTHING TOUCHES YOUR REAL STACK: its own ports (4310 / 5383), its own database
// (/tmp/limn-record.sqlite), `gh` off the PATH (as scripts/demo-stack.mjs explains — the boot
// would otherwise replace the seeded viewer, Morgan Diaz, with your GitHub identity). "Off the PATH"
// is three guards, because /usr/bin stays on it and a gh there authenticates from the environment:
// every GH_*/GITHUB_* token variable is stripped from the children, a `gh` shim that always fails
// sits FIRST on the PATH, and recording.json is refused unless /api/me answers as the fictional
// viewer (`user.login` === VIEWER_LOGIN) — a recording carrying your identity is never written.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import * as STEP_MODULE from './record-demo-steps.mjs';
import { installGithubStandIn } from './lib/demo-github.mjs';
import { browserClockScript } from './lib/demo-clock.mjs';
import { changedFiles, globToRegExp, stepsForChanges } from './lib/demo-changes.mjs';

const { STEPS } = STEP_MODULE;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, 'apps', 'backend');
const FRONTEND = join(ROOT, 'apps', 'frontend');
const CLOCK_MODULE = join(ROOT, 'scripts', 'lib', 'demo-clock.mjs');

const args = process.argv.slice(2);
/** `--name=value` or `--name value`; `true` for a bare flag; undefined when absent. */
function arg(name) {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = args[i + 1];
  return next != null && !next.startsWith('--') ? next : true;
}
const str = (name) => (typeof arg(name) === 'string' ? arg(name) : undefined);

const OUT = str('out') ?? join(FRONTEND, 'src', 'demo', 'data', 'recording.json');
const STEPS_OUT = `${OUT.replace(/\.json$/, '')}-steps.json`;
// Overridable so two worktrees can record side by side without sharing a database.
const DB = process.env.RECORD_DB ?? '/tmp/limn-record.sqlite';
process.env.RECORD_DB = DB; // the steps read it (timelinePrIds)
const SCRATCH = process.env.RECORD_SCRATCH ?? '/tmp/limn-record-home';
const DATA_DIR = join(SCRATCH, 'data');
const BACKEND_PORT = Number(str('api-port') ?? process.env.RECORD_BACKEND_PORT ?? 4310);
const FRONTEND_PORT = Number(str('web-port') ?? process.env.RECORD_FRONTEND_PORT ?? 5383);

const RESEED = !args.includes('--no-seed');
const KEEP = args.includes('--keep');
const PROBE = args.includes('--probe');
const HEADED = args.includes('--headed');
const DEV = args.includes('--dev');
const CONCURRENCY = Math.max(1, Number(str('concurrency') ?? process.env.RECORD_CONCURRENCY ?? 6));
// Backend processes (each with its own SPA server on the next port up): one Node process answering
// six pages is the bottleneck, and every read is DB-only, so several read the same SQLite file.
const BACKENDS = Math.max(1, Math.min(CONCURRENCY, Number(str('backends') ?? 3)));
/** Lane i: backend `api-port + i`, its SPA on `web-port + i`. Lane 0 is the one named on the command line. */
const LANES = Array.from({ length: BACKENDS }, (_, i) => ({
  api: BACKEND_PORT + i,
  web: FRONTEND_PORT + i,
  origin: `http://localhost:${FRONTEND_PORT + i}`,
  base: `http://localhost:${FRONTEND_PORT + i}/app/`,
  backend: `http://localhost:${BACKEND_PORT + i}`,
}));
const SETTLE_SCALE = Number(str('settle-scale') ?? 0.5);
const ONLY = str('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const CHANGED = arg('changed');
const CHANGED_BASE = typeof CHANGED === 'string' ? CHANGED : (str('base') ?? null);
// The seeded viewer (apps/backend/scripts/seed-demo.ts). The recording must answer as them.
const VIEWER_LOGIN = 'morgan-diaz';

// --- a gh-free PATH the children can still find node on --------------------------------------
const shimDir = mkdtempSync(join(tmpdir(), 'limn-record-bin-'));
symlinkSync(process.execPath, join(shimDir, 'node'));
// A `gh` that always fails, ahead of any /usr/bin/gh: the boot can never learn a real identity.
writeFileSync(join(shimDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const SAFE_PATH = [shimDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

mkdirSync(DATA_DIR, { recursive: true });
const baseEnv = {
  ...process.env,
  PATH: SAFE_PATH,
  HOME: SCRATCH,
  LIMN_DATA_DIR: DATA_DIR,
  LIMN_DOCS_DIR: join(DATA_DIR, 'docs'),
  CLONE_DIR: join(DATA_DIR, 'clones'),
  DATABASE_URL: DB,
  // No first-boot AI download (ai/auto-install.ts): it would hit the network and turn /api/me's
  // `ai.runtime` into 'installing' mid-shot.
  LIMN_AI_AUTO_INSTALL: 'false',
  DISABLE_SCHEDULER: 'true',
  // The walk below is far faster than a person; a 429 would be recorded as the answer.
  RATE_LIMIT_DISABLED: 'true',
  // A credential that is not one, and nowhere to send it. The routes report "Claude is set up", so
  // the recording shows the Run buttons the demo replays; a run that somehow started would reach
  // nothing (port 9 on loopback) and fail at once. No API key at all.
  CLAUDE_CODE_OAUTH_TOKEN: 'limn-demo-recording-not-a-token',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  // The ML gate is the URL (see demo-stack.mjs); nothing calls it with the scheduler off.
  SEVERITY_API_URL: 'http://127.0.0.1:8799',
  LIMN_ML_SCORER: 'http',
};
delete baseEnv.ANTHROPIC_API_KEY;
delete baseEnv.SUMMARY_ANTHROPIC_API_KEY;
// gh (and anything else) authenticates from these regardless of HOME — none may reach a child.
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) delete baseEnv[k];

// --- process helpers ---------------------------------------------------------------------------
const children = new Set();
function run(cmd, cmdArgs, opts) {
  const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  const tag = opts.tag ?? cmd;
  child.stdout.on('data', (d) => process.env.RECORD_VERBOSE && process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on('data', (d) => process.env.RECORD_VERBOSE && process.stderr.write(`[${tag}] ${d}`));
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function stop(child) {
  if (!child || child.exitCode != null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
const cleanups = [];
function teardown() {
  for (const c of children) stop(c);
  for (const f of cleanups.splice(0)) f();
}
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});
process.on('exit', teardown);

function portBusy(port) {
  const r = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  return r.stdout.trim().length > 0;
}

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs / 1000}s`);
}

function seed(env) {
  console.log(`▸ seeding → ${DB}`);
  rmSync(join(DATA_DIR, 'docs'), { recursive: true, force: true });
  const r = spawnSync(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['scripts/seed-demo.ts'], {
    cwd: BACKEND,
    stdio: process.env.RECORD_VERBOSE ? 'inherit' : ['ignore', 'ignore', 'inherit'],
    env,
  });
  if (r.status !== 0) throw new Error('seed-demo.ts failed');
}

/**
 * The production SPA, built once per distinct source: a hash of everything `vite build` reads names
 * the output directory, so an incremental record after a backend-only change skips the build.
 */
async function buildSpa(env, vite) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('dist-')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else hash.update(p).update(readFileSync(p));
    }
  };
  for (const d of [join(FRONTEND, 'src'), join(ROOT, 'packages', 'shared', 'src')]) walk(d);
  for (const f of [join(FRONTEND, 'index.html'), join(FRONTEND, 'vite.config.ts'), join(FRONTEND, 'package.json'), join(ROOT, 'pnpm-lock.yaml')]) {
    if (existsSync(f)) hash.update(f).update(readFileSync(f));
  }
  const key = hash.digest('hex').slice(0, 16);
  const prefix = 'limn-record-web-';
  const dir = join(tmpdir(), `${prefix}${key}`);
  if (existsSync(join(dir, 'index.html'))) {
    console.log(`▸ the SPA is unchanged since the last record: reusing ${dir}`);
    return dir;
  }
  for (const name of readdirSync(tmpdir())) if (name.startsWith(prefix)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  const building = `${dir}.building`;
  console.log(`▸ building the SPA → ${dir}`);
  const status = await new Promise((res) => {
    const b = spawn(vite, ['build', '--outDir', building, '--emptyOutDir', '--logLevel', 'error'], { cwd: FRONTEND, env, stdio: ['ignore', 'ignore', 'inherit'] });
    b.on('exit', res);
  });
  if (status !== 0) throw new Error('vite build failed');
  renameSync(building, dir);
  return dir;
}

/**
 * Writes the SPA makes by itself when a view opens, answered IN THE BROWSER the way the demo answers
 * them (apps/frontend/src/demo/routes.ts), so the backend never sees them. Opening a PR marks it viewed
 * — and "new since you last looked" is part of what other views read, so a write that reached the
 * backend would make a step's answers depend on which steps ran before it.
 */
const STUBBED_WRITES = [
  { method: 'POST', re: /^\/api\/prs\/\d+\/mark-viewed$/, body: () => ({ status: 'ok' }) },
  { method: 'POST', re: /^\/api\/prs\/mark-all-viewed$/, body: () => ({ status: 'ok', count: 0 }) },
  { method: 'POST', re: /^\/api\/activity\/feed\/mark-seen$/, body: () => ({ feedLastSeenAt: new Date().toISOString() }) },
];
async function stubWrites(context) {
  await context.route(
    (url) => STUBBED_WRITES.some((w) => w.re.test(url.pathname)),
    (route) => {
      const req = route.request();
      const w = STUBBED_WRITES.find((x) => x.method === req.method() && x.re.test(new URL(req.url()).pathname));
      if (!w) return route.continue();
      return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(w.body()) });
    },
  );
}

// --- path normalisation: the SAME rule as apps/frontend/src/demo/recording.ts ----------------
const TIME_PARAM_NAMES = new Set(['from', 'to', 'since', 'until', 'before', 'after', 'start', 'end', 'asOf', 'now', 'fromMs', 'toMs', 't', '_']);
const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_MS_VALUE = /^\d{12,13}$/;
function normalisePath(input) {
  const u = new URL(input, 'http://demo.invalid');
  const pairs = [];
  u.searchParams.forEach((value, name) => {
    if (!(TIME_PARAM_NAMES.has(name) || ISO_DATE_VALUE.test(value) || EPOCH_MS_VALUE.test(value))) pairs.push([name, value]);
  });
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`).join('&');
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}
/** The recorded path keeps the full (sorted) query; the demo drops time params when matching. */
function sortedPath(input) {
  const u = new URL(input, 'http://demo.invalid');
  const pairs = [];
  u.searchParams.forEach((v, k) => pairs.push([k, v]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`).join('&');
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}
const entryKey = (method, path) => `${method} ${normalisePath(path)}`;
const pathnameOf = (path) => new URL(path, 'http://demo.invalid').pathname;

// Batched read POSTs: one recorded answer per path, its rows merged across every call
// (apps/frontend/src/demo/README.md § Batched read POSTs). The key de-duplicates rows.
const BATCHED = {
  '/api/claude-review/states': { field: 'states', key: (r) => r.prId },
  '/api/claude-review/thread-judgements': { field: 'prs', key: (r) => r.prId },
  '/api/ci-reviews/states': { field: 'states', key: (r) => r.prId },
  '/api/ticket-reviews/states': { field: 'states', key: (r) => r.ident },
  '/api/ticket-links': { field: 'prs', key: (r) => r.prId },
  '/api/reactions/lookup': { field: 'results', key: (r) => `${r.kind}:${r.id}` },
  '/api/prs/resolve': { field: 'refs', key: (r) => `${r.repo}#${r.number}` },
};
// Writes the SPA makes on its own while a view is open. They change nothing the recording reads (no
// GitHub, no tracker, no model is reachable, so a refresh finds nothing new). Any OTHER write during
// a step not marked `mutates` is reported at the end.
const QUIET_WRITES = [
  /^\/api\/prs\/\d+\/refresh$/,
  /^\/api\/prs\/\d+\/(sonar|tracker-ticket)\/refresh$/,
  /^\/api\/attention\/liveness$/,
  /^\/api\/sprint-stories\/refresh$/,
];

// --- one step's bucket -------------------------------------------------------------------------
function newCapture(step) {
  return {
    name: step.name,
    idx: step.idx,
    gets: new Map(), // key → entry (the first answer this step saw)
    batched: new Map(), // path → { extra, rows: Map(rowKey → row) }
    streams: new Set(),
    seen: [],
    writes: [],
    pending: new Set(),
  };
}

function addGet(capture, url, status, body) {
  const key = entryKey('GET', url);
  if (!capture.gets.has(key)) capture.gets.set(key, { method: 'GET', path: sortedPath(url), status, body });
}

function onResponse(capture, resp) {
  const req = resp.request();
  const u = new URL(req.url());
  if (!u.pathname.startsWith('/api/')) return;
  const method = req.method();
  const ct = resp.headers()['content-type'] ?? '';
  const pathQ = u.pathname + u.search;
  if (ct.includes('text/event-stream') || u.pathname.endsWith('/stream')) {
    if (method === 'GET') capture.streams.add(pathQ);
    capture.seen.push({ method, path: pathQ, status: resp.status(), stream: true });
    return;
  }
  const status = resp.status();
  if (method !== 'GET' && !BATCHED[u.pathname] && ![...QUIET_WRITES, ...STUBBED_WRITES.map((w) => w.re)].some((re) => re.test(u.pathname))) {
    capture.writes.push(`${method} ${u.pathname}`);
  }
  const p = resp
    .text()
    .then((text) => {
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        return;
      }
      capture.seen.push({ method, path: pathQ, status, empty: isEmptyish(body) });
      if (method === 'GET') {
        // A transient 5xx or a 404 the SPA tolerates is still the truth of what the screen got;
        // keep 4xx (the demo replays them as is) and drop 5xx.
        if (status >= 500 || status === 429) return;
        addGet(capture, pathQ, status, body);
        return;
      }
      const spec = BATCHED[u.pathname];
      if (method === 'POST' && spec && status < 400 && body && Array.isArray(body[spec.field])) {
        let rows = capture.batched.get(u.pathname);
        if (!rows) capture.batched.set(u.pathname, (rows = { extra: body, rows: new Map() }));
        for (const r of body[spec.field]) {
          const k = String(spec.key(r));
          if (!rows.rows.has(k)) rows.rows.set(k, r);
        }
      }
    })
    .catch(() => {
      /* the page navigated away before the body arrived — the step re-requests it */
    })
    .finally(() => capture.pending.delete(p));
  capture.pending.add(p);
}

function isEmptyish(body) {
  if (body == null) return true;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body !== 'object') return false;
  const vals = Object.values(body);
  return vals.every((v) => v == null || (Array.isArray(v) && v.length === 0) || v === false || v === 0 || v === '');
}

/** Read one finished run's stream from the backend: frames until it closes (or 4s pass). */
async function captureStream(pathQ) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  const frames = [];
  try {
    const res = await fetch(`${LANES[0].backend}${pathQ}`, { signal: ctl.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let last = Date.now();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        let parsed;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          continue;
        }
        const now = Date.now();
        frames.push({ event, data: parsed, delayMs: frames.length === 0 ? 0 : Math.min(400, now - last) });
        last = now;
      }
    }
  } catch {
    /* aborted: a stream that never closes keeps what it sent */
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

// --- the browser pass ------------------------------------------------------------------------
const isStreamRequest = (r) => r.url().endsWith('/stream') || (r.headers().accept ?? '').includes('text/event-stream');
/** Requests settle() waits for: the SPA's own origin (its /api and its lazy chunks), never a stream. */
const counts = (r) => /^http:\/\/localhost:\d+\//.test(r.url()) && !isStreamRequest(r);

/**
 * Wait until the page has had NO request in flight (an /api answer, a lazy chunk, an image — server-
 * sent event streams excepted, they never finish) for `quietMs` × the settle scale, AND its main
 * thread has gone idle without asking for anything more. The idle check is what makes the shorter
 * quiet window safe on a loaded machine: rendering a big answer can outlast the window.
 */
async function settle(page, { quietMs = 900, maxMs = 15_000 } = {}) {
  const quiet = Math.max(150, Math.round(quietMs * SETTLE_SCALE));
  const start = Date.now();
  let lastActivity = Date.now();
  const inflight = new Set();
  const onReq = (r) => {
    if (!counts(r)) return;
    inflight.add(r);
    lastActivity = Date.now();
  };
  const onDone = (r) => {
    if (inflight.delete(r)) lastActivity = Date.now();
  };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  try {
    while (Date.now() - start < maxMs) {
      await page.waitForTimeout(100);
      if (inflight.size === 0 && Date.now() - lastActivity >= quiet) {
        // The network is quiet — but a busy page may still be rendering what the last answer brought
        // (a lazy chunk evaluating, a large PR laying out) before it asks for the next thing. Wait for
        // the main thread to go idle, then look again.
        const mark = lastActivity;
        await page
          .evaluate(
            () =>
              new Promise((resolve) => {
                const after = () => requestAnimationFrame(() => setTimeout(resolve, 0));
                if (typeof requestIdleCallback === 'function') requestIdleCallback(after, { timeout: 3000 });
                else setTimeout(after, 50);
              }),
          )
          .catch(() => {});
        await page.waitForTimeout(60);
        if (inflight.size === 0 && lastActivity === mark) break;
      }
    }
  } finally {
    if (process.env.RECORD_DEBUG_SETTLE && Date.now() - start > 2000) {
      console.log(`    settle ${Date.now() - start}ms; in flight: ${[...inflight].map((r) => r.url().replace(/^http:\/\/localhost:\d+/, '')).join(' ') || '-'}`);
    }
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
  }
}

function stepHelpers(worker) {
  const { page, lane } = worker;
  const h = {
    page,
    base: lane.base,
    async go(query) {
      await page.goto(`${lane.base}${query}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
    },
    settle: (o) => settle(page, o),
    /** Click the first visible match; never fails the step when it is absent. */
    async click(locator, { settleAfter = true, timeout = 2500 } = {}) {
      const l = typeof locator === 'string' ? page.locator(locator) : locator;
      try {
        await l.first().waitFor({ state: 'visible', timeout });
        await l.first().click({ timeout });
        if (settleAfter) await settle(page);
        return true;
      } catch {
        return false;
      }
    },
    async clickRole(role, name, opts) {
      return h.click(page.getByRole(role, { name }), opts);
    },
    async clickText(text, opts) {
      return h.click(page.getByText(text, { exact: false }), opts);
    },
    /** Click every visible match (up to `max`), settling after each. */
    async clickAll(locator, { max = 12, after } = {}) {
      const l = typeof locator === 'string' ? page.locator(locator) : locator;
      const n = Math.min(max, await l.count());
      for (let i = 0; i < n; i++) {
        try {
          const el = l.nth(i);
          if (!(await el.isVisible())) continue;
          await el.click({ timeout: 2000 });
          await settle(page, { quietMs: 600 });
          if (after) await after(i);
        } catch {
          /* gone after a re-render */
        }
      }
    },
    async hover(locator) {
      const l = typeof locator === 'string' ? page.locator(locator) : locator;
      try {
        await l.first().hover({ timeout: 2000 });
        await settle(page, { quietMs: 500 });
      } catch {
        /* absent */
      }
    },
    async escape() {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    },
    /** Scroll the page (and every scrollable panel) to the bottom, so lazy sections mount. */
    async scroll() {
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight;
          }
        });
        await settle(page, { quietMs: 500 });
      }
    },
    /**
     * Scroll every scrollable panel down ONE SCREEN AT A TIME, settling after each, up to `screens`
     * screens — so a virtualised list (the Feed) renders, and fetches for, every row on the way down,
     * the same rows on every run. (`scroll()` jumps to the end: rows it skips past depend on timing.)
     */
    async scrollThrough({ screens = 40 } = {}) {
      for (let i = 0; i < screens; i++) {
        const moved = await page.evaluate(() => {
          let any = false;
          for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
            if (!el) continue;
            const s = el === document.scrollingElement ? null : getComputedStyle(el);
            if (s && !(s.overflowY === 'auto' || s.overflowY === 'scroll')) continue;
            if (el.scrollHeight <= el.clientHeight + 20) continue;
            const before = el.scrollTop;
            el.scrollTop = before + Math.max(200, Math.floor(el.clientHeight * 0.9));
            if (el.scrollTop > before) any = true;
          }
          return any;
        });
        await settle(page, { quietMs: 500 });
        if (!moved) break;
      }
    },
    /** Pick every option of every <select> in turn (window pickers and the like), then the first again. */
    async selectAll(selector) {
      const selects = page.locator(selector);
      const n = Math.min(6, await selects.count());
      for (let i = 0; i < n; i++) {
        const sel = selects.nth(i);
        try {
          if (!(await sel.isVisible())) continue;
          const values = await sel.evaluate((el) => [...el.options].map((o) => o.value));
          for (const v of [...values.slice(1), values[0]]) {
            await sel.selectOption(v, { timeout: 2000 });
            await settle(page, { quietMs: 600 });
          }
        } catch {
          /* re-rendered away */
        }
      }
    },
    /**
     * Expand what a reader would expand: tabs and closed disclosures, never a button whose label is
     * a verb that changes something. Within `scope` (a CSS selector), up to `max` clicks.
     */
    async explore({ max = 10, scope = 'body' } = {}) {
      const UNSAFE =
        /merge|approve|request|post|push|run\b|re-?run|generate|redraw|refresh|close|reopen|delete|remove|resolve|reply|send|arm\b|cancel|dismiss|withdraw|update|commit|save|apply|sync|add\b|connect|test|set up|install|draw|check|start|build|summari|ask|mute|hide|sign|copy|open on github|download|discard|approve and|plan first|fix\b|clear|reset|forget|leave|switch|edit|rename|new\b|upload|follow|mark|undo|take|ignore|accept|choose|pick|move/i;
      const seenLabels = new Set();
      let clicks = 0;
      for (let pass = 0; pass < 3 && clicks < max; pass++) {
        const cands = page.locator(`${scope} [role="tab"][aria-selected="false"], ${scope} button[aria-expanded="false"], ${scope} summary`);
        const n = await cands.count();
        let progressed = false;
        for (let i = 0; i < n && clicks < max; i++) {
          const el = cands.nth(i);
          try {
            if (!(await el.isVisible())) continue;
            const label = ((await el.getAttribute('aria-label')) ?? (await el.innerText())).trim().slice(0, 80);
            if (label === '' || seenLabels.has(label) || UNSAFE.test(label)) continue;
            seenLabels.add(label);
            await el.click({ timeout: 1500 });
            clicks++;
            progressed = true;
            await settle(page, { quietMs: 500, maxMs: 8000 });
          } catch {
            /* gone after a re-render */
          }
        }
        if (!progressed) break;
      }
      return clicks;
    },
    async openSettings() {
      const ok = await h.click(page.locator('button[title^="Signed in as"]'), { settleAfter: false });
      if (ok) await h.click(page.getByRole('menuitem', { name: 'Settings' }));
    },
    async scrollModal() {
      // Settings is a tab list (one area shown at a time): visit every tab, scrolling each to its end.
      const tabs = page.locator('[aria-label="Settings"] [role="tab"]');
      const n = await tabs.count();
      for (let t = 0; t < Math.max(n, 1); t++) {
        if (n > 0) await h.click(tabs.nth(t));
        for (let i = 0; i < 4; i++) {
          await page.evaluate(() => {
            const d = document.querySelector('[aria-label="Settings"]');
            const scroller = d ? [d, ...d.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 20) : null;
            if (scroller) scroller.scrollTop += 700;
          });
          await settle(page, { quietMs: 400 });
        }
      }
    },
    /** A GET the SPA would make from a surface the recorder cannot reach by clicking. */
    async fetchGet(path) {
      const capture = worker.capture;
      try {
        const res = await fetch(`${lane.backend}${path}`);
        const text = await res.text();
        const body = text ? JSON.parse(text) : undefined;
        capture.seen.push({ method: 'GET', path, status: res.status, empty: isEmptyish(body), direct: true });
        if (res.status < 500) addGet(capture, path, res.status, body);
        return body;
      } catch {
        return undefined;
      }
    },
  };
  return h;
}

// --- steps: expansion, selection, scheduling ----------------------------------------------------
/** Every step in declared order, `expand` steps replaced by their children (the DB must exist). */
async function expandSteps() {
  const out = [];
  for (const s of STEPS) {
    if (s.expand) for (const c of await s.expand()) out.push({ ...c, mutates: c.mutates ?? s.mutates });
    else out.push({ ...s });
  }
  const names = new Set();
  for (const [idx, s] of out.entries()) {
    if (names.has(s.name)) throw new Error(`two recorder steps are named ${s.name}`);
    names.add(s.name);
    s.idx = idx;
  }
  return out;
}

/** `pr:113` matches `pr:113` and every `pr:113:…`; a pattern with `*` is a glob over the whole name. */
function stepMatcher(patterns) {
  const tests = patterns.map((p) => (/[*?{]/.test(p) ? (n) => globToRegExp(p).test(n) : (n) => n === p || n.startsWith(`${p}:`)));
  return (name) => tests.some((t) => t(name));
}

/**
 * Run `steps` on the workers. A step marked `mutates` is a barrier: everything declared before it
 * finishes first, it runs alone, then the rest continue. Within a stretch of read-only steps the
 * longest (by the last record's timings) start first.
 */
async function runAll(workers, steps, durations, onDone) {
  const stretches = [];
  let cur = [];
  for (const s of steps) {
    if (s.mutates) {
      if (cur.length) stretches.push(cur);
      stretches.push([s]);
      cur = [];
    } else cur.push(s);
  }
  if (cur.length) stretches.push(cur);
  for (const stretch of stretches) {
    const queue = [...stretch].sort((a, b) => (durations[b.name] ?? 4000) - (durations[a.name] ?? 4000) || a.idx - b.idx);
    const n = stretch.length === 1 ? 1 : workers.length;
    await Promise.all(
      workers.slice(0, n).map(async (w) => {
        for (let s = queue.shift(); s; s = queue.shift()) await runStep(w, s, onDone);
      }),
    );
  }
}

async function resetBrowser(worker) {
  // A same-origin page that is not the SPA, so its storage can be cleared before the step boots it.
  await worker.page.goto(`${worker.lane.origin}/__limn_record_blank__`, { waitUntil: 'commit' }).catch(() => {});
  await worker.page
    .evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('pierre:onboarded', '1');
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(
        dbs.map(
          (d) =>
            new Promise((res) => {
              const r = indexedDB.deleteDatabase(d.name);
              r.onsuccess = r.onerror = r.onblocked = () => res();
            }),
        ),
      );
    })
    .catch(() => {});
}

async function runStep(worker, step, onDone) {
  const capture = newCapture(step);
  const t0 = Date.now();
  let error = null;
  try {
    await resetBrowser(worker);
    worker.capture = capture;
    await step.run(worker.h);
    // Answers whose bodies are still arriving belong to this step.
    await Promise.race([Promise.allSettled([...capture.pending]), new Promise((r) => setTimeout(r, 5000))]);
  } catch (err) {
    error = String(err?.message ?? err).split('\n')[0];
  }
  capture.ms = Date.now() - t0;
  worker.capture = worker.idle;
  onDone(capture, error);
}

// --- merging buckets into the recording ----------------------------------------------------------
/**
 * The recording + its steps index from per-step buckets, optionally on top of an OLD recording
 * (incremental). An answer belongs to its lowest-index captor; its body is the freshest one (a
 * re-recorded step's, else the old file's).
 */
function buildRecording({ steps, captures, streamFrames, old, rerecorded, capturedAt }) {
  const idxOf = new Map(steps.map((s) => [s.name, s.idx]));
  const END = steps.length;
  const owner = (captors) => (captors.length ? Math.min(...captors.map((n) => idxOf.get(n) ?? END)) : END);
  const byIdx = (a, b) => (idxOf.get(a) ?? END) - (idxOf.get(b) ?? END) || (a < b ? -1 : 1);
  /** key → { entry, captors:Set, fresh } */
  const byKey = new Map();
  /** path → { extra, extraOwner, rows: Map(rowKey → { row, captors:Set, fresh }) } */
  const batched = new Map();
  /** Captors still standing after the re-recorded (and removed) steps are taken out; null = drop. */
  const keep = (all) => {
    const left = (all ?? []).filter((n) => idxOf.has(n) && !rerecorded.has(n));
    return all && all.length && !left.length ? null : left;
  };

  if (old) {
    for (const e of old.recording.entries) {
      const path = pathnameOf(e.path);
      const spec = e.method === 'POST' ? BATCHED[path] : undefined;
      if (spec) {
        const rowIdx = old.index.rows?.[path] ?? {};
        const b = { extra: e.body, extraOwner: END, rows: new Map() };
        for (const r of e.body?.[spec.field] ?? []) {
          const k = String(spec.key(r));
          const captors = keep(rowIdx[k]);
          if (captors) b.rows.set(k, { row: r, captors: new Set(captors), fresh: false });
        }
        batched.set(path, b);
        continue;
      }
      const key = entryKey(e.method, e.path);
      const captors = keep(old.index.keys[key]);
      if (captors) byKey.set(key, { entry: e, captors: new Set(captors), fresh: false });
    }
  }

  const add = (map, key, value, name) => {
    const cur = map.get(key);
    if (!cur) map.set(key, { ...value, captors: new Set([name]), fresh: true });
    else {
      cur.captors.add(name);
      if (!cur.fresh) Object.assign(cur, value, { fresh: true });
    }
  };
  for (const c of [...captures].sort((a, b) => a.idx - b.idx)) {
    for (const [key, entry] of c.gets) add(byKey, key, { entry }, c.name);
    for (const [path, { extra, rows }] of c.batched) {
      let b = batched.get(path);
      if (!b) batched.set(path, (b = { extra, extraOwner: c.idx, rows: new Map() }));
      else if (c.idx < b.extraOwner) Object.assign(b, { extra, extraOwner: c.idx });
      for (const [k, row] of rows) add(b.rows, k, { row }, c.name);
    }
  }
  // Streams: a path the SPA opened as a stream and nobody answered as JSON.
  for (const [pathQ, { frames, captors }] of streamFrames) {
    const key = entryKey('GET', pathQ);
    const cur = byKey.get(key);
    if (cur && !cur.entry.stream && cur.fresh) {
      for (const n of captors) cur.captors.add(n);
      continue;
    }
    for (const n of captors) add(byKey, key, { entry: { method: 'GET', path: sortedPath(pathQ), status: 200, stream: frames } }, n);
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const keyed = [...byKey.entries()].map(([key, v]) => ({ key, ...v, owner: owner([...v.captors]) }));
  keyed.sort((a, b) => a.owner - b.owner || cmp(a.key, b.key));
  const entries = keyed.map((k) => k.entry);
  const index = { version: 1, capturedAt, steps: steps.map((s) => s.name), ms: {}, keys: {}, rows: {} };
  for (const k of keyed) index.keys[k.key] = [...k.captors].sort(byIdx);
  for (const path of [...batched.keys()].sort()) {
    const { extra, rows } = batched.get(path);
    const spec = BATCHED[path];
    const list = [...rows.entries()].map(([k, v]) => ({ k, ...v, owner: owner([...v.captors]) }));
    list.sort((a, b) => a.owner - b.owner || cmp(a.k, b.k));
    entries.push({ method: 'POST', path, status: 200, body: { ...extra, [spec.field]: list.map((r) => r.row) } });
    index.keys[`POST ${path}`] = [...new Set(list.flatMap((r) => [...r.captors]))].sort(byIdx);
    index.rows[path] = Object.fromEntries(list.map((r) => [r.k, [...r.captors].sort(byIdx)]));
  }
  return { entries, index };
}

/** One entry per line: a re-record's diff names the answers that changed. Still one JSON value. */
function serialise(recording) {
  const head = JSON.stringify({ version: recording.version, capturedAt: recording.capturedAt });
  return `${head.slice(0, -1)},"entries":[\n${recording.entries.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
}
function serialiseIndex(index) {
  const lines = (obj) => Object.entries(obj).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return `{\n"version": 1,\n"capturedAt": ${JSON.stringify(index.capturedAt)},\n"steps": ${JSON.stringify(index.steps)},\n"ms": ${JSON.stringify(index.ms)},\n"keys": {\n${lines(index.keys)}\n},\n"rows": {\n${lines(index.rows)}\n}\n}\n`;
}

function loadOld() {
  if (!existsSync(OUT) || !existsSync(STEPS_OUT)) return null;
  const recording = JSON.parse(readFileSync(OUT, 'utf8'));
  const index = JSON.parse(readFileSync(STEPS_OUT, 'utf8'));
  if (index.version !== 1 || index.capturedAt !== recording.capturedAt) return null;
  return { recording, index };
}

async function main() {
  for (const p of LANES.flatMap((l) => [l.api, l.web])) {
    if (portBusy(p)) throw new Error(`port ${p} is in use — pass --api-port / --web-port (lanes use the next ${BACKENDS - 1} ports up)`);
  }

  // ── What to record: everything, or (incremental) some steps merged into the old file ──
  let old = ONLY || CHANGED ? loadOld() : null;
  const indexName = STEPS_OUT.split('/').pop();
  // --only with nothing to merge into: refused for the committed file (it would replace the whole
  // recording with a few steps); allowed with --out, as a scratch recording of just those steps.
  if (ONLY && !old && !str('out')) {
    throw new Error(`--only needs ${indexName} beside the recording, from the same record: run a full \`pnpm demo:record\` first`);
  }
  if (CHANGED && !old) console.log(`▸ no ${indexName} from the same record: recording everything`);
  let changedVerdict = null;
  if (CHANGED && old && !ONLY) {
    const files = changedFiles(ROOT, CHANGED_BASE);
    const names = [...new Set([...old.index.steps, ...STEPS.filter((s) => !s.expand).map((s) => s.name)])];
    changedVerdict = stepsForChanges(ROOT, files, STEP_MODULE, old.index, names);
    for (const w of changedVerdict.why) console.log(`  · ${w}`);
    if (changedVerdict.full) {
      console.log(`▸ full record: ${changedVerdict.full}`);
      old = null;
    } else if (!changedVerdict.steps.size) {
      console.log(`▸ ${files.length} changed file(s); none changes a recorded answer: nothing to record`);
      process.exit(0);
    }
  }
  const incremental = Boolean(old);
  const offsetMs = incremental ? Date.now() - Date.parse(old.recording.capturedAt) : 0;
  const childEnv = { ...baseEnv };
  if (offsetMs) {
    childEnv.LIMN_CLOCK_OFFSET_MS = String(offsetMs);
    childEnv.NODE_OPTIONS = `${baseEnv.NODE_OPTIONS ?? ''} --import ${pathToFileURL(CLOCK_MODULE).href}`.trim();
    process.env.LIMN_CLOCK_OFFSET_MS = String(offsetMs);
    console.log(`▸ incremental: clocks moved back ${(offsetMs / 3_600_000).toFixed(1)}h, to ${old.recording.capturedAt}`);
  }
  const t0 = Date.now();
  const viteEnv = (lane) => ({ ...baseEnv, BACKEND_PORT: String(lane.api), FRONTEND_PORT: String(lane.web) });
  const vite = join(FRONTEND, 'node_modules', '.bin', 'vite');
  // A production build (a few large chunks, not hundreds of dev modules) loads several times faster per
  // page, and it is what the demo itself runs. Built while the seeder runs; reused while the SPA's
  // sources are unchanged.
  const built = DEV ? Promise.resolve(null) : buildSpa(viteEnv(LANES[0]), vite);
  built.catch(() => {});
  if (RESEED) seed(childEnv);
  else if (incremental) console.log('⚠ --no-seed on an incremental record: the DB must have been seeded as of the same capturedAt');

  const steps = await expandSteps();
  let selected = steps;
  if (incremental) {
    const pick = ONLY ? stepMatcher(ONLY) : (n) => changedVerdict.steps.has(n);
    selected = steps.filter((s) => pick(s.name));
    if (!selected.length) throw new Error(`no recorder step matches ${ONLY ? ONLY.join(',') : 'the changed files'}`);
    console.log(`▸ re-recording ${selected.length} of ${steps.length} steps`);
  } else if (ONLY) {
    selected = steps.filter((s) => stepMatcher(ONLY)(s.name));
    console.log(`▸ a scratch recording of ${selected.length} steps → ${OUT}`);
  }

  const bootBackend = (lane) =>
    run(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
      cwd: BACKEND,
      tag: `backend:${lane.api}`,
      env: { ...childEnv, PORT: String(lane.api), FRONTEND_PORT: String(lane.web) },
    });
  // The first backend migrates the database; the others start once it has.
  console.log(`▸ backend${BACKENDS > 1 ? 's' : ''} :${LANES.map((l) => l.api).join(', :')}`);
  bootBackend(LANES[0]);
  const webDir = await built;
  await waitFor(`${LANES[0].backend}/api/health`, 'backend');
  for (const lane of LANES.slice(1)) bootBackend(lane);
  for (const lane of LANES) {
    if (DEV) run(vite, ['--port', String(lane.web), '--strictPort'], { cwd: FRONTEND, tag: `vite:${lane.web}`, env: viteEnv(lane) });
    else run(vite, ['preview', '--port', String(lane.web), '--strictPort', '--outDir', webDir], { cwd: FRONTEND, tag: `vite:${lane.web}`, env: viteEnv(lane) });
  }
  console.log(`▸ ${DEV ? 'vite dev' : 'vite preview'} :${LANES.map((l) => l.web).join(', :')}`);
  await Promise.all(LANES.flatMap((l) => [waitFor(`${l.backend}/api/health`, 'backend'), waitFor(l.base, 'frontend')]));

  const capturedAt = incremental ? old.recording.capturedAt : new Date().toISOString();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const errors = [];
  const n = Math.min(CONCURRENCY, selected.length);
  const workers = [];
  for (let i = 0; i < n; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce', colorScheme: 'dark' });
    const lane = LANES[i % LANES.length];
    if (offsetMs) await context.addInitScript(browserClockScript(offsetMs));
    await context.addInitScript(() => localStorage.setItem('pierre:onboarded', '1'));
    await installGithubStandIn(context, { backend: lane.backend });
    await stubWrites(context);
    const page = await context.newPage();
    const idle = newCapture({ name: '(between steps)', idx: -1 });
    const worker = { context, page, lane, capture: idle, idle };
    // Each response belongs to the step that was running when its REQUEST went out.
    const owners = new WeakMap();
    page.on('request', (r) => owners.set(r, worker.capture));
    page.on('response', (resp) => {
      const c = owners.get(resp.request()) ?? worker.capture;
      if (c !== idle) onResponse(c, resp);
    });
    page.on('pageerror', (e) => errors.push(`${worker.capture.name}: ${e.message}`));
    worker.h = stepHelpers(worker);
    workers.push(worker);
  }
  // Warm every page (and, on --dev, Vite's module graph) — nothing is recorded yet.
  await Promise.all(
    workers.map(async (w) => {
      await w.page.goto(w.lane.base, { waitUntil: 'load', timeout: 120_000 });
      await settle(w.page, { quietMs: DEV ? 2500 : 1000, maxMs: 60_000 });
    }),
  );
  console.log(`▸ ${selected.length} steps on ${n} page${n === 1 ? '' : 's'}`);

  const captures = [];
  const writes = [];
  let done = 0;
  const tRec = Date.now();
  await runAll(workers, selected, old?.index.ms ?? (existsSync(STEPS_OUT) ? JSON.parse(readFileSync(STEPS_OUT, 'utf8')).ms ?? {} : {}), (capture, error) => {
    done++;
    captures.push(capture);
    if (capture.writes.length && !steps[capture.idx].mutates) writes.push(`${capture.name}: ${[...new Set(capture.writes)].join(', ')}`);
    console.log(`  ${error ? '✗' : '✓'} [${done}/${selected.length}] ${capture.name} (${capture.ms}ms)${error ? `: ${error}` : ''}`);
  });
  const recordMs = Date.now() - tRec;
  await browser.close();

  // Streams: read each finished run's stream straight from the backend, once per path.
  const streamCaptors = new Map();
  for (const c of captures) for (const s of c.streams) (streamCaptors.get(s) ?? streamCaptors.set(s, []).get(s)).push(c.name);
  const streamFrames = new Map();
  for (const s of [...streamCaptors.keys()].sort()) {
    const frames = await captureStream(s);
    if (frames && frames.length) streamFrames.set(s, { frames, captors: streamCaptors.get(s) });
  }

  const rerecorded = new Set(selected.map((s) => s.name));
  const { entries, index } = buildRecording({ steps, captures, streamFrames, old: incremental ? old : null, rerecorded, capturedAt });
  index.ms = Object.fromEntries(
    steps.map((s) => [s.name, captures.find((c) => c.name === s.name)?.ms ?? old?.index.ms?.[s.name]]).filter(([, ms]) => ms != null),
  );

  if (PROBE) {
    const seen = [...captures].sort((a, b) => a.idx - b.idx).flatMap((c) => c.seen.map((x) => ({ step: c.name, ...x })));
    writeFileSync('/tmp/limn-record-probe.json', JSON.stringify({ errors, seen }, null, 1));
    console.log(`probe → /tmp/limn-record-probe.json (${seen.length} responses, ${errors.length} page errors)`);
  }
  // ⚠ Refuse to write a recording that answers as anyone but the fictional viewer — the live
  // backend AND every recorded /api/me must agree, or your real GitHub identity would ship in it.
  const liveMes = await Promise.all(
    LANES.map((l) =>
      fetch(`${l.backend}/api/me`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ),
  );
  const logins = [...liveMes, ...entries.filter((e) => e.path === '/api/me').map((e) => e.body)].map(
    (b) => b?.user?.login ?? null,
  );
  if (logins.some((l) => l !== VIEWER_LOGIN)) {
    teardown();
    throw new Error(
      `refusing to write the recording: /api/me answered as ${JSON.stringify([...new Set(logins)])}, not '${VIEWER_LOGIN}'`,
    );
  }
  const recording = { version: 1, capturedAt, entries };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, serialise(recording));
  writeFileSync(STEPS_OUT, serialiseIndex(index));
  const kb = Math.round(statSync(OUT).size / 1024);
  console.log(`\n✅ ${entries.length} entries → ${OUT} (${kb} KB)${incremental ? `; ${selected.length} of ${steps.length} steps re-recorded` : ''}`);
  console.log(`   walk ${Math.round(recordMs / 1000)}s on ${n} page(s); total ${Math.round((Date.now() - t0) / 1000)}s`);
  if (writes.length) console.log(`⚠ steps not marked \`mutates\` sent writes:\n  ${writes.join('\n  ')}`);
  if (errors.length) console.log(`⚠ ${errors.length} page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);

  if (KEEP) {
    console.log(`servers still up: ${LANES.map((l) => `${l.base} (backend :${l.api})`).join(', ')}. Ctrl-C stops.`);
    await new Promise(() => {});
  }
  teardown();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  teardown();
  process.exit(1);
});
