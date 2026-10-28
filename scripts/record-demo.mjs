// THE DEMO RECORDER — `pnpm demo:record`.
//
// Seeds the fictional acme/* data into a scratch database, boots an ISOLATED backend + Vite on
// spare ports, drives the real SPA with Playwright through every view, and writes every /api
// answer it saw to apps/frontend/src/demo/data/recording.json — the file the static demo at
// /demo/ replays (format: apps/frontend/src/demo/README.md).
//
//   pnpm demo:record                 seed → boot → record → write → teardown
//   pnpm demo:record --no-seed       reuse the scratch DB from the last run
//   pnpm demo:record --keep          leave the servers running afterwards (Ctrl-C stops)
//   pnpm demo:record --probe         record, but write /tmp/limn-record-probe.json instead
//                                    (every request, plus the GETs that answered empty or 4xx)
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
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { STEPS } from './record-demo-steps.mjs';
import { installGithubStandIn } from './lib/demo-github.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, 'apps', 'backend');
const FRONTEND = join(ROOT, 'apps', 'frontend');
const OUT = join(FRONTEND, 'src', 'demo', 'data', 'recording.json');
const DB = process.env.RECORD_DB ?? '/tmp/limn-record.sqlite';
const SCRATCH = process.env.RECORD_SCRATCH ?? '/tmp/limn-record-home';
const DATA_DIR = join(SCRATCH, 'data');
const BACKEND_PORT = Number(process.env.RECORD_BACKEND_PORT ?? 4310);
const FRONTEND_PORT = Number(process.env.RECORD_FRONTEND_PORT ?? 5383);
const BASE = `http://localhost:${FRONTEND_PORT}/app/`;

const args = process.argv.slice(2);
const RESEED = !args.includes('--no-seed');
const KEEP = args.includes('--keep');
const PROBE = args.includes('--probe');
const HEADED = args.includes('--headed');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
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
function teardown() {
  for (const c of children) stop(c);
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
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs / 1000}s`);
}

function seed() {
  console.log(`▸ seeding → ${DB}`);
  rmSync(join(DATA_DIR, 'docs'), { recursive: true, force: true });
  const r = spawnSync(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['scripts/seed-demo.ts'], {
    cwd: BACKEND,
    stdio: 'inherit',
    env: baseEnv,
  });
  if (r.status !== 0) throw new Error('seed-demo.ts failed');
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

// --- the recording ---------------------------------------------------------------------------
const gets = new Map(); // normalised "METHOD path" → entry
const order = [];
const batched = new Map(); // path → Map(key → row)
const streams = new Set();
const seen = []; // probe log
let currentStep = '';

function addEntry(method, url, status, body) {
  const key = `${method} ${normalisePath(url)}`;
  if (gets.has(key)) return;
  const entry = { method, path: sortedPath(url), status, body };
  gets.set(key, entry);
  order.push(key);
}

function onResponse(resp) {
  const req = resp.request();
  const u = new URL(req.url());
  if (!u.pathname.startsWith('/api/')) return;
  const method = req.method();
  const ct = resp.headers()['content-type'] ?? '';
  const pathQ = u.pathname + u.search;
  if (ct.includes('text/event-stream') || u.pathname.endsWith('/stream')) {
    if (method === 'GET') streams.add(pathQ);
    seen.push({ step: currentStep, method, path: pathQ, status: resp.status(), stream: true });
    return;
  }
  const status = resp.status();
  resp
    .text()
    .then((text) => {
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        return;
      }
      seen.push({ step: currentStep, method, path: pathQ, status, empty: isEmptyish(body) });
      if (method === 'GET') {
        // A transient 5xx or a 404 the SPA tolerates is still the truth of what the screen got;
        // keep 4xx (the demo replays them as is) and drop 5xx.
        if (status >= 500 || status === 429) return;
        addEntry('GET', pathQ, status, body);
        return;
      }
      const spec = BATCHED[u.pathname];
      if (method === 'POST' && spec && status < 400 && body && Array.isArray(body[spec.field])) {
        let rows = batched.get(u.pathname);
        if (!rows) batched.set(u.pathname, (rows = { extra: body, rows: new Map() }));
        for (const r of body[spec.field]) {
          const k = spec.key(r);
          if (!rows.rows.has(k)) rows.rows.set(k, r);
        }
      }
    })
    .catch(() => {
      /* the page navigated away before the body arrived — the step re-requests it */
    });
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
    const res = await fetch(`http://localhost:${BACKEND_PORT}${pathQ}`, { signal: ctl.signal });
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
async function settle(page, { quietMs = 900, maxMs = 15_000 } = {}) {
  // Wait until no /api request has been in flight for `quietMs`.
  const start = Date.now();
  let lastActivity = Date.now();
  let inflight = 0;
  const onReq = (r) => {
    if (r.url().includes('/api/')) {
      inflight++;
      lastActivity = Date.now();
    }
  };
  const onDone = (r) => {
    if (r.url().includes('/api/')) {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    }
  };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  try {
    while (Date.now() - start < maxMs) {
      await page.waitForTimeout(150);
      if (inflight <= 0 && Date.now() - lastActivity >= quietMs) break;
    }
  } finally {
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
  }
}

function stepHelpers(page) {
  const h = {
    page,
    base: BASE,
    async go(query) {
      await page.goto(`${BASE}${query}`, { waitUntil: 'domcontentloaded' });
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
      try {
        const res = await fetch(`http://localhost:${BACKEND_PORT}${path}`);
        const text = await res.text();
        const body = text ? JSON.parse(text) : undefined;
        seen.push({ step: currentStep, method: 'GET', path, status: res.status, empty: isEmptyish(body), direct: true });
        if (res.status < 500) addEntry('GET', path, res.status, body);
        return body;
      } catch {
        return undefined;
      }
    },
  };
  return h;
}

async function main() {
  for (const p of [BACKEND_PORT, FRONTEND_PORT]) {
    if (portBusy(p)) throw new Error(`port ${p} is in use — set RECORD_BACKEND_PORT / RECORD_FRONTEND_PORT`);
  }
  if (RESEED) seed();

  console.log(`▸ backend :${BACKEND_PORT}`);
  run(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
    cwd: BACKEND,
    tag: 'backend',
    env: { ...baseEnv, PORT: String(BACKEND_PORT), FRONTEND_PORT: String(FRONTEND_PORT) },
  });
  await waitFor(`http://localhost:${BACKEND_PORT}/api/health`, 'backend');
  console.log(`▸ frontend :${FRONTEND_PORT}`);
  run(join(FRONTEND, 'node_modules', '.bin', 'vite'), ['--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: FRONTEND,
    tag: 'vite',
    env: { ...baseEnv, BACKEND_PORT: String(BACKEND_PORT), FRONTEND_PORT: String(FRONTEND_PORT) },
  });
  await waitFor(BASE, 'frontend');

  const capturedAt = new Date().toISOString();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce', colorScheme: 'dark' });
  await context.addInitScript(() => localStorage.setItem('pierre:onboarded', '1'));
  context.on('response', onResponse);
  await installGithubStandIn(context, { backend: `http://localhost:${BACKEND_PORT}` });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${currentStep}: ${e.message}`));
  const h = stepHelpers(page);

  // Warm Vite (first load compiles every module).
  await page.goto(BASE, { waitUntil: 'load', timeout: 120_000 });
  await settle(page, { quietMs: 2500, maxMs: 60_000 });

  for (const step of STEPS) {
    if (ONLY && !step.name.includes(ONLY)) continue;
    currentStep = step.name;
    const t0 = Date.now();
    try {
      await step.run(h);
    } catch (err) {
      console.log(`  ✗ ${step.name}: ${err.message.split('\n')[0]}`);
      continue;
    }
    console.log(`  ✓ ${step.name} (${Date.now() - t0}ms)`);
  }
  await settle(page, { quietMs: 1500 });
  await browser.close();

  // Streams: read each finished run's stream straight from the backend.
  for (const s of streams) {
    const frames = await captureStream(s);
    if (frames && frames.length) {
      const key = `GET ${normalisePath(s)}`;
      if (!gets.has(key)) {
        gets.set(key, { method: 'GET', path: sortedPath(s), status: 200, stream: frames });
        order.push(key);
      }
    }
  }

  const entries = order.map((k) => gets.get(k));
  for (const [path, { extra, rows }] of batched) {
    const spec = BATCHED[path];
    entries.push({ method: 'POST', path, status: 200, body: { ...extra, [spec.field]: [...rows.values()] } });
  }

  if (PROBE) {
    writeFileSync('/tmp/limn-record-probe.json', JSON.stringify({ errors, seen }, null, 1));
    console.log(`probe → /tmp/limn-record-probe.json (${seen.length} responses, ${errors.length} page errors)`);
  }
  // ⚠ Refuse to write a recording that answers as anyone but the fictional viewer — the live
  // backend AND every recorded /api/me must agree, or your real GitHub identity would ship in it.
  const liveMe = await fetch(`http://localhost:${BACKEND_PORT}/api/me`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const logins = [liveMe, ...entries.filter((e) => e.path === '/api/me').map((e) => e.body)].map(
    (b) => b?.user?.login ?? null,
  );
  if (logins.some((l) => l !== VIEWER_LOGIN)) {
    teardown();
    throw new Error(
      `refusing to write the recording: /api/me answered as ${JSON.stringify([...new Set(logins)])}, not '${VIEWER_LOGIN}'`,
    );
  }
  const recording = { version: 1, capturedAt, entries };
  const outPath = PROBE ? '/tmp/limn-record-probe-recording.json' : OUT;
  writeFileSync(outPath, JSON.stringify(recording));
  const kb = Math.round(statSync(outPath).size / 1024);
  console.log(`\n✅ ${entries.length} entries → ${outPath} (${kb} KB)`);
  if (errors.length) console.log(`⚠ ${errors.length} page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);

  if (KEEP) {
    console.log(`servers still up: ${BASE} (backend :${BACKEND_PORT}). Ctrl-C stops.`);
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
