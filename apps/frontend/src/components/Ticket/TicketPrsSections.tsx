import { useId, useMemo, useState } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useRepos } from '../../hooks/useTimeline.js';
import { dateTime, relativeTime } from '../../lib/ui.js';
import { OpenPrsCards } from '../Activity/OpenPrsCards.js';
import { ChevronIcon } from '../Icons.js';

// One ticket's pull requests as the Open PRs cards draw them: its open PRs on the Open PRs cards, its
// merged PRs on the "Merged so far" cards, and closed ones in a collapsed list. The ticket tab
// (TicketTabView) and This sprint's drawer (SprintTicketDrawer) both render this over the SAME fold
// (`TicketPrsResponse`), so the two never draw a ticket's PRs two ways.

export function TicketPrsSections({
  open,
  merged,
  closed,
  onOpenPr,
}: {
  open: TimelinePr[];
  merged: TimelinePr[];
  closed: TimelinePr[];
  onOpenPr: (pr: TimelinePr) => void;
}): JSX.Element {
  const { data: repos } = useRepos();
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);
  const [closedOpen, setClosedOpen] = useState(false);
  const openId = useId();
  const mergedId = useId();
  return (
    <>
      {open.length > 0 && (
        <section aria-labelledby={openId} className="space-y-2">
          <h3 id={openId} className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Open
          </h3>
          <OpenPrsCards prs={open} isLoading={false} isError={false} sort={null} grouped={false} onOpenPr={onOpenPr} />
        </section>
      )}
      {merged.length > 0 && (
        <section aria-labelledby={mergedId} className="space-y-2">
          <h3 id={mergedId} className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Merged
          </h3>
          <OpenPrsCards
            prs={merged}
            isLoading={false}
            isError={false}
            sort={null}
            variant="merged"
            grouped={false}
            onOpenPr={onOpenPr}
          />
        </section>
      )}
      {closed.length > 0 && (
        <section className="space-y-2">
          <button
            type="button"
            aria-expanded={closedOpen}
            onClick={() => setClosedOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-gray-800 hover:underline dark:text-gray-100"
          >
            <ChevronIcon dir={closedOpen ? 'down' : 'right'} aria-hidden="true" />
            Closed without merging ({closed.length})
          </button>
          {closedOpen && (
            <ul aria-label="Closed pull requests" className="space-y-1">
              {closed.map((pr) => (
                <li key={pr.id}>
                  <button
                    type="button"
                    onClick={() => onOpenPr(pr)}
                    className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                  >
                    <span className="min-w-0 break-words text-gray-900 dark:text-gray-100">{pr.title}</span>
                    <span className="text-xs text-gray-600 dark:text-gray-300">
                      {repoNameById.get(pr.repoId) ?? ''}#{pr.number}
                      {pr.closedAt != null && (
                        <span title={`Closed ${dateTime(pr.closedAt)}`}> · closed {relativeTime(pr.closedAt)}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
