// STUB — replaced by stream B (the PreToolUse path guard). Only the contract's exports; stream B's
// file wins on merge.
import type { CodexHookConfig } from './types.js';

/** STUB: a placeholder entry. Stream B builds the real guard command and its content hash. */
export function pathGuardHook(_roots: { read: string[]; write: string[] }): CodexHookConfig {
  return { matcher: 'apply_patch|Edit|Write|mcp__workspace__.*', command: 'limn-codex-path-guard', hash: 'sha256:stub' };
}

/** STUB: never trusted, so a write run refuses and a read-only run goes without the hook. */
export async function verifyHookTrusted(_home: string, _hook: CodexHookConfig): Promise<boolean> {
  return false;
}
