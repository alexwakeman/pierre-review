// Entry of Limn's workspace MCP server — the process Codex starts per run (`workspace-mcp.ts`).
// ⚠ Node built-ins and relative files ONLY (scripts/build-release.mjs asserts it): it runs from a
// release install that carries no AI package, and from dev under tsx.
import { parseServerArgv, serveWorkspaceMcp } from './workspace-mcp.js';

try {
  const { read, logFile } = parseServerArgv(process.argv.slice(2));
  await serveWorkspaceMcp({ read, logFile, input: process.stdin, output: process.stdout });
} catch (e) {
  process.stderr.write(`limn workspace MCP server: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
