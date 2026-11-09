// `pnpm dev:scratch` — a throwaway Limn for development and testing, beside the reader's own
// (docs/TESTING.md § Scratch stack). Run it from a GIT WORKTREE: the reader's Limn is `pnpm dev` in
// the main checkout (tsx watch), so an edit there restarts it.
//
//   pnpm dev:scratch                       demo data (acme/*), GitHub off, slot 0
//   pnpm dev:scratch --seed copy           a scrubbed snapshot of the real dev database, GitHub read-only
//   pnpm dev:scratch --seed empty          migrations only
//   pnpm dev:scratch --slot 2              a second stack (ports 4220 / 5393, folder .scratch/2)
//   --github off|read|write                off = no token; read = writes blocked in code; write = real writes
//   --sync                                 run the scheduler (sync, auto review, Slack…): spends the shared GitHub budget
//   --codex                                allow Codex (sign in separately into the scratch Codex home)
//   --ml                                   ML scoring on (uses ~/.limn's downloaded model, if any)
//   --reseed                               throw the scratch database away and seed again
//   --keep-tracker                         copy seed: keep the tracker / Sonar / wiki tokens
//   --no-frontend                          the backend only
//
// Everything lives in <repo>/.scratch/<slot>/ (gitignored): limn.sqlite, clones/, docs/, the Codex
// home. Every path the backend reads is set here explicitly, and LIMN_SCRATCH=1 makes the backend
// skip `.env` and refuse the real database, data folder and ports (apps/backend/src/scratch.ts).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listenerPid,
  mainCheckout,
  processCwd,
  readSeedMarker,
  removeDb,
  seedCopy,
  seedDemo,
} from './lib/scratch-seed.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, 'apps', 'backend');
const FRONTEND = join(ROOT, 'apps', 'frontend');
const REAL_DATA_DIR = join(homedir(), '.limn');

function refuse(msg) {
  console.error(`\n✗ dev:scratch refused: ${msg}\n`);
  process.exit(1);
}

// --- arguments ----------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) refuse(`--${name} needs a value`);
  return v;
}
const flag = (name) => argv.includes(`--${name}`);
const SEED = opt('seed', 'demo');
if (!['demo', 'copy', 'empty'].includes(SEED)) refuse(`--seed must be demo, copy or empty (got ${SEED})`);
const SLOT = Number(opt('slot', '0'));
if (!Number.isInteger(SLOT) || SLOT < 0 || SLOT > 9) refuse('--slot must be 0–9');
const GITHUB = opt('github', SEED === 'copy' ? 'read' : 'off');
if (!['off', 'read', 'write'].includes(GITHUB)) refuse(`--github must be off, read or write (got ${GITHUB})`);
const SYNC = flag('sync');
const CODEX = flag('codex');
const ML = flag('ml');
const RESEED = flag('reseed');
const KEEP_TRACKER = flag('keep-tracker');
const FRONTEND_ON = !flag('no-frontend');

const BACKEND_PORT = 4200 + 10 * SLOT;
const FRONTEND_PORT = 5373 + 10 * SLOT;
const DIR = join(ROOT, '.scratch', String(SLOT));
const DB = join(DIR, 'limn.sqlite');

const isWithin = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
};

// --- never the reader's Limn ------------------------------------------------------
// The main checkout is the reader's while it serves :4000 (`pnpm dev`, tsx watch).
const MAIN = mainCheckout(ROOT);
if (resolve(MAIN) === resolve(ROOT)) {
  const pid = listenerPid(4000);
  const cwd = pid ? processCwd(pid) : null;
  if (pid && cwd && isWithin(resolve(cwd), resolve(ROOT))) {
    refuse(
      `this is the main checkout, and the Limn on :4000 (process ${pid}) runs from it.\n` +
        '  Make a worktree and run it there:\n' +
        `    git worktree add ../pierre-review-wt/<name> -b <branch> && cd ../pierre-review-wt/<name> && pnpm install && pnpm dev:scratch`,
    );
  }
}
if (isWithin(resolve(DIR), REAL_DATA_DIR)) refuse(`the scratch folder ${DIR} is inside ${REAL_DATA_DIR}`);

// Our ports: free them only when THIS checkout holds them (a stale scratch stack), else refuse.
for (const port of FRONTEND_ON ? [BACKEND_PORT, FRONTEND_PORT] : [BACKEND_PORT]) {
  const pid = listenerPid(port);
  if (!pid) continue;
  const cwd = processCwd(pid);
  if (cwd && isWithin(resolve(cwd), resolve(ROOT))) {
    console.log(`⚠ stopping process ${pid}, a stale scratch server of this checkout on :${port}`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 50 && listenerPid(port); i++) spawnSync('sleep', ['0.1']);
    if (listenerPid(port)) refuse(`port ${port} is still held by process ${pid}`);
  } else {
    refuse(`port ${port} is in use by process ${pid} (${cwd ?? 'unknown folder'}). Pick another --slot.`);
  }
}

// --- the folder -------------------------------------------------------------------
mkdirSync(DIR, { recursive: true, mode: 0o700 });
writeFileSync(join(ROOT, '.scratch', '.gitignore'), '*\n');

/** Link one of ~/.limn's downloaded runtimes into the scratch folder (read in practice; never re-downloaded here). */
function linkRuntime(name) {
  const target = join(REAL_DATA_DIR, name);
  const link = join(DIR, name);
  if (existsSync(link) || !existsSync(target)) return;
  symlinkSync(target, link);
}
linkRuntime('ai-runtime');
if (ML) {
  linkRuntime('ml-runtime');
  linkRuntime('ml-models');
}

// --- the environment ----------------------------------------------------------------
const env = { ...process.env };
// Everything config.ts would otherwise take from the shell or .env, set or cleared on purpose.
for (const k of [
  'DATABASE_URL',
  'CLONE_DIR',
  'LIMN_DOCS_DIR',
  'ENCRYPTION_KEY',
  'SYNC_CRON',
  'SEVERITY_API_URL',
  'SEVERITY_API_DEFAULT_URL',
  'APP_BASE_URL',
  'APP_WEB_URL',
  'LIMN_CODEX_PATH',
  'LIMN_AI_PROVIDER',
]) delete env[k];
Object.assign(env, {
  LIMN_SCRATCH: '1',
  LIMN_SCRATCH_GITHUB: GITHUB,
  LIMN_DATA_DIR: DIR,
  DATABASE_URL: DB,
  CLONE_DIR: join(DIR, 'clones'),
  LIMN_DOCS_DIR: join(DIR, 'docs'),
  PORT: String(BACKEND_PORT),
  FRONTEND_PORT: String(FRONTEND_PORT),
  BACKEND_PORT: String(BACKEND_PORT),
  // No download from a scratch stack: it would write into the linked runtime.
  LIMN_AI_AUTO_INSTALL: 'false',
});
if (!SYNC) env.DISABLE_SCHEDULER = 'true';
else delete env.DISABLE_SCHEDULER;
if (!CODEX) env.LIMN_AI_PROVIDER = 'claude';
if (!ML) {
  env.LIMN_ML_DISABLED = 'true';
  env.ML_SEVERITY_DISABLED = 'true';
}
if (GITHUB === 'off') {
  // The demo's recipe: a `gh` that always fails, first on the PATH, and no token variable.
  const shimDir = mkdtempSync(join(tmpdir(), 'limn-scratch-bin-'));
  writeFileSync(join(shimDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  env.PATH = `${shimDir}:${env.PATH ?? '/usr/bin:/bin'}`;
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) delete env[k];
}

// --- seed ---------------------------------------------------------------------------
const marker = readSeedMarker(DIR);
if (marker && marker.seed !== SEED && !RESEED && existsSync(DB)) {
  refuse(`.scratch/${SLOT} holds a "${marker.seed}" database. Add --reseed to replace it with "${SEED}".`);
}
if (RESEED || !existsSync(DB)) {
  removeDb(DB);
  rmSync(join(DIR, 'seed.json'), { force: true });
  if (SEED === 'demo') seedDemo({ backendDir: BACKEND, env });
  else if (SEED === 'copy') await seedCopy({ root: ROOT, backendDir: BACKEND, dest: DB, keepTracker: KEEP_TRACKER, refuse });
  writeFileSync(join(DIR, 'seed.json'), `${JSON.stringify({ seed: SEED, at: new Date().toISOString() })}\n`);
}

// --- run ------------------------------------------------------------------------------
const children = new Set();
function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: 'inherit', detached: true, ...opts });
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (children.size === 0 || code) {
      teardown();
      process.exit(code ?? 0);
    }
  });
  return child;
}
function teardown() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM'); // the whole group (tsx watch, vite's esbuild)
    } catch {
      /* gone */
    }
  }
}
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  teardown();
  process.exit(143);
});

console.log(`\n▸ scratch backend :${BACKEND_PORT} (tsx watch)`);
run(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['watch', 'src/index.ts'], { cwd: BACKEND, env });
if (FRONTEND_ON) {
  run(join(FRONTEND, 'node_modules', '.bin', 'vite'), ['--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: FRONTEND,
    env,
  });
}

const githubLine = {
  off: 'off (no token; Limn shows no "you")',
  read: 'READ-ONLY with your gh token: every write is blocked in code. Reads spend the same hourly budget as your real Limn',
  write: 'READ AND WRITE with your gh token: buttons post, merge and push for real',
}[GITHUB];
console.log(`
✅ scratch Limn (slot ${SLOT}, seed ${SEED})

   App        http://localhost:${FRONTEND_ON ? FRONTEND_PORT : BACKEND_PORT}/app/
   API        http://localhost:${BACKEND_PORT}/api/health
   Folder     ${DIR}
   GitHub     ${githubLine}
   Scheduler  ${SYNC ? 'ON (sync, auto review, Slack…; writes still follow the GitHub line)' : 'off (add --sync)'}
   AI         Claude${CODEX ? ` + Codex (sign in: Settings → AI, into ${join(DIR, 'codex')})` : ' only (add --codex)'}
   ML         ${ML ? 'on' : 'off (add --ml)'}

   Ctrl-C to stop.
`);
await new Promise(() => {});
