// FLAKY CHECKS — a failing check that is probably not the PR's fault (docs/MERGE-CI-TRUNK.md
// § Flaky checks). Computed on the SERVER from stored rows only (`db/flaky-checks.ts`
// `classifyFlakyChecks`); the wire carries the verdict and the reasons, never a guess the SPA makes.
//
// ⚠ A FLAKY CHECK IS STILL A FAILURE. Nothing here changes a count, a CI label, the merge verdict
// or which cards exist — it only adds a chip and, on the Pending card, a re-run button.

/** Why a failing check counts as flaky. A check can carry both.
 *  - `passed_and_failed`: the same head commit was seen with every check passing, and this check
 *    is failing on it now (`ci_status_events`, the PR's stored CI log).
 *  - `ci_review_infra`: the latest CI review at the PR's current head classified this failure
 *    `flaky_or_infra`. */
export type FlakyCheckReason = 'passed_and_failed' | 'ci_review_infra';

export interface FlakyCheck {
  /** The check's bare name, as `failingChecks` spells it. */
  name: string;
  /** Never empty. `passed_and_failed` first when both apply. */
  reasons: FlakyCheckReason[];
}

/** What a red Pending card carries about its flaky checks. Absent when no failing check is flaky. */
export interface CiFlakySummary {
  /** The flaky ones among the failing checks at the PR's current head, alphabetical. Never empty.
   *  Uncapped (unlike `failingChecks`), so the "N flaky" count is exact. */
  checks: FlakyCheck[];
  /** Every failing check at that head is flaky — the only case the card offers a re-run. */
  allFailing: boolean;
  /** The reader may re-run CI here (WRITE / MAINTAIN / ADMIN on the repo). The route re-checks. */
  viewerCanPush: boolean;
}
