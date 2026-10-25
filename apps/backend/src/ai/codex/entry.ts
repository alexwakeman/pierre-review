// How Codex starts Limn's two helper processes — the workspace MCP server and the path-guard hook —
// in BOTH builds:
//   dev (`pnpm dev`, vitest): this module is `ai/codex/entry.ts`, so the entry is the sibling `.ts`
//     file, run by the same Node binary with tsx's loader given by ABSOLUTE file URL (Codex starts
//     the process in the run's worktree, where a bare `--import tsx` would not resolve);
//   release (`npx limn-review`): this module is `dist/ai/codex/entry.js`, so the entry is the
//     compiled sibling `.js`, run by plain Node. scripts/build-release.mjs asserts both entries ship
//     and import nothing but `node:` built-ins and relative files.
// `process.execPath` is the Node running Limn, so the helpers never depend on PATH.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CodexHelperEntry = 'workspace-mcp-main' | 'path-guard-hook-main';

export interface HelperCommand {
  /** The program (the Node binary). */
  command: string;
  /** Its arguments, ending with the entry script. */
  args: string[];
}

export function helperCommand(entry: CodexHelperEntry): HelperCommand {
  const here = fileURLToPath(import.meta.url);
  const dev = here.endsWith('.ts');
  const file = join(dirname(here), `${entry}.${dev ? 'ts' : 'js'}`);
  if (!dev) return { command: process.execPath, args: [file] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return { command: process.execPath, args: ['--import', tsx, file] };
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** One argv word for `sh -c`, quoted only when it needs to be (so the common command reads plainly). */
export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
