import { useEffect, useMemo, useRef } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { User } from '@pierre-review/shared';
import { profileUrl, userLabel } from '../lib/ui.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useRepos } from '../hooks/useTimeline.js';
import { useUserStats } from '../hooks/useUserStats.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { ExternalLinkIcon } from './Icons.js';

// Where the popover hangs off. `element` is the ordinary case — a real anchor node (the
// clicked handle) that floating-ui tracks directly. `selector` is the vis-timeline case: the
// row label is destroyed + rebuilt on every timeline rebuild, so the anchor is re-resolved by
// attribute selector each animation frame (the same trick MarkerPopover/UserStatsPopover use),
// falling back to the click point while it's briefly missing.
export type PopoverAnchor =
  | { kind: 'element'; el: HTMLElement }
  | { kind: 'selector'; selector: string; x: number; y: number };

// A contributor card: enlarged avatar, their ALL-TIME contribution totals in the context you
// clicked from, a link to their GitHub profile, and a link that opens their activity feed in
// its own tab. Replaces the bare profile link that every handle in the app used to be — the
// profile was one click away and told you nothing about THIS codebase.
//
// Scope: `repoId` set (the handle was rendered inside a PR/thread/comment) → that repo's
// numbers, counted in THAT REPO'S OWN WORKSPACE. Otherwise the WHOLE active workspace. The
// caption states which, because "12 merged" means nothing without it.
//
// ⚠ IT NO LONGER FALLS BACK TO `filters.repoIds`. This card is rendered from five surfaces —
// timeline row labels, PR detail, threads, feed cards, the drill-down tables — and only the first
// two live on the Timeline board, which is the only place the repo picker is mounted. One scope
// that silently means "the picker" on Activity would make the same person's totals differ between
// two screens for a reason invisible on both of them.
//
// ⚠ THE WORKSPACE FOLLOWS THE REPO, NOT THE SELECTOR. The server narrows to
// `membership ∩ (repoIds ?? membership)`, so naming the SELECTED workspace while passing a repo
// from another one intersects to nothing and the card silently reports all zeros under a caption
// that names the repo. A PR can be open from a different workspace via `?pr=<id>`, a restored
// tab or a search hit, so `Repo.workspaceId` — the client's only repo→workspace mapping — is what
// this must ask for.
export function UserProfilePopover({
  user,
  userId,
  repoId,
  anchor,
  onDismiss,
}: {
  user: User | undefined;
  userId: number;
  repoId: number | null;
  anchor: PopoverAnchor;
  onDismiss: () => void;
}): JSX.Element {
  const activeWorkspaceId = useFilters((s) => s.workspaceId);
  const openUserActivityTab = usePinnedTabs((s) => s.openUserActivityTab);
  const { periodReports } = useProCapabilities();
  const { data: repos } = useRepos();

  // The repo subset the counts cover + the caption that names it. A single in-context repo wins;
  // otherwise `null`, which the backend resolves to every repo in the named workspace.
  const scopeRepoIds = useMemo(
    () => (repoId != null ? [repoId] : null),
    [repoId],
  );
  // The workspace the counts are read in. In a PR context it is the PR's repo's OWN workspace
  // (see the note above); otherwise the selected one. `null` while `useRepos()` is still loading
  // keeps the query inert rather than asking the wrong workspace.
  const scopeWorkspaceId = useMemo(() => {
    if (repoId == null) return activeWorkspaceId;
    return (repos ?? []).find((x) => x.id === repoId)?.workspaceId ?? null;
  }, [repoId, repos, activeWorkspaceId]);
  const scopeLabel = useMemo(() => {
    if (repoId != null) {
      const r = (repos ?? []).find((x) => x.id === repoId);
      return r ? `in ${r.fullName}` : 'in this repo';
    }
    return 'across this workspace';
  }, [repoId, repos]);

  const { data: stats, isLoading, isError } = useUserStats(userId, scopeWorkspaceId, scopeRepoIds);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onDismiss();
    },
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-start', 'right-start', 'left-start'] }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: (ref, float, update) =>
      autoUpdate(ref, float, update, { animationFrame: anchor.kind === 'selector' }),
  });
  // Outside-press dismisses, EXCEPT on another handle: those have their own toggle handler
  // (click the same handle to close, a different one to re-anchor). Without the exclusion the
  // pointerdown would close and the following click re-open — the toggle would never work.
  // Both flavours of handle count: the React `UserName` button and the timeline row label,
  // whose anchor is a selector-tracked <a> (the popover uses a VIRTUAL reference there, so
  // floating-ui can't tell the label is "inside").
  const dismiss = useDismiss(context, {
    outsidePress: (e) => {
      const t = e.target as HTMLElement | null;
      return !t?.closest?.('[data-user-handle]') && !t?.closest?.('[data-user-gid]');
    },
  });
  const { getFloatingProps } = useInteractions([dismiss]);

  // Hold the last rect resolved from a live selector anchor, so the card keeps its spot when
  // the anchor briefly vanishes mid-rebuild. Cleared when the anchored target changes.
  const lastRectRef = useRef<DOMRect | null>(null);
  const anchorKey = anchor.kind === 'selector' ? anchor.selector : 'element';
  useEffect(() => {
    lastRectRef.current = null;
  }, [anchorKey]);

  useEffect(() => {
    if (anchor.kind === 'element') {
      refs.setReference(anchor.el);
      return;
    }
    const { selector, x, y } = anchor;
    const clickPoint = (): DOMRect =>
      ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect;
    refs.setReference({
      getBoundingClientRect: () => {
        const el = document.querySelector(selector);
        if (el) {
          const r = el.getBoundingClientRect();
          lastRectRef.current = r;
          return r;
        }
        return lastRectRef.current ?? clickPoint();
      },
    });
    // `anchor` is rebuilt each render by the caller; depend on its fields, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, anchor.kind, anchorKey, anchor.kind === 'selector' ? anchor.x : 0, anchor.kind === 'selector' ? anchor.y : 0]);

  const label = userLabel(user, userId);
  const login = user?.githubLogin ?? null;
  const rows: { label: string; value: number; dot?: string }[] = stats
    ? [
        { label: 'PRs merged', value: stats.prsMerged, dot: '#8957e5' },
        { label: 'PRs open', value: stats.prsOpen, dot: '#3b82f6' },
        { label: 'PRs draft', value: stats.prsDraft, dot: '#9ca3af' },
        { label: 'PRs closed', value: stats.prsClosed, dot: '#ef4444' },
        { label: 'Reviews given', value: stats.reviewsGiven },
        { label: 'Comments', value: stats.comments },
      ]
    : [];

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
        {...getFloatingProps()}
        data-testid="user-profile-popover"
        className="z-50 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="flex items-center gap-2.5">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              width={44}
              height={44}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-11 w-11 shrink-0 rounded-full bg-gray-100 dark:bg-gray-800"
            />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-200 text-base font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {(label[0] ?? '?').toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <div
              className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100"
              title={label}
            >
              {label}
            </div>
            {login && (
              <div className="truncate text-xs text-gray-500 dark:text-gray-400" title={`@${login}`}>
                @{login}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2.5 text-[10px] uppercase tracking-wide text-gray-400" title={scopeLabel}>
          All time · {scopeLabel}
        </div>

        {isLoading && (
          <div className="py-3 text-xs text-gray-400 dark:text-gray-500">Loading activity…</div>
        )}
        {isError && (
          <div className="py-3 text-xs text-red-500 dark:text-red-400">Couldn't load stats.</div>
        )}
        {stats && (
          <table className="mt-1 w-full text-xs">
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.label}
                  className="border-t border-gray-100 first:border-0 dark:border-gray-800"
                >
                  <td className="py-1 pr-2 text-gray-500 dark:text-gray-400">
                    <span className="inline-flex items-center gap-1.5">
                      {r.dot && (
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: r.dot }}
                        />
                      )}
                      {r.label}
                    </span>
                  </td>
                  <td className="py-1 text-right font-medium tabular-nums text-gray-800 dark:text-gray-100">
                    {r.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                openUserActivityTab(userId, {
                  id: userId,
                  login: user?.githubLogin ?? null,
                  displayName: user?.displayName ?? null,
                  avatarUrl: user?.avatarUrl ?? null,
                });
                onDismiss();
              }}
              className="rounded px-1.5 py-1 text-xs font-medium text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950/40"
              title={`Open ${label}'s recent activity in a tab`}
            >
              View activity →
            </button>
            {/* 1:1 prep (Pro `periodReports`, plan P4.2): the SAME tab — its header carries the
                person-period vector. A separate line so the EM's entry point is named; absent
                (never a nudge, never an error) when the capability is off. */}
            {periodReports && (
              <button
                type="button"
                onClick={() => {
                  openUserActivityTab(userId, {
                    id: userId,
                    login: user?.githubLogin ?? null,
                    displayName: user?.displayName ?? null,
                    avatarUrl: user?.avatarUrl ?? null,
                  });
                  onDismiss();
                }}
                className="rounded px-1.5 py-1 text-xs font-medium text-ai-signal hover:bg-ai-signal/10"
                title={`Prep for a 1:1 with ${label} — their period figures, not a scorecard`}
              >
                1:1 prep →
              </button>
            )}
          </div>
          {login && (
            <a
              href={profileUrl(login)}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              title={`@${login} on GitHub`}
            >
              GitHub
              <ExternalLinkIcon size={11} />
            </a>
          )}
        </div>
      </div>
    </FloatingPortal>
  );
}
