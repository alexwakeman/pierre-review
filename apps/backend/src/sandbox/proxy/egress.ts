// ONE SESSION'S EGRESS (docs/SANDBOX.md § The egress proxy): start the proxy container on the session's
// internal network, give it the allow-list and the model credential, follow its log into the Network
// panel, and apply the reader's Allow clicks. The session manager (WP7) calls `startEgress` once per
// session, BEFORE the sandbox starts, and tears it down with `runtime.destroy(sessionId)`.
//
//   • Secrets travel ONLY over the proxy's loopback control port, through `docker exec -i` STDIN — never
//     an env var, an argv or a file (so `docker inspect` of the proxy shows none).
//   • An Allow is a READER'S CLICK, never automatic: `allow(rule, 'session' | 'workspace')`. The
//     workspace scope is stored (db/sandbox-allowed-hosts.ts) and applies to every later session.
import { randomBytes } from 'node:crypto';
import { addSandboxAllowedHost, listSandboxAllowedHosts, type AddAllowedHostResult } from '../../db/sandbox-allowed-hosts.js';
import type { SandboxRuntime, SessionOwner } from '../runtime/types.js';
import { effectiveRules, validateReaderRule, type CredentialMode, type SandboxProvider } from './allow-list.js';
import {
  claudeSandboxEnv,
  codexSandboxAuth,
  newPlaceholder,
  proxyCredentialsFor,
  PROXY_ALIAS,
  readCodexAuth,
  SANDBOX_CREDENTIAL_MODE,
  sandboxToolProxyEnv,
} from './credentials.js';
import { NetworkLog, type NetworkEntry } from './log.js';
import { DEFAULT_PORTS, PROXY_CONFIG_ENV, PROXY_MAIN_ENV, type ProxyCredentials, type ProxyEnvConfig } from './server.js';
import { proxyProgramSource } from './source.js';

/** Runs INSIDE the proxy container (`docker exec -i … node -e`): stdin `{path, body}` → the control port. */
export const CONTROL_CLIENT = [
  `const cfg = JSON.parse(process.env.${PROXY_CONFIG_ENV} || '{}');`,
  `let input = '';`,
  `process.stdin.setEncoding('utf8');`,
  `process.stdin.on('data', (c) => (input += c));`,
  `process.stdin.on('end', async () => {`,
  `  try {`,
  `    const { path, body } = JSON.parse(input);`,
  `    const r = await fetch('http://127.0.0.1:${DEFAULT_PORTS.control}' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-limn-control': cfg.controlToken }, body: JSON.stringify(body) });`,
  `    process.stdout.write(await r.text());`,
  `    process.exit(r.ok ? 0 : 1);`,
  `  } catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(2); }`,
  `});`,
].join('\n');

export interface AllowedHostStore {
  list(accountId: number, workspaceId: number): Promise<string[]>;
  add(accountId: number, workspaceId: number, rule: string): Promise<AddAllowedHostResult>;
}

const DB_STORE: AllowedHostStore = { list: listSandboxAllowedHosts, add: addSandboxAllowedHost };

export interface StartEgressOptions {
  runtime: SandboxRuntime;
  owner: SessionOwner;
  workspaceId: number;
  image: string;
  network: string;
  provider: SandboxProvider;
  credentialMode?: CredentialMode;
  /** Settings: give the sandbox the global HTTP(S)_PROXY variables too (credentials.ts). */
  globalProxyEnv?: boolean;
  store?: AllowedHostStore;
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  credentialsFor?: (provider: SandboxProvider, env: NodeJS.ProcessEnv) => { creds: ProxyCredentials; problem: string | null };
  readyTimeoutMs?: number;
  onNetwork?: (e: NetworkEntry) => void;
}

export interface EgressSession {
  proxy: string;
  log: NetworkLog;
  /** The sandbox's environment for the network and the model credential (placeholders only). */
  sandboxEnv: Record<string, string>;
  /** The sandbox's Codex auth.json (fake secrets), for the Codex driver to copy in. Null for Claude. */
  codexAuthJson: string | null;
  /** The one line Settings and the session show. */
  credentialMode: CredentialMode;
  /** Why the model cannot be reached, when the host has no usable sign-in. */
  credentialProblem: string | null;
  rules(): string[];
  allow(rule: string, scope: 'session' | 'workspace'): Promise<{ ok: true; rule: string } | { ok: false; reason: string }>;
  /** Push the host's current credential again (before each turn: the host refreshes, the sandbox never does). */
  refreshCredentials(): Promise<string | null>;
  /** Stop following the log. The container goes with `runtime.destroy(sessionId)`. */
  close(): void;
}

export async function startEgress(o: StartEgressOptions): Promise<EgressSession> {
  const env = o.env ?? process.env;
  const store = o.store ?? DB_STORE;
  const credentialsFor = o.credentialsFor ?? proxyCredentialsFor;
  const credentialMode = o.credentialMode ?? SANDBOX_CREDENTIAL_MODE[o.provider];
  if (credentialMode !== 'injected') throw new Error('Only injected credentials are built (docs/SANDBOX.md § Credentials).');

  const nonce = randomBytes(8).toString('hex');
  const anthropicPlaceholder = newPlaceholder();
  let chatgptPlaceholder = newPlaceholder();
  let codexAuthJson: string | null = null;
  if (o.provider === 'codex') {
    const fake = codexSandboxAuth(readCodexAuth(env), nonce);
    if (fake) {
      codexAuthJson = fake.authJson;
      chatgptPlaceholder = fake.placeholder;
    }
  }

  const workspaceRules = new Set(await store.list(o.owner.accountId, o.workspaceId));
  const sessionRules = new Set<string>();
  const rules = (): string[] =>
    effectiveRules({ provider: o.provider, credentialMode, workspaceRules: [...workspaceRules], sessionRules: [...sessionRules] });

  const config: ProxyEnvConfig = {
    rules: rules(),
    placeholders: { anthropic: anthropicPlaceholder, chatgpt: chatgptPlaceholder },
    controlToken: randomBytes(24).toString('hex'),
  };
  const handle = await o.runtime.startProxy({
    ...o.owner,
    image: o.image,
    network: o.network,
    alias: PROXY_ALIAS,
    source: proxyProgramSource(),
    env: { [PROXY_MAIN_ENV]: '1', [PROXY_CONFIG_ENV]: JSON.stringify(config) },
  });

  let members: Map<string, string> | null = null;
  const log = new NetworkLog({
    sourceOf: async (ip) => {
      if (!members?.has(ip)) members = await o.runtime.networkMembers(o.network);
      return members.get(ip) ?? null;
    },
  });
  if (o.onNetwork) log.onChange(o.onNetwork);
  const follow = o.runtime.followLogs(handle.name);
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  void (async () => {
    let buf = '';
    for await (const ev of follow.events) {
      if (ev.type === 'exit') break;
      buf += ev.data.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        await log.ingestLine(line);
        if (log.ready) readyResolve();
      }
    }
  })();

  const timeout = o.readyTimeoutMs ?? 20_000;
  const timedOut = await Promise.race([ready.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), timeout).unref())]);
  if (timedOut) {
    follow.kill();
    throw new Error('The egress proxy did not start.');
  }

  const control = async (path: '/rules' | '/credentials', body: unknown): Promise<void> => {
    // microsandbox: the proxy is a HOST process; the runtime talks to its control socket directly.
    if (o.runtime.proxyControl) {
      if (!(await o.runtime.proxyControl(handle.name, path, body))) throw new Error(`The egress proxy refused a control request (${path}).`);
      return;
    }
    const r = await o.runtime.run(handle.name, ['node', '-e', CONTROL_CLIENT], { input: JSON.stringify({ path, body }), timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`The egress proxy refused a control request (${path}).`);
  };

  let lastCreds: ProxyCredentials = {};
  const refreshCredentials = async (): Promise<string | null> => {
    const { creds, problem } = credentialsFor(o.provider, env);
    await control('/credentials', creds);
    lastCreds = creds;
    return problem;
  };
  const credentialProblem = await refreshCredentials();

  // The CLI is told which header to send by WHICH placeholder variable it gets. Fixed for the session:
  // a reader who switches between a login and a key starts a new session.
  const sandboxEnv: Record<string, string> = {
    ...sandboxToolProxyEnv({ globalProxyEnv: o.globalProxyEnv === true }),
    ...(o.provider === 'claude' ? claudeSandboxEnv(lastCreds.anthropicApiKey ? 'api_key' : 'oauth', anthropicPlaceholder) : {}),
  };

  return {
    proxy: handle.name,
    log,
    sandboxEnv,
    codexAuthJson,
    credentialMode,
    credentialProblem,
    rules,
    async allow(text, scope) {
      const v = validateReaderRule(text);
      if (!v.ok) return v;
      if (scope === 'workspace') {
        const saved = await store.add(o.owner.accountId, o.workspaceId, v.rule);
        if (!saved.ok) return saved;
        workspaceRules.add(saved.rule);
      } else {
        sessionRules.add(v.rule);
      }
      await control('/rules', { rules: rules() });
      return { ok: true, rule: v.rule };
    },
    refreshCredentials,
    close() {
      follow.kill();
      log.close();
    },
  };
}
