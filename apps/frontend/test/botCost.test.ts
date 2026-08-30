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
  perSeatMonthlyUsd,
  resolveVendorCost,
} from '../src/lib/botCost.js';

describe('costStateOf — two states, and nothing behind either', () => {
  it('no price is "none"', () => {
    expect(costStateOf({ costMonthlyUsd: null })).toBe('none');
  });

  // ⚠ THE NULL IS NOW THREE-VALUED ON THE WIRE, AND THIS FUNCTION CANNOT SPLIT IT — pinned so the
  // ambiguity is a documented property rather than something a later reader discovers. Since the
  // ROI panel went paid, every route echoing a `WorkspaceReviewer` STRIPS the price for an account
  // without `botDepth`, deliberately into the never-priced SHAPE (null + `costModel:'flat'`), so a
  // withheld $240 seat and a bot nobody priced are byte-identical here. The entitlement answer
  // comes from `/api/me`; a caller that renders 'none' without checking it is claiming "no price
  // set" about a bot that has one.
  it('a WITHHELD price is indistinguishable from an unset one — read /api/me, not the value', () => {
    const unpriced = { costMonthlyUsd: null, costModel: 'flat' as const };
    const strippedByTheServer = { costMonthlyUsd: null, costModel: 'flat' as const };
    expect(costStateOf(unpriced)).toBe('none');
    expect(costStateOf(strippedByTheServer)).toBe('none');
    expect(costStateOf(strippedByTheServer)).toBe(costStateOf(unpriced));
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

  // ── The pricing MODE is part of what "unchanged" compares ─────────────────────────────────
  // $29 flat and $29/seat are different monthly figures the moment the workspace has ≠1 seats, so
  // a mode flip with an untouched number must be a REAL save — a number-only comparison leaves
  // the toggle looking saved while the server still meters the old way.
  it('a MODE change with an unchanged number is a real save', () => {
    expect(costEditOutcome(29, 29, 'flat', 'per_seat')).toEqual({ kind: 'set', dirty: true });
    expect(costEditOutcome(29, 29, 'per_seat', 'flat')).toEqual({ kind: 'set', dirty: true });
  });

  it('same number AND same mode is unchanged', () => {
    expect(costEditOutcome(29, 29, 'per_seat', 'per_seat')).toEqual({
      kind: 'unchanged',
      dirty: false,
    });
  });

  // The models default to 'flat' so every pre-existing two-argument call keeps its meaning.
  it('omitted models mean flat/flat — the two-argument form is unchanged', () => {
    expect(costEditOutcome(120, 120)).toEqual({ kind: 'unchanged', dirty: false });
  });

  // A clear resets the stored model to 'flat' server-side in the same UPDATE, so the modes play
  // no part in whether the clear sends.
  it('a CLEAR is a clear regardless of the modes', () => {
    expect(costEditOutcome(29, null, 'per_seat', 'per_seat')).toEqual({
      kind: 'clear',
      dirty: true,
    });
    expect(costEditOutcome(null, null, 'flat', 'per_seat')).toEqual({
      kind: 'no-cost',
      dirty: false,
    });
  });
});

describe('buildCostBody', () => {
  // `monthlyUsd` must always be PRESENT: the contract makes it required precisely so `undefined`
  // is not a third meaning. Spreading it conditionally would turn Clear into a silent no-op.
  it('always carries monthlyUsd, including when clearing', () => {
    expect(buildCostBody(3, null)).toEqual({ workspaceId: 3, monthlyUsd: null });
    expect('monthlyUsd' in buildCostBody(3, null)).toBe(true);
    expect(buildCostBody(3, 0)).toEqual({ workspaceId: 3, monthlyUsd: 0 });
    expect(buildCostBody(3, 120)).toEqual({ workspaceId: 3, monthlyUsd: 120 });
  });

  // ⚠ THE WORKSPACE IS PART OF THE ROW'S KEY, not a filter over it. A price names exactly one
  // `workspace_reviewers` row (predicate `(account_id, workspace_id, author_user_id)`), so a body
  // without it has no row to land on — and the SAME actor's price in another workspace is a
  // different, legitimately different, number that this write must not reach.
  it('names the workspace the price belongs to', () => {
    expect(buildCostBody(3, 120).workspaceId).toBe(3);
    expect(buildCostBody(4, 120).workspaceId).toBe(4);
  });

  // The body addresses one row. A repoId here would be the "$720 for one $120 subscription" bug
  // reintroduced from the write side: every repo in the workspace is priced by this single row.
  it('carries a workspaceId and a price, and nothing else — no repoId', () => {
    expect(Object.keys(buildCostBody(3, 120)).sort()).toEqual(['monthlyUsd', 'workspaceId']);
  });

  // The pricing mode rides the COST body (it changes what the number means — money the same way
  // the number is), and only when a number is being set.
  it('carries costModel when setting with a mode', () => {
    expect(buildCostBody(3, 29, 'per_seat')).toEqual({
      workspaceId: 3,
      monthlyUsd: 29,
      costModel: 'per_seat',
    });
    expect(buildCostBody(3, 0, 'per_seat')).toEqual({
      workspaceId: 3,
      monthlyUsd: 0,
      costModel: 'per_seat',
    });
  });

  // A CLEAR carries no model: the server resets the stored one to 'flat' inside the same UPDATE,
  // and a model on a null price would imply a cleared price still has a reading rule.
  it('a CLEAR omits costModel even when one is passed', () => {
    expect(buildCostBody(3, null, 'per_seat')).toEqual({ workspaceId: 3, monthlyUsd: null });
    expect(Object.keys(buildCostBody(3, null, 'per_seat')).sort()).toEqual([
      'monthlyUsd',
      'workspaceId',
    ]);
  });
});

describe('perSeatMonthlyUsd — the preview mirrors the server’s read-time arithmetic', () => {
  it('multiplies and re-rounds to the cent (binary64 × integer picks up error)', () => {
    expect(perSeatMonthlyUsd(29.99, 7)).toBe(209.93);
    expect(perSeatMonthlyUsd(0.1, 3)).toBe(0.3);
  });

  it('zero seats and zero unit are honest zeros, not blanks', () => {
    expect(perSeatMonthlyUsd(29, 0)).toBe(0);
    expect(perSeatMonthlyUsd(0, 12)).toBe(0);
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
