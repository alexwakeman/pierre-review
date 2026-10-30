// THE DOCKER PREFLIGHT (docs/SECURITY.md § Sandboxed checks). A check that needs Docker services (a
// compose file, testcontainers, a script naming docker) runs only when the Docker daemon answers, and
// Limn asks FIRST — `docker info`, a fixed argv, outside the sandbox (it is Limn's own command, no
// repository text in it) — so a run without Docker fails in a second with one plain line instead of a
// test suite timing out on a connection. A check never gets the Docker socket itself.
import { runProcess } from './spawn.js';
import { findOnPath } from './sandbox.js';
import { NEVER_PASSED } from './env.js';

export interface DockerStatus {
  running: boolean;
  /** One line when not running. */
  note: string | null;
}

/** Limn's environment minus anything credential-shaped, plus what the Docker CLI reads. */
export function dockerCliEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== 'string') continue;
    if (/^(?:DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY)$/.test(k) || !NEVER_PASSED.test(k)) env[k] = v;
  }
  return env;
}

export async function dockerPreflight(opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DockerStatus> {
  const env = opts.env ?? process.env;
  const docker = findOnPath('docker', env.PATH ?? '');
  if (!docker) return { running: false, note: 'Docker isn’t installed, so checks that need it were skipped.' };
  const r = await runProcess({
    command: docker,
    args: ['info', '--format', '{{.ServerVersion}}'],
    cwd: '/',
    env: dockerCliEnv(env),
    timeoutMs: opts.timeoutMs ?? 15_000,
    outputCap: 2_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (r.exitCode === 0 && r.output.trim() !== '') return { running: true, note: null };
  return { running: false, note: 'Docker isn’t running, so checks that need it were skipped.' };
}
