import type { CiFlakySummary, FlakyCheck, FlakyCheckReason } from '@pierre-review/shared';

// FLAKY CHECKS IN THE SPA (docs/MERGE-CI-TRUNK.md § Flaky checks). The SERVER decides which failing
// checks are flaky (db/flaky-checks.ts) and why; these components only show it. A flaky check is
// still a failure — nothing here hides a check or changes a count.

/** The words for one reason — the tooltip's lines. */
export function flakyReasonText(reason: FlakyCheckReason): string {
  return reason === 'passed_and_failed'
    ? 'Passed and failed on this commit'
    : 'The CI review says: network or infrastructure';
}

/** The chip's tooltip: every reason that applies, one sentence each. */
export function flakyTitle(reasons: readonly FlakyCheckReason[]): string {
  return reasons.map(flakyReasonText).join('. ');
}

/** name → its flaky verdict. */
export function flakyByName(list: readonly FlakyCheck[] | null | undefined): Map<string, FlakyCheck> {
  return new Map((list ?? []).map((f) => [f.name, f]));
}

/** "Flaky" for one check, "2 flaky" for several — the Pending card's summary label. */
export function flakyCountLabel(n: number): string {
  return n === 1 ? 'Flaky' : `${n} flaky`;
}

/** Offer the card's re-run only when EVERY failing check is flaky and the reader can push. */
export function flakyRerunOffered(f: CiFlakySummary | null | undefined): boolean {
  return f != null && f.allFailing && f.viewerCanPush;
}

export const FLAKY_CHIP_CLASS = 'shrink-0 rounded-ui bg-ui-warn/10 px-1 text-meta font-semibold text-ui-warn';

/** The chip on one check row. */
export function FlakyChip({ reasons }: { reasons: readonly FlakyCheckReason[] }): JSX.Element {
  return (
    <span className={FLAKY_CHIP_CLASS} title={flakyTitle(reasons)} data-testid="flaky-chip">
      Flaky
    </span>
  );
}
