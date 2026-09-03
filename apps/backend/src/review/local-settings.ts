import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

// Local-only settings store for the Claude Review feature, persisted to
// ~/.pierre-review/config.json (mode 0600). NEVER read or written in cloud mode
// — the file lives on the user's machine.
//
// ⚠ IT NO LONGER HOLDS A CREDENTIAL. The BYO Anthropic key this file existed for is
// RETIRED: local Claude Review resolves auth from an ambient Claude session first (so a
// subscription pays rather than a meter) and otherwise leaves the environment's
// ANTHROPIC_API_KEY in place — two rungs, in review/auth.ts. There is no reader, no
// writer, no route and no form.
//
// ⚠ AN ALREADY-STORED `anthropicApiKey` IS LEFT ON DISK, UNTOUCHED. The decision was to
// stop READING it, not to destroy somebody's file — and `write()` below rewrites the whole
// object it read, so the field round-trips through a budget save rather than being dropped.
// `LocalSettings` deliberately does NOT declare it: an undeclared field is never read and
// never assigned, which is exactly what "retired" means here (the same treatment the plugin
// gives a dormant column). Do not re-add a reader, and do not add an eraser — an eraser is a
// write path back.
//
// What is still LIVE is `maxReviewBudgetUsd`, below: the per-review USD ceiling behind
// ReviewBudgetPanel, PUT /api/claude-review/budget and getEffectiveReviewBudget().

const FILE = join(homedir(), '.pierre-review', 'config.json');

// Bounds on the user-set per-review budget cap. The MAX is the hard product ceiling the
// user can never exceed; the MIN keeps them from setting a value so low that every review
// trips `error_max_budget_usd` and fails-yet-still-bills (see config.reviewBudgetUsd docs).
export const MIN_REVIEW_BUDGET_USD = 0.5;
export const MAX_REVIEW_BUDGET_USD = 5;

interface LocalSettings {
  // (No `anthropicApiKey` — retired; see the header. The key may still be PRESENT in the
  // file and simply passes through `read()` → `write()` untyped and unread.)
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

// NOTE: the per-run env handling for Claude Review lives in review/auth.ts as
// `applyClaudeReviewAuth` (it implements the prefer-ambient policy and needs the
// ambient-session probe). With the stored key retired, that ladder is two rungs and this
// module holds no credential at all — only the budget.
