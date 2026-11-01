import { useState } from 'react';
import type { ClaudeCoverageItem, ClaudeCoverageStatus } from '@pierre-review/shared';
import { CheckIcon, ChevronIcon, WarningIcon } from './Icons.js';
import { cx, FOCUS_RING } from './ui/cx.js';

// THE REVIEW PLAN on a review (docs/CLAUDE-REVIEW.md § The review plan): the changed files Limn ranked
// by risk before the run, in that order, and what the reviewer reported on each. One line under the
// review's summary header; it opens to the list. The ranking is the code's; the status is the run's
// (a file it raised a finding on always reads "issues").

const STATUS_WORD: Record<ClaudeCoverageStatus, string> = {
  issues: 'Issues',
  no_issues: 'No issues',
  not_reviewed: 'Not reviewed',
};

/** The line's counts. Pure (test/reviewPlan.test.ts). */
export function reviewPlanCounts(items: readonly ClaudeCoverageItem[]): { total: number; checked: number; notReviewed: number } {
  const notReviewed = items.filter((i) => i.status === 'not_reviewed').length;
  return { total: items.length, checked: items.length - notReviewed, notReviewed };
}

/** "Review plan: 12 files, 11 checked" (+ ", 1 not reviewed"). */
export function reviewPlanLine(items: readonly ClaudeCoverageItem[]): string {
  const c = reviewPlanCounts(items);
  const files = `${c.total} file${c.total === 1 ? '' : 's'}`;
  return `Review plan: ${files}, ${c.checked} checked${c.notReviewed > 0 ? `, ${c.notReviewed} not reviewed` : ''}`;
}

function StatusMark({ status }: { status: ClaudeCoverageStatus }): JSX.Element {
  if (status === 'issues') return <WarningIcon size={12} className="text-ui-warn" />;
  if (status === 'no_issues') return <CheckIcon size={12} className="text-ui-success" />;
  return <span className="block h-px w-2.5 bg-ui-faint" />;
}

export function ReviewPlan({ items }: { items: readonly ClaudeCoverageItem[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="text-meta" data-review-plan>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cx('inline-flex items-center gap-1 rounded-ui text-ui-mute hover:text-ui-ink', FOCUS_RING)}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={10} className="shrink-0" />
        {reviewPlanLine(items)}
      </button>
      {open && (
        <ol className="m-0 mt-1 list-none space-y-1.5 p-0" aria-label="Review plan">
          {items.map((i) => (
            <li key={i.ref} className="flex gap-2" data-coverage-status={i.status}>
              <span className="flex h-4 w-3.5 shrink-0 items-center justify-center" title={STATUS_WORD[i.status]}>
                <StatusMark status={i.status} />
                <span className="sr-only">{STATUS_WORD[i.status]}</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 tabular-nums text-ui-faint">{i.ref}</span>
                  <span className="min-w-0 truncate font-mono text-ui-ink" title={i.path}>
                    {i.path}
                  </span>
                </div>
                <div className="text-ui-faint">{i.reasons.join(' · ')}</div>
                {i.note != null && <div className="text-ui-mute">{i.note}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
