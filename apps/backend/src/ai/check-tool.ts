// The project-checks tool's names (ai/provider.ts `AgentCheckTool`), in a module of their own so the
// providers can import them without a cycle through the registry.
/** The checks tool's server and name on Claude (`mcp__checks__run_check`). */
export const CHECKS_TOOL_SERVER = 'checks';
export const RUN_CHECK_TOOL = 'run_check';
