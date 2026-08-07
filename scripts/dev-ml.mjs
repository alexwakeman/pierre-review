// Start the `pierre-ml` severity-api (the `packages/ml` submodule) for the local dev loop.
//
// The ML severity/category labels on bot comments are produced by a SEPARATE service — the
// `severity-api` from the `packages/ml` submodule (a fine-tuned ModernBERT-ONNX model on CPU).
// Nothing in this repo ships a model, so without that service running the feature is simply
// dark. Having to remember a second terminal made "why are there no badges?" a recurring
// question, so `pnpm dev` starts it too. See docs/ML-SEVERITY.md § "Running it locally".
//
//   pnpm dev              starts this alongside the backend + frontend (via scripts/dev.mjs)
//   pnpm dev:ml           starts ONLY the service, e.g. in its own terminal
//
//   PIERRE_ML_DIR=…       override the submodule location (default: packages/ml)
//   SEVERITY_API_PORT=…   port to serve on (default 8799)
//   PIERRE_ML_DISABLED=1  skip it entirely
//
// THIS SCRIPT NEVER FAILS THE DEV LOOP. The submodule is optional — it is a separate,
// private-ish research repo, and a plain `git clone` (without `--recurse-submodules`) leaves
// `packages/ml` an EMPTY directory. Every "can't run it" path prints one line and exits 0, so
// `pnpm dev` starts the app exactly as it always did.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const ML_PORT = process.env.SEVERITY_API_PORT || '8799';
export const ML_DIR = process.env.PIERRE_ML_DIR
  ? resolve(process.env.PIERRE_ML_DIR)
  : resolve(ROOT, 'packages', 'ml');

const SERVE_SCRIPT = join(ML_DIR, 'scripts', 'serve_local.sh');

/**
 * Why the severity-api can't be started here, or null when it can.
 *
 * Exported so the dev orchestrator can make ONE decision from it: a reason returned here is
 * also the reason the backend must NOT be pointed at the service. Pointing it at a URL nothing
 * is listening on would flip `mlSeverity` on in /api/me and leave the sync UI reporting a
 * scoring backlog that nothing is draining — a worse lie than the feature being off.
 */
export function severityApiUnavailable() {
  if (process.env.PIERRE_ML_DISABLED === '1' || process.env.PIERRE_ML_DISABLED === 'true') {
    return 'PIERRE_ML_DISABLED is set';
  }
  if (process.env.ML_SEVERITY_DISABLED === 'true') return 'ML_SEVERITY_DISABLED=true';
  // An uninitialised submodule is an empty directory, which lands here exactly like a missing
  // sibling repo used to — same graceful skip, but the fix is now one command rather than a clone.
  if (!existsSync(SERVE_SCRIPT)) {
    return `nothing at ${ML_DIR} (run \`git submodule update --init packages/ml\`)`;
  }
  // `serve_local.sh` runs `uv sync` + `uv run uvicorn` under `set -euo pipefail`, so a missing
  // `uv` is a hard failure two lines in. Catch it here instead, where it can be one clear line.
  const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  if (uv.error) return 'uv is not installed (https://docs.astral.sh/uv/)';
  return null;
}

/**
 * What is already listening on the severity-api port: nothing, our service, or a stranger.
 *
 * ⚠ WITHOUT THIS THE DEV LOOP FAILS SILENTLY AND LIES. `serve_local.sh` ends in `exec uvicorn`,
 * which dies with `[Errno 48] Address already in use` on an occupied port. Under `pnpm dev` that
 * job runs inside `concurrently`, which does NOT restart an exited job — so the ml job vanishes
 * into the scrollback while `dev.mjs`, having already decided `withMl`, points the backend at the
 * port anyway. The result is the exact failure this file's header says must never happen: the
 * backend reports `mlSeverity: true` and the sync UI shows a scoring backlog that nothing is
 * draining. Observed in the wild after a hand-started service was left holding the port.
 *
 * A HEALTHY severity-api already on the port is not an error — it is the thing we were about to
 * start. Reusing it makes `pnpm dev` idempotent with a separately-run `pnpm dev:ml`, which is how
 * anyone draining a backlog in its own terminal ends up arranged.
 */
async function probePort() {
  const url = `http://127.0.0.1:${ML_PORT}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return 'stranger';
    const body = await res.json();
    // `models_loaded` is the severity-api's own shape; anything else answering /health on this
    // port is some other service and must NOT be treated as ours.
    return body && typeof body === 'object' && 'models_loaded' in body ? 'ours' : 'stranger';
  } catch (err) {
    // ECONNREFUSED is the ordinary "nothing there" case. Anything else answered badly enough
    // that we cannot claim the port, and must not be mistaken for a free one.
    const code = err?.cause?.code ?? err?.code;
    return code === 'ECONNREFUSED' ? 'free' : 'stranger';
  }
}

async function main() {
  const blocked = severityApiUnavailable();
  if (blocked) {
    console.log(`[dev:ml] skipping severity-api — ${blocked}.`);
    console.log('[dev:ml] the app runs fine without it; bot comments just carry no ML labels.');
    return;
  }

  const occupant = await probePort();
  if (occupant === 'ours') {
    console.log(`[dev:ml] severity-api already serving on :${ML_PORT} — reusing it.`);
    return;
  }
  if (occupant === 'stranger') {
    console.log(
      `[dev:ml] NOT starting severity-api — :${ML_PORT} is held by something that is not one.`,
    );
    console.log(
      `[dev:ml] free the port (lsof -ti:${ML_PORT}) or set SEVERITY_API_PORT, then restart.`,
    );
    return;
  }

  console.log(`[dev:ml] starting severity-api from ${ML_DIR} on :${ML_PORT}`);
  // `detached` puts the service in its OWN process group so it can be killed as a group below.
  const child = spawn('bash', [SERVE_SCRIPT], {
    cwd: ML_DIR,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, SEVERITY_API_PORT: ML_PORT },
  });

  // ⚠ SIGNAL THE GROUP, NOT THE CHILD — otherwise uvicorn outlives the dev loop and holds the
  // port. `serve_local.sh` ends in `exec uv run uvicorn`, so the process this spawns becomes
  // `uv run`; but `uv run` does NOT exec uvicorn, it spawns it as a child of its own. Signalling
  // just `child` therefore kills the wrapper and orphans the server (verified: SIGTERM to this
  // script left uvicorn holding the port). The negative pid reaches the whole group.
  //
  // Ctrl-C would normally reach everything anyway via the terminal's foreground group — but
  // `detached` takes the service OUT of that group, so this handler is now the only path, and
  // `concurrently` signalling its direct children is the case that needed it regardless.
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone, or no group (spawn failed) — fall back to the direct child.
      try {
        child.kill(signal);
      } catch {
        /* nothing left to signal */
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => killGroup(signal));
  }
  // A detached group survives its parent by design, so an ordinary exit has to take it down too
  // (an uncaught throw here would otherwise leak the port until the next reboot).
  process.on('exit', () => killGroup('SIGTERM'));

  child.on('error', (err) => {
    console.log(`[dev:ml] could not start severity-api: ${err.message}`);
    process.exitCode = 0;
  });
  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code) console.log(`[dev:ml] severity-api exited with code ${code}`);
    process.exitCode = 0;
  });
}

// Only run when invoked directly — scripts/dev.mjs imports the helpers above.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  // Never reject: this script must not be able to fail the dev loop (see the header).
  main().catch((err) => {
    console.log(`[dev:ml] could not start severity-api: ${err?.message ?? err}`);
    process.exitCode = 0;
  });
}

export { probePort };
