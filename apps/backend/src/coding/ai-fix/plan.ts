import {
  aiRunProvider,
  type AiFixPlan,
  type AiFixPlanMessage,
  type AiFixPlanState,
  type AiFixPlanStatus,
} from '@pierre-review/shared';

// THE REMOVED PLAN MODE's stored columns, READ for history only (docs/CLAUDE-REVIEW.md § AI Fix). The
// shell-less planning pass is gone: "Plan first" is now a chat-mode workspace session
// (sandbox/session/fix.ts), and nothing writes these columns any more. Old rows still render their plan.

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

/** The wire shape, from the row's plan columns. null when the run never planned. */
export function planStateOf(row: {
  planStatus?: string | null;
  planRevision?: number | null;
  plan?: string | null;
  planTranscript?: string | null;
  planCostUsd?: number | null;
  planModel?: string | null;
  planProvider?: string | null;
  planEffort?: string | null;
}): AiFixPlanState | null {
  const status = parsePlanStatus(row.planStatus);
  if (status == null) return null;
  return {
    status,
    revision: row.planRevision ?? 0,
    plan: parsePlan(row.plan),
    transcript: parseTranscript(row.planTranscript),
    costUsd: row.planCostUsd ?? null,
    // What the latest planning pass ran on (0128); absent before the first pass and on older rows.
    ...(row.planModel ? { model: row.planModel, provider: aiRunProvider(row.planProvider, row.planModel) } : {}),
    // The effort that pass used (0130); absent on older rows.
    ...(row.planEffort ? { effort: row.planEffort } : {}),
  };
}
