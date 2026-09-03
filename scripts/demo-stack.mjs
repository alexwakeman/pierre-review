// One-command demo stack — seeds the fictional acme/* data and boots the
// ISOLATED demo servers used for the landing-page screenshots (never touching
// your real :4000/:5173 dev stack or your real DB).
//
//   pnpm demo               seed /tmp/pierre-demo.sqlite + boot the full Pro
//                           stack (backend :4100, frontend :5273), keep running
//                           for manual browsing / ad-hoc captures. Ctrl-C stops.
//   pnpm demo --free        same, but boot in pure-OSS mode (PRO_DISABLED=true)
//   pnpm demo --no-seed     reuse the existing demo DB (skip reseeding)
//   pnpm shots              the WHOLE screenshot pipeline: seed → boot Pro →
//                           capture-shots.mjs (pro set) → restart backend in
//                           OSS mode → capture-shots.mjs (free set) → teardown.
//                           Pass a shot filename to capture just that one, e.g.
//                           `pnpm shots claude-review.png` (pro set only).
//
// Why the backend runs with `gh` OFF the PATH: ensureLocalAccount() shells out
// to `gh api user` at boot and would overwrite the seeded "Morgan Diaz" local
// account with YOUR GitHub identity, emptying the My Turn triage in the shots.
// The children get a minimal PATH (a shim dir holding only `node` + the system
// dirs), so `gh` is unreachable no matter where it's installed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, 'apps', 'backend');
const FRONTEND = join(ROOT, 'apps', 'frontend');
const DB = '/tmp/pierre-demo.sqlite';
const BACKEND_PORT = 4100;
const FRONTEND_PORT = 5273;

const args = process.argv.slice(2);
const MODE = args.includes('--shots') ? 'shots' : 'serve';
const FREE = args.includes('--free');
const RESEED = !args.includes('--no-seed');
const ONLY_SHOT = args.find((a) => a.endsWith('.png'));

// --- a gh-free PATH the children can still find node on -----------------------
const shimDir = mkdtempSync(join(tmpdir(), 'pierre-demo-bin-'));
symlinkSync(process.execPath, join(shimDir, 'node'));
const SAFE_PATH = [shimDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

const baseEnv = {
  ...process.env,
  PATH: SAFE_PATH,
  DATABASE_URL: DB,
  DISABLE_SCHEDULER: 'true',
  ANTHROPIC_API_KEY: 'dummy',
  // The ML severity gate IS the URL (config.severityApiUrl): without it /api/me reports
  // mlSeverity:false and the SPA issues zero ML queries — so the seeded ml_comment_labels
  // (severity badges, the Bots ROI severity + Inflation columns) would never render in the
  // shots. Reads are DB-only and the scheduler (which owns the enrichment worker) is
  // disabled, so nothing ever actually calls this URL; it only needs to be non-empty.
  SEVERITY_API_URL: 'http://127.0.0.1:8799',
};
const proEnv = { PRO_DIGEST_ENABLED: 'true', PRO_ADVANCED_AI_ENABLED: 'true' };
const freeEnv = { PRO_DISABLED: 'true' };

// --- helpers -------------------------------------------------------------------
function freePort(port) {
  const r = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  const pids = r.stdout.trim().split('\n').filter(Boolean);
  for (const pid of pids) {
    console.log(`⚠ killing stale process ${pid} holding demo port :${port}`);
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

const children = new Set();
function run(cmd, cmdArgs, opts) {
  const child = spawn(cmd, cmdArgs, { stdio: 'inherit', detached: true, ...opts });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function stop(child) {
  if (!child || child.exitCode != null) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // whole process group (vite spawns esbuild)
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
process.on('SIGTERM', () => {
  teardown();
  process.exit(143);
});
process.on('exit', teardown);

async function waitFor(url, label, timeoutMs = 90_000) {
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
  console.log(`\n▸ seeding demo data → ${DB}`);
  const r = spawnSync(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['scripts/seed-demo.ts'], {
    cwd: BACKEND,
    stdio: 'inherit',
    env: baseEnv,
  });
  if (r.status !== 0) {
    console.error('seed-demo.ts failed');
    process.exit(r.status ?? 1);
  }
}

async function startBackend(tier) {
  console.log(`\n▸ starting demo backend :${BACKEND_PORT} (${tier} tier, gh off PATH)`);
  const child = run(join(BACKEND, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
    cwd: BACKEND,
    // FRONTEND_PORT so the backend's `appWebUrl` (the base for app deep links, e.g. in the Slack
    // digest) points at THIS stack's Vite on :5273 rather than the default :5173.
    env: {
      ...baseEnv,
      PORT: String(BACKEND_PORT),
      FRONTEND_PORT: String(FRONTEND_PORT),
      ...(tier === 'free' ? freeEnv : proEnv),
    },
  });
  await waitFor(`http://localhost:${BACKEND_PORT}/api/health`, 'backend');
  return child;
}

async function startFrontend() {
  console.log(`\n▸ starting demo frontend :${FRONTEND_PORT}`);
  const child = run(
    join(FRONTEND, 'node_modules', '.bin', 'vite'),
    ['--port', String(FRONTEND_PORT), '--strictPort'],
    { cwd: FRONTEND, env: { ...baseEnv, BACKEND_PORT: String(BACKEND_PORT) } },
  );
  await waitFor(`http://localhost:${FRONTEND_PORT}/app/`, 'frontend');
  return child;
}

function capture(set, only) {
  console.log(`\n▸ capturing ${set} shots${only ? ` (${only} only)` : ''}`);
  const r = spawnSync(process.execPath, ['scripts/capture-shots.mjs', ...(only ? [only] : [])], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SHOT_SET: set },
  });
  if (r.status !== 0) throw new Error(`capture (${set}) failed`);
}

// --- go ------------------------------------------------------------------------
freePort(BACKEND_PORT);
freePort(FRONTEND_PORT);
if (RESEED) seed();

if (MODE === 'serve') {
  await startBackend(FREE ? 'free' : 'pro');
  await startFrontend();
  console.log(`
✅ demo stack up (${FREE ? 'FREE / pure-OSS' : 'PRO'} tier)

   App        http://localhost:${FRONTEND_PORT}/app/?view=activity
   Timeline   http://localhost:${FRONTEND_PORT}/app/?preset=30d&view=timeline
   PR #113    http://localhost:${FRONTEND_PORT}/app/?pr=113   (threads + Claude Review)
   PR #114    http://localhost:${FRONTEND_PORT}/app/?pr=114   (failing CI + AI Fix)

   Capture:   node scripts/capture-shots.mjs [shot.png]
   Ctrl-C to stop.
`);
  // keep the process alive while the children run
  await new Promise(() => {});
} else {
  let backend = await startBackend('pro');
  await startFrontend();
  capture('pro', ONLY_SHOT);
  if (!ONLY_SHOT) {
    stop(backend);
    await new Promise((r) => setTimeout(r, 1500)); // port release
    backend = await startBackend('free');
    capture('free');
  }
  teardown();
  console.log('\n✅ all shots captured → apps/landing/public/shots/');
  process.exit(0);
}
