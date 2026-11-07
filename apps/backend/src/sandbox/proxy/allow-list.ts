// THE SANDBOX ALLOW-LIST (docs/SANDBOX.md § The allow-list). A session's effective list is the UNION of
//
//   1. the DEFAULTS below (finalised from spike 4's log: what a real workspace — BNG — needed);
//   2. the provider's hosts, ONLY when its credential is in the sandbox (`token-in-sandbox` mode). With
//      INJECTED credentials (the shipped mode, spike 3) the model is reached through the proxy's own
//      injector port, so the provider host is NOT on the forward list at all;
//   3. the workspace's "Always allow" hosts (db/sandbox-allowed-hosts.ts);
//   4. this session's "Allow for this session" hosts (in memory, gone with the session).
//
// Nothing is added automatically: a denied host is shown with Allow buttons and waits for the reader.
//
// LEFT OFF ON PURPOSE (each was seen in spike 4 or considered):
//   • container registries (Docker Hub, ghcr.io) — images are pulled by the HOST's daemon, never from
//     inside the sandbox;
//   • auth.openai.com — a token refresh must never happen inside the sandbox (single-use refresh
//     tokens: it would sign the host out);
//   • telemetry and update hosts (config.liquibase.com, analytics.localstack.cloud, …) — harmless denies;
//   • raw.githubusercontent.com, cdn.jsdelivr.net — nothing the tests needed; one click away when one is.
import { parseRule } from './server.js';

export interface DefaultHost {
  rule: string;
  why: string;
}

export const DEFAULT_ALLOWED_HOSTS: readonly DefaultHost[] = [
  { rule: 'registry.npmjs.org', why: 'npm packages' },
  { rule: 'registry.yarnpkg.com', why: 'Yarn 1 packages' },
  { rule: 'repo.yarnpkg.com', why: 'Yarn 2+ releases' },
  { rule: 'pypi.org', why: 'Python package index' },
  { rule: 'files.pythonhosted.org', why: 'Python package files' },
  { rule: 'nodejs.org', why: 'Node versions named by .nvmrc' },
  { rule: 'repo1.maven.org', why: 'Maven Central (JDBC drivers for migrations)' },
  { rule: 'repo.maven.apache.org', why: 'Maven Central' },
  { rule: 'github.com', why: 'git dependencies (read only: the sandbox has no GitHub credentials)' },
  { rule: 'codeload.github.com', why: 'git dependency tarballs' },
  { rule: 'objects.githubusercontent.com', why: 'GitHub release downloads' },
];

export type SandboxProvider = 'claude' | 'codex';

/** Where the model's credential lives (owner decision Q4; spike 3 proved `injected` for both). */
export type CredentialMode = 'injected' | 'token-in-sandbox';

const PROVIDER_HOSTS: Record<SandboxProvider, readonly string[]> = {
  claude: ['api.anthropic.com'],
  codex: ['chatgpt.com'],
};

export function effectiveRules(opts: {
  provider: SandboxProvider;
  credentialMode: CredentialMode;
  workspaceRules?: readonly string[];
  sessionRules?: readonly string[];
}): string[] {
  const out = new Set<string>(DEFAULT_ALLOWED_HOSTS.map((h) => h.rule));
  if (opts.credentialMode === 'token-in-sandbox') for (const h of PROVIDER_HOSTS[opts.provider]) out.add(h);
  for (const r of [...(opts.workspaceRules ?? []), ...(opts.sessionRules ?? [])]) {
    const parsed = parseRule(r);
    if (parsed && !parsed.any) out.add(parsed.text);
  }
  return [...out];
}

/**
 * A rule a READER may add (Settings, or an Allow button). The normalised text, or a plain reason.
 * Refused: `*` (allow everything), a bare top-level suffix (`*.com`), loopback / link-local / private
 * IP literals, and `localhost`.
 */
export function validateReaderRule(text: string): { ok: true; rule: string } | { ok: false; reason: string } {
  const parsed = parseRule(text);
  if (!parsed) return { ok: false, reason: 'Not a host name. Use a name like registry.example.com, *.example.com or example.com:8443.' };
  if (parsed.any) return { ok: false, reason: 'Allowing every host is not offered. Name the host.' };
  if (parsed.host === 'localhost' || parsed.host.endsWith('.localhost')) return { ok: false, reason: 'localhost is never reachable from the sandbox.' };
  if (parsed.ip) {
    const v4 = /^(\d+)\.(\d+)\./.exec(parsed.host);
    const [a, b] = [Number(v4?.[1]), Number(v4?.[2])];
    if (parsed.host.includes(':') || a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224) {
      return { ok: false, reason: 'That address is never reachable from the sandbox.' };
    }
  }
  return { ok: true, rule: parsed.text };
}
