import { useId, useMemo, useState } from 'react';
import type { TicketMergedPr, TimelinePr } from '@pierre-review/shared';
import { useTicketPrs, useTicketStory } from '../../hooks/useTicketPrs.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { storyViewTicket } from '../../lib/ticketStory.js';
import { useFilters } from '../../store/filters.js';
import { parseTicketTabKey, ticketKeyOfIdent, usePinnedTabs } from '../../store/pinnedTabs.js';
import { dateTime, indexUsers, relativeTime } from '../../lib/ui.js';
import { OpenPrsCards } from '../Activity/OpenPrsCards.js';
import { ChevronIcon } from '../Icons.js';

// THE STORY VIEW (the ticket tab; docs/FRONTEND.md § The story view) — one ticket, Open PRs style: the
// SAME ticket stack the Open PRs board draws (`OpenPrsCards` with `story`), so a ticket reads the same
// in both places — the header (key, title, status, type, assignee, PR count, coverage pill), its Story
// section OPEN (the ticket review's result or Claude's summary and criteria, the ticket as written, the
// design), its open PRs as the Open PRs cards and "Merged (n)" — and, under it, the PRs closed without
// merging. A ticket with no pull request still gets its stack and its story.
//
// TWO stored reads, both DB-only and free: GET /api/ticket-prs (the PRs + the freshest tracker row) and
// GET /api/ticket-story (the sprint read's row + the CURRENT brief). Only this workspace's repos are
// listed; PRs elsewhere are counted. Every entry point opens it through `useOpenStory` (lib/ticketTab.ts).
//
// The tab key is `ticket:<ident>`; the header falls back to the tab's meta (captured at open time) until a
// read names the ticket. `workspaceId === null` renders nothing (not resolved).

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const MUTED = 'text-gray-600 dark:text-gray-300';

export function TicketTabView(): JSX.Element | null {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const workspaceId = useFilters((s) => s.workspaceId);
  const ident = parseTicketTabKey(activeTab);
  const meta = tabs.find((t) => t.key === activeTab)?.ticketMeta ?? null;
  const prsQ = useTicketPrs(workspaceId, ident);
  const storyQ = useTicketStory(workspaceId, ident);

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);

  const data = prsQ.data;
  const ticket = useMemo(
    () =>
      ident == null
        ? null
        : storyViewTicket(
            ident,
            { key: meta?.key ?? ticketKeyOfIdent(ident), title: meta?.title ?? null },
            data?.ticket,
            storyQ.data?.ticket,
          ),
    [ident, meta?.key, meta?.title, data?.ticket, storyQ.data?.ticket],
  );
  // The stack's "Merged (n)" panel rows, from the same read (never the board's batched request).
  const mergedRows = useMemo<TicketMergedPr[]>(
    () =>
      (data?.merged ?? []).map((pr) => {
        const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
        return {
          prId: pr.id,
          repoId: pr.repoId,
          repoFullName: repoNameById.get(pr.repoId) ?? '',
          number: pr.number,
          title: pr.title,
          authorLogin: u?.githubLogin ?? null,
          authorDisplayName: u?.displayName ?? null,
          authorAvatarUrl: u?.avatarUrl ?? null,
          mergedAt: pr.mergedAt ?? pr.closedAt ?? pr.updatedAt,
        };
      }),
    [data?.merged, usersById, repoNameById],
  );
  const story = useMemo(() => (ticket != null ? { ticket, merged: mergedRows } : null), [ticket, mergedRows]);

  if (workspaceId == null || ident == null || story == null) return null;

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

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const total = open.length + mergedRows.length + closed.length;
  const outside = data?.outsideWorkspace ?? 0;
  const found = data?.found === true || storyQ.data?.found === true;

  return (
    <div data-testid="ticket-tab-view" className="mx-auto max-w-5xl space-y-3 p-4">
      {prsQ.isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">Couldn’t load this story.</p>
      ) : prsQ.isLoading || data == null ? (
        <div aria-busy="true" aria-label="Loading the story" className="h-32 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-900/40" />
      ) : !found ? (
        <p className={`text-sm ${MUTED}`}>This ticket isn’t on this workspace’s tracker.</p>
      ) : (
        <>
          <OpenPrsCards prs={open} isLoading={false} isError={false} sort={null} grouped story={story} onOpenPr={openTab} />
          {total === 0 && (
            <p className={`px-1 text-sm ${MUTED}`}>
              {outside > 0
                ? `No pull requests in this workspace. ${plural(outside, 'pull request')} in other workspaces.`
                : 'No pull requests for this ticket yet.'}
            </p>
          )}
          {total > 0 && outside > 0 && <p className={`px-1 text-xs ${MUTED}`}>{plural(outside, 'pull request')} in other workspaces.</p>}
          {data.truncated && <p className="px-1 text-xs text-amber-800 dark:text-amber-300">Showing the latest pull requests only.</p>}
          {closed.length > 0 && <ClosedList prs={closed} repoNameById={repoNameById} onOpenPr={openTab} />}
        </>
      )}
    </div>
  );
}

/** The ticket's PRs closed without merging: collapsed, one compact row each. */
function ClosedList({
  prs,
  repoNameById,
  onOpenPr,
}: {
  prs: TimelinePr[];
  repoNameById: ReadonlyMap<number, string>;
  onOpenPr: (pr: TimelinePr) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section className="space-y-1.5 px-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        Closed without merging ({prs.length})
      </button>
      <ul id={listId} hidden={!open} aria-label="Closed pull requests" className="space-y-1">
        {prs.map((pr) => (
          <li key={pr.id}>
            <button
              type="button"
              onClick={() => onOpenPr(pr)}
              className="block w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-left hover:border-gray-300 hover:bg-gray-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-gray-700 dark:hover:bg-gray-900"
            >
              <span className="block min-w-0 break-words text-[13px] font-medium text-gray-800 dark:text-gray-100">{pr.title}</span>
              <span className="mt-0.5 block text-[11px] text-gray-600 dark:text-gray-300">
                <span className="font-mono">
                  {repoNameById.get(pr.repoId) ?? ''}#{pr.number}
                </span>
                {pr.closedAt != null && <span title={`Closed ${dateTime(pr.closedAt)}`}> · closed {relativeTime(pr.closedAt)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
