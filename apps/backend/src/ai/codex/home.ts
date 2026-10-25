// STUB — replaced by stream C (ai/codex/home.ts is stream C's file). Stream B only needs
// `codexBinary()` (verifyHookTrusted asks `codex app-server` for `hooks/list`) and `codexHome()`.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The Codex CLI to run. STUB: `LIMN_CODEX_BIN`, else `codex` on PATH. */
export async function codexBinary(): Promise<string> {
  return process.env.LIMN_CODEX_BIN || 'codex';
}

/** Limn's own CODEX_HOME. STUB: `$LIMN_DATA_DIR/codex`, else `~/.limn/codex`. */
export function codexHome(): string {
  return join(process.env.LIMN_DATA_DIR || join(homedir(), '.limn'), 'codex');
}
