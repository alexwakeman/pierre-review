// STUB — replaced by stream A (ai/codex/types.ts is stream A's file). Stream B wrote this copy so
// its modules compile on their own; the two shapes below are the ones stream B's
// `workspaceMcpConfig` and `pathGuardHook` RETURN, so stream A's copy must carry at least these
// fields (with these names) when the branches merge.

/** Limn's workspace MCP server, as Codex's `mcp_servers.<id>` table needs it. */
export interface CodexMcpConfig {
  /** The server id: its tools reach the model as `mcp__workspace__<tool>`. */
  id: 'workspace';
  /** Absolute path of the program Codex spawns (the Node binary). */
  command: string;
  /** Its arguments (the entry script and the `--read <root>` list). */
  args: string[];
  /** Extra environment for the server (Codex starts MCP servers with a reduced environment). */
  env: Record<string, string>;
  /** ⚠ Required under `approval_policy="never"`, or every MCP call fails (CODEX-SPIKE.md § 2). */
  default_tools_approval_mode: 'approve';
}

/** Limn's PreToolUse path-guard hook, given per run with `-c` and trusted in Limn's CODEX_HOME. */
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
   * Environment the `codex exec` process MUST carry (the hook inherits it): the run's roots. The
   * roots travel here, not in `command`, so the command — and so the trust hash — is the same for
   * every run, and concurrent runs never fight over the ONE trust entry.
   */
  env: Record<string, string>;
}
