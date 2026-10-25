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
import { AiRuntimeMissingError } from '../runtime-errors.js';
import { codexBaseEnv, LOCKED_SETTINGS, tomlValue, type TomlValue } from './config.js';
import type { CodexHookConfig } from './types.js';

/** The folder under the data directory. */
export const CODEX_HOME_DIR_NAME = 'codex';

/** Shown wherever Codex is not set up. One sentence, the command to run. */
export const CODEX_NOT_INSTALLED_MESSAGE = 'Codex is not set up yet. Run: limn ai install codex';

/**
 * Thrown by `codexBinary` (and the provider) when the Codex program is not installed. Its message is
 * safe to show. ⚠ An `AiRuntimeMissingError`: every cheap caller stops its pass on THAT class (one
 * missing install is not N failed briefs), so a missing Codex must be one too — with Codex's message.
 */
export class CodexNotInstalledError extends AiRuntimeMissingError {
  readonly codexCode = 'CODEX_NOT_INSTALLED';
  constructor() {
    super('@openai/codex');
    this.message = CODEX_NOT_INSTALLED_MESSAGE;
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
 * sign-out): the SAME allow-list a run gets (config.ts `codexBaseEnv` — never Limn's whole
 * environment, which may carry ANTHROPIC_API_KEY, a GitHub token, the session secret…) with
 * `CODEX_HOME` = Limn's home. No API-key variable is on the list, so `account/read` reports the
 * STORED sign-in, never a key from the environment, and a sign-in can never be satisfied by one.
 * `interactive` (the CLI's `codex login`, attached to the reader's terminal) adds only what a
 * terminal program opening a browser needs (TERM, DISPLAY, WAYLAND_DISPLAY, BROWSER) — no secrets.
 */
export function codexProcessEnv(env: NodeJS.ProcessEnv = process.env, opts: { interactive?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = { ...codexBaseEnv(env), CODEX_HOME: codexHome(env) };
  if (opts.interactive) {
    for (const k of ['TERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'BROWSER']) {
      const v = env[k];
      if (v) out[k] = v;
    }
  }
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
 * `LOCKED_SETTINGS` as TOML: the top-level keys first, then one `[table]` per first key segment (in
 * first-seen order). Every locked key has at most two segments; a deeper one is refused loudly.
 */
export function lockdownToml(settings: ReadonlyArray<readonly [string, TomlValue]> = LOCKED_SETTINGS): string[] {
  const top: string[] = [];
  const tables = new Map<string, string[]>();
  for (const [key, value] of settings) {
    const parts = key.split('.');
    if (parts.length > 2 || parts.some((p) => !/^[a-z_]+$/.test(p))) throw new Error(`Not a simple Codex config key: ${key}`);
    if (parts.length === 1) top.push(`${key} = ${tomlValue(value)}`);
    else {
      const rows = tables.get(parts[0]!) ?? [];
      rows.push(`${parts[1]} = ${tomlValue(value)}`);
      tables.set(parts[0]!, rows);
    }
  }
  const out = [...top];
  for (const [table, rows] of tables) out.push('', `[${table}]`, ...rows);
  return out;
}

/**
 * Limn's whole config.toml, from the hook trust entries to keep. Pure.
 *
 *   • `cli_auth_credentials_store = "file"` — the sign-in lives in THIS folder's auth.json, never the
 *     OS keychain (where it would be shared with, and rotated by, the reader's own Codex).
 *   • `forced_login_method` is deliberately NOT set (the API-key route is refused in code, not here).
 *   • `check_for_update_on_startup = false` — the version is Limn's pin, not "latest".
 *   • THE WHOLE LOCKDOWN (config.ts `LOCKED_SETTINGS`): no shell, no history, no analytics, no apps,
 *     plugins, remote plugins, memories, goals… — so EVERY process in this home inherits it, the
 *     app-server included (which otherwise fetched the remote plugin catalog on every start).
 *   • one `[hooks.state."<key>"] trusted_hash` per trusted path-guard hook.
 *
 * A run still passes the same keys with `-c` (and its sandbox, MCP server and hook) under
 * `--strict-config`: the file is the floor, the argv the second layer.
 */
export function codexHomeConfigToml(trust: ReadonlyMap<string, string>): string {
  const lines = [
    "# Limn's own Codex home. Written by Limn (apps/backend/src/ai/codex/home.ts); edits are overwritten.",
    '# Your own ~/.codex is never read or written by Limn.',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    ...lockdownToml(),
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
    if (hook) trust.set(hook.trustKey, hook.trustedHash);
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
