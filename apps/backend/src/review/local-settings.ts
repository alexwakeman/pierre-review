import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

// Local-only settings store for the Claude Review feature: the user's
// Anthropic API key, persisted to ~/.pierre-review/config.json (mode 0600).
// NEVER read or written in cloud mode — the file lives on the user's machine.

const FILE = join(homedir(), '.pierre-review', 'config.json');

interface LocalSettings {
  anthropicApiKey?: string;
}

function read(): LocalSettings {
  try {
    if (!existsSync(FILE)) return {};
    return JSON.parse(readFileSync(FILE, 'utf8')) as LocalSettings;
  } catch {
    return {};
  }
}

function write(settings: LocalSettings): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

export function getUserAnthropicKey(): string | null {
  if (config.isCloud) return null;
  const key = read().anthropicApiKey;
  return key && key.length > 0 ? key : null;
}

export function hasUserAnthropicKey(): boolean {
  return getUserAnthropicKey() != null;
}

// Set (non-empty) or clear (empty/null) the stored key.
export function setUserAnthropicKey(key: string | null): void {
  if (config.isCloud) return;
  const settings = read();
  if (key && key.trim().length > 0) settings.anthropicApiKey = key.trim();
  else delete settings.anthropicApiKey;
  write(settings);
}

/**
 * If the user supplied an Anthropic key, override the ambient Claude auth for the
 * duration of one review run by mutating process.env, returning a restore fn.
 *
 * process.env is process-global, so this is ONLY safe when at most one review
 * runs at a time — gated on reviewConcurrency === 1. With concurrency > 1 the
 * override is skipped (the ambient auth is used) to avoid a cross-run env race.
 * Always call the returned restore fn in a finally.
 */
export function applyUserAnthropicKey(): () => void {
  const key = getUserAnthropicKey();
  if (!key || config.reviewConcurrency !== 1) return () => {};
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = key;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return () => {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
  };
}
