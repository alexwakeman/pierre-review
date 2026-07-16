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

// Bounds on the user-set per-review budget cap. The MAX is the hard product ceiling the
// user can never exceed; the MIN keeps them from setting a value so low that every review
// trips `error_max_budget_usd` and fails-yet-still-bills (see config.reviewBudgetUsd docs).
export const MIN_REVIEW_BUDGET_USD = 0.5;
export const MAX_REVIEW_BUDGET_USD = 5;

interface LocalSettings {
  anthropicApiKey?: string;
  // Per-review USD ceiling (maxBudgetUsd for the SDK run). Absent = fall back to the
  // operator default (config.reviewBudgetUsd). Clamped to [MIN, MAX] on write.
  maxReviewBudgetUsd?: number;
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

const clampBudget = (n: number): number =>
  Math.min(Math.max(n, MIN_REVIEW_BUDGET_USD), MAX_REVIEW_BUDGET_USD);

// The user's personal per-review budget cap, or null if unset (local mode only). Clamped
// defensively on read too, in case the config file was hand-edited out of range.
export function getUserReviewBudget(): number | null {
  if (config.isCloud) return null;
  const v = read().maxReviewBudgetUsd;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return clampBudget(v);
}

// The budget actually handed to a review run: the user's cap if set, else the operator
// default. (Only the user's cap is bounded to [MIN, MAX]; an operator who raised
// REVIEW_BUDGET_USD past MAX via env keeps that value when the user hasn't overridden it.)
export function getEffectiveReviewBudget(): number {
  return getUserReviewBudget() ?? config.reviewBudgetUsd;
}

// Set (a positive number, clamped to [MIN, MAX]) or clear (null / non-positive) the cap.
export function setUserReviewBudget(usd: number | null): void {
  if (config.isCloud) return;
  const settings = read();
  if (usd != null && Number.isFinite(usd) && usd > 0) {
    settings.maxReviewBudgetUsd = clampBudget(usd);
  } else {
    delete settings.maxReviewBudgetUsd;
  }
  write(settings);
}

// NOTE: the per-run env override for Claude Review now lives in review/auth.ts as
// `applyClaudeReviewAuth` (it implements the prefer-ambient policy and needs the
// ambient-session probe). This module stays a pure key store.
