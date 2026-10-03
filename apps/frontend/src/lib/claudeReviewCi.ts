// The Claude Review tab's "CI failures" section — the pure half: what the section shows at all,
// the order of the rows, the count pills, the labels and the not-checked sentences. Rendered by
// components/ClaudeReviewCiFailures.tsx. Every figure here is counted from the server's
// reconciled list, which never invents a cause.
import type {
  ClaudeCiFailure,
  ClaudeCiFailureCategory,
  ClaudeCiNotCheckedReason,
  ClaudeReview,
} from '@pierre-review/shared';

const CHIP_RED = 'bg-red-500/10 text-red-700 dark:text-red-400';
const CHIP_ORANGE = 'bg-orange-500/10 text-orange-700 dark:text-orange-400';
const CHIP_GREEN = 'bg-green-500/10 text-green-700 dark:text-green-400';
const CHIP_GREY = 'bg-gray-500/10 text-gray-600 dark:text-gray-300';

export const CI_CATEGORY_LABEL: Record<ClaudeCiFailureCategory, string> = {
  code: 'Code',
  test: 'Test',
  flaky_or_infra: 'Flaky or infra',
  config: 'Config',
  unclear: 'Unclear',
};

export const CI_CATEGORY_CLASS: Record<ClaudeCiFailureCategory, string> = {
  code: CHIP_RED,
  test: CHIP_ORANGE,
  config: CHIP_ORANGE,
  flaky_or_infra: CHIP_GREY,
  unclear: CHIP_GREY,
};

/**
 * What the section renders:
 *   hidden  — the run did not look at CI (null), or it looked and found no checks at all
 *   passing — nothing failing and the head was green
 *   pending — nothing failing yet, but checks were still running
 *   list    — at least one failing check
 */
export type CiSectionMode = 'hidden' | 'passing' | 'pending' | 'list';

export function ciSectionMode(review: Pick<ClaudeReview, 'ciFailures' | 'ciState'>): CiSectionMode {
  const failures = review.ciFailures;
  if (failures == null) return 'hidden';
  if (failures.length > 0) return 'list';
  const state = review.ciState?.state;
  if (state === 'passing') return 'passing';
  if (state === 'pending') return 'pending';
  return 'hidden';
}

/** A failure this pull request can fix: diagnosed, and Claude said a change here would fix it. */
export const isCiFixableHere = (f: ClaudeCiFailure): boolean =>
  f.status === 'diagnosed' && f.fixableInPr === true;

/** Fixable here first, then the other diagnosed ones, then the unchecked — stable within each. */
export function orderCiFailures(items: readonly ClaudeCiFailure[]): ClaudeCiFailure[] {
  const rank = (f: ClaudeCiFailure): number =>
    isCiFixableHere(f) ? 0 : f.status === 'diagnosed' ? 1 : 2;
  return items
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

export interface CiCountPill {
  key: 'fixable' | 'notFixable' | 'notChecked';
  label: string;
  cls: string;
}

/** The header's count pills, zeros left out. */
export function ciCountPills(items: readonly ClaudeCiFailure[]): CiCountPill[] {
  let fixable = 0;
  let notFixable = 0;
  let notChecked = 0;
  for (const f of items) {
    if (f.status !== 'diagnosed') notChecked += 1;
    else if (f.fixableInPr === true) fixable += 1;
    else notFixable += 1;
  }
  const pills: Array<CiCountPill & { n: number }> = [
    { key: 'fixable', label: `${fixable} fixable here`, cls: CHIP_RED, n: fixable },
    { key: 'notFixable', label: `${notFixable} not from this change`, cls: CHIP_GREY, n: notFixable },
    { key: 'notChecked', label: `${notChecked} not checked`, cls: CHIP_GREY, n: notChecked },
  ];
  return pills.filter((p) => p.n > 0).map(({ key, label, cls }) => ({ key, label, cls }));
}

export const CI_PASSING_CLASS = CHIP_GREEN;

/** Why a failing check carries no diagnosis. One sentence per reason. */
export function ciNotCheckedSentence(reason: ClaudeCiNotCheckedReason | null): string {
  switch (reason) {
    case 'no_log':
      return 'No log available: this check does not run on GitHub Actions.';
    case 'log_unavailable':
      return "Its log couldn't be read.";
    case 'over_cap':
      return 'Not sent to Claude: too many failing checks.';
    case 'not_reported':
      return "Claude didn't report on this one.";
    default:
      return 'Not checked.';
  }
}

/** The header's count word: "1 failing check" / "3 failing checks". */
export function ciFailingLabel(n: number): string {
  return `${n} failing ${n === 1 ? 'check' : 'checks'}`;
}
