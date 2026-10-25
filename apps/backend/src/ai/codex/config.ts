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
//   web_search="disabled", history.persistence="none", analytics.enabled=false, agents.enabled=false.
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

/** The locked keys every run carries, in order. Exported for the test. */
export function lockedConfig(): string[] {
  return [
    ...c('approval_policy', 'never'),
    ...c('features.shell_tool', false),
    ...c('features.view_image', false),
    ...c('web_search', 'disabled'),
    ...c('history.persistence', 'none'),
    ...c('analytics.enabled', false),
    ...c('agents.enabled', false),
    ...c('project_doc_max_bytes', 0),
    ...c('skills.include_instructions', false),
  ];
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
  const out: Record<string, string> = { CODEX_HOME: home };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const v = base[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  if (apiKey) out.CODEX_API_KEY = apiKey;
  return out;
}
