// STUB — replaced by stream A (Codex Phase 2: ai/codex/types.ts is stream A's file). Stream C's
// home.ts reads only `CodexHookConfig.stateKey` and `.trustedHash`; the merge must keep those two
// (or rename them in home.ts `ensureCodexHomeConfig`).

/** The run's workspace MCP server (`-c mcp_servers.workspace.*`). */
export interface CodexMcpConfig {
  id: 'workspace';
  command: string;
  args: string[];
  env: Record<string, string>;
  default_tools_approval_mode: 'approve';
}

/** The per-run path-guard hook (`-c hooks.PreToolUse=[…]`) and its trust entry. */
export interface CodexHookConfig {
  /** The `-c` override value for `hooks.PreToolUse`. */
  override: string;
  /** The `hooks.state` key Codex gives a session-flag hook (`/<session-flags>/config.toml:pre_tool_use:0:0`). */
  stateKey: string;
  /** The handler's content hash, `sha256:<hex>` — written as `trusted_hash` in Limn's config.toml. */
  trustedHash: string;
}
