import type { DispatchDecision } from '../review/claude-review/specialists.js';

// AGENT ISOLATION — every Agent SDK run in this app sees ONLY the tools it registered itself.
//
// ⚠ MEASURED (2026-10-10): a run on the reader's ambient Claude Code login, with `tools: []`,
// `settingSources: []` and `bypassPermissions`, still lists the ACCOUNT'S claude.ai CONNECTORS
// (`mcp__claude_ai_Claude_Docs__create/update/delete/export`, …) a few seconds after start — they
// connect after `system/init`, so the init message shows none. A trial agent wrote a report into the
// user's Claude Docs unprompted. Claude Review reads PR text strangers write, so a prompt injection
// could create, edit or delete documents in the reader's claude.ai account. `strictMcpConfig: true`
// removes them (measured: 8 connector tools → 0); the PreToolUse hook below is the backstop that
// refuses any `mcp__` tool whose server the run did not register, and its deny holds under
// bypassPermissions (the path guard relies on the same property).
//
// EVERY `query({ options })` spreads `ISOLATED_MCP` and adds `ownToolsOnlyHook(<its server names>)`
// to `PreToolUse` — pinned by agent-isolation.test.ts, which reads every call site.

export const ISOLATED_MCP = { strictMcpConfig: true } as const;

/** The MCP server a tool name belongs to (`mcp__<server>__<tool>`), or null for a built-in tool. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const cut = rest.indexOf('__');
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** True when `toolName` is an MCP tool from a server this run did not register. */
export function isForeignMcpTool(toolName: string, ownServers: readonly string[]): boolean {
  const server = mcpServerOf(toolName);
  return server != null && !ownServers.includes(server);
}

/** One SDK PreToolUse matcher entry refusing every MCP tool outside `ownServers`. */
export function ownToolsOnlyHook(ownServers: readonly string[]): {
  hooks: Array<(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) => Promise<DispatchDecision>>;
} {
  return {
    hooks: [
      async (input) =>
        input.hook_event_name === 'PreToolUse' && isForeignMcpTool(input.tool_name ?? '', ownServers)
          ? {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `${input.tool_name} is not available in this run.`,
              },
            }
          : { continue: true },
    ],
  };
}
