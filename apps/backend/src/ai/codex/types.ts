// THE CODEX SHARED TYPES (docs/CODEX-PLAN.md Phase 2): the two shapes the runner (stream A,
// ai/codex/config.ts), the workspace MCP server + path-guard hook (stream B) and Limn's own Codex
// home (stream C) hand each other. Types only — nothing here runs.

/**
 * The ONE MCP server a Codex run may use: Limn's workspace server (ai/codex/workspace-mcp.ts), which
 * reads, lists and searches files inside the run's roots and refuses anything else. It becomes the
 * `-c mcp_servers.workspace.*` keys (ai/codex/config.ts).
 *
 * ⚠ `default_tools_approval_mode: 'approve'` is NOT optional: under `approval_policy = "never"` every
 * MCP call otherwise fails with "requires approval" (CODEX-SPIKE.md § 2).
 */
export interface CodexMcpConfig {
  id: 'workspace';
  command: string;
  args: string[];
  /** Extra environment for the server process. Absent or empty ⇒ not sent. */
  env?: Record<string, string>;
  default_tools_approval_mode: 'approve';
}

/**
 * The PreToolUse path-guard hook, given per run as `-c hooks.PreToolUse=[…]` (ai/codex/config.ts).
 *
 * ⚠ A hook given with `-c` is UNTRUSTED unless Limn's own CODEX_HOME `config.toml` carries
 * `[hooks.state."<key>"] trusted_hash = "<hash>"`, and an untrusted hook is skipped SILENTLY
 * (CODEX-SPIKE.md § 5) — so `hash` travels with the entry, stream C writes the trust entry from it,
 * and stream B's `verifyHookTrusted` checks it before a run relies on the guard.
 */
export interface CodexHookConfig {
  /** The `matcher` regex on `tool_name` (`apply_patch`, `mcp__workspace__read_file`, …). */
  matcher: string;
  /** The handler command (one shell word list joined, as Codex runs it). */
  command: string;
  /** The handler's content hash as Codex computes it (`sha256:…`), for the trust entry. */
  hash: string;
  /** Handler timeout in seconds. Absent ⇒ Codex's default (not sent). */
  timeoutSec?: number;
}

/**
 * The trust-state key Codex gives the FIRST PreToolUse hook passed with `-c` (seen in `hooks/list`
 * as `source: sessionFlags`). The hash depends on the handler's content, not on where it is defined.
 */
export const SESSION_FLAG_PRE_TOOL_USE_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';
