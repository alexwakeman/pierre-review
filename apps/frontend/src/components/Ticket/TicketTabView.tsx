import { useMemo, useState } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useTicketPrs } from '../../hooks/useTicketPrs.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { parseTicketTabKey, ticketKeyOfIdent, usePinnedTabs } from '../../store/pinnedTabs.js';
import { dateTime, indexUsers, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { OpenPrsCards } from '../Activity/OpenPrsCards.js';
import { CARD_NEUTRAL_CHIP } from '../Activity/PrCardShell.js';
import { ChevronIcon, ExternalLinkIcon, TicketIcon } from '../Icons.js';

// THE TICKET TAB — one ticket's pull requests in isolation (docs/FRONTEND.md § The ticket tab):
// its open PRs on the Open PRs cards, its merged PRs on the "Merged so far" cards, and closed ones
// in a collapsed list. ONE read, GET /api/ticket-prs (core, FREE). Only this workspace's repos are
// listed; PRs elsewhere are counted.
//
// The tab key is `ticket:<ident>`; the chip/heading text comes from the tab's meta (captured at open
// time) until the response names the ticket. `workspaceId === null` renders nothing (not resolved).

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function TicketTabView(): JSX.Element | null {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const workspaceId = useFilters((s) => s.workspaceId);
  const ident = parseTicketTabKey(activeTab);
  const meta = tabs.find((t) => t.key === activeTab)?.ticketMeta ?? null;
  const { data, isLoading, isError } = useTicketPrs(workspaceId, ident);

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);
  const [closedOpen, setClosedOpen] = useState(false);

  if (workspaceId == null || ident == null) return null;

  const openTab = (pr: TimelinePr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    openPrDetailTab(
      {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        repoFullName: repoNameById.get(pr.repoId) ?? '',
        authorLogin: u?.githubLogin ?? null,
        authorDisplayName: u?.displayName ?? null,
        authorAvatarUrl: u?.avatarUrl ?? null,
      },
      { fromActivity: true },
    );
  };

  const ticket = data?.ticket ?? null;
  const key = ticket?.key ?? meta?.key ?? ticketKeyOfIdent(ident);
  const title = ticket?.title ?? meta?.title ?? null;
  const href = safeExternalUrl(ticket?.url ?? null);
  const open = data?.open ?? [];
  const merged = data?.merged ?? [];
  const closed = data?.closed ?? [];
  const total = open.length + merged.length + closed.length;
  const outside = data?.outsideWorkspace ?? 0;

  return (
    <div data-testid="ticket-tab-view" className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className="shrink-0 text-gray-500 dark:text-gray-400">
            <TicketIcon />
          </span>
          <h2 className="min-w-0 break-words text-base font-semibold text-gray-900 dark:text-gray-100">
            {key}
            {title != null && title !== '' && <span className="font-normal"> · {title}</span>}
          </h2>
          {ticket?.status != null && <span className={CARD_NEUTRAL_CHIP}>{ticket.status.name}</span>}
          {href != null && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-400"
            >
              Open in tracker
              <ExternalLinkIcon size={11} aria-hidden="true" />
            </a>
          )}
        </div>
        {data?.found === true && total + outside > 0 && (
          <p className="text-xs text-gray-600 dark:text-gray-300">
            {open.length} open · {merged.length} merged · {closed.length} closed
            {outside > 0 && ` · ${outside} in other workspaces`}
          </p>
        )}
        {data?.truncated === true && (
          <p className="text-xs text-amber-800 dark:text-amber-300">Showing the latest pull requests only.</p>
        )}
      </header>

      {isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">Couldn’t load this ticket’s pull requests.</p>
      ) : isLoading || data == null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : !data.found ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">This ticket isn’t on this workspace’s tracker.</p>
      ) : total === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {outside > 0
            ? `No pull requests in this workspace. ${plural(outside, 'pull request')} in other workspaces.`
            : 'No pull requests for this ticket yet.'}
        </p>
      ) : (
        <>
          {open.length > 0 && (
            <section aria-labelledby="ticket-tab-open" className="space-y-2">
              <h3 id="ticket-tab-open" className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                Open
              </h3>
              <OpenPrsCards prs={open} isLoading={false} isError={false} sort={null} grouped={false} onOpenPr={openTab} />
            </section>
          )}
          {merged.length > 0 && (
            <section aria-labelledby="ticket-tab-merged" className="space-y-2">
              <h3 id="ticket-tab-merged" className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                Merged
              </h3>
              <OpenPrsCards
                prs={merged}
                isLoading={false}
                isError={false}
                sort={null}
                variant="merged"
                grouped={false}
                onOpenPr={openTab}
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
                        onClick={() => openTab(pr)}
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
      )}
    </div>
  );
}
