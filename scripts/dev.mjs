// `pnpm dev` — the local dev loop: backend (:4000) + frontend (:5173), plus the
// `packages/ml` severity-api (:8799) when that submodule is checked out.
//
// WHY THIS IS A SCRIPT AND NOT A `concurrently` ONE-LINER. Whether the ML service is available
// is a runtime question (is the submodule checked out? is `uv` installed?), and its answer
// has to reach TWO places: which processes to start, and whether the backend may be pointed at
// the service at all. Those must not be able to disagree — a backend told to use a severity-api
// that is not running would report `mlSeverity: true` from /api/me and show a scoring backlog
// that nothing is draining, which is a worse failure than the feature being quietly off. One
// decision, made here, used for both.
//
//   PIERRE_ML_DIR=…        override the submodule location (default: packages/ml)
//   SEVERITY_API_PORT=…    port for the severity-api (default 8799)
//   PIERRE_ML_DISABLED=1   run the app without it
//
// PRECEDENCE. The URL is exported as SEVERITY_API_DEFAULT_URL, never as SEVERITY_API_URL, so an
// explicit setting always wins: `process.loadEnvFile` does NOT overwrite an already-set variable
// (verified), so putting SEVERITY_API_URL on this command line would have silently overridden
// whatever the developer had in `.env` — the exact inverse of what a default should do.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ML_DIR, ML_PORT, severityApiUnavailable } from './dev-ml.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const blocked = severityApiUnavailable();
const withMl = blocked === null;

const env = { ...process.env };
if (withMl) {
  env.SEVERITY_API_DEFAULT_URL = `http://127.0.0.1:${ML_PORT}`;
  console.log(`[dev] severity-api: ${ML_DIR} → ${env.SEVERITY_API_DEFAULT_URL}`);
  if (process.env.SEVERITY_API_URL) {
    console.log(
      `[dev] note: SEVERITY_API_URL=${process.env.SEVERITY_API_URL} is set and takes precedence.`,
    );
  }
} else {
  console.log(`[dev] severity-api off (${blocked}) — bot comments will carry no ML labels.`);
}

const jobs = [
  ...(withMl ? [{ name: 'ml', color: 'yellow', cmd: 'pnpm dev:ml' }] : []),
  { name: 'backend', color: 'blue', cmd: 'pnpm dev:backend' },
  { name: 'frontend', color: 'magenta', cmd: 'pnpm dev:frontend' },
];

const child = spawn(
  'pnpm',
  [
    'exec',
    'concurrently',
    '-n',
    jobs.map((j) => j.name).join(','),
    '-c',
    jobs.map((j) => j.color).join(','),
    ...jobs.map((j) => j.cmd),
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    // pnpm resolves through a .cmd shim on Windows, which needs a shell to be executable.
    shell: process.platform === 'win32',
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 0);
});
