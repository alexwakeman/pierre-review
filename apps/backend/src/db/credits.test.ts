import { describe, expect, it } from 'vitest';
import {
  AI_CREDITS_PER_USD,
  DEFAULT_AGENT_CREDIT_ALLOWANCE,
  DEFAULT_SUMMARY_TURN_LIMIT,
  computeAiCreditStatus,
  monthStartMs,
} from './credits.js';

// The two load-bearing budget numbers: 500 summary turns/mo + a $15 (18,750 cr) agent allowance.
describe('metering constants', () => {
  it('summary is a flat 500-turn monthly budget', () => {
    expect(DEFAULT_SUMMARY_TURN_LIMIT).toBe(500);
  });
  it('agent allowance is $15 at 1250 cr/USD = 18,750 cr', () => {
    expect(AI_CREDITS_PER_USD).toBe(1250);
    expect(DEFAULT_AGENT_CREDIT_ALLOWANCE).toBe(18750);
    expect(DEFAULT_AGENT_CREDIT_ALLOWANCE / AI_CREDITS_PER_USD).toBeCloseTo(15.0, 5);
  });
});

const paid = { isLocal: false, plan: 'pro' as const, aiCreditAllowance: null };
const free = { isLocal: false, plan: 'free' as const, aiCreditAllowance: null };
const local = { isLocal: true, plan: 'free' as const, aiCreditAllowance: null };

describe('computeAiCreditStatus — SUMMARY seam (turns)', () => {
  it('counts turns toward the 500 limit; not blocked below it', () => {
    const s = computeAiCreditStatus(paid, { summaryTurns: 120, agentUsd: 0 });
    expect(s.summaryTurnLimit).toBe(500);
    expect(s.summaryTurnsUsed).toBe(120);
    expect(s.summaryTurnsRemaining).toBe(380);
    expect(s.summaryBlocked).toBe(false);
    expect(s.blocked).toBe(false); // alias === summaryBlocked
  });

  it('blocks summaries at the limit; `blocked` aliases summaryBlocked', () => {
    const s = computeAiCreditStatus(paid, { summaryTurns: 500, agentUsd: 0 });
    expect(s.summaryTurnsRemaining).toBe(0);
    expect(s.summaryBlocked).toBe(true);
    expect(s.blocked).toBe(true);
  });

  it('a free cloud account has a zero turn limit → summaries always blocked', () => {
    const s = computeAiCreditStatus(free, { summaryTurns: 0, agentUsd: 0 });
    expect(s.summaryTurnLimit).toBe(0);
    expect(s.summaryTurnsRemaining).toBe(0);
    expect(s.summaryBlocked).toBe(true);
  });

  it('a local account is unmetered for summaries — null limit, never blocked', () => {
    const s = computeAiCreditStatus(local, { summaryTurns: 9999, agentUsd: 0 });
    expect(s.summaryTurnLimit).toBeNull();
    expect(s.summaryTurnsRemaining).toBeNull();
    expect(s.summaryBlocked).toBe(false);
    expect(s.blocked).toBe(false);
  });
});

describe('computeAiCreditStatus — AGENT seam (credits)', () => {
  it('spends toward the $15 (18,750 cr) allowance; not blocked below it', () => {
    // $10 of agent spend = 12,500 cr, leaving 6,250.
    const s = computeAiCreditStatus(paid, { summaryTurns: 0, agentUsd: 10 });
    expect(s.agentAllowanceCredits).toBe(18750);
    expect(s.agentCreditsUsed).toBe(12500);
    expect(s.agentCreditsRemaining).toBe(6250);
    expect(s.agentBlocked).toBe(false);
  });

  it('blocks agent runs once the $15 allowance is spent', () => {
    const s = computeAiCreditStatus(paid, { summaryTurns: 0, agentUsd: 15 });
    expect(s.agentCreditsUsed).toBe(18750);
    expect(s.agentCreditsRemaining).toBe(0);
    expect(s.agentBlocked).toBe(true);
    // Exhausting the AGENT budget must NOT block summaries.
    expect(s.summaryBlocked).toBe(false);
    expect(s.blocked).toBe(false);
  });

  it('honors a per-account agent allowance override', () => {
    const s = computeAiCreditStatus(
      { isLocal: false, plan: 'pro', aiCreditAllowance: 5000 },
      { summaryTurns: 0, agentUsd: 3.2 },
    );
    expect(s.agentAllowanceCredits).toBe(5000);
    expect(s.agentCreditsUsed).toBe(4000);
    expect(s.agentCreditsRemaining).toBe(1000);
    expect(s.agentBlocked).toBe(false);
  });

  it('a local account is unmetered for agent spend too', () => {
    const s = computeAiCreditStatus(local, { summaryTurns: 0, agentUsd: 999 });
    expect(s.agentAllowanceCredits).toBeNull();
    expect(s.agentCreditsRemaining).toBeNull();
    expect(s.agentBlocked).toBe(false);
  });
});

describe('monthStartMs', () => {
  it('is the UTC first-of-month for the given instant', () => {
    const mid = Date.UTC(2026, 6, 8, 13, 45, 0); // 2026-07-08T13:45Z
    expect(monthStartMs(mid)).toBe(Date.UTC(2026, 6, 1));
  });
});
