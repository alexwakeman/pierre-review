// The period report's model tables (llm/seam.ts), and the ONE property that keeps them apart.
//
// There are TWO of them and they answer different questions:
//   · REPORT_MODEL_PRICING — every model we can PRICE, i.e. every model that has ever narrated a
//     stored `workspace_period_reports` row. It is how HISTORY stays readable.
//   · REPORT_MODELS        — what a REQUEST may select TODAY (body `model`,
//     `pro_settings.report_model`, `PRO_REPORT_MODEL`).
//
// They were ONE table until Sonnet was retired as a choice, and the gate was "is there a pricing
// row". Welded like that, retiring a model has no correct move: drop the pricing row and every
// stored Sonnet report loses its price and its label, keep it and Sonnet stays selectable. This
// file pins the split, because nothing else can — re-welding them type-checks perfectly and the
// only symptom is either a re-billed retired model or an unreadable old artifact.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/report-model-allowlist.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_MODEL,
  estimateReportCost,
  isReportModel,
  REPORT_MODELS,
  resolveReportModel,
} from '../llm/seam.js';

// The retired id, spelled out rather than imported: the point of these assertions is that this
// exact string behaves one way for SELECTION and another for PRICING. `as const` so it keeps the
// literal type — it must still satisfy `ReportModel` (the PRICEABLE union), and that it does is
// half the property under test: drop the pricing row and this line stops compiling.
const RETIRED = 'claude-sonnet-5' as const;

describe('REPORT_MODELS — the selection allowlist', () => {
  it('offers Haiku and nothing else', () => {
    expect(REPORT_MODELS).toEqual(['claude-haiku-5-5']);
  });

  it('has a default that is itself selectable', () => {
    // PRO_REPORT_MODEL is validated through the same gate, so a deployment cannot pin a model the
    // picker would refuse — the default and the allowlist can never disagree.
    expect(REPORT_MODELS).toContain(DEFAULT_REPORT_MODEL);
  });

  it('refuses the retired model, and every other untrusted string, WITHOUT throwing', () => {
    // The null (not throw) is load-bearing: `reportModelOf` runs on FREE GETs, so an account that
    // had pinned Sonnet would meet the retirement as a 500 on every report read.
    expect(resolveReportModel(RETIRED)).toBeNull();
    expect(isReportModel(RETIRED)).toBe(false);
    expect(resolveReportModel('claude-opus-4-8')).toBeNull();
    expect(resolveReportModel('')).toBeNull();
    expect(resolveReportModel(null)).toBeNull();
    expect(resolveReportModel(undefined)).toBeNull();
  });

  it('accepts a selectable id verbatim', () => {
    for (const model of REPORT_MODELS) {
      expect(resolveReportModel(model)).toBe(model);
    }
  });
});

describe('REPORT_MODEL_PRICING — the history table', () => {
  it('still prices the RETIRED model, so a stored report keeps its spend', () => {
    // 1M in × $3/1M + 1M out × $15/1M = $18. A retirement that took the row out would either
    // throw here or quote a stored Sonnet report at Haiku's rate — a wrong number on an artifact
    // someone already forwarded.
    const quote = estimateReportCost(RETIRED, 1_000_000, 1_000_000);
    expect(quote.model).toBe(RETIRED);
    expect(quote.estimatedUsd).toBeCloseTo(18, 9);
    expect(quote.estimatedCredits).toBe(18 * 1250);
  });

  it('still prices the previous Haiku at its own rate, and refuses it as a choice', () => {
    // 1M in × $1/1M + 1M out × $5/1M = $6.
    expect(estimateReportCost('claude-haiku-4-5', 1_000_000, 1_000_000).estimatedUsd).toBeCloseTo(6, 9);
    expect(resolveReportModel('claude-haiku-4-5')).toBeNull();
  });

  it('moves the current Haiku to its long-prompt rates above 100,000 input tokens, on both legs', () => {
    // ≤100k: $0.10 / $0.50 per 1M. 100k in + 10k out = 0.01 + 0.005.
    expect(estimateReportCost('claude-haiku-5-5', 100_000, 10_000).estimatedUsd).toBeCloseTo(0.015, 9);
    // >100k: $0.50 / $2.50 per 1M. 100,001 in + 10k out = 0.0500005 + 0.025 → 0.075 at 4dp.
    expect(estimateReportCost('claude-haiku-5-5', 100_001, 10_000).estimatedUsd).toBeCloseTo(0.075, 4);
  });

  it('prices every SELECTABLE model too — selection is a subset of pricing, never the reverse', () => {
    for (const model of REPORT_MODELS) {
      // A selectable model with no pricing row would reach the meter unpriceable; this is the
      // direction of the subset relation that must hold.
      expect(estimateReportCost(model, 1_000_000, 0).estimatedUsd).toBeGreaterThan(0);
    }
  });
});
