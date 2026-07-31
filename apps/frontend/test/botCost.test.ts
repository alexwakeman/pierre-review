// Per-team bot cost: the decisions that compile either way.
//
// Every assertion here pins a rule whose WRONG version type-checks, ships, and is only visible as
// a price that quietly changed:
//   • `??` vs `||`          — a real 0 ("free on this team") falling through to an inherited $120
//   • `!== undefined` vs `!= null` — "clear it" (null) collapsing into "leave it alone" (absent)
//   • empty box vs "0"      — `Number('')` is 0, so a missing empty-check turns "inherit" into "free"
//   • `automated` present   — a COST edit stamping the row manual and freezing its classification
//   • a null the server MEANT — a deprecated blob refilling a price the user deliberately cleared
//   • a delete that takes more than its label says — "Reset to default" dropping a typed price
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotVendorAnalytics } from '@pierre-review/shared';
import {
  buildCostOnlyBody,
  costEditOutcome,
  costStateOf,
  emptyStateCopy,
  emptyStateFor,
  formatCostInput,
  parseCostInput,
  resetOverrideOffer,
  resolveVendorCost,
} from '../src/lib/botCost.js';

describe('costStateOf — three states the user must tell apart without clicking', () => {
  it('no price anywhere is "none"', () => {
    expect(costStateOf({ costMonthlyUsd: null, costInherited: false })).toBe('none');
  });

  it('a resolved price flagged inherited is "inherited"', () => {
    expect(costStateOf({ costMonthlyUsd: 120, costInherited: true })).toBe('inherited');
  });

  it('a resolved price on this team’s own row is "set"', () => {
    expect(costStateOf({ costMonthlyUsd: 120, costInherited: false })).toBe('set');
  });

  it('an explicit ZERO is "set", not "none" — free here is a real, inheritance-beating price', () => {
    // The `||` bug: `costMonthlyUsd || null` collapses 0 to null and the row renders as
    // "no cost", losing the one statement the user made about this team.
    expect(costStateOf({ costMonthlyUsd: 0, costInherited: false })).toBe('set');
  });

  it('an inherited ZERO still reads as inherited', () => {
    expect(costStateOf({ costMonthlyUsd: 0, costInherited: true })).toBe('inherited');
  });

  it('checks null BEFORE the inherited flag, so a bad flag cannot claim to inherit nothing', () => {
    expect(costStateOf({ costMonthlyUsd: null, costInherited: true })).toBe('none');
  });
});

describe('parseCostInput — empty means inherit, zero means free', () => {
  it('an empty box parses to null (clear → inherit again)', () => {
    expect(parseCostInput('')).toEqual({ ok: true, value: null });
  });

  it('whitespace only is still empty', () => {
    expect(parseCostInput('   ')).toEqual({ ok: true, value: null });
  });

  it('"0" is a real zero, NOT the empty/inherit case', () => {
    // Number('') === 0, so an implementation that coerces before checking for empty would make
    // clearing the box mean "this bot is free" — a silent, chargeable-looking lie.
    expect(parseCostInput('0')).toEqual({ ok: true, value: 0 });
  });

  it('accepts a whole-dollar subscription', () => {
    expect(parseCostInput('120')).toEqual({ ok: true, value: 120 });
  });

  it('keeps cents, because storage is integer cents', () => {
    expect(parseCostInput('12.50')).toEqual({ ok: true, value: 12.5 });
  });

  it('rounds finer-than-a-cent input rather than letting it change on save', () => {
    expect(parseCostInput('12.345')).toEqual({ ok: true, value: 12.35 });
  });

  it('rejects non-numeric text instead of silently writing 0', () => {
    const r = parseCostInput('twelve');
    expect(r.ok).toBe(false);
  });

  it('rejects a negative cost', () => {
    const r = parseCostInput('-5');
    expect(r.ok).toBe(false);
  });
});

describe('formatCostInput', () => {
  it('renders null as an empty box, never as "0"', () => {
    expect(formatCostInput(null)).toBe('');
  });

  it('renders a real zero as "0" — the box must show the statement that was made', () => {
    expect(formatCostInput(0)).toBe('0');
  });

  it('prints whole dollars bare', () => {
    expect(formatCostInput(120)).toBe('120');
  });

  it('prints fractions to the cent', () => {
    expect(formatCostInput(12.5)).toBe('12.50');
  });
});

describe('costEditOutcome — what Apply actually does', () => {
  it('typing a price where there was none writes it', () => {
    expect(costEditOutcome('none', null, 120)).toEqual({ kind: 'set', dirty: true });
  });

  it('clearing an EXPLICIT price is the reset', () => {
    expect(costEditOutcome('set', 120, null)).toEqual({ kind: 'reset', dirty: true });
  });

  it('clearing an INHERITED row sends nothing and says why', () => {
    // The UI must state this rather than appearing broken: the box empties, the price still
    // applies, and the user has to know that is the correct outcome.
    expect(costEditOutcome('inherited', 120, null)).toEqual({
      kind: 'already-inheriting',
      dirty: false,
    });
  });

  it('clearing a row with no price anywhere is its own no-op reason', () => {
    expect(costEditOutcome('none', null, null)).toEqual({ kind: 'no-cost', dirty: false });
  });

  it('re-applying the same explicit price is unchanged', () => {
    expect(costEditOutcome('set', 120, 120)).toEqual({ kind: 'unchanged', dirty: false });
  });

  it('typing the INHERITED number back in is a real edit — it pins the price to this team', () => {
    // The box is pre-filled with the inherited value, so next === current is the untouched state;
    // treating it as "unchanged" would make the pin action unreachable. Writing it means later
    // edits to the default stop reaching this team, which is a genuine change of meaning.
    expect(costEditOutcome('inherited', 120, 120)).toEqual({ kind: 'set', dirty: true });
  });

  it('setting an explicit 0 over an inherited $120 is a real edit', () => {
    // `||`-flavoured logic reads 0 as "nothing typed" and would call this a no-op, leaving the
    // team billed at the inherited price it just declared it does not pay.
    expect(costEditOutcome('inherited', 120, 0)).toEqual({ kind: 'set', dirty: true });
  });

  it('an explicit 0 already stored is unchanged, not "no cost"', () => {
    expect(costEditOutcome('set', 0, 0)).toEqual({ kind: 'unchanged', dirty: false });
  });

  it('clearing an explicit 0 is still the reset (it inherits again)', () => {
    expect(costEditOutcome('set', 0, null)).toEqual({ kind: 'reset', dirty: true });
  });
});

describe('buildCostOnlyBody — the absence of `automated` is the contract', () => {
  it('omits `automated` entirely', () => {
    const body = buildCostOnlyBody(3, 120);
    // `in`, not `=== undefined`: sending the KEY with an undefined value still serialises the
    // patch as classification-bearing on any handler that checks `'automated' in body`.
    expect('automated' in body).toBe(false);
  });

  it('omits kind / label / role too — a price says nothing about what the bot is', () => {
    const body = buildCostOnlyBody(3, 120);
    expect('kind' in body).toBe(false);
    expect('label' in body).toBe(false);
    expect('role' in body).toBe(false);
  });

  it('carries the team key and the price', () => {
    expect(buildCostOnlyBody(3, 120)).toEqual({ teamId: 3, costMonthlyUsd: 120 });
  });

  it('sends costMonthlyUsd: null EXPLICITLY on a clear, never by dropping the key', () => {
    const body = buildCostOnlyBody(3, null);
    // Absent means "leave the stored cost alone" — dropping the key here would make the reset
    // button a silent no-op.
    expect('costMonthlyUsd' in body).toBe(true);
    expect(body.costMonthlyUsd).toBeNull();
  });

  it('sends an explicit 0 as 0', () => {
    expect(buildCostOnlyBody(0, 0).costMonthlyUsd).toBe(0);
  });
});

describe('emptyStateFor — an empty list means three different things', () => {
  it('0 scoped repos means the team has none assigned (syncing will never fix it)', () => {
    expect(emptyStateFor(0)).toBe('no-repos');
  });

  it('>0 scoped repos means no reviewer has been seen in them yet', () => {
    expect(emptyStateFor(4)).toBe('no-reviewers');
  });

  it('null means the listing was never scoped — no repo count may be quoted', () => {
    expect(emptyStateFor(null)).toBe('unscoped');
  });
});

describe('emptyStateCopy — never points at a control that is not on screen', () => {
  // The "Add a review bot" search block is rendered inside the NON-EMPTY branch of the table, so
  // no empty-state sentence may send the user to it. The old 'no-reviewers' copy read "…sync one,
  // or search below to mark a reviewer yourself" — on the only screen that copy can appear, there
  // is nothing below it, and hoisting the block would not help (it filters the same empty array,
  // so it could only render a box that matches nobody).
  for (const [kind, count] of [
    ['no-repos', 0],
    ['no-reviewers', 3],
    ['unscoped', null],
  ] as const) {
    it(`the ${kind} copy does not mention searching`, () => {
      expect(emptyStateCopy(kind, count).toLowerCase()).not.toContain('search');
    });
  }

  it('sends a repo-less team to assign repos — the one fix syncing will never apply', () => {
    expect(emptyStateCopy('no-repos', 0)).toContain('Manage repos & teams');
  });

  it('quotes the scoped repo count, singular and plural', () => {
    expect(emptyStateCopy('no-reviewers', 1)).toContain('1 repo —');
    expect(emptyStateCopy('no-reviewers', 4)).toContain('4 repos —');
  });
});

describe('resetOverrideOffer — a delete that would take a price with it must say so', () => {
  const row = (over: Partial<Parameters<typeof resetOverrideOffer>[0]> = {}) => ({
    inherited: false,
    isManualOverride: true,
    costMonthlyUsd: null as number | null,
    costInherited: false,
    ...over,
  });

  it('is offered on a real manual override for a team', () => {
    expect(resetOverrideOffer(row(), 3)).toEqual({ show: true, dropsCostUsd: null });
  });

  it('is never offered at the root — nothing sits above it to fall back to', () => {
    expect(resetOverrideOffer(row(), 0).show).toBe(false);
  });

  it('is never offered on an inherited row, where it would delete nothing', () => {
    // A silent no-op is indistinguishable from a reset that worked.
    expect(resetOverrideOffer(row({ inherited: true }), 3).show).toBe(false);
  });

  it('is NOT offered on a cost-only row — its only effect there is deleting the price', () => {
    // A team row born from a COST-ONLY patch is not a classification opinion: it copies the
    // default's verbatim (the columns are NOT NULL). `!inherited` is true for it, so the old
    // `teamId !== 0 && !inherited` condition put a button labelled "Reset to default" on a row
    // whose only user-authored content was money — and pressing it deleted exactly that.
    const costOnly = row({ isManualOverride: false, costMonthlyUsd: 500 });
    expect(resetOverrideOffer(costOnly, 3)).toEqual({ show: false, dropsCostUsd: null });
  });

  it('names the price when this team has one of its own', () => {
    // The tooltip said it "resets the classification" and the source comment claimed "not the
    // cost — the cost has its own reset". deleteReviewerOverride deletes the whole ROW, and
    // cost_monthly_cents is a column on it.
    expect(resetOverrideOffer(row({ costMonthlyUsd: 12.35 }), 3)).toEqual({
      show: true,
      dropsCostUsd: 12.35,
    });
  });

  it('a real 0 ("free here") is still a price that would be lost', () => {
    // `dropsCostUsd || …` anywhere downstream would drop this one silently — 0 is a stored value
    // the user typed, not the absence of one.
    expect(resetOverrideOffer(row({ costMonthlyUsd: 0 }), 3).dropsCostUsd).toBe(0);
  });

  it('does NOT warn about an INHERITED price — that one survives the delete', () => {
    // It lives on the row being inherited FROM, so claiming it would be lost is a lie the other
    // way, and would train the user to click through a dialog that never mattered.
    expect(resetOverrideOffer(row({ costMonthlyUsd: 120, costInherited: true }), 3)).toEqual({
      show: true,
      dropsCostUsd: null,
    });
  });
});

const vendor = (over: Partial<BotVendorAnalytics>): BotVendorAnalytics =>
  ({
    key: 'u7',
    kind: 'coderabbit',
    label: 'CodeRabbit',
    login: 'coderabbitai',
    reviewers: 1,
    threads: 10,
    comments: 20,
    actedOn: 4,
    actedOnPct: 40,
    untouched: 6,
    overdueUntouched: 2,
    medianAddressedMs: null,
    oldestUntouchedDays: null,
    humanFollowThroughPct: null,
    noiseRatioPct: null,
    verdict: 'tune',
    costMonthlyUsd: null,
    costPerActedOnUsd: null,
    costInherited: false,
    dormant: false,
    lastActiveAt: null,
    trend: [],
    ...over,
  }) as BotVendorAnalytics;

describe('resolveVendorCost — the server answer is FINAL; the legacy blob only POINTS', () => {
  it('uses the server-resolved price and its inherited flag', () => {
    const r = resolveVendorCost(
      vendor({ costMonthlyUsd: 120, costPerActedOnUsd: 30, costInherited: true }),
      new Map([['coderabbitai', 999]]),
    );
    expect(r).toEqual({
      costMonthlyUsd: 120,
      costPerActedOnUsd: 30,
      costInherited: true,
      legacyOnlyUsd: null,
    });
  });

  it('a server-resolved ZERO beats the legacy blob — `??`, never `||`', () => {
    // This is the whole reason the column is nullable-with-no-default. `costMonthlyUsd || legacy`
    // would bill a team $999 for a bot it just declared free.
    const r = resolveVendorCost(
      vendor({ costMonthlyUsd: 0, costPerActedOnUsd: 0 }),
      new Map([['coderabbitai', 999]]),
    );
    expect(r.costMonthlyUsd).toBe(0);
    expect(r.legacyOnlyUsd).toBeNull();
  });

  it('a CLEARED price stays cleared — the legacy blob must not resurrect it', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The fallback used to fire on any null, so emptying the
    // cost box on a bot whose login is still in the deprecated `pro_settings.bots.cost` blob put
    // the old price straight back — badged "acct", contradicting the Settings screen (which shows
    // an empty box) and the box's own hint ("teams with no price of their own will show no cost").
    // Migration 0019 leaves the blob in place and `ProSettingsUpdate.bots.cost` was removed, so
    // there is no write path left to delete the entry: the price was permanently unremovable
    // through the product, while setting it to 0 worked. Cleared and 0 are distinct states
    // everywhere else, and they must be here.
    const r = resolveVendorCost(vendor({ actedOn: 4 }), new Map([['coderabbitai', 120]]));
    expect(r.costMonthlyUsd).toBeNull();
    // Not charged, not divided into $/acted-on…
    expect(r.costPerActedOnUsd).toBeNull();
    // …but not silently discarded either: surfaced as a pointer the UI offers to migrate.
    expect(r.legacyOnlyUsd).toBe(120);
  });

  it('never badges a legacy value as inherited — the No-team row does not hold it', () => {
    const r = resolveVendorCost(vendor({}), new Map([['coderabbitai', 120]]));
    expect(r.costInherited).toBe(false);
  });

  it('a row with no login cannot match the login-keyed blob', () => {
    // The 'pierre' sentinel row has `login: null`. The blob is a `{login, monthlyUsd}[]` decoded
    // from a JSON column, so a null login IS reachable in the map at runtime — and `Map.get(null)`
    // would then point a Pierre row at somebody else's price. The `v.login != null` guard is what
    // stops it, so the map here is seeded with the null key that makes the guard load-bearing
    // (without it this assertion is vacuous: a Map never matches null by accident).
    const blob = new Map<string, number>([
      [null as unknown as string, 999],
      ['coderabbitai', 120],
    ]);
    const r = resolveVendorCost(vendor({ login: null }), blob);
    expect(r.costMonthlyUsd).toBeNull();
    expect(r.legacyOnlyUsd).toBeNull();
  });

  it('no server price and no legacy entry stays null', () => {
    const r = resolveVendorCost(vendor({}), new Map());
    expect(r).toEqual({
      costMonthlyUsd: null,
      costPerActedOnUsd: null,
      costInherited: false,
      legacyOnlyUsd: null,
    });
  });
});
