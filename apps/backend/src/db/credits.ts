import type { Account } from '../auth/account.js';
import { getAiUsageSummary, getSummaryTurnCount } from './usage.js';

// USD → credits conversion, MIRRORED from @pierre-review/shared AI_CREDITS_PER_USD. Inlined
// here (not imported) because the release guard forbids a real runtime import of the
// types-only shared package into release/dist — the same reason the pro plugin inlines its
// own copy. Keep all three in lockstep (shared + this + packages/pro/src/insights/routes.ts).
// $1 of model cost = 1250 credits (1 credit ≈ $0.0008).
export const AI_CREDITS_PER_USD = 1250;

// The two AI seams are metered DIFFERENTLY:
//  - SUMMARY (cheap one-shot Haiku completions — digests, sprint report, insights chat, PR
//    summary, CI analysis, themes, …) is metered by a monthly TURN COUNT. Each real (billed)
//    completion is one turn; a $0 cache hit / ambient-session call is free and doesn't count.
//  - AGENT (Agent-SDK runs — Claude Review, AI Fix) is metered by CREDITS ($ cost), because a
//    single agentic run's cost varies wildly and a flat turn count would be unfair.
// Defaults for a paid cloud account (both reset at the UTC month boundary):
export const DEFAULT_SUMMARY_TURN_LIMIT = 500; // ~$5/mo of Haiku at a blended ~$0.01/turn
export const DEFAULT_AGENT_CREDIT_ALLOWANCE = 15 * AI_CREDITS_PER_USD; // 18,750 cr = $15/mo

const toCredits = (usd: number): number => Math.round(usd * AI_CREDITS_PER_USD);

export interface AiCreditStatus {
  // SUMMARY seam — metered by monthly TURN COUNT. null limit = unmetered (local / unlimited).
  summaryTurnsUsed: number;
  summaryTurnLimit: number | null;
  summaryTurnsRemaining: number | null;
  summaryBlocked: boolean;
  // AGENT seam — metered by CREDITS ($ cost). null allowance = unmetered.
  agentCreditsUsed: number;
  agentAllowanceCredits: number | null;
  agentCreditsRemaining: number | null;
  agentBlocked: boolean;
  // Back-compat alias, === summaryBlocked. Every existing summary-feature gate reads `.blocked`;
  // a summary must block on the SUMMARY budget ONLY (agent exhaustion never blocks a summary, and
  // vice-versa), so the alias points at the summary flag. New agent gates use `.agentBlocked`.
  blocked: boolean;
}

// UTC first-of-month epoch ms — the month-to-date window start (matches the /api/pro/ai-usage
// route). Monthly reset is automatic: the window rolls at the UTC month boundary.
export function monthStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// The account's SUMMARY monthly turn limit, or null when unmetered.
// - local (isLocal): unmetered — null (never blocked; today's behavior).
// - paid cloud (plan !== 'free'): the plan default turn limit.
// - free cloud: a zero limit (belt-and-braces — the /api/pro/* 402 gate blocks these first).
function summaryTurnLimitFor(account: Pick<Account, 'isLocal' | 'plan'>): number | null {
  if (account.isLocal) return null;
  if (account.plan !== 'free') return DEFAULT_SUMMARY_TURN_LIMIT;
  return 0;
}

// The account's AGENT credit allowance, or null when unmetered. The per-account override
// column (accounts.aiCreditAllowance) now governs the AGENT budget (a forward hook for
// top-ups / alternate plans); summary is a flat turn count with no per-account override yet.
function agentAllowanceFor(
  account: Pick<Account, 'isLocal' | 'plan' | 'aiCreditAllowance'>,
): number | null {
  if (account.isLocal) return null;
  if (account.plan !== 'free') return account.aiCreditAllowance ?? DEFAULT_AGENT_CREDIT_ALLOWANCE;
  return 0;
}

// The PURE metering computation (no I/O) — month-to-date usage vs. the per-seam budgets. Split
// out from aiCreditStatus so the budget math is unit-testable without a DB.
export function computeAiCreditStatus(
  account: Pick<Account, 'isLocal' | 'plan' | 'aiCreditAllowance'>,
  usage: { summaryTurns: number; agentUsd: number },
): AiCreditStatus {
  const summaryTurnLimit = summaryTurnLimitFor(account);
  const summaryTurnsUsed = usage.summaryTurns;
  const summaryTurnsRemaining =
    summaryTurnLimit == null ? null : Math.max(0, summaryTurnLimit - summaryTurnsUsed);
  const summaryBlocked = summaryTurnsRemaining != null && summaryTurnsRemaining <= 0;

  const agentAllowanceCredits = agentAllowanceFor(account);
  const agentCreditsUsed = toCredits(usage.agentUsd);
  const agentCreditsRemaining =
    agentAllowanceCredits == null ? null : Math.max(0, agentAllowanceCredits - agentCreditsUsed);
  const agentBlocked = agentCreditsRemaining != null && agentCreditsRemaining <= 0;

  return {
    summaryTurnsUsed,
    summaryTurnLimit,
    summaryTurnsRemaining,
    summaryBlocked,
    agentCreditsUsed,
    agentAllowanceCredits,
    agentCreditsRemaining,
    agentBlocked,
    blocked: summaryBlocked,
  };
}

// The per-account metering status: reads the month-to-date ledger (summary turn count + agent
// $ spend) and applies the pure computation above. This is what ctx.aiCredits.check calls per
// generation, and what /api/me + /api/pro/ai-usage surface.
export async function aiCreditStatus(
  account: Pick<Account, 'id' | 'isLocal' | 'plan' | 'aiCreditAllowance'>,
  nowMs: number,
): Promise<AiCreditStatus> {
  const since = monthStartMs(nowMs);
  const [summaryTurns, usage] = await Promise.all([
    getSummaryTurnCount(account.id, since),
    getAiUsageSummary(account.id, since),
  ]);
  return computeAiCreditStatus(account, { summaryTurns, agentUsd: usage.agentUsd });
}
