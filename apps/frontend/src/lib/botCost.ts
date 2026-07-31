import type { BotVendorAnalytics, ReviewerOverrideBody } from '@pierre-review/shared';
import { NO_TEAM_KEY } from '@pierre-review/shared';

// Pure logic for the per-TEAM bot cost: what state a row's price is in, what a typed box means,
// and what body a cost edit sends. Lives here (not inline in the component) because every rule in
// it is a decision with a wrong answer that compiles — `??` vs `||`, `!== undefined` vs `!= null`,
// "cleared" vs "unchanged" — so each one gets a test in test/botCost.test.ts.
//
// UNITS: the wire and everything in this file are US DOLLARS. Storage is integer cents on
// `bot_review_classification.cost_monthly_cents`; the conversion happens only at the server's
// store boundary. Nothing here may round to whole dollars — $0.50/mo is representable and a
// silent floor to $0 would read as "free".

// ── Row state ───────────────────────────────────────────────────────────────────────────────

/**
 * Which of the three visually-distinct cost states a reviewer row is in for the team being
 * viewed. The user must be able to tell them apart WITHOUT clicking, because the action that
 * clears the box means something different in each:
 *
 *   'none'      — no price anywhere in the chain. Clearing is a no-op; typing sets one.
 *   'inherited' — the price came from the No-team (default) row, not this team's. Clearing is a
 *                 no-op (it already inherits); typing PINS a price to this team.
 *   'set'       — an explicit price on this team's own row (at NO_TEAM_KEY: the account default
 *                 itself). Clearing IS the reset.
 */
export type CostState = 'none' | 'inherited' | 'set';

/**
 * `costMonthlyUsd` is already fully RESOLVED by the server (it walked team → team-0), so a null
 * here means "no price anywhere", never "inherited" — which is why the null test comes first and
 * `costInherited` is only consulted for a non-null value. The contract guarantees
 * `costInherited === false` whenever the cost is null, but ordering the checks this way means a
 * server bug shows up as a missing badge rather than a row claiming to inherit nothing.
 */
export function costStateOf(r: {
  costMonthlyUsd: number | null;
  costInherited: boolean;
}): CostState {
  if (r.costMonthlyUsd == null) return 'none';
  return r.costInherited ? 'inherited' : 'set';
}

// ── Input parsing ───────────────────────────────────────────────────────────────────────────

export type CostInputParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * Parse the dollars typed into a row's cost box.
 *
 * EMPTY → `null`, and that is the whole point of the control: null is the wire value that CLEARS
 * this team's price so the row inherits again (see `ReviewerOverrideBody.costMonthlyUsd`). It is
 * NOT the same as 0 — 0 is a real price meaning "free here" that must BEAT an inherited $120, so
 * this function never collapses one into the other. (`Number('')` is 0, which is exactly the trap:
 * the empty check must come before any numeric coercion.)
 *
 * Rounded to CENTS because that is the storage granularity — accepting $12.345 would silently
 * round-trip as $12.35 (or $12.34), and a number that changes when you save it reads as a bug.
 */
export function parseCostInput(raw: string): CostInputParse {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number, or clear the box to inherit.' };
  if (n < 0) return { ok: false, error: 'A monthly cost can’t be negative.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** The dollars to seed the box with. Null (no price anywhere) shows as empty, never as "0". */
export function formatCostInput(usd: number | null): string {
  if (usd == null) return '';
  // Integers print bare ("120"), fractions to the cent ("12.50") — so the common whole-dollar
  // subscription doesn't render as a noisy "120.00" the user then has to re-type.
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
}

// ── What pressing Apply would do ────────────────────────────────────────────────────────────

/**
 * The five outcomes of applying a cost box, kept as a discriminant (not a sentence) so the copy
 * lives in the component and the DECISION lives here under test.
 *
 * Two of the five send NOTHING, and they are the reason this function exists: "I cleared the box
 * and nothing happened" has to be answerable in the UI, and the two reasons for it are different
 * ('already-inheriting' still has a price applying to this team; 'no-cost' has none at all).
 */
export type CostEditKind =
  | 'set'                 // write an explicit price at this team key
  | 'reset'               // clear this team's explicit price → inherit the default again
  | 'unchanged'           // the same explicit price is already stored here
  | 'already-inheriting'  // box cleared on a row that inherits — it would keep inheriting
  | 'no-cost';            // box cleared on a row with no price anywhere

export interface CostEdit {
  kind: CostEditKind;
  /** Whether a request should be sent at all. False for the three no-op kinds. */
  dirty: boolean;
}

/**
 * Decide what applying `next` (the parsed box, null = cleared) does to a row currently in
 * `state` holding the resolved price `current`.
 *
 * ⚠ TYPING THE INHERITED NUMBER BACK IN IS A REAL EDIT, not 'unchanged'. On an inherited row the
 * box is pre-filled with the default's price, so `next === current` is the DEFAULT keystroke-free
 * state — but writing it pins that number to this team, which is a genuine change of meaning
 * (later edits to the default stop reaching this team). Only an already-explicit row can be
 * 'unchanged'.
 */
export function costEditOutcome(
  state: CostState,
  current: number | null,
  next: number | null,
): CostEdit {
  if (next == null) {
    if (state === 'set') return { kind: 'reset', dirty: true };
    return { kind: state === 'inherited' ? 'already-inheriting' : 'no-cost', dirty: false };
  }
  if (state === 'set' && current === next) return { kind: 'unchanged', dirty: false };
  return { kind: 'set', dirty: true };
}

/**
 * The body for a COST-ONLY patch.
 *
 * ⚠ `automated` MUST BE ABSENT. Its absence is the contract's discriminator for "this patch
 * carries no classification opinion"; sending it (even `automated: true`, even matching what the
 * row already says) stamps the row `source: 'manual'` and FREEZES that reviewer's classification
 * forever — it stops self-healing when the login later joins the vendor list — and on a team tab
 * silently converts a merely-inherited row into a full row-level override nobody asked for.
 * Pricing a bot is not an opinion about what it is. Same for `kind`/`label`/`role`: a cost edit
 * says nothing about any of them.
 *
 * `costMonthlyUsd` is always PRESENT here (never spread-conditionally), because absent means
 * "leave the stored cost alone" and null means "clear it" — dropping the key on a clear would
 * turn the reset button into a no-op with nothing to show for it.
 */
export function buildCostOnlyBody(teamId: number, costMonthlyUsd: number | null): ReviewerOverrideBody {
  return { teamId, costMonthlyUsd };
}

// ── Empty-state disambiguation ──────────────────────────────────────────────────────────────

/**
 * An empty `reviewers` list means three different things and looks like one. `scopedRepoCount`
 * is the only thing that tells them apart:
 *
 *   'no-repos'     — 0: the team has no repos assigned, so nothing could be detected. The fix is
 *                    to go assign repos, which no amount of syncing will do.
 *   'no-reviewers' — > 0: the team's repos are real but no automated reviewer has been seen in
 *                    them yet. The fix is to sync/wait.
 *   'unscoped'     — null: the caller never asked for a repo-scoped listing, so there is no repo
 *                    count to quote and quoting the account's total would be a lie about scope.
 *
 * (An unknown/foreign team id also reports 0, deliberately indistinguishable from an owned-but-
 * empty team so the id-addressed read stays free of an existence oracle. 'no-repos' copy has to
 * be true of both, so it must not promise the team exists.)
 */
export type ReviewerListEmptyKind = 'no-repos' | 'no-reviewers' | 'unscoped';

export function emptyStateFor(scopedRepoCount: number | null): ReviewerListEmptyKind {
  if (scopedRepoCount == null) return 'unscoped';
  return scopedRepoCount === 0 ? 'no-repos' : 'no-reviewers';
}

/**
 * The sentence shown in place of the list, for each empty kind.
 *
 * ⚠ NONE OF IT MAY POINT AT THE SEARCH BOX, which is the trap this function exists to keep shut.
 * The "Add a review bot" search block is rendered inside the NON-EMPTY branch of the table, so on
 * every screen this copy can appear there is nothing below it — and hoisting the block would not
 * help: it filters the same (empty) `reviewers` array, so it could only ever render a box that
 * matches nobody. An empty list has exactly two honest instructions: assign repos (when the team
 * has none) or wait for a sync (when it has repos but no automated reviewer has spoken in them).
 *
 * Copy, not markup, so the rule is testable — same reason every other decision in this file lives
 * here rather than inline in the component.
 */
export function emptyStateCopy(
  kind: ReviewerListEmptyKind,
  scopedRepoCount: number | null,
): string {
  if (kind === 'no-repos') {
    return 'This team has no repos yet. Assign some in “Manage repos & teams” — until then there is nothing here to detect reviewers in.';
  }
  if (kind === 'no-reviewers') {
    const n = scopedRepoCount ?? 0;
    return `No automated reviewers seen yet in this team’s ${n} repo${n === 1 ? '' : 's'} — they appear here once one has reviewed or commented on a PR we’ve synced.`;
  }
  return 'No reviewers detected yet — sync a repo first.';
}

// ── "Reset to default" ──────────────────────────────────────────────────────────────────────

export interface ResetOverrideOffer {
  /** Render the button at all. */
  show: boolean;
  /** The price, in dollars, that pressing it would DELETE along with the classification. */
  dropsCostUsd: number | null;
}

/**
 * Whether a row may be reset to the default, and what that reset would cost the user.
 *
 * ⚠ THE BUTTON DELETES THE WHOLE ROW, PRICE INCLUDED — `cost_monthly_cents` lives on the row
 * `deleteReviewerOverride` removes. That is unavoidable (there is no classification to keep
 * without the row), so the two rules here are what stop it being a silent loss:
 *
 *   • `show` requires a MANUAL row stored at THIS team. `!inherited` alone is not enough: a team
 *     row created by a COST-ONLY patch is not a classification opinion — it copies the default's
 *     verbatim because the columns are NOT NULL — so on such a row "Reset to default" is a
 *     control whose ONLY effect is deleting the price, named nowhere in its label. That row's
 *     reset is its cost box's own Clear (which drops the row server-side).
 *   • `dropsCostUsd` is non-null exactly when this team has a price OF ITS OWN. An inherited
 *     price survives the delete (it lives on the row being inherited from), so warning about it
 *     would be a lie in the other direction.
 *
 * Never at NO_TEAM_KEY: there is nothing above the root to fall back to.
 */
export function resetOverrideOffer(
  r: {
    inherited: boolean;
    isManualOverride: boolean;
    costMonthlyUsd: number | null;
    costInherited: boolean;
  },
  teamId: number,
): ResetOverrideOffer {
  const show = teamId !== NO_TEAM_KEY && !r.inherited && r.isManualOverride;
  return {
    show,
    dropsCostUsd: show && costStateOf(r) === 'set' ? r.costMonthlyUsd : null,
  };
}

// ── ROI cost resolution ─────────────────────────────────────────────────────────────────────

export interface ResolvedVendorCost {
  costMonthlyUsd: number | null;
  costPerActedOnUsd: number | null;
  /** The price came from the team-0 default, not this team's own row. */
  costInherited: boolean;
  /**
   * A price for this login found ONLY in the DEPRECATED per-login `pro_settings.bots.cost` blob,
   * i.e. one plugin migration 0019 could not move onto a classification row. It is a POINTER, not
   * a price: never applied, never charged, never divided into `costPerActedOnUsd` — the UI uses it
   * to say "there is an old account-wide figure here, re-enter it on the row to use it". Null when
   * there is none.
   */
  legacyOnlyUsd: number | null;
}

/**
 * Resolve one ROI row's cost.
 *
 * The server resolves cost per TEAM and hands it over on the row, so the old client-side overlay
 * from `pro_settings.bots.cost` is gone — a per-LOGIN map physically cannot express "$120 for Team
 * A, $0 for Team B", so it could only ever have been wrong on a team tab.
 *
 * ⚠ THE BLOB NO LONGER FILLS A NULL, AND MUST NOT. It used to, "only for the case migration 0019
 * cannot cover: a costed login with no `bot_review_classification` row to copy the price onto".
 * But the branch could not test that condition — it fired on ANY null, and a DELIBERATELY CLEARED
 * price is also null. Since 0019 backfills every MATCHED login and leaves the blob in place, and
 * `ProSettingsUpdate.bots.cost` was removed (so nothing can ever write or delete the blob again),
 * clearing the cost box on a legacy-costed bot showed the old price straight back, permanently and
 * unremovably — while the Settings screen showed an empty box, and the box's own hint promised
 * "teams with no price of their own will show no cost". Setting 0 worked; clearing did not, and
 * those are states this product treats as distinct everywhere else.
 *
 * So the server's answer is now FINAL — null means null — and the legacy value survives only as
 * `legacyOnlyUsd`, a surfaced-but-unapplied pointer. Nothing is silently lost (the unmatched set
 * is near-empty by 0019's own account, and the pg twin already treats a skipped backfill as
 * acceptable) and nothing is silently resurrected.
 *
 * ⚠ `??`, NEVER `||`, in every consumer of the server value: a resolved 0 is a REAL price ("this
 * team pays nothing for this bot"), which is the whole reason the column is nullable with no
 * default.
 *
 * RETIRE `legacyOnlyUsd` (with `ProSettings.bots.cost`, `bot_cost_json` and `parseCost`) one
 * release after per-team cost ships — there is no write path to that blob, so the set only shrinks.
 */
export function resolveVendorCost(
  v: Pick<BotVendorAnalytics, 'login' | 'actedOn' | 'costMonthlyUsd' | 'costPerActedOnUsd' | 'costInherited'>,
  legacyCostByLogin: Map<string, number>,
): ResolvedVendorCost {
  if (v.costMonthlyUsd != null) {
    return {
      costMonthlyUsd: v.costMonthlyUsd,
      costPerActedOnUsd: v.costPerActedOnUsd,
      costInherited: v.costInherited,
      legacyOnlyUsd: null,
    };
  }
  return {
    costMonthlyUsd: null,
    costPerActedOnUsd: null,
    costInherited: false,
    legacyOnlyUsd: v.login != null ? legacyCostByLogin.get(v.login) ?? null : null,
  };
}

// ── Team labelling ──────────────────────────────────────────────────────────────────────────

/**
 * The name of the row that a value was inherited FROM. Always the No-team default today (it is
 * the only inheritance root), but named through one function so the UI can never say merely
 * "inherited" — since the No-team tab now lists only UNTEAMED repos' reviewers, a team-0 row can
 * govern every team while being invisible on that tab, and "why is CodeRabbit priced everywhere
 * and I can't find where that was set" needs an answer on the row itself.
 */
export const DEFAULT_SOURCE_LABEL = 'No team (default)';

/** True when the tab being viewed IS the inheritance root, where nothing can be inherited. */
export function isDefaultTeam(teamId: number): boolean {
  return teamId === NO_TEAM_KEY;
}
