import { useId, useMemo, useState } from 'react';
import type { TicketMergedPr, TimelinePr } from '@pierre-review/shared';
import { useTicketPrs, useTicketStory } from '../../hooks/useTicketPrs.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { storyViewTicket } from '../../lib/ticketStory.js';
import { useFilters } from '../../store/filters.js';
import { ticketKeyOfIdent, usePinnedTabs } from '../../store/pinnedTabs.js';
import { dateTime, indexUsers, relativeTime } from '../../lib/ui.js';
import { OpenPrsCards } from '../Activity/OpenPrsCards.js';
import { ChevronIcon } from '../Icons.js';

// THE STORY VIEW'S BODY (docs/FRONTEND.md § The story view) — one ticket, Open PRs style: the SAME
// ticket stack the Open PRs board draws (`OpenPrsCards` with `story`), so a ticket reads the same in
// every place — the header (key, title, status, type, assignee, PR count, coverage pill), its Story
// section OPEN (the ticket review's result or Claude's summary and criteria, the ticket as written, the
// design), its open PRs as the Open PRs cards and "Merged (n)" — and, under it, the PRs closed without
// merging. A ticket with no pull request still gets its stack and its story.
//
// TWO HOSTS, ONE BODY: the story TAB (TicketTabView.tsx, its ident from the active tab) and This
// Sprint's story TRAY (Sprint/SprintStoryTray.tsx, its ident from `?sprintStory=`). Both mount THIS
// component, never a copy, so the two cannot drift. It reads nothing about where it is mounted.
//
// TWO stored reads, both DB-only and free: GET /api/ticket-prs (the PRs + the freshest tracker row) and
// GET /api/ticket-story (the sprint read's row + the CURRENT brief). Only this workspace's repos are
// listed; PRs elsewhere are counted. `workspaceId === null` renders nothing (not resolved).

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const MUTED = 'text-gray-600 dark:text-gray-300';

export function StoryViewBody({
  ident,
  meta,
}: {
  /** Shared `trackerTicketIdent`. */
  ident: string | null;
  /** What the opener knew (the header's fallback until a read names the ticket). */
  meta: { key: string; title: string | null } | null;
}): JSX.Element | null {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const workspaceId = useFilters((s) => s.workspaceId);
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
    <div data-testid="story-view-body" className="space-y-3">
      {prsQ.isError ? (
        <p className="text-body text-ui-danger">Couldn’t load this story.</p>
      ) : prsQ.isLoading || data == null ? (
        <div aria-busy="true" aria-label="Loading the story" className="h-32 rounded-ui bg-ui-surface motion-safe:animate-pulse" />
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
        className="inline-flex items-center gap-1.5 rounded-ui px-1 py-0.5 text-meta font-medium text-ui-mute hover:text-ui-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-10"
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
              className="block w-full rounded-ui bg-ui-surface px-3 py-1.5 text-left hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-11"
            >
              <span className="block min-w-0 break-words text-body font-medium text-ui-ink">{pr.title}</span>
              <span className="mt-0.5 block text-meta text-ui-mute">
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
