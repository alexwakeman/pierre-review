// STUB — replaced by stream B (Limn's workspace MCP server + its entry script). Only the contract's
// export, so the runner type-checks and its tests run; stream B's file wins on merge.
import type { CodexMcpConfig } from './types.js';

/** STUB: points at an entry script stream B ships. `LIMN_CODEX_MCP_ENTRY` overrides (live test). */
export function workspaceMcpConfig(roots: { read: string[]; write: string[] }): CodexMcpConfig {
  const entry = process.env.LIMN_CODEX_MCP_ENTRY?.trim() || 'workspace-mcp-entry.js';
  return { id: 'workspace', command: process.execPath, args: [entry, ...roots.read], default_tools_approval_mode: 'approve' };
}
