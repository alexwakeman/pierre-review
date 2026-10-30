import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { botNarrowLabel, selectorLabel } from '../lib/severityAgreement.js';
import {
  BarsIcon,
  BotIcon,
  CloseIcon,
  CommentIcon,
  MagnifierIcon,
  PersonIcon,
  TicketIcon,
  ResolveIcon,
  ThreadsIcon,
} from './Icons.js';
import { storyTabLabels } from '../lib/ticketTab.js';

// Active-label tone per chip flavour (inactive is the shared gray).
// The redesign drops the per-kind colours (docs/redesign/DESIGN.md § 3: colour means blocks /
// ready / the accent only): every active label is plain ink. The keys stay so each kind still
// names its family in one place.
const TONES = {
  violet: 'text-ui-ink',
  sky: 'text-ui-ink',
  amber: 'text-ui-ink',
  ai: 'text-ui-ink',
} as const;

function chipLabelClass(active: boolean, tone: keyof typeof TONES): string {
  // `min-w-0 flex-1` rather than a `max-w` cap: chips are now a FIXED width, so the label's job is
  // to absorb whatever space the icon and the ✕ leave. A max-width instead lets a long label push
  // the ✕ out of its column on some tabs and not others — the exact misalignment the fixed width
  // exists to remove. `min-w-0` is what actually lets `truncate` engage inside a flex row.
  return `min-w-0 flex-1 truncate text-body ${active ? `${TONES[tone]} font-medium` : 'text-ui-mute'}`;
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
// the activating role="tab" button, and the ✕ close button. The ten tab kinds differ
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
      // ⚠ EVERY CLOSABLE TAB IS THE SAME WIDTH (`w-52`), not sized to its label. The ✕ is the last
      // flex item on a fixed-width box, so it lands at the SAME offset from the tab's left edge on
      // every tab — which is the whole point: a close button that moves with the label length is a
      // moving target in a row of tabs, and a strip of ragged widths reads as broken alignment.
      // Labels absorb the difference by truncating (`chipLabelClass`), which they already did.
      // `width` remains a prop so a future kind can opt out deliberately; nothing does today.
      //
      // touch-none + select-none: without them the strip's overflow-x scroll (and text
      // selection) swallow the pointer drag before it can reorder anything.
      className={`group flex ${width ?? 'w-52'} h-7 shrink-0 touch-none select-none items-center gap-1 rounded-ui pl-2 pr-0.5 touch:h-10 ${
        isDragged ? 'cursor-grabbing opacity-50 ' : ''
      }${active ? 'bg-ui-sel' : 'bg-transparent hover:bg-ui-hover'}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onActivate(tabKey)}
        // `min-w-0 flex-1` by default too: the activating button must OWN the space left over
        // after the ✕, or a single-line chip sizes to its content and leaves the ✕ floating in the
        // middle of a fixed-width tab.
        className={buttonClass ?? 'flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ui-accent'}
        title={title}
      >
        {body}
      </button>
      <button
        type="button"
        data-tab-close
        onClick={() => closeTab(tabKey)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-faint opacity-70 hover:bg-ui-hover hover:text-ui-ink hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent group-hover:opacity-100 touch:h-9 touch:w-9 touch:opacity-100"
        title="Close this tab"
        aria-label={closeAria}
      >
        <CloseIcon />
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
  // Repo-scoped drill-down chips (bot-only-prs / bot-threads) show the repo name so a
  // per-repo tab is easy to track. These hooks run UNCONDITIONALLY (before the kind branches) to
  // satisfy the Rules of Hooks — TabChip renders for every tab; only the branches below use them.
  const botOnlyRepoId = useFilters((s) => s.botOnlyFocusRepoId);
  const botThreadsRepoId = useFilters((s) => s.botThreadsFocusRepoId);
  const themeThreadsSeed = useFilters((s) => s.themeThreadsSeed);
  const searchSeed = useFilters((s) => s.searchSeed);
  const botFlaggingSeed = useFilters((s) => s.botFlaggingSeed);
  const botVolumeSeed = useFilters((s) => s.botVolumeSeed);
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
          <span aria-hidden="true" className="shrink-0 text-ui-mute">
            <BarsIcon />
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
            <BotIcon />
          </span>
          <span className={chipLabelClass(active, 'ai')}>Bot Drill-Down</span>
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
            <BotIcon />
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
              className="h-3.5 w-3.5 shrink-0 rounded-full bg-ui-hover"
            />
          ) : (
            <span aria-hidden="true" className="shrink-0">
              <PersonIcon />
            </span>
          )}
          <span className={chipLabelClass(active, 'sky')}>{who}</span>
        </>
      ),
    };
  } else if (tab.kind === 'ticket') {
    // The STORY VIEW (the ticket tab: one ticket's story and pull requests) — labelled with the tracker
    // key captured at open time (or parsed off the ident when the tab was re-created from a URL). The
    // words are `storyTabLabels` (lib/ticketTab.ts): "KEY · Story", tooltip "KEY: story and pull requests".
    // ⚠ Not cosmetic: without this branch the tab falls through to the PR ladder below.
    const words = storyTabLabels(tab.ticketMeta?.key);
    cfg = {
      title: words.title,
      closeAria: words.closeAria,
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            <TicketIcon />
          </span>
          <span className={chipLabelClass(active, 'sky')}>{words.chip}</span>
        </>
      ),
    };
  } else if (tab.kind === 'bot-detail') {
    // One review bot's depth analytics — labelled with that bot (from the metadata captured
    // when it was opened, no lookup needed).
    // ⚠ Not cosmetic: without this branch the tab falls through to the PR ladder below and
    // renders as a two-line `#undefined` chip with no title and no author.
    const who = tab.botMeta?.label ?? tab.botMeta?.login ?? 'bot';
    cfg = {
      title: `${who} — bot depth`,
      closeAria: 'Close bot depth tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            <BotIcon />
          </span>
          <span className={chipLabelClass(active, 'sky')}>{who} · depth</span>
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
            <ResolveIcon />
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
            <ThreadsIcon />
          </span>
          <span className={chipLabelClass(active, 'sky')}>{themeTitle}</span>
        </>
      ),
    };
  } else if (tab.kind === 'bot-flagging') {
    // The ML-strip drill-down — labelled with the tile/chip it was opened on (the transient seed).
    // ⚠ This branch is not cosmetic: without it the tab falls through to the PR ladder below and
    // renders as a two-line `#undefined` chip with no title and no author.
    // `selectorLabel` returns the BARE tile name ("High severity"); the "Flagged ·" prefix is this
    // strip's, so the same string can head the drill-down's own <h2> unprefixed.
    // The bot narrowing is part of the NAME (see selectorLabel): two inflation bars opened in a
    // row are the same tile — "Findings" — and only the bot (or, for the card-level "view all",
    // the size of the bot SET) tells the two chips apart.
    const seedTitle = botFlaggingSeed
      ? selectorLabel(botFlaggingSeed.selector, botFlaggingSeed.bots).title
      : null;
    // The repo scope rides in the tooltip rather than the visible label: unlike the other
    // repo-scoped chips ("Bot-only PRs"), the label already carries two segments, and a third
    // would truncate away the one thing that distinguishes two flagging opens.
    const scopeName = repoName(botFlaggingSeed?.repoId ?? null);
    cfg = {
      title: `What the bots are flagging${seedTitle ? ` — ${seedTitle}` : ''}${
        scopeName ? ` · ${scopeName}` : ''
      }`,
      closeAria: 'Close bot-flagging tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            <MagnifierIcon size={13} />
          </span>
          <span className={chipLabelClass(active, 'sky')}>
            Flagged{seedTitle ? ` · ${seedTitle}` : ''}
          </span>
        </>
      ),
    };
  } else if (tab.kind === 'bot-volume') {
    // The "bot comments per PR" drill-down — labelled with the bot whose cell was clicked (the
    // transient seed), or nothing when it was opened on the workspace-wide total.
    // ⚠ Not cosmetic: without this branch the tab falls through to the PR ladder below and renders
    // as a two-line `#undefined` chip with no title and no author.
    // `botNarrowLabel` is the SAME function the drill-down's own pill uses, so the chip and the
    // page can never name one narrowing two ways.
    const botLabel = botVolumeSeed?.bots ? botNarrowLabel(botVolumeSeed.bots) : null;
    const scopeName = repoName(botVolumeSeed?.repoId ?? null);
    cfg = {
      title: `Bot comments per merged PR${botLabel ? ` — ${botLabel}` : ''}${
        scopeName ? ` · ${scopeName}` : ''
      }`,
      closeAria: 'Close bot-volume tab',
      body: (
        <>
          <span aria-hidden="true" className="shrink-0">
            <CommentIcon />
          </span>
          <span className={chipLabelClass(active, 'sky')}>
            Comments/PR{botLabel ? ` · ${botLabel}` : ''}
          </span>
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
          <span aria-hidden="true" className="shrink-0 text-ui-mute">
            <MagnifierIcon size={13} />
          </span>
          <span className={chipLabelClass(active, 'sky')}>{q ? `“${q}”` : 'Search'}</span>
        </>
      ),
    };
  } else {
    // PR tabs (pr-detail / pr-focus): two-line body — PR title + author; a focus tab is marked
    // with a magnifier icon + "PR focus" subtitle. The width is ChipShell's shared default now
    // (every closable chip is `w-52`), so nothing is set here.
    const isFocus = tab.kind === 'pr-focus';
    const meta = tab.meta;
    const author = meta?.authorDisplayName ?? meta?.authorLogin ?? 'unknown';
    // ONE LINE in the redesign's slim bar: "#N title". The author (the old second line) and "PR
    // focus" ride the tooltip and the accessible name; the magnifier still marks a focus tab.
    cfg = {
      title: `${meta?.repoFullName ?? ''} #${meta?.number ?? ''} · ${meta?.title ?? ''}${
        isFocus ? ' (PR focus)' : ` · by ${author}`
      }`,
      closeAria: `Close ${isFocus ? 'focus' : 'detail'} tab for PR #${meta?.number ?? ''}`,
      body: (
        <>
          {isFocus ? (
            <span aria-hidden="true" className="shrink-0 text-ui-mute">
              <MagnifierIcon size={13} />
            </span>
          ) : meta?.authorAvatarUrl != null ? (
            <img
              src={meta.authorAvatarUrl}
              alt=""
              width={16}
              height={16}
              draggable={false}
              className="shrink-0 rounded-full"
              style={{ width: 16, height: 16 }}
            />
          ) : (
            <span
              aria-hidden
              className="flex shrink-0 items-center justify-center rounded-full bg-ui-hover text-[11px] font-semibold text-ui-ink"
              style={{ width: 16, height: 16 }}
            >
              {author.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className={chipLabelClass(active, 'sky')}>
            <span className="tabular-nums text-ui-faint">#{meta?.number}</span> {meta?.title}
            <span className="sr-only">{isFocus ? ' · PR focus' : ` · ${author}`}</span>
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
    'flex h-8 w-full items-center gap-2 rounded-ui px-2 text-left text-body text-ui-ink enabled:hover:bg-ui-hover disabled:text-ui-faint touch:h-11';
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
        {...getFloatingProps()}
        role="menu"
        aria-label="Tab actions"
        className="z-[60] w-48 rounded-ui bg-ui-raise p-1 shadow-xl shadow-black/30 motion-safe:animate-ui-pop"
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

// The OPEN TABS strip, in the redesign's slim top bar (md and wider; the phone drawer lists the
// same tabs: components/shell/Sidebar.tsx). The fixed views — Activity, This Sprint, Timeline —
// left it for the sidebar; what remains are the dynamic tabs (a PR, a focus board, a drill-down),
// closable, drag-to-reorder (pointer events, not HTML5 drag) and right-clickable for close actions.
// Renders NOTHING when no tab is open.
export function PinnedTabsBar(): JSX.Element | null {
  const tabs = usePinnedTabs((s) => s.tabs);
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
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
    // Where inside the chip the pointer grabbed it, and where the strip's chips sit — both
    // captured at threshold entry so the ghost keeps the grab point under the cursor instead
    // of jumping its own centre there.
    grabDx: number;
    top: number;
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

  // ── the drag ghost ───────────────────────────────────────────────────────────────────────────
  // A LIFTED COPY of the chip that follows the pointer, so the gesture reads as "carrying this
  // tab" rather than "the strip is reflowing for reasons". The chip left behind keeps its
  // half-transparent placeholder styling, which now reads as the hole the tab came out of.
  //
  // It is a CLONE of the live chip node, not a re-render of the label: the per-kind chip bodies
  // (PR avatar + two-line title, drill-down emoji + label, search magnifier + query) live in
  // `TabChip`'s config ladder, and a hand-built ghost would be a second copy of all of it — drifting
  // the moment a kind changes. Cloning also gets the avatar image and the active/inactive colours
  // for free. React never touches the host's children (it renders it empty), so mutating it
  // imperatively is safe.
  const ghostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ghostRef.current;
    if (host == null) return;
    if (draggedKey == null) {
      host.replaceChildren();
      return;
    }
    const src = dragRef.current?.el;
    if (src == null) return;
    const clone = src.cloneNode(true) as HTMLElement;
    // Strip everything that would make the copy act like a real chip: its identity (so the drop
    // slot maths, which enumerates `[data-tabkey]`, can never count the ghost) and its ✕.
    clone.removeAttribute('data-tabkey');
    clone.querySelector('[data-tab-close]')?.remove();
    clone.classList.remove('opacity-50');
    host.replaceChildren(clone);
    // Paint it at the grab point immediately: without this it renders once at the parked
    // coordinates and visibly snaps on the next pointermove.
    const d = dragRef.current;
    if (d != null) host.style.transform = `translate3d(${d.lastX - d.grabDx}px, ${d.top}px, 0)`;
  }, [draggedKey]);

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
      // The ghost tracks the pointer by a DIRECT STYLE WRITE — a setState per pointermove would
      // reconcile the whole strip ~60×/s, which is the same reason the preview order lives in
      // local state and commits once on drop.
      const host = ghostRef.current;
      if (host != null) {
        host.style.transform = `translate3d(${e.clientX - d.grabDx}px, ${d.top}px, 0)`;
      }
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
        const r = e.currentTarget.getBoundingClientRect();
        dragRef.current = {
          key,
          pointerId: e.pointerId,
          startX: e.clientX,
          lastX: e.clientX,
          el: e.currentTarget,
          dragging: false,
          grabDx: e.clientX - r.left,
          top: r.top,
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

  if (tabs.length === 0) return null;

  return (
    <>
    <div
      ref={stripRef}
      data-testid="pinned-tabs"
      role="tablist"
      aria-label="Open tabs"
      className="tab-scrollbar relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain"
    >
      {displayTabs.map((t, i) => (
        <Fragment key={t.key}>
          <TabChip
            tab={t}
            isDragged={draggedKey === t.key}
            drag={dragHandlers}
            onActivate={activateTab}
            onOpenMenu={openMenu}
          />
        </Fragment>
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
    {/* The ghost's HOST. A SIBLING of the strip, never a child: the strip is `overflow-x-auto`,
        and while `position: fixed` escapes that clip today, one `transform` added to the strip
        (a hover lift, an animation) would turn it into the containing block and silently clip the
        ghost to the 42px bar. Kept mounted and empty so the clone can be attached synchronously
        at drag start, and `pointer-events-none` so it can never become its own hit target — the
        drop slot is derived from the real chips' rects. */}
    <div
      ref={ghostRef}
      aria-hidden="true"
      className={`pointer-events-none fixed left-0 top-0 z-[70] flex items-stretch rounded-ui bg-ui-raise shadow-lg shadow-black/30 ${
        draggedKey == null ? 'hidden' : ''
      }`}
      style={{ transform: 'translate3d(-9999px, -9999px, 0)' }}
    />
    </>
  );
}
