// Two host-side helpers the container runtimes share: finding a CLI on PATH, and the environment a
// runtime CLI (`docker`, `podman`, `msb`) is started with — Limn's own MINUS anything credential-shaped.
// (They lived in coding/checks/, AI Fix's removed "Run tests" sandbox, until 2026-11.)
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * A name that must never reach a runtime CLI: anything that looks like a credential, or an agent
 * socket. `DOCKER_*` is matched here and let back in by name below (the CLI's own settings).
 */
export const CREDENTIAL_SHAPED =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|AUTH|SESSION|COOKIE|^GH_|^GITHUB_|^ANTHROPIC|^OPENAI|^CLAUDE|^CODEX|^AWS_|^AZURE_|^GOOGLE_|^GCLOUD|^NPM_CONFIG_|^NODE_AUTH|SSH_AUTH_SOCK|GPG_AGENT|^LIMN_|^PIERRE_|^DATABASE_URL$|^DOCKER_/i;

/** Limn's environment minus anything credential-shaped, plus what the Docker CLI reads. */
export function dockerCliEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== 'string') continue;
    if (/^(?:DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY)$/.test(k) || !CREDENTIAL_SHAPED.test(k)) env[k] = v;
  }
  return env;
}

/** The first executable `name` on `path`, or null. */
export function findOnPath(name: string, path: string = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* next */
    }
  }
  return null;
}
