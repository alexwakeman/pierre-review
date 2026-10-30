// THE CODEX SHARED TYPES (docs/CODEX-PLAN.md Phase 2): the two shapes the runner
// (ai/codex/config.ts), the workspace MCP server + path-guard hook (ai/codex/workspace-mcp.ts,
// ai/codex/hook.ts) and Limn's own Codex home (ai/codex/home.ts) hand each other. Types only.

/**
 * The ONE MCP server a Codex run may use: Limn's workspace server (ai/codex/workspace-mcp.ts), which
 * reads, lists and searches files inside the run's roots and refuses anything else. It becomes the
 * `-c mcp_servers.workspace.*` keys (ai/codex/config.ts).
 *
 * ⚠ `default_tools_approval_mode: 'approve'` is NOT optional: under `approval_policy = "never"` every
 * MCP call otherwise fails with "requires approval" (CODEX-SPIKE.md § 2).
 */
export interface CodexMcpConfig {
  /** The server id: its tools reach the model as `mcp__workspace__<tool>`. */
  id: 'workspace';
  /** Absolute path of the program Codex spawns (the Node binary). */
  command: string;
  /** Its arguments (the entry script and the `--read <root>` list). */
  args: string[];
  /** Extra environment for the server (Codex starts MCP servers with a reduced environment). Empty ⇒ not sent. */
  env: Record<string, string>;
  default_tools_approval_mode: 'approve';
  /** Seconds one tool call may take (Codex's default is 60). Set when the run carries `run_check`. */
  tool_timeout_sec?: number;
}

/**
 * Limn's PreToolUse path-guard hook, given per run with `-c` (ai/codex/hook.ts `pathGuardHook`).
 *
 * ⚠ A hook given with `-c` is UNTRUSTED unless Limn's own CODEX_HOME `config.toml` carries
 * `[hooks.state."<trustKey>"] trusted_hash = "<trustedHash>"`, and an untrusted hook is skipped
 * SILENTLY (CODEX-SPIKE.md § 5) — so `ensureCodexHomeConfig` (home.ts) writes the trust entry and
 * `verifyHookTrusted` (hook.ts) checks it before a run relies on the guard.
 */
export interface CodexHookConfig {
  /** The whole `-c` value: `hooks.PreToolUse=[{matcher=…, hooks=[{type="command", …}]}]`. */
  override: string;
  /** The matcher regex on `tool_name`. */
  matcher: string;
  /** The shell command Codex runs (Node + the hook entry script). Constant per install. */
  command: string;
  /** The handler's timeout, seconds (part of the trust hash). */
  timeoutSec: number;
  /** The `hooks.state` key Codex gives a session-flag hook: `/<session-flags>/config.toml:pre_tool_use:0:0`. */
  trustKey: string;
  /** `sha256:<hex>` — what `hooks.state."<trustKey>".trusted_hash` must hold in CODEX_HOME/config.toml. */
  trustedHash: string;
  /**
   * Environment the `codex exec` process MUST carry (the hook inherits it): the run's roots
   * (`LIMN_CODEX_GUARD`). Without it the hook denies everything. The roots travel here, not in
   * `command`, so the trust hash is the same for every run and concurrent runs never fight over
   * the ONE trust entry.
   */
  env: Record<string, string>;
}
