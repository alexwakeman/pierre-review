import type { Account } from '../auth/account.js';
import { getAiUsageSummary } from './usage.js';

// USD → credits conversion, MIRRORED from @pierre-review/shared AI_CREDITS_PER_USD. Inlined
// here (not imported) because the release guard forbids a real runtime import of the
// types-only shared package into release/dist — the same reason the pro plugin inlines its
// own copy. Keep all three in lockstep (shared + this + packages/pro/src/insights/routes.ts).
// $1 of model cost = 1250 credits, so the paid plan's 2,500-credit allowance ≈ $2.00 of spend.
export const AI_CREDITS_PER_USD = 1250;

// The default monthly SUMMARY-AI credit allowance for a paid cloud account. Overridable per
// account via accounts.aiCreditAllowance (a forward hook for top-ups / alternate plans).
export const DEFAULT_AI_CREDIT_ALLOWANCE = 2500;

const toCredits = (usd: number): number => Math.round(usd * AI_CREDITS_PER_USD);

export interface AiCreditStatus {
  // null = unmetered (local mode / an unlimited account) → no cap, no bar in the UI.
  allowanceCredits: number | null;
  // Month-to-date credits spent across BOTH seams (summary + agent). Computed as the SUM of
  // each seam rounded independently, so it reconciles exactly with the /api/pro/ai-usage
  // meter's summaryCredits + agentCredits (which round per-seam too) — the gate and the
  // displayed "used" figure never disagree.
  usedCredits: number;
  // max(0, allowance − used); null when unmetered.
  remainingCredits: number | null;
  // allowance is finite AND spent → block further generation.
  blocked: boolean;
}

// UTC first-of-month epoch ms — the month-to-date window start (matches the /api/pro/ai-usage
// route). Monthly reset is automatic: the window rolls at the UTC month boundary.
export function monthStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// The account's allowance in credits, or null when unmetered.
// - local (isLocal): unmetered — null (never blocked; today's behavior).
// - paid cloud (plan !== 'free'): the per-account override, else the plan default (2,500).
// - free cloud: a zero allowance (belt-and-braces — the /api/pro/* 402 gate already blocks
//   these accounts before any Pro route runs).
function allowanceFor(
  account: Pick<Account, 'isLocal' | 'plan' | 'aiCreditAllowance'>,
): number | null {
  if (account.isLocal) return null;
  if (account.plan !== 'free') return account.aiCreditAllowance ?? DEFAULT_AI_CREDIT_ALLOWANCE;
  return 0;
}

// The PURE credit-ledger computation (no I/O) — month-to-date spend vs. the allowance. Split
// out from aiCreditStatus so the budget math is unit-testable without a DB. usedCredits sums
// each seam rounded independently, matching the /api/pro/ai-usage meter exactly.
export function computeAiCreditStatus(
  account: Pick<Account, 'isLocal' | 'plan' | 'aiCreditAllowance'>,
  usage: { summaryUsd: number; agentUsd: number },
): AiCreditStatus {
  const allowanceCredits = allowanceFor(account);
  const usedCredits = toCredits(usage.summaryUsd) + toCredits(usage.agentUsd);
  const remainingCredits =
    allowanceCredits == null ? null : Math.max(0, allowanceCredits - usedCredits);
  const blocked = remainingCredits != null && remainingCredits <= 0;
  return { allowanceCredits, usedCredits, remainingCredits, blocked };
}

// The per-account credit-ledger status: reads the month-to-date ledger and applies the pure
// computation above. This is what ctx.aiCredits.check calls per generation.
export async function aiCreditStatus(
  account: Pick<Account, 'id' | 'isLocal' | 'plan' | 'aiCreditAllowance'>,
  nowMs: number,
): Promise<AiCreditStatus> {
  const usage = await getAiUsageSummary(account.id, monthStartMs(nowMs));
  return computeAiCreditStatus(account, usage);
}
