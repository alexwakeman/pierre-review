// LIMN'S CODEX PATH-GUARD HOOK — config, trust and the trust CHECK (docs/CODEX-PLAN.md § 3.3,
// CODEX-SPIKE.md § 5). The decision itself is `hook-rule.ts`; the process is `path-guard-hook-main.ts`.
//
// HOW IT IS WIRED. Every run passes ONE `-c hooks.PreToolUse=[…]` override. Codex lists such a hook
// as source `sessionFlags`, key `/<session-flags>/config.toml:pre_tool_use:0:0`, and runs it ONLY
// when CODEX_HOME/config.toml trusts it: `[hooks.state."<key>"] trusted_hash = "sha256:<hex>"`
// (a trust given with `-c` does not count, and is ignored under `--ignore-user-config`). Limn owns its
// CODEX_HOME (`~/.limn/codex`, decided 2026-10-25), so home.ts `ensureCodexHomeConfig` writes that
// entry from `hookTrustToml(hook)`.
//
// ⚠ AN UNTRUSTED HOOK IS SKIPPED SILENTLY — no warning in the stream or on stderr, and the call it
// should have denied runs (spike run 10). So a run must not believe its guard until
// `verifyHookTrusted` says yes: it asks `codex app-server` `hooks/list` for the hook's trust status
// AND runs the hook's own command on a canary call that must be denied (exit 2), which also catches a
// hook that would crash — a hook exiting 1 lets the call through.
//
// THE COMMAND IS CONSTANT, THE ROOTS TRAVEL IN THE ENVIRONMENT. The trust hash covers the command,
// and there is ONE trust slot per key. If the roots were on the command line, every run would need a
// different hash in that one slot and two concurrent runs would untrust each other — silently. So
// the command is `<node> <hook entry>` (the same for every run on this install) and the roots ride
// `LIMN_CODEX_GUARD` in the `codex exec` process's environment, which the hook inherits
// (`hook.env` — the runner MUST merge it). With the variable missing the hook denies everything.
//
// THE HASH, found from the CLI (0.164.0; pinned in hook.test.ts against `hooks/list` readings): the
// SHA-256 of the handler's identity as compact JSON with SORTED keys —
//   {"event_name":"pre_tool_use","hooks":[{"async":false,"command":…,"timeout":…,"type":"command"}],"matcher":…}
// It depends on the event, matcher, command and timeout (default 600), not on where the hook is
// defined. Re-check on every CLI bump (`codexHookTrustHash` vs `hooks/list` `currentHash`).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appServerConfig, codexBaseEnv, codexChildEnv } from './config.js';
import { helperCommand, shellWord } from './entry.js';
import { encodeGuardRoots, GUARD_ENV, type GuardRoots } from './hook-rule.js';
import type { CodexHookConfig } from './types.js';

/**
 * EVERY tool call goes through the guard. ⚠ Not a list of the tools to check: the rule
 * (hook-rule.ts) is an ALLOW-list, and a matcher that named only the write and MCP tools would let
 * any tool it did not name run unseen — a built-in a future CLI adds, or one a config switch failed
 * to remove. Part of the trust hash (Codex re-hashes on a change; `ensureCodexHomeConfig` rewrites
 * the entry, and `verifyHookTrusted` re-checks).
 */
export const PATH_GUARD_MATCHER = '.*';
/** Seconds Codex waits for the hook (part of the trust hash). */
export const PATH_GUARD_TIMEOUT_SEC = 30;
/** The `hooks.state` key Codex gives the FIRST handler of the FIRST `-c` PreToolUse group. */
export const SESSION_FLAG_PRE_TOOL_USE_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';

/** A TOML basic string. JSON's escapes are TOML's, except the characters refused here. */
function tomlString(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]|[\ud800-\udfff]/.test(s)) throw new Error('codex hook: a control or lone surrogate character cannot go into config');
  return JSON.stringify(s);
}

/** Codex's trust hash for one command handler (see the header). */
export function codexHookTrustHash(h: { event: 'pre_tool_use'; matcher: string; command: string; timeoutSec?: number }): string {
  const identity = {
    event_name: h.event,
    hooks: [{ async: false, command: h.command, timeout: h.timeoutSec ?? 600, type: 'command' }],
    matcher: h.matcher,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** The shell command Codex runs for the hook: this install's Node + the hook entry. */
export function pathGuardCommand(): string {
  const { command, args } = helperCommand('path-guard-hook-main');
  return [command, ...args].map(shellWord).join(' ');
}

/** The hook for one run: `override` goes on the `codex exec` command line, `env` into its environment. */
export function pathGuardHook(roots: GuardRoots): CodexHookConfig {
  const command = pathGuardCommand();
  const matcher = PATH_GUARD_MATCHER;
  const timeoutSec = PATH_GUARD_TIMEOUT_SEC;
  const override =
    `hooks.PreToolUse=[{matcher=${tomlString(matcher)}, hooks=[{type="command", command=${tomlString(command)}, timeout=${timeoutSec}}]}]`;
  return {
    override,
    matcher,
    command,
    timeoutSec,
    trustKey: SESSION_FLAG_PRE_TOOL_USE_KEY,
    trustedHash: codexHookTrustHash({ event: 'pre_tool_use', matcher, command, timeoutSec }),
    env: { [GUARD_ENV]: encodeGuardRoots(roots) },
  };
}

/** The CODEX_HOME/config.toml block that trusts `hook` (for `ensureCodexHomeConfig`). */
export function hookTrustToml(hook: Pick<CodexHookConfig, 'trustKey' | 'trustedHash'>): string {
  return `[hooks.state.${tomlString(hook.trustKey)}]\ntrusted_hash = ${tomlString(hook.trustedHash)}\n`;
}

export interface HookTrustReport {
  trusted: boolean;
  /** Why not, in a sentence (null when trusted). */
  reason: string | null;
  /** What `hooks/list` said for the hook's key (null when it could not be read). */
  listed: { trustStatus: string; currentHash: string; enabled: boolean } | null;
}

const CANARY_TOOL = 'mcp__limn_canary__probe';

/** Run the hook's own command on a call it must deny. True when it exits 2. */
export function hookDeniesCanary(hook: CodexHookConfig, timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    // The hook's own environment, as `codex exec` would hand it on: the run allow-list + the roots.
    const child = spawn('/bin/sh', ['-c', hook.command], {
      env: { ...codexBaseEnv(process.env), ...hook.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 2);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: CANARY_TOOL, tool_input: {}, cwd: '/' }));
  });
}

interface ListedHook {
  key?: string;
  source?: string;
  currentHash?: string;
  trustStatus?: string;
  enabled?: boolean;
}

/** Ask `codex app-server` (CODEX_HOME=`home`) for `hooks/list` with the hook given as a session flag. */
export async function listSessionHooks(binary: string, home: string, hook: CodexHookConfig, timeoutMs = 20_000): Promise<ListedHook[] | null> {
  return new Promise((resolve) => {
    // The run allow-list (config.ts `codexChildEnv`, no API key): a trust read must not be satisfied
    // by, or bill, a key from Limn's environment, nor see anything else of Limn's.
    const env = codexChildEnv(home, process.env);
    // The lockdown with `-c` as well as in the home's config.toml (config.ts `LOCKED_SETTINGS`), and the
    // app-server's stub model catalog (no online model refresh — config.ts `appServerConfig`).
    const child = spawn(binary, ['app-server', '--strict-config', ...appServerConfig(home), '-c', hook.override], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const done = (v: ListedHook[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    child.on('error', () => done(null));
    child.on('close', () => done(null));
    child.stdin.on('error', () => {});
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: number; result?: unknown; error?: unknown };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return done(null);
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [home] } });
        } else if (m.id === 2) {
          const data = (m.result as { data?: Array<{ hooks?: ListedHook[] }> } | undefined)?.data;
          if (!Array.isArray(data)) return done(null);
          done(data.flatMap((d) => (Array.isArray(d.hooks) ? d.hooks : [])));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'limn', version: '1' } } });
  });
}

/** The whole check, with the reason (`verifyHookTrusted` is its boolean). */
export async function inspectHookTrust(home: string, hook: CodexHookConfig, opts: { binary?: string } = {}): Promise<HookTrustReport> {
  const binary = opts.binary ?? (await (await import('./home.js')).codexBinary());
  const hooks = await listSessionHooks(binary, home, hook);
  if (!hooks) return { trusted: false, reason: 'Codex did not answer hooks/list.', listed: null };
  const entry = hooks.find((h) => h.key === hook.trustKey && (h.source === undefined || h.source === 'sessionFlags'));
  if (!entry) return { trusted: false, reason: 'Codex did not load the path-guard hook.', listed: null };
  const listed = { trustStatus: String(entry.trustStatus), currentHash: String(entry.currentHash), enabled: entry.enabled !== false };
  if (listed.currentHash !== hook.trustedHash) {
    return { trusted: false, reason: `Codex hashes the hook as ${listed.currentHash}, not ${hook.trustedHash}.`, listed };
  }
  if (listed.trustStatus !== 'trusted') {
    return { trusted: false, reason: `Codex reports the path-guard hook as ${listed.trustStatus}, so it would be skipped.`, listed };
  }
  if (!listed.enabled) return { trusted: false, reason: 'Codex reports the path-guard hook as disabled.', listed };
  if (!(await hookDeniesCanary(hook))) {
    return { trusted: false, reason: 'The path-guard hook did not refuse a test call.', listed };
  }
  return { trusted: true, reason: null, listed };
}

/**
 * True only when Codex (CODEX_HOME=`home`) will RUN `hook` — trusted, current hash, enabled — and
 * the hook denies a canary call. ⚠ The silent-skip case (untrusted or modified) answers false.
 */
export async function verifyHookTrusted(home: string, hook: CodexHookConfig): Promise<boolean> {
  return (await inspectHookTrust(home, hook)).trusted;
}
