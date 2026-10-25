// THE CODEX ARGV BUILDER (docs/CODEX-PLAN.md § 3.2, as CORRECTED by docs/CODEX-SPIKE.md "Plan
// changes"). ONE function turns a run into the exact `codex exec` argv; every flag and every `-c` key
// is visible here and pinned by config.test.ts, one test per key. Codex is run DIRECTLY (never the
// SDK, which cannot pass --strict-config and hides stderr — the only place refusals appear).
//
// The locked run, and why each piece is there (spike § 1–5):
//   --json                     JSONL events on stdout (ai/codex/events.ts parses them).
//   --strict-config            an unknown `-c` key is an ERROR, so a typo cannot silently unlock.
//   --skip-git-repo-check      worktrees and the one-shot scratch dir are not always repos.
//   -C <cwd>                   the working root.
//   --output-schema <file>     the result's STRICT JSON Schema (ai/result-schemas.ts).
//   -m <model>                 + `model_reasoning_effort`.
//   sandbox_mode               `read-only`, or `workspace-write` with `writable_roots`,
//                              `network_access=false` and ⚠ BOTH `exclude_slash_tmp` and
//                              `exclude_tmpdir_env_var` — without them `/tmp` and `$TMPDIR` are
//                              writable too, and a write OUTSIDE the worktree succeeded (spike run 7).
//   approval_policy="never"    nothing interactive; ⚠ so the MCP server needs
//                              `default_tools_approval_mode="approve"` or every read fails.
//   features.shell_tool=false  NO SHELL (CLAUDE.md: anything an agent reads from a PR is untrusted).
//   features.view_image=false  no image reads (a leak the plan missed).
//   forced_login_method="chatgpt"  only a ChatGPT sign-in runs (the API-key route is refused).
//   web_search="disabled", history.persistence="none", analytics.enabled=false, agents.enabled=false.
//   features.image_generation=false, features.goals=false, features.apps=false (the ChatGPT apps /
//   connectors, `codex_apps`), features.plugins=false, features.remote_plugin=false and
//   features.tool_suggest=false + features.skill_mcp_dependency_install=false (a plugin, connector or
//   MCP dependency INSTALLED mid-run), features.memories=false
//   + memories.generate_memories=false + memories.use_memories=false, features.daemon_auto_start=false
//   — each a way for a run to reach or keep something beyond the files Limn hands it. Every key is
//   checked by the 0.164 CLI under --strict-config (live.test.ts), so a key a later CLI drops fails
//   loudly, never silently. The SAME list is written into Limn's config.toml (`LOCKED_SETTINGS`).
//   project_doc_max_bytes=0    ⚠ the ONLY thing that keeps a PR's own AGENTS.md out of the prompt.
//   skills.include_instructions=false  ⚠ user skills arrive through HOME, not CODEX_HOME.
//   projects."<cwd>".trust_level="untrusted"  belt and braces: the repo's `.codex/` layer loads only
//                              for a project trusted in CODEX_HOME's config, which Limn writes itself.
//   developer_instructions     the system prompt, when the run has one.
//   mcp_servers.workspace.*    Limn's workspace server (workspace-mcp.ts) — the run's ONLY way to read files.
//   hooks.PreToolUse           the path guard (hook.ts), trusted by Limn's own home (home.ts).
//
// What is deliberately ABSENT: `--ephemeral` (a validation retry is `exec resume`, which needs the
// session file — kept in Limn's OWN Codex home, never ~/.codex), `--ignore-user-config` (the config
// IS Limn's own, and the hook's trust entry is ignored under that flag), and
// `--dangerously-bypass-hook-trust` (the trust entry replaces it). The prompt is never an argv
// element: it goes in on stdin (`-`), so a large diff cannot hit ARG_MAX.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexHookConfig, CodexMcpConfig } from './types.js';

/** The part of a run the argv depends on (an `AgentRunSpec` satisfies it). */
export interface CodexExecSpec {
  cwd: string;
  /** Roots the run may write. [] ⇒ a read-only run. */
  writeRoots: string[];
  /** The system prompt. Absent ⇒ not sent. */
  system?: string;
}

export interface CodexExecContext {
  /** Limn's own CODEX_HOME. It reaches the child through the environment (`codexChildEnv`), not argv. */
  home: string;
  /** The workspace MCP server; null ⇒ none (the one-shot completion has no tools at all). */
  mcp: CodexMcpConfig | null;
  /** The path-guard hook; null ⇒ none. */
  hook: CodexHookConfig | null;
  /** The result's strict JSON Schema file; null ⇒ free text. */
  schemaPath: string | null;
  model: string;
  effort: string;
}

// ---- TOML values (the `-c` value is parsed as TOML) ---------------------------------------------

/**
 * A TOML basic string. JSON's string escapes are a subset of TOML's, EXCEPT a lone surrogate
 * (`\ud800`), which TOML rejects — and a value that fails to parse is taken as a RAW literal, quotes
 * and all. So the string is made well-formed first (a lone surrogate becomes U+FFFD).
 */
export function tomlString(s: string): string {
  // JSON leaves DEL (U+007F) raw; TOML forbids it unescaped.
  return JSON.stringify(s.replace(LONE_SURROGATE, '�')).replace(/\x7f/g, '\\u007f');
}
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

/** Any value as inline TOML. Keys are always quoted, so a path or an env name cannot break it. */
export function tomlValue(v: TomlValue): string {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('A Codex config number must be finite.');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${tomlString(k)} = ${tomlValue(x)}`)
    .join(', ')}}`;
}

/** One `-c key=value` pair. */
const c = (key: string, value: TomlValue): string[] => ['-c', `${key}=${tomlValue(value)}`];

// ---- the builder --------------------------------------------------------------------------------

/**
 * THE LOCKDOWN: every key that keeps a Codex process from reaching or keeping anything beyond what Limn
 * hands it, as [dotted key, value]. ONE list, used twice (docs/CODEX-PLAN.md, review fixes round 3):
 *   • home.ts writes it into Limn's own `config.toml`, so EVERY process started in that home — the
 *     app-server (thread cleanup, the sweep, the readings, a sign-in), the hook trust probe, a run —
 *     inherits it. Measured on 0.164: an app-server WITHOUT it fetched the remote plugin catalog
 *     (`ps/plugins/list`) and synced remote plugins; with it, no plugin catalog fetch and no plugin
 *     sync. ⚠ NOT "no traffic": it does not stop the ONLINE MODEL REFRESH (an authenticated GET of
 *     chatgpt.com's Codex model list) — that takes `model_catalog_json`, which only an APP-SERVER may
 *     carry (`appServerConfig` below: a run needs the real catalog) — nor the remote-control loop.
 *   • `lockedConfig()` passes the SAME pairs with `-c` on every `codex exec` and app-server start — a
 *     second layer, so a hand-edited config.toml cannot unlock a run.
 * Each key is checked by the 0.164 CLI under --strict-config (live.test.ts 2b; the app-server's
 * `model_catalog_json` by 2d).
 *
 * ⚠ REMOTE CONTROL CANNOT BE SWITCHED OFF BY CONFIG in 0.164: `features.remote_control` is a REMOVED
 * flag (a no-op), `allow_remote_control` is a requirements.toml key read only from /etc/codex or a
 * managed profile (never CODEX_HOME), and `remoteControl/disable` needs experimentalApi and changes no
 * persisted state. Every app-server therefore starts the IDLE remote-control loop ("remote control
 * websocket loop started") — its status stays `disabled` and nothing enrols, but the loop runs for as
 * long as the process does. Limn keeps app-server starts FEW instead: threads.ts batches every cleanup
 * into one process, the account probe runs at most every 5 minutes, and a drain whose process is up
 * anyway takes a due probe's reads on it (app-server.ts `shareCodexProbe`).
 */
export const LOCKED_SETTINGS: ReadonlyArray<readonly [string, TomlValue]> = [
  ['approval_policy', 'never'],
  // ⚠ WHILE THE API-KEY ROUTE IS REFUSED (ai/codex/detect.ts): only a ChatGPT sign-in may run. Codex
  // itself refuses anything else — measured on 0.164 with a stored (dummy) key in the home: `codex exec`
  // stops before any request ("ChatGPT login is required, but an API key is currently being used.
  // Logging out." — it DELETES that auth.json), CODEX_API_KEY in the environment is refused the same
  // way, and `account/read` answers `account: null`. Without it the stored key ran (a 401 from
  // api.openai.com proved it was sent). The code checks too (ai/providers/codex.ts
  // `runnableCredential`); this is the layer a stale cache cannot get past. Remove it when the
  // API-key route is priced and opened.
  ['forced_login_method', 'chatgpt'],
  ['features.shell_tool', false],
  ['features.view_image', false],
  ['web_search', 'disabled'],
  ['history.persistence', 'none'],
  ['analytics.enabled', false],
  ['agents.enabled', false],
  ['project_doc_max_bytes', 0],
  ['skills.include_instructions', false],
  ['features.image_generation', false],
  ['features.goals', false],
  ['features.apps', false],
  ['features.plugins', false],
  ['features.remote_plugin', false],
  ['features.tool_suggest', false],
  ['features.skill_mcp_dependency_install', false],
  ['features.memories', false],
  ['features.daemon_auto_start', false],
  ['memories.generate_memories', false],
  ['memories.use_memories', false],
];

/** The locked keys every run (and every app-server) carries, in order, as `-c` pairs. */
export function lockedConfig(): string[] {
  return LOCKED_SETTINGS.flatMap(([k, v]) => c(k, v));
}

// ---- the app-server's model catalog ---------------------------------------------------------------
//
// ⚠ NO ONLINE MODEL REFRESH FROM AN APP-SERVER. Measured on 0.164 (2026-10-25, Limn's own home, no
// model run): an app-server started the way Limn starts one — `--strict-config` + the lockdown above —
// still did an authenticated GET of chatgpt.com's Codex model list (`models_cache.json`'s `fetched_at`
// moved from 19:10 to 19:41 on one `account/read`). `features.remote_models` is a REMOVED flag (a
// no-op). The key that stops it is `model_catalog_json`: with a catalog given, Codex never refreshes
// online (the same start left `fetched_at` untouched). It must name at least ONE model with
// instructions, so the app-server gets this STUB — a hidden, API-less model no app-server call uses
// (account reads, thread deletes, the sweep, a sign-in and the hook trust probe never start a turn).
//
// ⚠ APP-SERVERS ONLY, NEVER `codex exec` AND NEVER config.toml: a run needs the REAL catalog (the
// model's instructions, its tools, its reasoning levels), so a run still refreshes it online — that
// fetch is the run's own, on a run the reader started. This key is therefore NOT in LOCKED_SETTINGS.

/** The stub catalog's file, in Limn's own Codex home (written by `appServerConfig`). */
export const APP_SERVER_MODEL_CATALOG_FILE = 'limn-app-server-models.json';

/** The ONE model the stub catalog lists: hidden, not in the API, never run. */
export const APP_SERVER_MODEL_CATALOG = {
  models: [
    {
      slug: 'limn-app-server-no-model',
      display_name: 'Limn app-server (no model)',
      base_instructions: '',
      supported_reasoning_levels: [],
      shell_type: 'default',
      visibility: 'hide',
      supported_in_api: false,
      priority: 0,
      support_verbosity: false,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      experimental_supported_tools: [],
    },
  ],
} as const;

/**
 * The `-c` pairs EVERY app-server Limn starts carries: the lockdown, then `model_catalog_json` = the
 * stub (written into `home` first when missing or different). Synchronous: the spawn options are.
 */
export function appServerConfig(home: string): string[] {
  const file = join(home, APP_SERVER_MODEL_CATALOG_FILE);
  const content = `${JSON.stringify(APP_SERVER_MODEL_CATALOG, null, 2)}\n`;
  try {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, file);
    }
  } catch {
    // Unwritable: start WITHOUT the key rather than name a file that is not there (Codex refuses to
    // start on a missing catalog). The refresh then happens, as before this fix.
    return lockedConfig();
  }
  return [...lockedConfig(), ...c('model_catalog_json', file)];
}

/** The sandbox keys: read-only, or workspace-write confined to `writeRoots`. */
export function sandboxConfig(writeRoots: readonly string[]): string[] {
  if (writeRoots.length === 0) return c('sandbox_mode', 'read-only');
  return [
    ...c('sandbox_mode', 'workspace-write'),
    ...c('sandbox_workspace_write.writable_roots', [...writeRoots]),
    ...c('sandbox_workspace_write.network_access', false),
    ...c('sandbox_workspace_write.exclude_slash_tmp', true),
    ...c('sandbox_workspace_write.exclude_tmpdir_env_var', true),
  ];
}

/** The workspace MCP server's keys. */
export function mcpConfig(mcp: CodexMcpConfig): string[] {
  const base = `mcp_servers.${mcp.id}`;
  return [
    ...c(`${base}.command`, mcp.command),
    ...c(`${base}.args`, mcp.args),
    ...(mcp.env && Object.keys(mcp.env).length > 0 ? c(`${base}.env`, mcp.env) : []),
    ...c(`${base}.default_tools_approval_mode`, mcp.default_tools_approval_mode),
  ];
}

/**
 * The path-guard hook as the ONE PreToolUse entry: hook.ts's own `override`, verbatim. ⚠ Never
 * re-serialised here — the trust hash and `verifyHookTrusted`'s `hooks/list` read are both of THAT
 * text, so a second spelling could hash differently and be skipped silently.
 */
export function hookConfig(hook: CodexHookConfig): string[] {
  return ['-c', hook.override];
}

/**
 * THE argv for `codex exec` (without the binary). The prompt is read from stdin (`-`, last).
 *
 * ⚠ A WRITE run's working directory must be one of its write roots: `workspace-write` always makes
 * the working root writable, so a cwd outside `writeRoots` would widen the run silently.
 */
export function buildExecArgs(spec: CodexExecSpec, ctx: CodexExecContext): string[] {
  if (spec.writeRoots.length > 0 && !spec.writeRoots.includes(spec.cwd)) {
    throw new Error('A Codex write run must work inside one of its write roots.');
  }
  return [
    'exec',
    '--json',
    '--strict-config',
    '--skip-git-repo-check',
    '-C',
    spec.cwd,
    ...(ctx.schemaPath ? ['--output-schema', ctx.schemaPath] : []),
    '-m',
    ctx.model,
    ...c('model_reasoning_effort', ctx.effort),
    ...sandboxConfig(spec.writeRoots),
    ...lockedConfig(),
    // ⚠ ONE inline table, never `projects."<cwd>".trust_level`: Codex splits a `-c` key on EVERY dot,
    // quotes or not, so a cwd with a dot in it (`.claude/worktrees`) failed --strict-config (measured).
    ...c('projects', { [spec.cwd]: { trust_level: 'untrusted' } }),
    ...(spec.system !== undefined && spec.system !== '' ? c('developer_instructions', spec.system) : []),
    ...(ctx.mcp ? mcpConfig(ctx.mcp) : []),
    ...(ctx.hook ? hookConfig(ctx.hook) : []),
    '-',
  ];
}

/**
 * The SAME run, resumed on its thread (a validation retry): every option stays where `exec` takes it
 * and `resume <threadId>` goes before the stdin prompt marker. Codex reports a resumed turn's usage
 * as the THREAD's cumulative total (events.ts `usageDelta`).
 */
export function toResumeArgs(args: readonly string[], threadId: string): string[] {
  if (args[0] !== 'exec' || args[args.length - 1] !== '-') throw new Error('Not a codex exec argv.');
  if (!/^[0-9A-Za-z][0-9A-Za-z-]*$/.test(threadId)) throw new Error('Not a Codex thread id.');
  return [...args.slice(0, -1), 'resume', threadId, '-'];
}

/**
 * The child's environment: the MINIMUM it needs, never Limn's whole environment (which may carry
 * ANTHROPIC_API_KEY, a GitHub token, the session secret…). CODEX_HOME is Limn's own home. An API key
 * rides as CODEX_API_KEY only when that is the credential in use.
 */
export function codexChildEnv(
  home: string,
  base: NodeJS.ProcessEnv = process.env,
  apiKey: string | null = null,
): Record<string, string> {
  const out: Record<string, string> = { ...codexBaseEnv(base), CODEX_HOME: home };
  if (apiKey) out.CODEX_API_KEY = apiKey;
  return out;
}

/** The ONE allow-list of inherited variables every process Limn starts for Codex may see. */
export const CODEX_ENV_ALLOW = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;

/**
 * The allow-listed part of `base`, and nothing else — the base of EVERY Codex-related process (a run,
 * the app-server, a sign-in, the hook's canary): never Limn's whole environment, never an API key.
 */
export function codexBaseEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CODEX_ENV_ALLOW) {
    const v = base[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}
