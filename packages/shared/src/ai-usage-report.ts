// REPORTS → AI USAGE (GET /api/ai/usage-report, docs/API.md; the fold is the backend's
// db/ai-usage-report.ts, the screen Activity/AiUsageView.tsx).
//
// Where Limn's own AI runs went: by feature, by pull request, by story, over the reporting window,
// and over the last 12 weeks (the LABELLED exception). Read from the `ai_usage` ledger (one row per
// billable run) plus the run tables that carry what the ledger does not (status, trigger, head,
// diff size, cache reads).
//
// ⚠ THE UNIVERSAL MEASURE IS TOKENS (input + output, both providers). A cost rides beside it in ONE
// unit for the whole response, Claude's: `usd` on an API key, `week_pct` (a share of a week's
// allowance) on a subscription whose kind is known, null otherwise. A subscription NEVER carries
// US$ on this wire — the server converts with the budget's own rate (`weekPctPerUsd`) before it
// answers. Codex on a ChatGPT sign-in has no price and no per-run share: tokens only.

import type { ReportingWindowInfo } from './types.js';

/** The report's feature groups, in display order. */
export type AiUsageFeatureGroup =
  | 'code'
  | 'story'
  | 'ci'
  | 'fix'
  | 'chat'
  | 'diagrams'
  | 'sprint'
  | 'docs'
  | 'resolve'
  | 'other';

export const AI_USAGE_FEATURE_GROUPS: readonly AiUsageFeatureGroup[] = [
  'code',
  'story',
  'ci',
  'fix',
  'chat',
  'diagrams',
  'sprint',
  'docs',
  'resolve',
  'other',
];

export const AI_USAGE_GROUP_LABEL: Readonly<Record<AiUsageFeatureGroup, string>> = {
  code: 'Code review',
  story: 'Story review',
  ci: 'CI review',
  fix: 'AI Fix',
  chat: 'Review chat',
  diagrams: 'Diagrams',
  sprint: 'Sprint view',
  docs: 'Docs',
  resolve: 'Resolve with Claude',
  other: 'Summaries',
};

/**
 * A ledger `feature` → its group. The ledger's feature is free text (a new feature needs no
 * migration), so anything unknown lands in 'other' ("Summaries": the one-shot completions).
 */
export function aiUsageFeatureGroup(feature: string): AiUsageFeatureGroup {
  const f = feature.trim();
  // Codex records each specialist as `claude_review:<name>`; the pair merge, the replies pass and
  // Check threads are code review too.
  if (f === 'claude_review' || f.startsWith('claude_review:') || f === 'claude_review_merge') return 'code';
  if (f === 'replies_check' || f === 'thread_check') return 'code';
  if (f === 'ticket_review' || f === 'story_labels') return 'story';
  if (f === 'ci_review' || f === 'ci_analysis') return 'ci';
  if (f === 'ai_fix' || f === 'ai_fix_plan') return 'fix';
  if (f === 'claude_review_chat') return 'chat';
  if (f === 'sequence_diagram') return 'diagrams';
  if (f.startsWith('sprint_')) return 'sprint';
  if (f.startsWith('reference_docs_') || f.startsWith('docs_') || f.startsWith('story_docs_')) return 'docs';
  if (f === 'ai_resolve') return 'resolve';
  return 'other';
}

/** Is this ledger feature a code-review specialist (Codex records them apart)? */
export function isSpecialistFeature(feature: string): boolean {
  return feature.startsWith('claude_review:');
}

/** The response's ONE cost unit (Claude's). Null = no cost is shown, only tokens. */
export type AiUsageCostUnit = 'usd' | 'week_pct';

/** One population's figures. */
export interface AiUsageFigures {
  /** Ledger rows (one per billable run). */
  runs: number;
  /** Input + output tokens, both providers. A run with no token figure adds nothing here. */
  tokens: number;
  claudeTokens: number;
  codexTokens: number;
  /** Claude's runs' cost in the response's `costUnit`; null when that unit is null. */
  claudeCost: number | null;
}

export interface AiUsageDayBucket {
  /** Local midnight, ISO. */
  start: string;
  /** Tokens per group; a group with none is absent. */
  tokens: Partial<Record<AiUsageFeatureGroup, number>>;
}

export interface AiUsageGroupRow {
  group: AiUsageFeatureGroup;
  figures: AiUsageFigures;
}

export interface AiUsagePrRow {
  prId: number;
  number: number;
  title: string;
  repoFullName: string;
  figures: AiUsageFigures;
}

export interface AiUsageStoryRow {
  /** Shared `trackerTicketIdent` — the story tab's key. */
  ident: string;
  key: string;
  title: string | null;
  /** Pull requests of this story that used AI in the window. */
  prCount: number;
  figures: AiUsageFigures;
}

export interface AiUsageWeek {
  /** Monday, local midnight, ISO. */
  start: string;
  /** The current week, still running. */
  partial: boolean;
  figures: AiUsageFigures;
}

/** Where a suggestion's setting lives (the SPA maps it to a Settings focus). */
export type AiUsageSettingLink = 'auto-review' | 'ai-effort';

export type AiUsageSuggestionKind =
  | 'auto_rereviews'
  | 'failed_runs'
  | 'large_diffs'
  | 'deep_model'
  | 'many_reviews';

/** A token-saving suggestion: a fact, what it would have saved, and the setting that changes it. */
export interface AiUsageSuggestion {
  kind: AiUsageSuggestionKind;
  /** The fact, one sentence, the server's words. */
  fact: string;
  /** What to change, a few words ("Review fewer pushes"). */
  action: string;
  /** The estimated saving over the window. */
  saving: Pick<AiUsageFigures, 'tokens' | 'claudeCost'>;
  setting: AiUsageSettingLink | null;
  /** The pull requests behind it, most first (≤ 5). */
  prIds: number[];
}

export type AiUsageInsightKind = 'cache' | 'specialists' | 'model_mix' | 'auto_share' | 'unmeasured';

/** A measured fact with no saving attached. */
export interface AiUsageInsight {
  kind: AiUsageInsightKind;
  text: string;
}

export interface AiUsageReportResponse {
  workspaceId: number;
  /** The reporting window every figure except `weeks` is measured over. */
  window: ReportingWindowInfo;
  costUnit: AiUsageCostUnit | null;
  totals: AiUsageFigures;
  /** Of `totals.runs`: rows tied to no repository (sprint view, docs, summaries), counted in every
   *  workspace. */
  machineWideRuns: number;
  /** Of `totals.runs`: rows with no token figure (a cancelled run, an older row). */
  unmeasuredRuns: number;
  days: AiUsageDayBucket[];
  groups: AiUsageGroupRow[];
  /** ≤ 10, most tokens first. */
  topPrs: AiUsagePrRow[];
  /** ≤ 10, most tokens first. Empty when the workspace has no tracker. */
  topStories: AiUsageStoryRow[];
  /** LABELLED EXCEPTION: the last 12 weeks, oldest first, whatever the reporting window. */
  weeks: AiUsageWeek[];
  /** Tokens a week, least-squares over the COMPLETE weeks; null with fewer than 3 of them. */
  weeklySlope: number | null;
  suggestions: AiUsageSuggestion[];
  insights: AiUsageInsight[];
}

/** "840", "12k", "1.4M" tokens — the ONE spelling of a token count. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(Math.round(n / 100) / 10).toString()}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(Math.round(n / 100_000) / 10).toString()}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** An empty figures record. */
export function emptyAiUsageFigures(costUnit: AiUsageCostUnit | null): AiUsageFigures {
  return { runs: 0, tokens: 0, claudeTokens: 0, codexTokens: 0, claudeCost: costUnit == null ? null : 0 };
}
