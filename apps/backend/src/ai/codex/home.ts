// LIMN'S OWN CODEX HOME (docs/CODEX-PLAN.md § 6, DECIDED 2026-10-25): `<LIMN_DATA_DIR>/codex`
// (`~/.limn/codex`). Every Codex process Limn starts — a run, the app-server probe, a sign-in — gets
// `CODEX_HOME` pointed here, so:
//   • the sign-in is Limn's own (`auth.json` here, file storage — never the keychain, never a copy
//     of the reader's: a ChatGPT refresh token ROTATES, so two copies would sign one of them out);
//   • the config is Limn's own (`config.toml`, written whole by `ensureCodexHomeConfig`), including
//     the path-guard hook's TRUST ENTRY — a hook given with `-c` is skipped SILENTLY unless this
//     file trusts its hash (docs/CODEX-SPIKE.md § 5);
//   • session files land here, which is what makes a validation retry (`exec resume`) possible.
//
// ⚠ THE READER'S `~/.codex` IS NEVER READ OR WRITTEN. Nothing in this module looks there.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../../data-dir.js';
import { codexBinaryPath } from '../runtime.js';
import type { CodexHookConfig } from './types.js';

/** The folder under the data directory. */
export const CODEX_HOME_DIR_NAME = 'codex';

/** Shown wherever Codex is not set up. One sentence, the command to run. */
export const CODEX_NOT_INSTALLED_MESSAGE = 'Codex is not set up yet. Run: limn ai install codex';

/** Thrown by `codexBinary` when the Codex program is not installed. Its message is safe to show. */
export class CodexNotInstalledError extends Error {
  readonly code = 'CODEX_NOT_INSTALLED';
  constructor() {
    super(CODEX_NOT_INSTALLED_MESSAGE);
    this.name = 'CodexNotInstalledError';
  }
}

/** `<LIMN_DATA_DIR>/codex`. Read at call time, so a test's LIMN_DATA_DIR is honoured. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir(env), CODEX_HOME_DIR_NAME);
}

/** The Codex native program (LIMN_CODEX_PATH, else the first-use install). Throws when absent. */
export async function codexBinary(): Promise<string> {
  const bin = codexBinaryPath();
  if (!bin) throw new CodexNotInstalledError();
  return bin;
}

/**
 * The environment of a Codex process that is NOT a model run (the app-server probe, a sign-in,
 * sign-out): the inherited one, with `CODEX_HOME` set to Limn's home and every API-key variable
 * removed — so `account/read` reports the STORED sign-in, never a key from the environment, and a
 * sign-in can never be satisfied by one.
 */
export function codexProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CODEX_HOME: codexHome(env) };
  delete out.OPENAI_API_KEY;
  delete out.CODEX_API_KEY;
  return out;
}

// ---- config.toml ----------------------------------------------------------------------------------

/** A TOML basic string. JSON's escapes (\", \\, \n, \uXXXX) are all valid TOML basic-string escapes. */
const tomlString = (s: string): string => JSON.stringify(s);

/** The hook trust entries already in a config.toml Limn wrote: `hooks.state` key → `trusted_hash`. */
export function parseTrustEntries(toml: string): Map<string, string> {
  const out = new Map<string, string>();
  // Only the exact two-line shape `codexHomeConfigToml` writes; anything else is not ours.
  const re = /^\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\r?\ntrusted_hash = ("(?:[^"\\]|\\.)*")\s*$/gm;
  for (const m of toml.matchAll(re)) {
    try {
      out.set(JSON.parse(m[1]!) as string, JSON.parse(m[2]!) as string);
    } catch {
      /* not ours */
    }
  }
  return out;
}

/**
 * Limn's whole config.toml, from the hook trust entries to keep. Pure.
 *
 *   • `cli_auth_credentials_store = "file"` — the sign-in lives in THIS folder's auth.json, never the
 *     OS keychain (where it would be shared with, and rotated by, the reader's own Codex).
 *   • `forced_login_method` is deliberately NOT set: a ChatGPT sign-in and an API key both work.
 *   • `check_for_update_on_startup = false` — the version is Limn's pin, not "latest".
 *   • `history.persistence = "none"` — no prompt history (pull-request text is untrusted input).
 *   • `analytics.enabled = false`.
 *   • one `[hooks.state."<key>"] trusted_hash` per trusted path-guard hook.
 *
 * Everything that locks a RUN down (sandbox, shell off, MCP, the hook itself) is passed per run with
 * `-c` by the runner, under `--strict-config`; this file only holds what must persist.
 */
export function codexHomeConfigToml(trust: ReadonlyMap<string, string>): string {
  const lines = [
    "# Limn's own Codex home. Written by Limn (apps/backend/src/ai/codex/home.ts); edits are overwritten.",
    '# Your own ~/.codex is never read or written by Limn.',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    '',
    '[history]',
    'persistence = "none"',
    '',
    '[analytics]',
    'enabled = false',
  ];
  for (const [key, hash] of [...trust.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `[hooks.state.${tomlString(key)}]`, `trusted_hash = ${tomlString(hash)}`);
  }
  return lines.join('\n') + '\n';
}

/** One write at a time, in-process: two runs trusting hooks at once must not lose an entry. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Create Limn's Codex home (mode 0700) and write its config.toml, adding `hook`'s trust entry (and
 * keeping every entry already trusted). `null` writes the base config and keeps the entries — the
 * sign-in calls it that way before `codex login`. Writes only when the content changes, atomically
 * (temp file + rename), so a run reading the file never sees half of it.
 */
export function ensureCodexHomeConfig(hook: CodexHookConfig | null, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const next = writeChain.then(() => {
    const home = codexHome(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, 'config.toml');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const trust = parseTrustEntries(current);
    if (hook) trust.set(hook.stateKey, hook.trustedHash);
    const content = codexHomeConfigToml(trust);
    if (content === current) return;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  });
  // A failed write must not wedge every later one.
  writeChain = next.catch(() => {});
  return next;
}
