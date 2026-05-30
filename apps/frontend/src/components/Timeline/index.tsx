import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DataSet,
  Timeline as VisTimeline,
  type DataGroup,
  type DataItem,
  type TimelineOptions,
} from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.css';
import type { TimelineEvent, TimelinePr, TimelineResponse, User } from '@gh-team-monitor/shared';
import { useTimeline, useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useOpenPrs } from '../../hooks/useTriage.js';
import { resolveRange, useFilters } from '../../store/filters.js';
import { indexUsers, userLabel } from '../../lib/ui.js';
import { renderPrBar, prClassName } from './prBar.js';
import { computeUserStats, renderUserLabel } from './userRow.js';
import { buildMarkerItems } from './clustering.js';
import {
  MarkerPopover,
  type ContextFocus,
  type PopoverState,
} from './MarkerPopover.js';

const ZOOM_MIN_MS = 1000 * 60 * 60;

const VIS_OPTIONS: TimelineOptions = {
  stack: true,
  stackSubgroups: true,
  orientation: { axis: 'top', item: 'top' },
  zoomMin: ZOOM_MIN_MS,
  zoomMax: 1000 * 60 * 60 * 24 * 365 * 2,
  margin: { item: 4, axis: 8 },
  tooltip: { followMouse: true, overflowMethod: 'flip' },
  // Plain wheel scrolls rows vertically; trackpad/side-scroll (deltaX) pans the
  // time axis. Zoom requires a modifier key (zoomKey, set per-platform at
  // construction) so the wheel no longer zooms by accident.
  verticalScroll: true,
  horizontalScroll: true,
  selectable: true,
  multiselect: false,
  maxHeight: '100%',
  // Marker content is our own inline SVG; vis's default sanitizer allowlists
  // only div/span and would escape the SVG to text. All PR titles are already
  // run through escapeHtml before reaching here.
  xss: { disabled: true },
};

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// vis-timeline's zoomKey takes a single modifier; mac users zoom with Cmd
// (metaKey), everyone else with Ctrl — matching the platform-native gesture and
// avoiding the OS Ctrl+wheel page-zoom on mac.
function zoomModifierKey(): 'metaKey' | 'ctrlKey' {
  const ua =
    typeof navigator !== 'undefined'
      ? navigator.platform || navigator.userAgent
      : '';
  return /Mac|iP(hone|ad|od)/.test(ua) ? 'metaKey' : 'ctrlKey';
}

function groupOf(ev: TimelineEvent): string {
  return ev.actorId != null
    ? `repo:${ev.repoId}:user:${ev.actorId}`
    : `repo:${ev.repoId}`;
}

const USER_GROUP_RE = /^repo:\d+:user:\d+$/;

// A DOM-safe class token for a group id (`repo:2:user:5` → `tlg-repo-2-user-5`),
// set as part of the group's className so focusRows can find the rendered label
// + foreground rows for that group to animate them. vis copies a group's
// className onto both its label and its foreground row.
function groupClassToken(id: string): string {
  return `tlg-${id.replace(/:/g, '-')}`;
}

export function Timeline(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<VisTimeline | null>(null);
  const itemsRef = useRef(new DataSet<DataItem>());
  const groupsRef = useRef(new DataSet<DataGroup>());
  const eventsByIdRef = useRef(new Map<number, TimelineEvent>());
  const clusterMembersRef = useRef(new Map<string, number[]>());
  // Reverse of clusterMembers — event id → the cluster item id it currently sits
  // in — so a highlighted event that's been clustered glows on its cluster pill.
  const eventToClusterRef = useRef(new Map<number, string>());
  const dataRef = useRef<TimelineResponse | null>(null);
  const usersByIdRef = useRef(new Map<number, User>());
  // The PR bar currently glowing as the "linked" partner of an open marker
  // modal, so we can clear it when the modal closes or moves to another PR.
  const highlightedPrRef = useRef<number | null>(null);
  // Cross-user row focus (Fix 1): the user-group ids kept visible while a
  // cross-user marker modal is open (null = no focus), the set of rows that are
  // currently collapsed/hidden, and any in-flight collapse/expand timers so we
  // can cancel them when focus changes mid-animation.
  const focusedGroupIdsRef = useRef<string[] | null>(null);
  const collapsedRowsRef = useRef<Set<string>>(new Set());
  const focusTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The event currently glowing as the clicked partner of a two-person context
  // (semantic id), plus the actual item carrying the class — an `ev:` marker or,
  // when that event is clustered, the `cl:` cluster pill — so we can clear the
  // right one even after a re-cluster moves the event between items.
  const highlightedEventRef = useRef<number | null>(null);
  const highlightedItemRef = useRef<string | null>(null);
  // Marker drill-down depth mirrored onto the History API (0 closed / 1 popover
  // / 2 a comment picked from a cluster list); the window captured when the
  // drill-down began (restored on back-out); and a counter of popstate events to
  // swallow when we unwind history ourselves.
  const drillDepthRef = useRef(0);
  const savedWindowRef = useRef<{ start: Date; end: Date } | null>(null);
  const suppressPopstateRef = useRef(0);

  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Latest popover state, readable from stable callbacks without re-binding.
  const popoverRef = useRef<PopoverState | null>(null);
  popoverRef.current = popover;

  const { data, isLoading, error } = useTimeline();
  const { data: openPrsData } = useOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const derivedStates = useFilters((s) => s.derivedStates);
  const selectPr = useFilters((s) => s.selectPr);
  const selectedPrId = useFilters((s) => s.selectedPrId);
  // selectedPrId mirrored into a ref so the rebuild effect can keep force-showing
  // the selected PR's bar without taking selectedPrId as a dependency — a plain
  // selection must NOT trigger a rebuild (see the selection effect below).
  const selectedPrIdRef = useRef(selectedPrId);
  // Bumped only when a selection lands on a PR the current filter hides, to ask
  // the rebuild to materialize that one bar.
  const [forceShowNonce, setForceShowNonce] = useState(0);

  const preset = useFilters((s) => s.preset);
  const customFrom = useFilters((s) => s.customFrom);
  const customTo = useFilters((s) => s.customTo);

  const reposById = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of repos ?? []) m.set(r.id, r.fullName);
    return m;
  }, [repos]);
  const usersById = useMemo(() => indexUsers(users), [users]);
  usersByIdRef.current = usersById;

  // PR lookup for the marker modal: attribution ("A acted on B's #123") and the
  // commit deep link, without an extra fetch — the timeline already has these.
  const prsById = useMemo(() => {
    const m = new Map<number, TimelinePr>();
    for (const p of data?.prs ?? []) m.set(p.id, p);
    return m;
  }, [data]);

  // Glow the PR band a marker concerns while its modal is open. The class lives
  // on the DataSet item, so the highlight survives pan/zoom/restack natively.
  const highlightPr = useCallback((prId: number | null) => {
    const items = itemsRef.current;
    const prev = highlightedPrRef.current;
    if (prev != null && prev !== prId) {
      const item = items.get(`pr:${prev}`) as DataItem | null;
      if (item && typeof item.className === 'string') {
        items.update({
          id: `pr:${prev}`,
          className: item.className.replace(/\s*pr-cross-linked/g, ''),
        });
      }
    }
    if (prId != null) {
      const item = items.get(`pr:${prId}`) as DataItem | null;
      if (
        item &&
        typeof item.className === 'string' &&
        !item.className.includes('pr-cross-linked')
      ) {
        items.update({ id: `pr:${prId}`, className: `${item.className} pr-cross-linked` });
      }
    }
    highlightedPrRef.current = prId;
  }, []);

  // Glow the clicked event the same way as its linked PR while a two-person
  // context is shown. The event may be rendered as a lone `ev:` marker or folded
  // into a `cl:` cluster pill — highlight whichever item currently holds it, and
  // remember that exact item so we clear the right one (clusters re-form on zoom).
  const highlightEvent = useCallback((eventId: number | null) => {
    const items = itemsRef.current;
    const prevId = highlightedItemRef.current;
    if (prevId != null) {
      const item = items.get(prevId) as DataItem | null;
      if (item && typeof item.className === 'string' && item.className.includes('ev-cross-linked')) {
        items.update({
          id: prevId,
          className: item.className.replace(/\s*ev-cross-linked/g, ''),
        });
      }
      highlightedItemRef.current = null;
    }
    highlightedEventRef.current = eventId;
    if (eventId == null) return;
    // Resolve to the lone marker, else the cluster pill it's folded into.
    const targetId = items.get(`ev:${eventId}`)
      ? `ev:${eventId}`
      : (eventToClusterRef.current.get(eventId) ?? null);
    if (targetId == null) return; // event not currently rendered
    const item = items.get(targetId) as DataItem | null;
    if (
      item &&
      typeof item.className === 'string' &&
      !item.className.includes('ev-cross-linked')
    ) {
      items.update({ id: targetId, className: `${item.className} ev-cross-linked` });
      highlightedItemRef.current = targetId;
    }
  }, []);

  // Cross-user row focus (Fix 1): collapse every user row except `keepIds` so
  // the two linked rows (actor + PR author) sit together — no vertical jump.
  // `keepIds === null` (or empty) restores all rows. Rows animate via inline
  // max-height measured from the live row height (a true accordion, no clipping
  // and no snap); neighbours reflow because vis rows are normal-flow.
  // `animate: false` force-re-asserts visibility instantly (no animation) — used
  // after a background-sync rebuild, which can re-show a collapsed row and add
  // brand-new rows that must be hidden again seamlessly (Fix 3).
  const focusRows = useCallback((keepIds: string[] | null, animate = true) => {
    const container = containerRef.current;
    if (!container) return;

    // Cancel in-flight timers so rapid switching never leaves a row half-
    // collapsed or fires a deferred visible:false after we re-show it.
    for (const t of focusTimersRef.current) clearTimeout(t);
    focusTimersRef.current = [];

    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const rowEls = (id: string): HTMLElement[] => {
      const token = groupClassToken(id);
      const out: HTMLElement[] = [];
      const fg = container.querySelector<HTMLElement>(
        `.vis-foreground .vis-group.${token}`,
      );
      const lbl = container.querySelector<HTMLElement>(
        `.vis-labelset .vis-label.${token}`,
      );
      if (fg) out.push(fg);
      if (lbl) out.push(lbl);
      return out;
    };

    const clearInline = (id: string): void => {
      for (const el of rowEls(id)) {
        el.style.maxHeight = '';
        el.style.opacity = '';
        el.style.overflow = '';
        el.style.transition = '';
      }
    };

    const collapse = (id: string): void => {
      const els = rowEls(id);
      if (els.length === 0 || reduceMotion) {
        groupsRef.current.update({ id, visible: false });
        return;
      }
      for (const el of els) {
        el.style.overflow = 'hidden';
        el.style.maxHeight = `${el.offsetHeight}px`;
      }
      void els[0]!.offsetHeight; // commit the start height before transitioning
      requestAnimationFrame(() => {
        for (const el of rowEls(id)) {
          el.style.maxHeight = '0px';
          el.style.opacity = '0';
        }
      });
      focusTimersRef.current.push(
        setTimeout(() => groupsRef.current.update({ id, visible: false }), 240),
      );
    };

    const expand = (id: string): void => {
      const g = groupsRef.current.get(id);
      if (g && g.visible === false) groupsRef.current.update({ id, visible: true });
      if (reduceMotion) {
        clearInline(id);
        return;
      }
      // Wait for vis to (re)create + lay out the row, then play 0 → natural.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (const el of rowEls(id)) {
            el.style.maxHeight = ''; // measure natural height
            const h = el.offsetHeight;
            el.style.transition = 'none';
            el.style.overflow = 'hidden';
            el.style.maxHeight = '0px';
            el.style.opacity = '0';
            void el.offsetHeight; // commit the collapsed start
            el.style.transition = ''; // hand back to the CSS transition
            el.style.maxHeight = `${h}px`;
            el.style.opacity = '1';
          }
          focusTimersRef.current.push(setTimeout(() => clearInline(id), 260));
        }),
      );
    };

    // Instant, forced hide/show — no animation. Used by the rebuild re-apply.
    const setHidden = (id: string, hide: boolean): void => {
      if (hide) {
        collapsedRowsRef.current.add(id);
        groupsRef.current.update({ id, visible: false });
      } else {
        collapsedRowsRef.current.delete(id);
        groupsRef.current.update({ id, visible: true });
        clearInline(id);
      }
    };

    const allUserIds = groupsRef.current
      .getIds()
      .map(String)
      .filter((id) => USER_GROUP_RE.test(id));
    const keep = keepIds && keepIds.length ? new Set(keepIds) : null; // null = all

    for (const id of allUserIds) {
      const shouldHide = keep != null && !keep.has(id);
      if (!animate) {
        // Force the desired visibility regardless of the tracked state — a
        // background rebuild may have reset it (and added new rows).
        setHidden(id, shouldHide);
        continue;
      }
      const isCollapsed = collapsedRowsRef.current.has(id);
      if (shouldHide && !isCollapsed) {
        collapsedRowsRef.current.add(id);
        collapse(id);
      } else if (!shouldHide && isCollapsed) {
        collapsedRowsRef.current.delete(id);
        expand(id);
      }
    }

    focusedGroupIdsRef.current = keep ? (keepIds as string[]) : null;
  }, []);

  // (Re)build only the marker/cluster items from current data + current zoom.
  const rebuildMarkers = useCallback(() => {
    const tl = timelineRef.current;
    const container = containerRef.current;
    const cur = dataRef.current;
    if (!tl || !container || !cur) return;
    const win = tl.getWindow();
    const rangeMs = win.end.valueOf() - win.start.valueOf();
    const px = container.clientWidth || 1000;
    const msPerPx = rangeMs / px;

    const { items, clusterMembers } = buildMarkerItems(
      cur.events,
      groupOf,
      usersByIdRef.current,
      msPerPx,
    );
    clusterMembersRef.current = clusterMembers;
    const evToCl = new Map<number, string>();
    for (const [clId, members] of clusterMembers) {
      for (const mid of members) evToCl.set(mid, clId);
    }
    eventToClusterRef.current = evToCl;

    const stale = itemsRef.current
      .getIds()
      .filter((id) => {
        const k = String(id);
        return k.startsWith('ev:') || k.startsWith('cl:');
      });
    itemsRef.current.remove(stale);
    itemsRef.current.add(items);

    // The glow lived on an `ev:`/`cl:` item just removed + re-added: re-assert it
    // so the cross-link survives a re-cluster on manual zoom / a background sync.
    // highlightEvent re-resolves to whichever item now holds the event (marker or
    // cluster pill).
    if (highlightedEventRef.current != null) {
      const ev = highlightedEventRef.current;
      highlightedItemRef.current = null; // the old DOM item is gone
      highlightedEventRef.current = null; // force highlightEvent to re-add the class
      highlightEvent(ev);
    }
  }, [highlightEvent]);

  // Apply (or clear, with null) the whole combined-context overlay at once: the
  // two focused rows, the linked-PR glow, and the clicked-marker glow. Timeline
  // owns this now (not the popover's unmount) so it persists past "Open in
  // detail pane" and is cleared explicitly on dismiss / back.
  const applyContext = useCallback(
    (ctx: ContextFocus | null) => {
      focusRows(ctx?.groupIds ?? null);
      highlightPr(ctx?.prId ?? null);
      highlightEvent(ctx?.eventId ?? null);
    },
    [focusRows, highlightPr, highlightEvent],
  );

  // Restore the window captured when the drill-down began (idempotent across the
  // two back steps). Honors reduced-motion like focusRows does.
  const restoreWindow = useCallback(() => {
    const tl = timelineRef.current;
    const win = savedWindowRef.current;
    if (!tl || !win) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tl.setWindow(win.start, win.end, { animation: !reduceMotion });
  }, []);

  // --- Marker drill-down + browser/mouse-back navigation -------------------
  // The popover journey is mirrored onto the History API so the mouse/browser
  // back button (and the in-popover "‹ back" button, routed through
  // history.back) steps out one level at a time: depth 2 (a comment picked from
  // a cluster) → depth 1 (the cluster list) → depth 0 (closed). Backing out
  // restores the pre-drill window. drillDepthRef is the source of truth;
  // suppressPopstateRef swallows the popstate(s) our own history.go/back emit.

  const openPopover = useCallback(
    (x: number, y: number, eventIds: number[]) => {
      if (eventIds.length === 0) return;
      applyContext(null); // drop any lingering (e.g. post-navigate) overlay
      if (drillDepthRef.current === 0) {
        history.pushState({ ghtmDrill: 1 }, '');
      } else if (drillDepthRef.current === 2) {
        // Collapse the extra entry so we sit on a single drill slot.
        suppressPopstateRef.current += 1;
        history.go(-1);
      }
      drillDepthRef.current = 1;
      // Capture before any selection/scroll side effect can move the window.
      savedWindowRef.current = timelineRef.current?.getWindow() ?? null;
      setPopover({
        x,
        y,
        eventIds,
        picked: eventIds.length === 1 ? eventIds[0]! : null,
      });
    },
    [applyContext],
  );

  // Drill from the cluster list into a single comment (deepens to depth 2).
  const onPick = useCallback((id: number) => {
    const p = popoverRef.current;
    if (!p || p.picked != null || p.eventIds.length <= 1) return;
    drillDepthRef.current = 2;
    history.pushState({ ghtmDrill: 2 }, '');
    setPopover({ ...p, picked: id });
  }, []);

  // In-popover back button → route through history so all three back paths
  // (mouse, browser, button) converge on the popstate handler.
  const onBack = useCallback(() => {
    history.back();
  }, []);

  // Ordinary dismiss (X / outside-click / Escape): tear down immediately for an
  // instant feel, then pop our history entries (one popstate per go(), swallowed).
  const dismissPopover = useCallback(() => {
    const depth = drillDepthRef.current;
    applyContext(null);
    setPopover(null);
    restoreWindow();
    if (depth > 0) {
      suppressPopstateRef.current += 1;
      history.go(-depth);
    }
    drillDepthRef.current = 0;
    savedWindowRef.current = null;
  }, [applyContext, restoreWindow]);

  // Open-in-detail: close the popover but KEEP the overlay + one history entry,
  // so a later back press clears the overlay and restores the window (the detail
  // pane itself stays open).
  const navigatePopover = useCallback(() => {
    if (drillDepthRef.current === 2) {
      suppressPopstateRef.current += 1;
      drillDepthRef.current = 1;
      history.go(-1);
    }
    setPopover(null);
  }, []);

  // The single back-handler for the mouse/browser back button.
  useEffect(() => {
    const onPopState = (): void => {
      if (suppressPopstateRef.current > 0) {
        suppressPopstateRef.current -= 1;
        return;
      }
      const depth = drillDepthRef.current;
      if (depth >= 2) {
        // Back to the cluster list: clear the overlay, restore the window.
        drillDepthRef.current = 1;
        setPopover((p) => (p ? { ...p, picked: null } : p));
        applyContext(null);
        restoreWindow();
      } else if (depth === 1) {
        // Out of the drill-down entirely.
        drillDepthRef.current = 0;
        applyContext(null);
        setPopover(null);
        restoreWindow();
        savedWindowRef.current = null;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyContext, restoreWindow]);

  // Create the timeline once.
  useEffect(() => {
    if (!containerRef.current) return;
    const { from, to } = resolveRange(useFilters.getState());
    const timeline = new VisTimeline(
      containerRef.current,
      itemsRef.current,
      groupsRef.current,
      { ...VIS_OPTIONS, start: from, end: to, zoomKey: zoomModifierKey() },
    );

    timeline.on('click', (props: {
      item: string | number | null;
      event: { srcEvent?: MouseEvent } & Partial<MouseEvent>;
      pageX?: number;
      pageY?: number;
    }) => {
      const id = props.item;
      if (id == null) {
        setPopover(null);
        return;
      }
      const key = String(id);
      const native = props.event?.srcEvent ?? props.event;
      const x = native?.clientX ?? props.pageX ?? 0;
      const y = native?.clientY ?? props.pageY ?? 0;

      if (key.startsWith('pr:')) {
        selectPr(Number.parseInt(key.slice(3), 10));
        setPopover(null);
      } else if (key.startsWith('ev:')) {
        // Every single marker (commit, comment, review) opens the closely-
        // positioned modal; the modal shows detail + attribution and offers
        // "Open in detail pane" / "Open on GitHub" to drill in. While it's open
        // the related PR band glows (see highlightPr, wired via MarkerPopover).
        const evId = Number.parseInt(key.slice(3), 10);
        openPopover(x, y, [evId]);
      } else if (key.startsWith('cl:')) {
        // A cluster opens the list popover (pick a comment to drill in). The
        // timeline is stable now, so we no longer zoom into the cluster span.
        const members = clusterMembersRef.current.get(key) ?? [];
        openPopover(x, y, members);
      } else {
        setPopover(null);
      }
    });

    // Re-cluster when the zoom level changes (a burst that smears at one zoom
    // may separate at another).
    let reclusterTimer: ReturnType<typeof setTimeout> | null = null;
    timeline.on('rangechanged', () => {
      if (reclusterTimer) clearTimeout(reclusterTimer);
      reclusterTimer = setTimeout(() => rebuildMarkers(), 120);
    });

    timelineRef.current = timeline;
    return () => {
      if (reclusterTimer) clearTimeout(reclusterTimer);
      timeline.destroy();
      timelineRef.current = null;
    };
  }, [selectPr, rebuildMarkers, openPopover]);

  // Rebuild groups + PR bars when data or the derived-state filter changes.
  useEffect(() => {
    if (!data) return;
    dataRef.current = data;

    const prs: TimelinePr[] = data.prs.filter(
      (pr) =>
        // Always render the selected PR's bar so event→PR navigation has a
        // target even when the derived-state filter would otherwise hide it.
        pr.id === selectedPrIdRef.current ||
        derivedStates.length === 0 ||
        derivedStates.some((s) => pr.threadCounts[s] > 0),
    );

    const evMap = new Map<number, TimelineEvent>();
    for (const ev of data.events) evMap.set(ev.id, ev);
    eventsByIdRef.current = evMap;

    // Per-user interaction tallies for the row labels — from the full timeframe
    // (all events + all PRs), so they don't shift with the thread-state filter.
    const userStats = computeUserStats(data.events, data.prs);

    const repoIds = unique([
      ...prs.map((p) => p.repoId),
      ...data.events.map((e) => e.repoId),
    ]);

    const groups: DataGroup[] = [];
    for (const rid of repoIds) {
      // A member sub-row exists for anyone who either acted in this repo or
      // authored a PR shown here. The latter keeps a row for PR authors with no
      // events (so their bar has a home); the former keeps a row for pure
      // reviewers (markers, no bar) — every contributor stays visible.
      const memberIds = unique([
        ...data.events
          .filter((e) => e.repoId === rid && e.actorId != null)
          .map((e) => e.actorId as number),
        ...prs
          .filter((p) => p.repoId === rid && p.authorId != null)
          .map((p) => p.authorId as number),
      ]);
      const nested = memberIds.map((uid) => `repo:${rid}:user:${uid}`);
      groups.push({
        id: `repo:${rid}`,
        content: reposById.get(rid) ?? `repo ${rid}`,
        nestedGroups: nested.length ? nested : undefined,
        treeLevel: 1,
      } as DataGroup);
      for (const uid of memberIds) {
        const gid = `repo:${rid}:user:${uid}`;
        groups.push({
          id: gid,
          content: renderUserLabel(usersById.get(uid), uid, userStats.get(uid)),
          treeLevel: 2,
          // `tl-user-row` scopes the collapse transition; the per-group token
          // lets focusRows find this row's label + bar to animate (Fix 1).
          className: `tl-user-row ${groupClassToken(gid)}`,
        } as DataGroup);
      }
    }

    const prItems: DataItem[] = prs.map((pr) => {
      const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      // The PR creator owns the band in their own row; fall back to the repo
      // row only when the author is unknown.
      const group =
        pr.authorId != null
          ? `repo:${pr.repoId}:user:${pr.authorId}`
          : `repo:${pr.repoId}`;
      return {
        id: `pr:${pr.id}`,
        group,
        type: 'range',
        start: pr.openedAt,
        end: pr.mergedAt ?? pr.closedAt ?? new Date().toISOString(),
        content: renderPrBar(pr, {
          label: userLabel(author, pr.authorId),
          avatarUrl: author?.avatarUrl ?? null,
        }),
        className: prClassName(pr),
        title: `#${pr.number} ${pr.title}`,
      } as DataItem;
    });

    // Diff the DataSets in place rather than clear()+add(). update() merges by
    // id and only ever adds/updates — vis keeps the existing DOM rows, so the
    // vertical scroll, the visible window, and the selection all survive a
    // background-sync refetch (Fix 3). Only genuinely-gone ids are removed.
    const tl = timelineRef.current;
    const win = tl?.getWindow();

    const nextGroupIds = new Set(groups.map((g) => String(g.id)));
    groupsRef.current.update(groups);
    const goneGroups = groupsRef.current
      .getIds()
      .map(String)
      .filter((id) => !nextGroupIds.has(id));
    if (goneGroups.length) groupsRef.current.remove(goneGroups);

    const nextPrIds = new Set(prItems.map((i) => String(i.id)));
    const gonePr = itemsRef.current
      .getIds()
      .map(String)
      .filter((id) => id.startsWith('pr:') && !nextPrIds.has(id));
    itemsRef.current.update(prItems);
    if (gonePr.length) itemsRef.current.remove(gonePr);

    rebuildMarkers();

    // Pin the window across the rebuild (belt-and-suspenders; the diff alone
    // shouldn't move it).
    if (tl && win) tl.setWindow(win.start, win.end, { animation: false });

    // Re-assert overlay state so an open marker modal survives a background
    // sync untouched: selection, the cross-link glow, and the row focus.
    const selPr = selectedPrIdRef.current;
    if (
      selPr != null &&
      tl &&
      itemsRef.current.get(`pr:${selPr}`) &&
      !tl.getSelection().map(String).includes(`pr:${selPr}`)
    ) {
      tl.setSelection([`pr:${selPr}`]);
    }
    if (highlightedPrRef.current != null) {
      const hp = highlightedPrRef.current;
      highlightedPrRef.current = null; // reset so highlightPr re-adds the class
      highlightPr(hp);
    }
    if (focusedGroupIdsRef.current) {
      focusRows(focusedGroupIdsRef.current, false); // instant re-assert, no animation
    }
  }, [
    data,
    derivedStates,
    reposById,
    usersById,
    forceShowNonce,
    rebuildMarkers,
    highlightPr,
    focusRows,
  ]);

  // Reflect the active PR selection without disturbing the view. Selecting a PR
  // — clicking its bar, j/k cycling, a marker's "open in detail" — is a purely
  // visual change: vis's setSelection only toggles a class, it never scrolls.
  // We deliberately keep it OUT of the rebuild effect above (which re-filters
  // PRs, rebuilds every row, and re-clusters every marker); running that on a
  // plain click was what made the timeline jump around. Intentional scroll-to-PR
  // navigation goes through the separate timelineFocusPr effect below.
  useEffect(() => {
    selectedPrIdRef.current = selectedPrId;
    const tl = timelineRef.current;
    if (!tl) return;
    // The selected PR's bar can be hidden by the derived-state filter (j/k
    // cycles the full PR list; a marker may belong to a filtered-out PR). Force
    // one rebuild to materialize the bar — its tail re-asserts the selection.
    if (selectedPrId != null && !itemsRef.current.get(`pr:${selectedPrId}`)) {
      setForceShowNonce((n) => n + 1);
      return;
    }
    const want = selectedPrId != null ? [`pr:${selectedPrId}`] : [];
    const cur = tl.getSelection().map(String);
    const same =
      cur.length === want.length && want.every((id) => cur.includes(id));
    if (!same) tl.setSelection(want);
  }, [selectedPrId]);

  // Move the visible window when the range preset changes.
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    const { from, to } = resolveRange(useFilters.getState());
    tl.setWindow(from, to, { animation: false });
  }, [preset, customFrom, customTo]);

  // Scroll the timeline to a PR opened from the strip / my-turn / an event.
  const timelineFocusPr = useFilters((s) => s.timelineFocusPr);
  const timelineFocusAt = useFilters((s) => s.timelineFocusAt);
  useEffect(() => {
    if (timelineFocusPr == null) return;
    const tl = timelineRef.current;
    if (!tl) return;

    const inWindow = data?.prs.find((p) => p.id === timelineFocusPr);
    if (inWindow) {
      const win = tl.getWindow();
      const width = win.end.valueOf() - win.start.valueOf();
      // Recenter on the clicked event's instant when provided, otherwise on the
      // PR bar's midpoint. The former avoids a big jump when a long-running PR's
      // midpoint is far from the event the user clicked.
      let center: number;
      if (timelineFocusAt) {
        center = Date.parse(timelineFocusAt);
      } else {
        const startMs = new Date(inWindow.openedAt).getTime();
        const endMs = new Date(
          inWindow.mergedAt ?? inWindow.closedAt ?? new Date().toISOString(),
        ).getTime();
        center = (startMs + endMs) / 2;
      }
      tl.setWindow(center - width / 2, center + width / 2, { animation: true });
      tl.setSelection([`pr:${timelineFocusPr}`]);
      useFilters.getState().consumeTimelineFocus();
      return;
    }

    const candidate = openPrsData?.prs.find((p) => p.id === timelineFocusPr);
    if (candidate) {
      const { from } = resolveRange(useFilters.getState());
      const openedMs = new Date(candidate.openedAt).getTime();
      if (openedMs < from.getTime()) {
        const day = new Date(openedMs - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        useFilters.getState().setCustomRange(day, today);
        return;
      }
    }
    useFilters.getState().consumeTimelineFocus();
  }, [timelineFocusPr, timelineFocusAt, data, openPrsData]);

  return (
    <div className="relative h-full w-full">
      {isLoading && !data && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">
          Loading timeline…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-red-500">
          {String(error)}
        </div>
      )}
      {data && data.prs.length === 0 && data.events.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">
          No activity in this window. Add a repo or widen the date range.
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
      {popover && (
        <MarkerPopover
          state={popover}
          eventsById={eventsByIdRef.current}
          usersById={usersById}
          prsById={prsById}
          onContextFocus={applyContext}
          onDismiss={dismissPopover}
          onNavigate={navigatePopover}
          onPick={onPick}
          onBack={onBack}
        />
      )}
    </div>
  );
}
