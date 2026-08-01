// Bot cost: the decisions that compile either way.
//
// Every assertion here pins a rule whose WRONG version type-checks, ships, and is only visible as
// a price that quietly changed:
//   • empty box vs "0"       — `Number('')` is 0, so a missing empty-check turns "clear" into "free"
//   • 0 vs null              — truthiness collapses "we pay nothing" and "nobody said" into one
//   • a null the server MEANT — a deprecated blob refilling a price the user deliberately cleared
//   • int4 cents             — a price pg 500s on but sqlite stores happily
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotVendorAnalytics } from '@pierre-review/shared';
import {
  buildCostBody,
  costEditOutcome,
  costStateOf,
  formatCostInput,
  MAX_COST_USD,
  parseCostInput,
  resolveVendorCost,
} from '../src/lib/botCost.js';

describe('costStateOf — two states, and nothing behind either', () => {
  it('no price is "none"', () => {
    expect(costStateOf({ costMonthlyUsd: null })).toBe('none');
  });

  it('a price is "set"', () => {
    expect(costStateOf({ costMonthlyUsd: 120 })).toBe('set');
  });

  // The trap: 0 is a real price ("we pay nothing for this"), not an absence. A truthiness test
  // here would report 'none' and the input would render as an empty box the user has to re-type.
  it('ZERO is a price, not an absence', () => {
    expect(costStateOf({ costMonthlyUsd: 0 })).toBe('set');
  });
});

describe('parseCostInput — the empty box is the CLEAR gesture', () => {
  it('empty parses to null, never to 0', () => {
    expect(parseCostInput('')).toEqual({ ok: true, value: null });
    expect(parseCostInput('   ')).toEqual({ ok: true, value: null });
  });

  it('"0" parses to 0 — a real price, distinct from empty', () => {
    expect(parseCostInput('0')).toEqual({ ok: true, value: 0 });
  });

  it('rounds to the cent (the storage granularity)', () => {
    expect(parseCostInput('12.345')).toEqual({ ok: true, value: 12.35 });
    expect(parseCostInput('120')).toEqual({ ok: true, value: 120 });
    expect(parseCostInput(' 45.50 ')).toEqual({ ok: true, value: 45.5 });
  });

  it('rejects non-numeric, negative and non-finite input', () => {
    expect(parseCostInput('abc').ok).toBe(false);
    expect(parseCostInput('-1').ok).toBe(false);
    expect(parseCostInput('Infinity').ok).toBe(false);
    expect(parseCostInput('NaN').ok).toBe(false);
  });

  // The ceiling is where the two dialects stop agreeing: pg RAISES `integer out of range` on an
  // int4 cents overflow while sqlite stores it, so an unbounded field means the same request
  // succeeds locally and 500s in cloud.
  it('accepts the int4-cents ceiling and rejects above it', () => {
    expect(parseCostInput(String(MAX_COST_USD))).toEqual({ ok: true, value: MAX_COST_USD });
    expect(parseCostInput('21474836.48').ok).toBe(false);
    expect(parseCostInput('99999999999').ok).toBe(false);
  });
});

describe('formatCostInput', () => {
  it('null is an empty box, never "0"', () => {
    expect(formatCostInput(null)).toBe('');
  });

  it('0 prints as "0" — the user set a price of zero and must see it', () => {
    expect(formatCostInput(0)).toBe('0');
  });

  it('integers print bare, fractions to the cent', () => {
    expect(formatCostInput(120)).toBe('120');
    expect(formatCostInput(12.5)).toBe('12.50');
  });
});

describe('costEditOutcome — which gestures actually send a request', () => {
  it('a new price sets', () => {
    expect(costEditOutcome(null, 120)).toEqual({ kind: 'set', dirty: true });
  });

  it('a different price sets', () => {
    expect(costEditOutcome(120, 90)).toEqual({ kind: 'set', dirty: true });
  });

  it('the same price is unchanged and sends nothing', () => {
    expect(costEditOutcome(120, 120)).toEqual({ kind: 'unchanged', dirty: false });
  });

  it('emptying a priced bot CLEARS', () => {
    expect(costEditOutcome(120, null)).toEqual({ kind: 'clear', dirty: true });
  });

  // Both directions of the 0/null boundary, because truthiness collapses them and the collapse is
  // silent: "free" would become un-clearable, and "no price" un-settable-to-free.
  it('emptying a bot recorded as FREE is a real clear, not a no-op', () => {
    expect(costEditOutcome(0, null)).toEqual({ kind: 'clear', dirty: true });
  });

  it('typing 0 on an unpriced bot is a real set, not a no-op', () => {
    expect(costEditOutcome(null, 0)).toEqual({ kind: 'set', dirty: true });
  });

  it('emptying an unpriced bot sends nothing, and says which no-op it is', () => {
    expect(costEditOutcome(null, null)).toEqual({ kind: 'no-cost', dirty: false });
  });
});

describe('buildCostBody', () => {
  // `monthlyUsd` must always be PRESENT: the contract makes it required precisely so `undefined`
  // is not a third meaning. Spreading it conditionally would turn Clear into a silent no-op.
  it('always carries monthlyUsd, including when clearing', () => {
    expect(buildCostBody(null)).toEqual({ monthlyUsd: null });
    expect('monthlyUsd' in buildCostBody(null)).toBe(true);
    expect(buildCostBody(0)).toEqual({ monthlyUsd: 0 });
    expect(buildCostBody(120)).toEqual({ monthlyUsd: 120 });
  });

  // The body is actor-keyed. A repoId here would be the "$720 for one $120 subscription" bug
  // reintroduced from the write side.
  it('carries no repoId', () => {
    expect(Object.keys(buildCostBody(120))).toEqual(['monthlyUsd']);
  });
});

function vendorRow(over: Partial<BotVendorAnalytics>): Pick<
  BotVendorAnalytics,
  'login' | 'actedOn' | 'costMonthlyUsd' | 'costPerActedOnUsd'
> {
  return {
    login: 'coderabbitai',
    actedOn: 10,
    costMonthlyUsd: null,
    costPerActedOnUsd: null,
    ...over,
  };
}

describe('resolveVendorCost — the server’s answer is FINAL', () => {
  it('passes a server price straight through', () => {
    const r = resolveVendorCost(
      vendorRow({ costMonthlyUsd: 120, costPerActedOnUsd: 12 }),
      new Map([['coderabbitai', 500]]),
    );
    expect(r.costMonthlyUsd).toBe(120);
    expect(r.costPerActedOnUsd).toBe(12);
    // The legacy blob must not even be consulted when the server has an answer.
    expect(r.legacyOnlyUsd).toBeNull();
  });

  // The regression this function exists for: a DELIBERATELY CLEARED price is also null, and the
  // old code refilled it from a blob nothing can write or delete any more — so clearing a
  // legacy-costed bot showed the old price straight back, permanently.
  it('does NOT apply a legacy blob price to a null — it only POINTS at it', () => {
    const r = resolveVendorCost(vendorRow({}), new Map([['coderabbitai', 500]]));
    expect(r.costMonthlyUsd).toBeNull();
    expect(r.costPerActedOnUsd).toBeNull();
    expect(r.legacyOnlyUsd).toBe(500);
  });

  it('a server price of ZERO is a price and beats any legacy value', () => {
    const r = resolveVendorCost(
      vendorRow({ costMonthlyUsd: 0, costPerActedOnUsd: 0 }),
      new Map([['coderabbitai', 500]]),
    );
    expect(r.costMonthlyUsd).toBe(0);
    expect(r.legacyOnlyUsd).toBeNull();
  });

  it('a null login can never match a blob entry', () => {
    const r = resolveVendorCost(vendorRow({ login: null }), new Map([['coderabbitai', 500]]));
    expect(r.legacyOnlyUsd).toBeNull();
  });
});
