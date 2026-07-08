import { describe, expect, it } from 'vitest';
import {
  AI_CREDITS_PER_USD,
  DEFAULT_AI_CREDIT_ALLOWANCE,
  computeAiCreditStatus,
  monthStartMs,
} from './credits.js';

// The credit rate is the load-bearing budget number: 2,500 credits ≈ $2.00 of Haiku spend.
describe('credit rate', () => {
  it('is $1 = 1250 credits so the 2,500 allowance ≈ $2.00 COGS', () => {
    expect(AI_CREDITS_PER_USD).toBe(1250);
    expect(DEFAULT_AI_CREDIT_ALLOWANCE / AI_CREDITS_PER_USD).toBeCloseTo(2.0, 5);
  });
});

const paid = { isLocal: false, plan: 'pro' as const, aiCreditAllowance: null };
const free = { isLocal: false, plan: 'free' as const, aiCreditAllowance: null };
const local = { isLocal: true, plan: 'free' as const, aiCreditAllowance: null };

describe('computeAiCreditStatus', () => {
  it('a $2.00 ledger month spends the whole 2,500 allowance → blocked', () => {
    const s = computeAiCreditStatus(paid, { summaryUsd: 2.0, agentUsd: 0 });
    expect(s.usedCredits).toBe(2500);
    expect(s.allowanceCredits).toBe(2500);
    expect(s.remainingCredits).toBe(0);
    expect(s.blocked).toBe(true);
  });

  it('a $1.60 month leaves 500 credits and is not blocked', () => {
    const s = computeAiCreditStatus(paid, { summaryUsd: 1.6, agentUsd: 0 });
    expect(s.usedCredits).toBe(2000);
    expect(s.remainingCredits).toBe(500);
    expect(s.blocked).toBe(false);
  });

  it('a typical digest (~$0.007) costs ≈ 9 credits', () => {
    const s = computeAiCreditStatus(paid, { summaryUsd: 0.007, agentUsd: 0 });
    expect(s.usedCredits).toBe(9); // round(0.007 * 1250) = round(8.75) = 9
  });

  it('sums the two seams rounded independently (matches the ai-usage meter)', () => {
    // round(0.0034*1250)=round(4.25)=4 ; round(0.0026*1250)=round(3.25)=3 → 7 (not round(7.5)=8)
    const s = computeAiCreditStatus(paid, { summaryUsd: 0.0034, agentUsd: 0.0026 });
    expect(s.usedCredits).toBe(7);
  });

  it('honors a per-account allowance override', () => {
    const s = computeAiCreditStatus(
      { isLocal: false, plan: 'pro', aiCreditAllowance: 5000 },
      { summaryUsd: 3.2, agentUsd: 0 },
    );
    expect(s.allowanceCredits).toBe(5000);
    expect(s.usedCredits).toBe(4000);
    expect(s.remainingCredits).toBe(1000);
    expect(s.blocked).toBe(false);
  });

  it('a free cloud account has a zero allowance → always blocked', () => {
    const s = computeAiCreditStatus(free, { summaryUsd: 0, agentUsd: 0 });
    expect(s.allowanceCredits).toBe(0);
    expect(s.remainingCredits).toBe(0);
    expect(s.blocked).toBe(true);
  });

  it('a local account is unmetered — null allowance, never blocked, regardless of spend', () => {
    const s = computeAiCreditStatus(local, { summaryUsd: 999, agentUsd: 999 });
    expect(s.allowanceCredits).toBeNull();
    expect(s.remainingCredits).toBeNull();
    expect(s.blocked).toBe(false);
  });
});

describe('monthStartMs', () => {
  it('is the UTC first-of-month for the given instant', () => {
    const mid = Date.UTC(2026, 6, 8, 13, 45, 0); // 2026-07-08T13:45Z
    expect(monthStartMs(mid)).toBe(Date.UTC(2026, 6, 1));
  });
});
