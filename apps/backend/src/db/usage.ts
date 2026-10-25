import { and, eq, gte } from 'drizzle-orm';
import { db, schema } from './client.js';

const { aiUsage } = schema;

// The two seams that spend money on AI. 'summary' = cheap one-shot LLM completions
// (digests, sprint report, PR summary, CI analysis); 'agent' = Agent-SDK runs (Claude
// Review, AI Fix). Surfaced to the user split this way (see AiUsageResponse).
export type AiUsageSeam = 'summary' | 'agent';

// One billable AI operation to append to the ledger. `costUsd` is the authoritative
// dollar cost (SDK-reported where available, else priced from tokens); it is stored but
// NEVER surfaced to the client — only credits are (AI_CREDITS_PER_USD). A row with a
// non-finite / negative cost is dropped, and so is a $0 one — EXCEPT a Codex row carrying tokens
// or a share (a ChatGPT-plan run has no price; see recordAiUsage).
export interface AiUsageRecord {
  accountId: number;
  seam: AiUsageSeam;
  feature: string; // digest | sprint_report | ai_analysis | ci_analysis | claude_review | ai_fix
  model: string;
  costUsd: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  prId?: number | null;
  repoId?: number | null;
  /** Which AI provider spent it (ai/provider.ts). Absent ⇒ 'claude', the only one in Phase 1. */
  provider?: 'claude' | 'codex';
  /** A subscription run's rise in its provider's weekly window, in percent, when reported. */
  sharePct?: number | null;
}

// Append one usage row. Best-effort + non-fatal: a ledger write must never break the
// feature that spent the money, so callers `.catch()` or await-in-try. Drops rows with
// no real cost (a $0 ambient-session completion isn't worth a row).
export async function recordAiUsage(row: AiUsageRecord): Promise<void> {
  if (!Number.isFinite(row.costUsd) || row.costUsd < 0) return;
  // ⚠ A CODEX run on a ChatGPT sign-in has NO price — it is recorded at US$0 WITH ITS TOKENS, because
  // those tokens are the numerator of the Codex budget's token-weighted share (packages/shared
  // ai-budget.ts). Dropping it would read every Codex window as 0% Limn. A $0 row with nothing in it
  // (and every $0 Claude row) is still not worth one.
  if (row.costUsd === 0) {
    const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    if ((row.provider ?? 'claude') === 'claude' || (tokens <= 0 && row.sharePct == null)) return;
  }
  await db
    .insert(aiUsage)
    .values({
      accountId: row.accountId,
      seam: row.seam,
      feature: row.feature,
      model: row.model,
      costUsd: row.costUsd,
      inputTokens: row.inputTokens ?? null,
      outputTokens: row.outputTokens ?? null,
      prId: row.prId ?? null,
      repoId: row.repoId ?? null,
      provider: row.provider ?? 'claude',
      sharePct: row.sharePct ?? null,
      occurredAt: new Date(),
    })
    .execute();
}

export interface AiUsageSummary {
  summaryUsd: number;
  agentUsd: number;
  totalUsd: number;
}

// Sum recorded AI spend for an account since `sinceMs`, split by seam. Rows are small
// (per account, per month) so we fetch + reduce in JS — portable across both dialects.
export async function getAiUsageSummary(
  accountId: number,
  sinceMs: number,
): Promise<AiUsageSummary> {
  const rows = await db
    .select({ seam: aiUsage.seam, costUsd: aiUsage.costUsd })
    .from(aiUsage)
    .where(and(eq(aiUsage.accountId, accountId), gte(aiUsage.occurredAt, new Date(sinceMs))))
    .execute();
  let summaryUsd = 0;
  let agentUsd = 0;
  for (const r of rows) {
    if (r.seam === 'agent') agentUsd += r.costUsd;
    else summaryUsd += r.costUsd;
  }
  return { summaryUsd, agentUsd, totalUsd: summaryUsd + agentUsd };
}

// Auxiliary summary sub-calls that belong to a SINGLE user-initiated turn and must NOT count as
// their own turn — e.g. the insights-chat CHART is a second Haiku call rendering the SAME
// question, so one charted question is still one turn. Their $ cost stays on the ledger (COGS
// visibility); only the turn TALLY excludes them.
const NON_TURN_SUMMARY_FEATURES = new Set<string>(['sprint_chat_chart']);

// Count the SUMMARY-seam turns an account has spent since `sinceMs` (month-to-date). One
// recorded ledger row = one turn, EXCEPT auxiliary sub-calls (above); a $0 cache hit /
// ambient-session completion isn't recorded, so it's free and doesn't count (recordAiUsage
// drops non-positive-cost rows). A summary turn limit caps this. Portable across both dialects
// (fetch + reduce in JS; the row set is bounded by ~the monthly limit — same pattern as
// getAiUsageSummary).
export async function getSummaryTurnCount(accountId: number, sinceMs: number): Promise<number> {
  const rows = await db
    .select({ feature: aiUsage.feature })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.accountId, accountId),
        eq(aiUsage.seam, 'summary'),
        gte(aiUsage.occurredAt, new Date(sinceMs)),
      ),
    )
    .execute();
  return rows.filter((r) => !NON_TURN_SUMMARY_FEATURES.has(r.feature)).length;
}
