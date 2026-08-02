import type { BotVendorAnalytics, ReviewerCostBody } from '@pierre-review/shared';

// Pure logic for a bot's monthly price: what state it is in, what a typed box means, and what
// body a cost edit sends. Lives here (not inline in the component) because every rule in it is a
// decision with a wrong answer that compiles — "cleared" vs "unchanged", $0 vs no price, a
// fractional cent that survives a round trip — so each one gets a test in test/botCost.test.ts.
//
// ⚠ COST IS A PER-WORKSPACE FACT, and that is the single most important thing in this file. It is
// stored once per (account, WORKSPACE, actor) in `workspace_reviewers.monthly_cents` and served on
// `WorkspaceReviewer.costMonthlyUsd` — one plain column on the same row that carries the judgement
// and the identity. Nothing here takes a repo id and nothing here may be called once per repo: a
// vendor running in six of the workspace's repos is ONE row with ONE price.
//
// ⚠ AND IT IS NEVER SUMMED ACROSS WORKSPACES. Within one workspace there is exactly one row per
// actor, so a total there is a plain sum (`monthlyCostTotal` in lib/botReviewers.ts). Across
// workspaces it is not a sum at all — six workspaces each listing a $120 CodeRabbit is either six
// subscriptions or one seen six ways, and the app must not assert which. Editing the price in
// workspace A leaves B untouched and B may legitimately hold a different number; nothing
// reconciles them and nothing is meant to. That is why the editor's label is
// "Price for this Workspace" and not a bare "Price".
//
// UNITS: the wire and everything in this file are US DOLLARS. Storage is integer cents; the
// conversion happens only at the server's store boundary. Nothing here may round to whole dollars
// — $0.50/mo is representable and a silent floor to $0 would read as "free".
//
// ⚠ THERE IS NO INHERITANCE, AND NO FAN-OUT. There is no default row to fall back to and no
// sibling row that gets seeded when this one is written, so `null` means exactly "no price set" —
// not "ask my parent". Exactly TWO states — null and a number (0 being the real, deliberate "we
// pay nothing") — with nothing behind either. Do not reintroduce a third.

// ── Row state ───────────────────────────────────────────────────────────────────────────────

/**
 * Which of the two visually-distinct cost states a bot's price is in, IN THIS WORKSPACE.
 *
 *   'none' — no price recorded. Clearing the box is a no-op; typing sets one.
 *   'set'  — a price is recorded (possibly 0, meaning "free"). Clearing IS the reset.
 *
 * Trivial today because the server's answer is final — kept as a named function anyway so the
 * component's input chrome keys on a state with a docstring rather than on an inline `== null`,
 * and so a future third state (if one is ever justified) has one place to land.
 */
export type CostState = 'none' | 'set';

export function costStateOf(r: { costMonthlyUsd: number | null }): CostState {
  return r.costMonthlyUsd == null ? 'none' : 'set';
}

// ── Input parsing ───────────────────────────────────────────────────────────────────────────

export type CostInputParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * The ceiling the wire contract fixes for `ReviewerCostBody.monthlyUsd`: storage is int4 CENTS in
 * BOTH dialects, and that is exactly where the two stop agreeing — Postgres RAISES `integer out of
 * range` (a 500) above it while SQLite's 64-bit integers accept the value happily. Rejecting it
 * here means the same input can't succeed locally and 500 in cloud. (The route clamps/400s too;
 * this is the client half of the same rule, not a substitute for it.)
 */
export const MAX_COST_USD = 21_474_836.47;

/**
 * Parse the dollars typed into a cost box.
 *
 * EMPTY → `null`, and that is the whole point of the control: null is the wire value that CLEARS
 * the price (see `ReviewerCostBody`). It is NOT the same as 0 — 0 is a real price meaning "we pay
 * nothing for this" — so this function never collapses one into the other. (`Number('')` is 0,
 * which is exactly the trap: the empty check must come before any numeric coercion.)
 *
 * Rounded to CENTS because that is the storage granularity — accepting $12.345 would silently
 * round-trip as $12.35 (or $12.34), and a number that changes when you save it reads as a bug.
 * The rounding rule is the contract's: cents = floor(usd × 100 + 0.5) in binary64, spelled here
 * as `Math.round(n * 100)`, which is the same operation on non-negative input. Do not "improve"
 * it to an exact-decimal rounding on one side only — $1.005 lands on 100 under this rule and 101
 * under that one, and the two backfill paths were measured disagreeing on exactly that value.
 */
export function parseCostInput(raw: string): CostInputParse {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  // `Number.isFinite` also rejects NaN, which is what a stray letter parses to.
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number, or clear the box for no price.' };
  if (n < 0) return { ok: false, error: 'A monthly cost can’t be negative.' };
  if (n > MAX_COST_USD) return { ok: false, error: 'That’s larger than the maximum storable price.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** The dollars to seed the box with. Null (no price set) shows as empty, never as "0". */
export function formatCostInput(usd: number | null): string {
  if (usd == null) return '';
  // Integers print bare ("120"), fractions to the cent ("12.50") — so the common whole-dollar
  // subscription doesn't render as a noisy "120.00" the user then has to re-type.
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
}

// ── What pressing Save would do ─────────────────────────────────────────────────────────────

/**
 * The four outcomes of applying a cost box, kept as a discriminant (not a sentence) so the copy
 * lives in the component and the DECISION lives here under test.
 *
 * Two of the four send NOTHING, and they are the reason this function exists: "I cleared the box
 * and nothing happened" has to be answerable on screen.
 */
export type CostEditKind =
  | 'set'        // write this price
  | 'clear'      // there is a price and the box is empty → write null
  | 'unchanged'  // the same price is already stored
  | 'no-cost';   // box cleared on an actor that has no price anyway

export interface CostEdit {
  kind: CostEditKind;
  /** Whether a request should be sent at all. False for the two no-op kinds. */
  dirty: boolean;
}

/**
 * Decide what applying `next` (the parsed box, null = cleared) does to a bot currently priced at
 * `current` IN THIS WORKSPACE.
 *
 * ⚠ 0 IS A PRICE. `current: 0, next: null` is a real CLEAR (from "we pay nothing" to "nobody has
 * said"), and `current: null, next: 0` is a real SET. Any implementation that leans on
 * truthiness collapses both into no-ops, which is why both are pinned by tests.
 */
export function costEditOutcome(current: number | null, next: number | null): CostEdit {
  if (next == null) {
    return current == null ? { kind: 'no-cost', dirty: false } : { kind: 'clear', dirty: true };
  }
  if (current === next) return { kind: 'unchanged', dirty: false };
  return { kind: 'set', dirty: true };
}

/**
 * The body for `PUT /api/bot-reviewers/:userId/cost`.
 *
 * ⚠ `workspaceId` IS REQUIRED AND IS PART OF THE ROW'S KEY, not a filter over it. A price now
 * NAMES a per-workspace row (`workspace_reviewers.monthly_cents`, predicate
 * `(account_id, workspace_id, author_user_id)`), so a body without it has no row to land on. It is
 * the FIRST parameter deliberately: every call site had to be re-read when the wire type gained
 * the field, and a positional required argument is what turned that into a tsc error rather than
 * something a grep had to find.
 *
 * `monthlyUsd` is REQUIRED by the contract precisely so `undefined` is not a third meaning: a
 * number sets, null clears. Spreading it conditionally (the reflex from the old optional-field
 * patch body) would turn the Clear button into a silent no-op.
 *
 * ⚠ IT CARRIES NO `repoId`, and must not gain one. Every repo in the workspace is priced by this
 * one row; keying it per repo is how six repos of CodeRabbit become $720.
 */
export function buildCostBody(workspaceId: number, monthlyUsd: number | null): ReviewerCostBody {
  return { workspaceId, monthlyUsd };
}

// ── ROI cost resolution ─────────────────────────────────────────────────────────────────────

export interface ResolvedVendorCost {
  costMonthlyUsd: number | null;
  costPerActedOnUsd: number | null;
  /**
   * A price for this login found ONLY in the DEPRECATED per-login `pro_settings.bots.cost` blob,
   * i.e. one no migration could move onto a reviewer row. It is a POINTER, not a price: never
   * applied, never charged, never divided into `costPerActedOnUsd` — the UI uses it to say "there
   * is an old account-wide figure here, re-enter it on the bot's card to use it in this
   * Workspace". Null when there is none.
   */
  legacyOnlyUsd: number | null;
}

/**
 * Resolve one ROI row's cost.
 *
 * The server reads the price off that reviewer's `workspace_reviewers` row FOR THE WORKSPACE THE
 * ANALYTICS WERE REQUESTED AT and hands it over on the analytics row, so the old client-side
 * overlay from `pro_settings.bots.cost` is gone.
 *
 * ⚠ THE BLOB NO LONGER FILLS A NULL, AND MUST NOT. It used to, "only for the case migration 0019
 * cannot cover: a costed login with no row to copy the price onto". But the branch could not test
 * that condition — it fired on ANY null, and a DELIBERATELY CLEARED price is also null. Since
 * `ProSettingsUpdate.bots.cost` was removed (nothing can ever write or delete the blob again),
 * clearing the cost box on a legacy-costed bot showed the old price straight back, permanently and
 * unremovably — while the Settings screen showed an empty box. Setting 0 worked; clearing did not,
 * and those are states this product treats as distinct everywhere else.
 *
 * So the server's answer is FINAL — null means null — and the legacy value survives only as
 * `legacyOnlyUsd`, a surfaced-but-unapplied pointer.
 *
 * ⚠ THE PRICE BELONGS TO ONE WORKSPACE. The row aggregates one reviewer over whatever repo
 * narrowing was requested INSIDE that workspace, and the price is the single figure recorded on
 * its row there. Never sum or multiply it across rows, and never add it to the same vendor's
 * figure in another workspace — that is a comparison, not an invoice.
 *
 * RETIRE `legacyOnlyUsd` (with `ProSettings.bots.cost`, `bot_cost_json` and `parseCost`) one
 * release after `workspace_reviewers` ships — there is no write path to that blob, so the set only
 * shrinks.
 */
export function resolveVendorCost(
  v: Pick<BotVendorAnalytics, 'login' | 'actedOn' | 'costMonthlyUsd' | 'costPerActedOnUsd'>,
  legacyCostByLogin: Map<string, number>,
): ResolvedVendorCost {
  if (v.costMonthlyUsd != null) {
    return {
      costMonthlyUsd: v.costMonthlyUsd,
      costPerActedOnUsd: v.costPerActedOnUsd,
      legacyOnlyUsd: null,
    };
  }
  return {
    costMonthlyUsd: null,
    costPerActedOnUsd: null,
    legacyOnlyUsd: v.login != null ? legacyCostByLogin.get(v.login) ?? null : null,
  };
}
