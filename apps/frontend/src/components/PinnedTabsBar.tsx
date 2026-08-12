import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import { usePinnedTabs, type Tab } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';
import { useRepos } from '../hooks/useTimeline.js';
import { MagnifierIcon } from './Icons.js';

const MetricsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="20" x2="4" y2="12" />
    <line x1="10" y1="20" x2="10" y2="6" />
    <line x1="16" y1="20" x2="16" y2="14" />
    <line x1="20" y1="20" x2="20" y2="9" />
  </svg>
);
// A git-pull-request glyph for the all-open-PRs drill-down chip.
const OpenPrsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="6" y1="9" x2="6" y2="15" />
    <circle cx="18" cy="18" r="3" />
    <path d="M18 15V9a3 3 0 0 0-3-3h-3" />
  </svg>
);

// Active-label tone per chip flavour (inactive is the shared gray).
const TONES = {
  violet: 'text-violet-600 dark:text-violet-400',
  sky: 'text-sky-600 dark:text-sky-400',
  amber: 'text-amber-600 dark:text-amber-400',
} as const;

function chipLabelClass(active: boolean, tone: keyof typeof TONES): string {
  return `max-w-[12rem] truncate text-xs font-medium ${
    active ? TONES[tone] : 'text-gray-600 dark:text-gray-300'
  }`;
}

// Pointer handlers the strip installs on every DYNAMIC chip wrapper (the fixed
// Activity/Timeline chips are neither draggable nor drop targets). One shared object —
// the handlers read the chip's key off its data-tabkey attribute.
interface ChipDragHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}

// The shared shell every dynamic chip renders: wrapper (drag + context-menu surface),
// the activating role="tab" button, and the ✕ close button. The nine tab kinds differ
// only in width, body content, title and close aria-label.
function ChipShell({
  tabKey,
  active,
  isDragged,
  width,
  buttonClass,
  title,
  closeAria,
  body,
  onActivate,
  drag,
  onOpenMenu,
}: {
  tabKey: string;
  active: boolean;
  isDragged: boolean;
  width?: string;
  buttonClass?: string;
  title: string;
  closeAria: string;
  body: JSX.Element;
  onActivate: (key: string) => void;
  drag: ChipDragHandlers;
  onOpenMenu: (e: React.MouseEvent, tabKey: string | null) => void;
}): JSX.Element {
  const closeTab = usePinnedTabs((s) => s.closeTab);
  return (
    <div
      role="presentation"
      data-tabkey={tabKey}
      onContextMenu={(e) => onOpenMenu(e, tabKey)}
      {...drag}
      // touch-none + select-none: without them the strip's overflow-x scroll (and text
      // selection) swallow the pointer drag before it can reorder anything.
      className={`group flex ${width ?? ''} shrink-0 touch-none select-none items-center gap-1 rounded-t-md border border-b-0 pl-2 pr-1 ${
        isDragged ? 'cursor-grabbing opacity-50 ' : ''
      }${
        active
          ? 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950'
          : 'border-transparent bg-transparent hover:bg-gray-200/60 dark:hover:bg-gray-800/60'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onActivate(tabKey)}
        className={buttonClass ?? 'flex items-center gap-1.5 py-1.5 text-left'}
        title={title}
      >
        {body}
      </button>
      <button
        type="button"
        data-tab-close
        onClick={() => closeTab(tabKey)}
        className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        title="Close this tab"
        aria-label={closeAria}
      >
        ✕
      </button>
    </div>
  );
}

// One closable tab chip. Clicking the body activates the tab (App.tsx renders the matching
// content). PR tabs (pr-detail / pr-focus) are fixed-width with the PR title + author; the
// drill-down kinds render a compact icon + label. Each branch below only assembles the
// per-kind config — the chrome, drag and context-menu behaviour live in ChipShell.
function TabChip({
  tab,
  isDragged,
  drag,
  onActivate,
  onOpenMenu,
}: {
  tab: Tab;
  isDragged: boolean;
  drag: ChipDragHandlers;
  onActivate: (key: string) => void;
  onOpenMenu: (e: React.MouseEvent, tabKey: string | null) => void;
}): JSX.Element {
  const active = usePinnedTabs((s) => s.activeTab === tab.key);
  // Repo-scoped drill-down chips (bot-only-prs / bot-threads / open-prs) show the repo name so a
  // per-repo tab is easy to track. These hooks run UNCONDITIONALLY (before the kind branches) to
  // satisfy the Rules of Hooks — TabChip renders for every tab; only the branches below use them.
  const botOnlyRepoId = useFilters((s) => s.botOnlyFocusRepoId);
  const botThreadsRepoId = useFilters((s) => s.botThreadsFocusRepoId);
  const themeThreadsSeed = useFilters((s) => s.themeThreadsSeed);
  const searchSeed = useFilters((s) => s.searchSeed);
  const openPrsScope = useFilters((s) => s.openPrsScope);
  const { data: repos } = useRepos();
  const repoName = (id: number | null): string | null =>
    id != null ? ((repos ?? []).find((r) => r.id === id)?.fullName ?? `repo ${id}`) : null;

  interface ChipCfg {
    width?: string;
    buttonClass?: string;
    title: string;
    closeAria: string;
    body: JSX.Element;
  }
  let cfg: ChipCfg;

  if (tab.kind === 'metrics-detail') {
    cfg = {
      title: 'Flow metrics — drill-down',
      closeAria: 'Close flow-metrics tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0 text-violet-500">
            {MetricsIcon}
          </span>
          <span className={chipLabelClass(active, 'violet')}>Flow metrics</span>
        </>
      ),
    };
  } else if (tab.kind === 'bot-prs') {
    // The `bot-prs` kind is the wire/state identifier and keeps its name; the label the
    // user reads does not, because the tab opens on the COMMENTS view.
    cfg = {
      title: 'Bot Drill-Down — what a review bot said, and the PRs it touched',
      closeAria: 'Close bot drill-down tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            🤖
          </span>
          <span className={chipLabelClass(active, 'violet')}>Bot Drill-Down</span>
        </>
      ),
    };
  } else if (tab.kind === 'open-prs') {
    // A repo/group scope surfaces its name so a scoped tab is easy to track; the workspace-wide
    // 'feed' scope (the Flow metrics tile) reads "All repos".
    const scopeName =
      typeof openPrsScope === 'number'
        ? repoName(openPrsScope)
        : openPrsScope != null && typeof openPrsScope === 'object'
          ? openPrsScope.label
          : openPrsScope === 'feed'
            ? 'All repos'
            : null;
    cfg = {
      title: `Open PRs — sortable drill-down${scopeName ? ` · ${scopeName}` : ''}`,
      closeAria: 'Close open-PRs tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0 text-sky-500">
            {OpenPrsIcon}
          </span>
          <span className={chipLabelClass(active, 'sky')}>
            Open PRs{scopeName ? ` · ${scopeName}` : ''}
          </span>
        </>
      ),
    };
  } else if (tab.kind === 'bot-only-prs') {
    const scopeName = repoName(botOnlyRepoId);
    cfg = {
      title: `Bot-only PRs — only a bot reviewed these${scopeName ? ` · ${scopeName}` : ''}`,
      closeAria: 'Close bot-only-PRs tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            🤖
          </span>
          <span className={chipLabelClass(active, 'amber')}>
            Bot-only PRs{scopeName ? ` · ${scopeName}` : ''}
          </span>
        </>
      ),
    };
  } else if (tab.kind === 'user-activity') {
    // One contributor's activity feed — labelled with that person (from the metadata
    // captured when it was opened, no lookup needed).
    const who = tab.userMeta?.login ?? tab.userMeta?.displayName ?? 'contributor';
    cfg = {
      title: `${who} — recent activity`,
      closeAria: 'Close contributor activity tab',
      body: (
        <>
          {tab.userMeta?.avatarUrl ? (
            <img
              src={tab.userMeta.avatarUrl}
              width={14}
              height={14}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              draggable={false}
              className="h-3.5 w-3.5 shrink-0 rounded-full bg-gray-200 dark:bg-gray-800"
            />
          ) : (
            <span aria-hidden="true" className="shrink-0">
              👤
            </span>
          )}
          <span className={chipLabelClass(active, 'sky')}>{who}</span>
        </>
      ),
    };
  } else if (tab.kind === 'bot-threads') {
    const scopeName = repoName(botThreadsRepoId);
    cfg = {
      title: `Bot threads — review & resolve the likely-addressed backlog${scopeName ? ` · ${scopeName}` : ''}`,
      closeAria: 'Close bot-threads tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            🧹
          </span>
          <span className={chipLabelClass(active, 'sky')}>
            Bot threads{scopeName ? ` · ${scopeName}` : ''}
          </span>
        </>
      ),
    };
  } else if (tab.kind === 'theme-threads') {
    // Labelled with the theme's title (from the transient seed).
    const themeTitle = themeThreadsSeed?.theme.title ?? 'Theme threads';
    cfg = {
      title: `Theme threads — ${themeTitle}`,
      closeAria: 'Close theme-threads tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            🧵
          </span>
          <span className={chipLabelClass(active, 'sky')}>{themeTitle}</span>
        </>
      ),
    };
  } else if (tab.kind === 'search') {
    // The cross-repo search-results drill-down — labelled with the query (transient seed).
    const q = searchSeed ?? '';
    cfg = {
      title: q ? `Search — “${q}”` : 'Search',
      closeAria: 'Close search tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0 text-gray-500">
            <MagnifierIcon size={13} />
          </span>
          <span className={chipLabelClass(active, 'sky')}>{q ? `“${q}”` : 'Search'}</span>
        </>
      ),
    };
  } else {
    // PR tabs (pr-detail / pr-focus): fixed width, two-line body — PR title + author; a
    // focus tab is marked with a magnifier icon + "PR focus" subtitle.
    const isFocus = tab.kind === 'pr-focus';
    const meta = tab.meta;
    const author = meta?.authorDisplayName ?? meta?.authorLogin ?? 'unknown';
    cfg = {
      width: 'w-52',
      buttonClass: 'flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left',
      title: `${meta?.repoFullName ?? ''} #${meta?.number ?? ''} · ${meta?.title ?? ''}${
        isFocus ? ' (focus)' : ''
      }`,
      closeAria: `Close ${isFocus ? 'focus' : 'detail'} tab for PR #${meta?.number ?? ''}`,
      body: (
        <>
          {isFocus ? (
            <span aria-hidden="true" className="shrink-0 text-sky-500">
              <MagnifierIcon size={14} />
            </span>
          ) : meta?.authorAvatarUrl != null ? (
            <img
              src={meta.authorAvatarUrl}
              alt={author}
              width={16}
              height={16}
              draggable={false}
              className="shrink-0 rounded-full"
              style={{ width: 16, height: 16 }}
            />
          ) : (
            <span
              className="flex shrink-0 items-center justify-center rounded-full bg-gray-300 text-[8px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
              style={{ width: 16, height: 16 }}
            >
              {author.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="flex min-w-0 flex-col leading-tight">
            <span
              className={`truncate text-xs font-medium ${
                active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              <span className="text-gray-400">#{meta?.number}</span> {meta?.title}
            </span>
            <span className="truncate text-[10px] text-gray-500">
              {isFocus ? 'PR focus' : author}
            </span>
          </span>
        </>
      ),
    };
  }

  return (
    <ChipShell
      tabKey={tab.key}
      active={active}
      isDragged={isDragged}
      width={cfg.width}
      buttonClass={cfg.buttonClass}
      title={cfg.title}
      closeAria={cfg.closeAria}
      body={cfg.body}
      onActivate={onActivate}
      drag={drag}
      onOpenMenu={onOpenMenu}
    />
  );
}

// A permanent, NON-closable tab (Activity / Timeline). These live at the head of the strip
// as first-class tabs so the two core views read the same as the dynamic PR tabs — one
// clear place to switch, no separate header toggle (reduces confusion). Not draggable and
// not a drop target; right-click still offers "Close all tabs" (a dead right-click reads
// as a bug, and "close others"/"close all" mean the same thing here).
function FixedChip({
  active,
  onClick,
  onContextMenu,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  icon: JSX.Element;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-semibold ${
        active
          ? 'border-gray-300 bg-white text-blue-600 dark:border-gray-700 dark:bg-gray-950 dark:text-blue-400'
          : 'border-transparent bg-transparent text-gray-600 hover:bg-gray-200/60 dark:text-gray-300 dark:hover:bg-gray-800/60'
      }`}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      {label}
    </button>
  );
}

const ActivityIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);
const TimelineIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="14" y2="12" />
    <line x1="4" y1="17" x2="18" y2="17" />
  </svg>
);

// The right-click menu for a chip. ONE instance rendered from the strip (not per chip), in
// a FloatingPortal — the strip is overflow-x-auto, so a non-portaled absolute menu would
// clip to the 42px bar. Anchored to a virtual zero-size rect at the click point (the
// MarkerPopover trick). `tabKey` null = a fixed Activity/Timeline chip: only "Close all".
function TabContextMenu({
  x,
  y,
  tabKey,
  tabCount,
  onClose,
}: {
  x: number;
  y: number;
  tabKey: string | null;
  tabCount: number;
  onClose: () => void;
}): JSX.Element {
  const closeTab = usePinnedTabs((s) => s.closeTab);
  const closeOtherTabs = usePinnedTabs((s) => s.closeOtherTabs);
  const closeAllTabs = usePinnedTabs((s) => s.closeAllTabs);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onClose();
    },
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(2), flip({ fallbackPlacements: ['top-start'] }), shift({ padding: 8 })],
  });
  // Escape is handled by our OWN capture-phase listener below, not useDismiss's: it must
  // stopPropagation or the global `esc` handler (useKeyboard → showTimeline) would also
  // fire and yank the user off their current tab.
  const dismiss = useDismiss(context, { escapeKey: false });
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    refs.setReference({
      getBoundingClientRect: () =>
        ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
    });
  }, [refs, x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const item =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 enabled:hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:enabled:hover:bg-gray-800';
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
        {...getFloatingProps()}
        role="menu"
        aria-label="Tab actions"
        className="z-[60] w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        {tabKey != null && (
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              onClose();
              closeTab(tabKey);
            }}
            className={item}
          >
            Close this tab
          </button>
        )}
        {tabKey != null && (
          <button
            role="menuitem"
            type="button"
            disabled={tabCount <= 1}
            onClick={() => {
              onClose();
              closeOtherTabs(tabKey);
            }}
            className={item}
          >
            Close other tabs
          </button>
        )}
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            onClose();
            closeAllTabs();
          }}
          disabled={tabCount === 0}
          className={item}
        >
          Close all tabs
        </button>
      </div>
    </FloatingPortal>
  );
}

// The tab strip: Activity + Timeline are permanent, non-closable tabs at the head (the two
// core views — no separate header toggle); the dynamic pinned tabs follow and are closable,
// drag-to-reorderable (pointer events, not HTML5 drag) and right-clickable for close actions.
export function PinnedTabsBar(): JSX.Element {
  const tabs = usePinnedTabs((s) => s.tabs);
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const showTimeline = usePinnedTabs((s) => s.showTimeline);
  const moveTab = usePinnedTabs((s) => s.moveTab);

  const stripRef = useRef<HTMLDivElement>(null);
  // In-flight drag bookkeeping. `dragging` flips only past the 4px threshold so a plain
  // click never enters drag mode; pointer capture is taken only THEN (capturing on
  // pointerdown would retarget the resulting click to the wrapper and break activation).
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    lastX: number;
    el: HTMLElement;
    dragging: boolean;
  } | null>(null);
  // True from drag-mode entry until the next pointerdown — guards the chip's onClick so
  // the drop doesn't also switch tabs.
  const draggedRef = useRef(false);
  // The PREVIEW order (tab keys) lives here during a drag; the store's moveTab is called
  // exactly ONCE on drop (every store write runs persist() + the useUrlState subscription).
  const [previewKeys, setPreviewKeys] = useState<string[] | null>(null);
  const previewRef = useRef<string[] | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scrollDirRef = useRef(0);
  const [menu, setMenu] = useState<{ x: number; y: number; tabKey: string | null } | null>(null);

  // Re-derive the drop slot from the LIVE chip rects (the DOM is in preview order): the
  // insertion index is the count of other dynamic chips whose midpoint sits left of the
  // pointer. Fixed chips carry no data-tabkey, so the dynamic region starts after them.
  const updatePreview = useCallback((clientX: number) => {
    const d = dragRef.current;
    const strip = stripRef.current;
    if (!d || !strip) return;
    const others = Array.from(strip.querySelectorAll<HTMLElement>('[data-tabkey]')).filter(
      (el) => el.dataset.tabkey !== d.key,
    );
    let idx = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) idx++;
    }
    const keys = others.map((el) => el.dataset.tabkey as string);
    keys.splice(idx, 0, d.key);
    previewRef.current = keys;
    setPreviewKeys((prev) =>
      prev != null && prev.length === keys.length && prev.every((k, i) => k === keys[i])
        ? prev
        : keys,
    );
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = null;
    scrollDirRef.current = 0;
  }, []);
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  // Keep the strip scrolling while the pointer parks near an edge; every step moves the
  // chip rects, so the drop slot is re-derived from the pointer's last known position.
  const autoScrollStep = useCallback(() => {
    const strip = stripRef.current;
    const d = dragRef.current;
    if (!strip || !d || scrollDirRef.current === 0) {
      scrollRafRef.current = null;
      return;
    }
    strip.scrollLeft += scrollDirRef.current * 8;
    updatePreview(d.lastX);
    scrollRafRef.current = requestAnimationFrame(autoScrollStep);
  }, [updatePreview]);

  const endDrag = useCallback(
    (commit: boolean) => {
      const d = dragRef.current;
      dragRef.current = null;
      stopAutoScroll();
      if (d?.dragging) {
        try {
          d.el.releasePointerCapture(d.pointerId);
        } catch {
          /* already released */
        }
        const order = previewRef.current;
        if (commit && order != null) {
          const to = order.indexOf(d.key);
          if (to !== -1) moveTab(d.key, to);
        }
      }
      previewRef.current = null;
      setPreviewKeys(null);
      setDraggedKey(null);
      // Clear the click-swallow flag once the drop's own click (which fires after pointerup)
      // has been consumed. Leaving it set until the next pointerdown would also swallow
      // keyboard activation (Enter/Space produce a click with NO preceding pointerdown).
      if (draggedRef.current) {
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }
    },
    [moveTab, stopAutoScroll],
  );

  // Escape cancels an in-flight drag without committing. Capture-phase + stopPropagation
  // so the global `esc` (useKeyboard → showTimeline) doesn't also fire.
  useEffect(() => {
    if (draggedKey == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      endDrag(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [draggedKey, endDrag]);

  // Window-level listeners own the drag once it starts: pointer capture keeps events
  // flowing while the pointer leaves the strip, but React MOVES the captured chip node on
  // every preview reorder and a browser may drop capture on a DOM move — the window
  // listeners (the MarkerPopover precedent) keep the drag alive either way.
  useEffect(() => {
    if (draggedKey == null) return;
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId || !d.dragging) return;
      // Missed pointerup (e.g. released over a context menu): treat as a drop.
      if ((e.buttons & 1) === 0) {
        endDrag(true);
        return;
      }
      d.lastX = e.clientX;
      updatePreview(e.clientX);
      const strip = stripRef.current;
      if (strip != null) {
        const r = strip.getBoundingClientRect();
        scrollDirRef.current = e.clientX < r.left + 40 ? -1 : e.clientX > r.right - 40 ? 1 : 0;
        if (scrollDirRef.current !== 0 && scrollRafRef.current == null) {
          scrollRafRef.current = requestAnimationFrame(autoScrollStep);
        }
      }
    };
    const up = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      endDrag(true);
    };
    const cancel = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      endDrag(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [draggedKey, endDrag, updatePreview, autoScrollStep]);

  const dragHandlers: ChipDragHandlers = useMemo(
    () => ({
      onPointerDown: (e) => {
        // A second pointer (touch) landing mid-drag must not clobber the in-flight record —
        // the original drag's pointerId would stop matching and its endDrag would never run,
        // freezing the strip in an uncommitted preview order.
        if (dragRef.current?.dragging) return;
        if (e.button !== 0) return;
        // Never start a drag from the ✕ button.
        if ((e.target as HTMLElement).closest('[data-tab-close]') != null) return;
        const key = e.currentTarget.dataset.tabkey;
        if (key == null) return;
        draggedRef.current = false;
        dragRef.current = {
          key,
          pointerId: e.pointerId,
          startX: e.clientX,
          lastX: e.clientX,
          el: e.currentTarget,
          dragging: false,
        };
      },
      // Threshold entry only — past 4px horizontal the drag starts and the window-level
      // listeners (mounted by setDraggedKey) take over move/up/cancel.
      onPointerMove: (e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pointerId || d.dragging) return;
        // A mouse keeps ONE pointerId across presses, so a stale down-state from a press
        // that ended off-chip would otherwise start a drag on a mere hover.
        if ((e.buttons & 1) === 0) {
          dragRef.current = null;
          return;
        }
        d.lastX = e.clientX;
        if (Math.abs(e.clientX - d.startX) <= 4) return;
        d.dragging = true;
        draggedRef.current = true;
        try {
          d.el.setPointerCapture(d.pointerId);
        } catch {
          /* pointer already gone */
        }
        setDraggedKey(d.key);
        updatePreview(e.clientX);
      },
      onPointerUp: (e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pointerId) return;
        endDrag(true);
      },
      onPointerCancel: (e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pointerId) return;
        endDrag(false);
      },
    }),
    [endDrag, updatePreview],
  );

  const activateTab = useCallback(
    (key: string) => {
      // Swallow the click that follows a drop (endDrag clears draggedRef asynchronously,
      // after this click has been consumed).
      if (!draggedRef.current) setActiveTab(key);
    },
    [setActiveTab],
  );

  const openMenu = useCallback((e: React.MouseEvent, tabKey: string | null) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tabKey });
  }, []);

  // During a drag the strip renders the PREVIEW order; the store stays untouched until drop.
  const displayTabs = useMemo(() => {
    if (previewKeys == null) return tabs;
    const byKey = new Map(tabs.map((t) => [t.key, t]));
    const ordered = previewKeys.map((k) => byKey.get(k)).filter((t): t is Tab => t != null);
    // A tab the preview doesn't know (opened mid-drag) keeps its store position at the end.
    for (const t of tabs) if (!previewKeys.includes(t.key)) ordered.push(t);
    return ordered;
  }, [tabs, previewKeys]);

  return (
    <div
      ref={stripRef}
      data-testid="pinned-tabs"
      role="tablist"
      aria-label="Views"
      // Fixed min-height so the strip never shrinks when the (taller, two-line) PR tabs are all
      // closed. `items-stretch` makes EVERY tab fill the strip's full height, so the single-line
      // chips (Activity / Timeline / drill-downs) and the two-line PR tabs come out the SAME
      // height with vertically-centred content — no ragged tops or misaligned text.
      className="tab-scrollbar flex min-h-[42px] shrink-0 items-stretch gap-1 overflow-x-auto bg-gray-100 px-2 pt-1 dark:bg-gray-900"
    >
      <FixedChip
        active={activeTab === 'activity'}
        onClick={() => setActiveTab('activity')}
        onContextMenu={(e) => openMenu(e, null)}
        icon={ActivityIcon}
        label="Activity"
        title="Activity — per-repo triage console"
      />
      <FixedChip
        active={activeTab === 'timeline'}
        onClick={showTimeline}
        onContextMenu={(e) => openMenu(e, null)}
        icon={TimelineIcon}
        label="Timeline"
        title="Timeline — the activity board"
      />
      {displayTabs.map((t) => (
        <TabChip
          key={t.key}
          tab={t}
          isDragged={draggedKey === t.key}
          drag={dragHandlers}
          onActivate={activateTab}
          onOpenMenu={openMenu}
        />
      ))}
      {menu != null && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          tabKey={menu.tabKey}
          tabCount={tabs.length}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
