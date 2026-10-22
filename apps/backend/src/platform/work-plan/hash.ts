// The WORK PLAN's PAYLOAD HASH — the $0-on-unchanged gate and the free GET's staleness probe, in
// ONE exported function so the two writers-of-truth (the POST's cache check and the GET's `stale`
// flag) cannot drift the way two hand-copied formulas do. Both callers import THIS; neither
// re-spells it. (The addressed-check lesson: a drifted second formula is not a wrong answer once,
// it is PERMANENT staleness that re-bills on every click, forever, silently.)
//
// ── WHAT IT FOLDS, AND ONLY THIS ────────────────────────────────────────────────────────────
//   - WORK_PLAN_SCHEMA_VERSION + WORK_PLAN_PROMPT_VERSION: folding them makes a bump
//     SELF-EXECUTING — every stored row flips `stale` at once and regenerates on the next click,
//     with no migration and no sweep (the PERIOD_METRICS_SCHEMA_VERSION discipline).
//   - the scope key: the population's identity (`ws:<id>`, plus the repo tail when narrowed).
//   - per item, SORTED: its id, kind, relevance and its STABLE facts (approvals,
//     mergeStateStatus, ciStatus, untouchedThreads, pendingReviewers, changedFiles).
//
// ── WHAT IT MUST NEVER FOLD — THIS IS THE EASIEST WAY TO SHIP A TIMER THAT BILLS MONEY ──────
//   - `evidence.generatedAt`, or anything else derived from `now()`. It is an ISO stamp of the
//     FOLD, so it moves on every single poll.
//   - `facts.ageHours` — and therefore ALSO `item.stallRisk` and `item.score`, which are COMPUTED
//     FROM ageHours, and therefore ALSO the items' ORDER, which is the sort of those scores.
//     That is why the per-item signatures below are `.sort()`ed into a set rather than folded in
//     rank order: rank is a clock-derived view of a stable population, and folding the view would
//     re-bill a completely dormant workspace the moment one PR crossed 24h.
//   - `evidence.counts` and `evidence.totals`. They look like stable code-derived state and are
//     not: `counts.stalled` is an AGE THRESHOLD over the same cards, so it ticks over on its own.
//     Nothing is lost by omitting them — a count cannot move without the item set or a fact
//     underneath it moving, and both of those ARE folded.
//   - anything GitHub-hydrated or model-produced. The free GET recomputes this hash from a fresh
//     `getWorkPlan` fold (plain DB reads, zero external cost), so a hydrated field would make the
//     GET and the POST disagree FOREVER: every plan permanently `stale`, re-billed on every click.
//
// ── THE ONE RESIDUAL CLOCK DEPENDENCE, WHICH IS DELIBERATE ──────────────────────────────────
// `evidence.items` is the CAPPED list, and the cap selects by `score` — which is clock-derived.
// So on a board with MORE than WORK_PLAN_ITEM_CAP ranked rows, a stall-bucket crossing (24h / 48h
// / 96h — the buckets are discrete, so this is not continuous drift) can swap the twelfth row for
// the thirteenth with no underlying data change, moving this hash.
//
// That is accepted, on three grounds, and the alternatives are worse:
//   1. NO MONEY MOVES ON ITS OWN. Nothing auto-generates — `generate.mutate()` has exactly one
//      caller, a button. A moved hash raises the `stale` badge; a human decides whether to spend.
//   2. WHEN THE TOP TWELVE CHANGES, THE PLAN REALLY IS OUT OF DATE. It is a narration OF those
//      twelve items; once the set differs, saying so is correct rather than spurious.
//   3. The obvious "fix" — selecting membership by a time-free key — would mean an ageing row could
//      never climb into the plan no matter how long it sat, which deletes the "likelihood of
//      stall" half of the prioritisation this feature was asked for.
// `work-plan.test.ts` pins the part that DOES matter: an unchanged board whose ages, risks, scores
// and rank order have all moved hashes IDENTICALLY.
//
// The exposure here is worse than the synthesis seam's, because that GET reads a cheap input fold
// while this one re-runs the whole ranked worklist on every Activity mount. Read the "never fold"
// list again before adding a field.
import { createHash } from 'node:crypto';
import type { WorkPlanEvidence, WorkPlanItem } from '@pierre-review/shared';

/** Bump when the STORED output structure changes shape. Self-invalidating via the hash. */
export const WORK_PLAN_SCHEMA_VERSION = 1;

/** Bump when the prompt materially changes (the same worklist should be re-narrated).
 *  Self-invalidating via the hash — that is what makes a wording fix reach accounts that already
 *  have a stored plan, instead of leaving them on the old prose until their board happens to
 *  change (the SYNTHESIS_PROMPT_VERSION 2→3 lesson). */
// 3 → 4: the narration moved off the standalone "Plan for today" panel onto the Pending board's
// ranked head, so the prompt's framing changed — items it omits are no longer "shown anyway" in a
// tail below the panel, they stay on a board that shows everything under a divider, and `parked`
// now introduces that divider. Without this bump, every account with a stored plan keeps prose
// describing a panel that no longer exists.
export const WORK_PLAN_PROMPT_VERSION = 4;

/**
 * One item's STABLE signature. Fixed slot order with a '-' for every absent value, so the arity
 * never varies and no field can be mistaken for its neighbour (the scope-key discipline).
 *
 * `?? '-'` deliberately collapses `undefined` and `null` onto one spelling: for `ciStatus` those
 * mean "we did not fold this fact" and "GitHub reports no CI", and no reader of a work plan
 * distinguishes them — while a separate spelling would make the two flip a row stale against each
 * other for nothing.
 *
 * ⚠ `facts.ageHours` and `facts.clock` are ABSENT from this list ON PURPOSE. See the header.
 */
function itemSignature(i: WorkPlanItem): string {
  const f = i.facts;
  return [
    i.id,
    `k:${i.kind}`,
    `rel:${i.relevance}`,
    `ap:${f.approvals ?? '-'}`,
    `ms:${f.mergeStateStatus ?? '-'}`,
    `ci:${f.ciStatus ?? '-'}`,
    `ut:${f.untouchedThreads ?? '-'}`,
    `pr:${f.pendingReviewers ?? '-'}`,
    `cf:${f.changedFiles ?? '-'}`,
  ].join('#');
}

export function workPlanPayloadHash(scopeKey: string, evidence: WorkPlanEvidence): string {
  const sig = [
    `sv:${WORK_PLAN_SCHEMA_VERSION}`,
    `pv:${WORK_PLAN_PROMPT_VERSION}`,
    scopeKey,
    // SORTED — an order-independent SET of items. The ranked order is clock-derived (see header).
    ...evidence.items.map(itemSignature).sort(),
  ].join('|');
  return createHash('sha256').update(sig).digest('hex');
}
