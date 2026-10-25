// STUB — replaced by stream C (Limn's own Codex home, the pinned CLI install). Only the contract's
// exports, with the minimum behaviour stream A's runner and tests need; stream C's file wins on merge.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../../data-dir.js';
import type { CodexHookConfig } from './types.js';

/** The Codex CLI. STUB: `LIMN_CODEX_PATH`, else the first-use install's bin, else an error. */
export async function codexBinary(): Promise<string> {
  const explicit = process.env.LIMN_CODEX_PATH?.trim();
  if (explicit) return explicit;
  const installed = join(resolveDataDir(), 'ai-runtime', 'node_modules', '.bin', 'codex');
  if (existsSync(installed)) return installed;
  throw new Error('Codex is not set up yet. Run: limn ai install');
}

/** Limn's OWN Codex home (never ~/.codex): `<dataDir>/codex`. */
export function codexHome(): string {
  return join(resolveDataDir(), 'codex');
}

/** STUB: creates the home only. Stream C writes config.toml and the hook's trust entry. */
export async function ensureCodexHomeConfig(_hook: CodexHookConfig | null): Promise<void> {
  mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
}
