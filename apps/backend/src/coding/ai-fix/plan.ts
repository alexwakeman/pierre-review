import {
  AI_FIX_PLAN_BULLET_MAX_CHARS,
  AI_FIX_PLAN_MAX_BULLETS,
  type AiFixPlan,
  type AiFixPlanMessage,
  type AiFixPlanState,
  type AiFixPlanStatus,
  type AiFixPlanStep,
  type AiFixReviewItem,
} from '@pierre-review/shared';
import type { FixSeed } from './prompts.js';

// PLAN MODE's pure half (docs/CLAUDE-REVIEW.md § AI Fix "Plan mode"): checking what the planning
// agent hands `submit_plan`, normalising it for storage, and parsing the stored columns. No DB, no
// SDK — the unit tests import this file directly.

// What `submit_plan` receives, UNVALIDATED (the zod shape in coding/schema.ts is lenient on purpose).
export interface RawPlanSubmission {
  summary?: unknown;
  steps?: unknown;
  notAddressed?: unknown;
  reply?: unknown;
}

// A planning pass's live progress: checking out, then reading (with the rolling activity log).
export interface PlanRunProgress {
  phase: 'cloning' | 'planning';
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

// The planning pass's input (coding/agent.ts `runPlanAgent`, via AgentContext.coding.generatePlan).
export interface GeneratePlanArgs {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  // The commit the pass reads (the live PR head when the plan started).
  baseSha: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  // The refs the pass was shown — what `submit_plan` checks its refs against.
  shownRefs: readonly string[];
  maxTurns?: number;
  maxBudgetUsd: number;
  abortController: AbortController;
  onProgress: (p: PlanRunProgress) => void;
  /** The PR, for the ledger row a provider that records its own usage (Codex) writes. */
  prId?: number;
  /** The provider the prompt was worded for (ai/prompt-tools.ts). Absent ⇒ the active one. */
  provider?: 'claude' | 'codex';
  /** Codex-only run knobs (the opt-in live test's effort). */
  codex?: { effort?: string; timeoutMs?: number };
}

// What a planning pass returns to the manager (coding/agent.ts `runPlanAgent`).
export interface GeneratePlanResult {
  // The accepted submission, or null when the agent never made an acceptable submit_plan call.
  plan: RawPlanSubmission | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  costUsd: number | null;
  numTurns: number | null;
  aborted: boolean;
  /** True ⇒ the provider already wrote this pass's AI-usage ledger row (Codex): write no second one. */
  usageRecorded?: boolean;
}

export const PLAN_STEP_TITLE_MAX = 200;
export const PLAN_STEP_CHANGE_MAX = 1_200;
export const PLAN_REASON_MAX = 400;
export const PLAN_REPLY_MAX = 600;
const MAX_STEPS = 40;
const MAX_FILES_PER_STEP = 20;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+\n/g, '\n').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// A bullet arrives as "- text" or "• text" often enough that the marker is stripped, not counted.
function bullet(s: string): string {
  return s.replace(/^\s*(?:[-*•]|\d+[.)])(?:\s+|$)/, '').trim();
}

/**
 * What is wrong with a `submit_plan` call, as sentences the TOOL answers the model with (so it can
 * call again). [] = acceptable. The limits are the point of the summary: at most
 * AI_FIX_PLAN_MAX_BULLETS bullets, each at most AI_FIX_PLAN_BULLET_MAX_CHARS characters; every ref
 * must be one the pass was SHOWN.
 */
export function checkPlanSubmission(raw: RawPlanSubmission, shownRefs: readonly string[]): string[] {
  const problems: string[] = [];
  const bullets = strings(raw.summary).map(bullet).filter((b) => b !== '');
  if (bullets.length === 0) problems.push('`summary` needs at least one bullet.');
  if (bullets.length > AI_FIX_PLAN_MAX_BULLETS)
    problems.push(`\`summary\` has ${bullets.length} bullets; give at most ${AI_FIX_PLAN_MAX_BULLETS}.`);
  const long = bullets.filter((b) => b.length > AI_FIX_PLAN_BULLET_MAX_CHARS).length;
  if (long > 0)
    problems.push(
      `${long} summary bullet${long === 1 ? ' is' : 's are'} longer than ${AI_FIX_PLAN_BULLET_MAX_CHARS} characters; keep each short.`,
    );
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const declined = Array.isArray(raw.notAddressed) ? raw.notAddressed : [];
  if (steps.length === 0 && declined.length === 0)
    problems.push('Give at least one step, or list every item in `notAddressed`.');
  const shown = new Set(shownRefs);
  const cited: string[] = [];
  for (const s of steps) {
    if (s && typeof s === 'object') cited.push(...strings((s as { refs?: unknown }).refs));
  }
  for (const d of declined) {
    if (d && typeof d === 'object' && typeof (d as { ref?: unknown }).ref === 'string')
      cited.push((d as { ref: string }).ref);
  }
  const unknown = [...new Set(cited.map((r) => r.trim()).filter((r) => r !== '' && !shown.has(r)))];
  if (unknown.length > 0)
    problems.push(
      shown.size === 0
        ? `This task has no item refs; leave \`refs\` empty (you cited ${unknown.join(', ')}).`
        : `Unknown ref${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}. Use only the refs you were given: ${[...shown].join(', ')}.`,
    );
  return problems;
}

/**
 * The stored plan, from an ACCEPTED submission: text clipped, bullets capped at the limit, unknown
 * refs dropped, the first `notAddressed` per ref kept, and `notCovered` = shown refs the plan neither
 * covers nor declines. Never throws.
 */
export function normalizePlan(
  raw: RawPlanSubmission,
  shownRefs: readonly string[],
  revision: number,
): AiFixPlan {
  const shown = new Set(shownRefs);
  const summary = strings(raw.summary)
    .map(bullet)
    .filter((b) => b !== '')
    .slice(0, AI_FIX_PLAN_MAX_BULLETS)
    .map((b) => clip(b, AI_FIX_PLAN_BULLET_MAX_CHARS));
  const steps: AiFixPlanStep[] = [];
  for (const s of (Array.isArray(raw.steps) ? raw.steps : []).slice(0, MAX_STEPS)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { title?: unknown; files?: unknown; change?: unknown; refs?: unknown };
    const change = typeof o.change === 'string' ? clip(o.change, PLAN_STEP_CHANGE_MAX) : '';
    const title = typeof o.title === 'string' ? clip(o.title, PLAN_STEP_TITLE_MAX) : '';
    if (change === '' && title === '') continue;
    const refs = [...new Set(strings(o.refs).map((r) => r.trim()).filter((r) => shown.has(r)))];
    const files = [
      ...new Set(
        strings(o.files)
          .map((f) => f.trim().replace(/^\.\//, '').replace(/^\/+/, ''))
          .filter((f) => f !== ''),
      ),
    ].slice(0, MAX_FILES_PER_STEP);
    steps.push({ title: title || clip(change, 80), files, change, refs });
  }
  const notAddressed: AiFixPlan['notAddressed'] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(raw.notAddressed) ? raw.notAddressed : []) {
    if (!d || typeof d !== 'object') continue;
    const o = d as { ref?: unknown; reason?: unknown };
    if (typeof o.ref !== 'string' || typeof o.reason !== 'string') continue;
    const ref = o.ref.trim();
    if (!shown.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    notAddressed.push({ ref, reason: clip(o.reason, PLAN_REASON_MAX) });
  }
  const covered = new Set(steps.flatMap((s) => s.refs));
  const notCovered = shownRefs.filter((r) => !covered.has(r) && !seen.has(r));
  return { revision, summary, steps, notAddressed, notCovered };
}

/** The pass's one-line answer to the reader's latest message, clipped; null when it gave none. */
export function planReply(raw: RawPlanSubmission): string | null {
  return typeof raw.reply === 'string' && raw.reply.trim() !== '' ? clip(raw.reply, PLAN_REPLY_MAX) : null;
}

/** The refs a review run SHOWED the agent (its included items); [] for a plain run. */
export function shownRefsOf(items: readonly AiFixReviewItem[] | null): string[] {
  return (items ?? []).filter((i) => i.included).map((i) => i.ref);
}

// ---- the stored columns, parsed DEFENSIVELY (they load the whole AI Fix tab) ----

function parseJson(json: string | null | undefined): unknown {
  if (json == null || json === '') return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

const PLAN_STATUSES: ReadonlySet<string> = new Set<AiFixPlanStatus>([
  'planning',
  'plan_ready',
  'approved',
  'discarded',
  'failed',
]);

export function parsePlanStatus(v: string | null | undefined): AiFixPlanStatus | null {
  return v != null && PLAN_STATUSES.has(v) ? (v as AiFixPlanStatus) : null;
}

export function parsePlan(json: string | null | undefined): AiFixPlan | null {
  const v = parseJson(json);
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Partial<AiFixPlan>;
  return {
    revision: typeof o.revision === 'number' ? o.revision : 1,
    summary: Array.isArray(o.summary) ? o.summary.filter((x) => typeof x === 'string') : [],
    steps: Array.isArray(o.steps) ? o.steps : [],
    notAddressed: Array.isArray(o.notAddressed) ? o.notAddressed : [],
    notCovered: Array.isArray(o.notCovered) ? o.notCovered : [],
  };
}

export function parseTranscript(json: string | null | undefined): AiFixPlanMessage[] {
  const v = parseJson(json);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (m): m is AiFixPlanMessage =>
      m != null &&
      typeof m === 'object' &&
      ((m as AiFixPlanMessage).role === 'reader' || (m as AiFixPlanMessage).role === 'claude') &&
      typeof (m as AiFixPlanMessage).text === 'string',
  );
}

export function parsePlanSeed(json: string | null | undefined): FixSeed | null {
  const v = parseJson(json);
  if (v == null || typeof v !== 'object') return null;
  const o = v as Partial<FixSeed>;
  if ((o.kind !== 'review' && o.kind !== 'plain') || typeof o.text !== 'string') return null;
  return { kind: o.kind, text: o.text };
}

/** The wire shape, from the row's plan columns. null when the run never planned. */
export function planStateOf(row: {
  planStatus?: string | null;
  planRevision?: number | null;
  plan?: string | null;
  planTranscript?: string | null;
  planCostUsd?: number | null;
}): AiFixPlanState | null {
  const status = parsePlanStatus(row.planStatus);
  if (status == null) return null;
  return {
    status,
    revision: row.planRevision ?? 0,
    plan: parsePlan(row.plan),
    transcript: parseTranscript(row.planTranscript),
    costUsd: row.planCostUsd ?? null,
  };
}
