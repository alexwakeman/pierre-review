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

// NOTE: the per-run env override for Claude Review now lives in review/auth.ts as
// `applyClaudeReviewAuth` (it implements the prefer-ambient policy and needs the
// ambient-session probe). This module stays a pure key store.
