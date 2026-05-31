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
import {
  useMergers,
  useSearchTimeline,
  useTimeline,
  useRepos,
  useUsers,
} from '../../hooks/useTimeline.js';
import { useOpenPrs, useSearchOpenPrs } from '../../hooks/useTriage.js';
import { resolveRange, useFilters } from '../../store/filters.js';
import { indexUsers, userLabel } from '../../lib/ui.js';
import { renderPrBar, prClassName } from './prBar.js';
import { computeUserStats, renderUserLabel } from './userRow.js';
import { buildMarkerItems } from './clustering.js';
import { assignPrLanes, prGroupId } from './lanes.js';
import {
  MarkerPopover,
  type ContextFocus,
  type PopoverState,
} from './MarkerPopover.js';

const ZOOM_MIN_MS = 1000 * 60 * 60;
const FOCUS_GLOW_MS = 2000; // matches the pr-focus-glow keyframe in index.css

const VIS_OPTIONS: TimelineOptions = {
  // stack:false + stackSubgroups:true is the "subgroups as ordered single-line
  // bands" mode (vis `nostack`): every subgroup occupies its own horizontal line
  // and items within it never stack vertically — they share one line even when
  // bunched. We lean on this to give each PR a [bar line · own-events line] pair
  // (ordered by the per-item `sortKey`, see subgroupOrder on the groups) and to
  // drop every cross-user marker onto one shared line at the bottom of the row.
  // (With stack:true vis ignores subgroups for layout and full-stacks instead.)
  stack: false,
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

// Order-independent equality for the repo filter (null = "all repos"). Used to
// detect a *genuine* repo-selection change so focus mode can be dropped only
// then — not on every unrelated re-render.
function sameRepoSelection(a: number[] | null, b: number[] | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Parse a row-label HTML string into a live DOM element ONCE, so it can be
// handed to vis as the group `content`. vis's Group.setData re-applies a group's
// content on every `groupsData.update()` — including a bare `{ visible }` toggle.
// With a string it re-parses the whole label (`innerHTML = …`) each time; with an
// Element it just re-appends the cached node. The focus feature toggles `visible`
// on every off-screen row (dozens–hundreds), so a string label turns each
// enter/exit-focus into hundreds of synchronous innerHTML re-parses (~1.8s on a
// large board). The element is built in the main document so vis can append it
// without cross-document adoption.
function labelElement(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return (host.firstElementChild as HTMLElement | null) ?? host;
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
  // The cross-band divider items (`xsep:<group>`) from the last marker build, for
  // ALL cross-active rows. vis renders `type:background` items regardless of the
  // group's `visible` flag, so a collapsed (focus-hidden) row keeps painting its
  // full-width divider line. We gate them ourselves: drop the divider for any
  // collapsed row and restore it on expand (see applyCrossSeps).
  const allXsepItemsRef = useRef<DataItem[]>([]);
  const dataRef = useRef<TimelineResponse | null>(null);
  const usersByIdRef = useRef(new Map<number, User>());
  // PR lookup mirrored into a ref so the stable rebuildMarkers callback can
  // resolve each event's PR author (own-work flag) without re-binding.
  const prsByIdRef = useRef(new Map<number, TimelinePr>());
  // prId -> packed lane index, mirrored into a ref so rebuildMarkers (own-work
  // event bands) and focusSubgroups (the kept lane band) can read the same lane
  // assignment the bar build used, without re-binding on every data change.
  const prLanesRef = useRef(new Map<number, number>());
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
  // While a cross-user context is focused, each kept row still carries a band per
  // PR its user ever touched — for a prolific contributor that's dozens of bars
  // stacked into an unreadable wall. We hide every band in the focused rows that
  // isn't the interaction itself (the discussed PR's bar/events + the cross band)
  // via vis `subgroupVisibility`. This maps each focused group id to the subgroup
  // ids we set hidden, so we can flip them back visible when the focus clears.
  const hiddenSubgroupsRef = useRef<Map<string, string[]>>(new Map());
  // The event currently glowing as the clicked partner of a two-person context
  // (semantic id), plus the actual item carrying the class — an `ev:` marker or,
  // when that event is clustered, the `cl:` cluster pill — so we can clear the
  // right one even after a re-cluster moves the event between items.
  const highlightedEventRef = useRef<number | null>(null);
  const highlightedItemRef = useRef<string | null>(null);
  // The marker that opened the current focus, re-shown with a one-shot fade glow
  // (no marching ants) when the user leaves focus so they can relocate where they
  // were. Mirrors highlightedEvent/Item but for the transient `ev-exit-glow`
  // class, plus a timer that strips it once the 3s fade completes.
  const exitGlowEventRef = useRef<number | null>(null);
  const exitGlowItemRef = useRef<string | null>(null);
  const exitGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The strip / search "locate the bar" cue: a finite sky glow (no marching ants)
  // on a focused PR bar, plus a timer that strips it once the ~2s fade completes.
  const prFocusGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An open PR opened *within* the window but absent from the lean /api/timeline
  // payload (it had no in-window activity). The focus path stages it here so the
  // next rebuild materializes its bar; cleared once the rebuild consumes it.
  const forceShowOpenPrRef = useRef<TimelinePr | null>(null);
  // True while a sticky "Show on timeline" overlay (from the activity panel) is
  // applied — a glowing marker plus, for a cross-user action, the collapsed
  // two-person row focus. Unlike the marker popover it has nothing to dismiss
  // it, so it persists until the next timeline interaction; the click handler
  // and openPrFocused read this to expand back to all users.
  const showFocusActiveRef = useRef(false);
  // Marker drill-down depth mirrored onto the History API (0 closed / 1 popover
  // / 2 a comment picked from a cluster list); the window captured when the
  // drill-down began (restored on back-out); and a counter of popstate events to
  // swallow when we unwind history ourselves.
  const drillDepthRef = useRef(0);
  const savedWindowRef = useRef<{ start: Date; end: Date } | null>(null);
  // Vertical scroll captured alongside savedWindowRef when the cluster popover
  // opens, so backing out of a picked comment returns to where the cluster sat
  // (the row-expand on back otherwise leaves the scroll at the top).
  const savedScrollTopRef = useRef<number | null>(null);
  // Event whose cluster should get the "you returned here" glow once the popover
  // is back in list mode (applied in an effect, see below).
  const pendingClusterGlowRef = useRef<number | null>(null);
  const suppressPopstateRef = useRef(0);

  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Latest popover state, readable from stable callbacks without re-binding.
  const popoverRef = useRef<PopoverState | null>(null);
  popoverRef.current = popover;
  // True whenever a row-collapse focus overlay is active (a cross-user marker or
  // an activity "Show"). Drives the bottom-left "Exit focus" button. Clicking the
  // timeline no longer reverts focus — this button (or browser-back) is the way
  // out, so it must be visible the whole time the timeline is collapsed.
  const [focusActive, setFocusActive] = useState(false);

  const { data, isLoading, error } = useTimeline();
  const { data: openPrsData } = useOpenPrs();
  // Member-agnostic PR sets (shared cache with the PR-title search). They let a
  // global search pick focus a PR the member filter hides: if it overlaps the
  // window it's here, so we force-show its bar in place; an old open PR found
  // only here widens the range like the strip does. Dedupes with the filtered
  // queries when no member filter is active (identical key → no extra fetch).
  const { data: searchData } = useSearchTimeline();
  const { data: searchOpenPrsData } = useSearchOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const { data: mergers } = useMergers();
  const derivedStates = useFilters((s) => s.derivedStates);
  // Member filter: when set, the timeline collapses to just these contributors'
  // rows (see the PR filter in the rebuild effect). Events are already actor-
  // filtered server-side, so restricting which PR bars render is enough to drop
  // every non-selected author's row.
  const userIds = useFilters((s) => s.userIds);
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
  // repoId → set of userIds with merge rights there (have merged a PR). Drives
  // the maintainer shield on each contributor row label.
  const mergersByRepo = useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const e of mergers ?? []) m.set(e.repoId, new Set(e.userIds));
    return m;
  }, [mergers]);
  const usersById = useMemo(() => indexUsers(users), [users]);
  usersByIdRef.current = usersById;

  // PR lookup for the marker modal: attribution ("A acted on B's #123") and the
  // commit deep link, without an extra fetch — the timeline already has these.
  const prsById = useMemo(() => {
    const m = new Map<number, TimelinePr>();
    for (const p of data?.prs ?? []) m.set(p.id, p);
    return m;
  }, [data]);
  prsByIdRef.current = prsById;

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

  // Add / move / clear the transient `ev-exit-glow` class on whichever item
  // currently holds `eventId` (a lone `ev:` marker or the `cl:` cluster it folded
  // into). Mirrors highlightEvent, but the class drives a finite 3s fade with no
  // marching-ants ring — the "you exited focus here" cue.
  const applyExitGlow = useCallback((eventId: number | null) => {
    const items = itemsRef.current;
    // Strip the glow from EVERY item that currently holds it before re-applying.
    // A recluster within the glow's lifetime (e.g. the restore-window rebuild on
    // back-out) can re-key the cluster and strand the class on a now-detached
    // copy, so tracking a single item ref isn't enough to guarantee one glow.
    for (const id of items.getIds()) {
      const it = items.get(id) as DataItem | null;
      if (it && typeof it.className === 'string' && it.className.includes('ev-exit-glow')) {
        items.update({ id, className: it.className.replace(/\s*ev-exit-glow/g, '') });
      }
    }
    exitGlowItemRef.current = null;
    exitGlowEventRef.current = eventId;
    if (eventId == null) return;
    const targetId = items.get(`ev:${eventId}`)
      ? `ev:${eventId}`
      : (eventToClusterRef.current.get(eventId) ?? null);
    if (targetId == null) return; // event not currently rendered
    const item = items.get(targetId) as DataItem | null;
    if (
      item &&
      typeof item.className === 'string' &&
      !item.className.includes('ev-exit-glow')
    ) {
      items.update({ id: targetId, className: `${item.className} ev-exit-glow` });
      exitGlowItemRef.current = targetId;
    }
  }, []);

  // Flash the exit glow on `eventId` for 3s, then strip it. A re-cluster within
  // that window re-applies it (see rebuildMarkers), so it survives a zoom/refetch.
  const flashExitGlow = useCallback(
    (eventId: number) => {
      if (exitGlowTimerRef.current) clearTimeout(exitGlowTimerRef.current);
      applyExitGlow(eventId);
      exitGlowTimerRef.current = setTimeout(() => {
        applyExitGlow(null);
        exitGlowTimerRef.current = null;
      }, 3000);
    },
    [applyExitGlow],
  );

  // Flash a finite sky glow on a PR bar for FOCUS_GLOW_MS, then strip it. Used by
  // the strip / search focus path — "locate the bar" feedback without the infinite
  // marching-ants ring cross-user focus mode uses (pr-cross-linked). Operates on
  // the `pr:<id>` DataSet item directly (like highlightPr) so it survives a
  // restack; re-resolves the item on the strip-off timeout because a background
  // rebuild may have replaced it in the meantime.
  const flashPrFocusGlow = useCallback((prId: number) => {
    const items = itemsRef.current;
    if (prFocusGlowTimerRef.current) clearTimeout(prFocusGlowTimerRef.current);
    // Clear the class off any bar that still carries it (rapid re-clicks).
    for (const it of items.get() as DataItem[]) {
      if (typeof it.className === 'string' && it.className.includes('pr-focus-glow')) {
        items.update({ id: it.id, className: it.className.replace(/\s*pr-focus-glow/g, '') });
      }
    }
    const item = items.get(`pr:${prId}`) as DataItem | null;
    if (!item || typeof item.className !== 'string') return;
    if (!item.className.includes('pr-focus-glow')) {
      items.update({ id: `pr:${prId}`, className: `${item.className} pr-focus-glow` });
    }
    prFocusGlowTimerRef.current = setTimeout(() => {
      const it = items.get(`pr:${prId}`) as DataItem | null;
      if (it && typeof it.className === 'string') {
        items.update({ id: `pr:${prId}`, className: it.className.replace(/\s*pr-focus-glow/g, '') });
      }
      prFocusGlowTimerRef.current = null;
    }, FOCUS_GLOW_MS);
  }, []);

  // Reconcile the cross-band divider items with the current collapsed set: a
  // divider only belongs in a row that's actually showing. vis paints
  // `type:background` items even when their group is `visible:false` (and
  // re-creates the background row on every redraw, defeating any inline clip), so
  // removing the item itself is the only reliable way to drop the stray
  // full-width line a collapsed row would otherwise leave behind. Idempotent:
  // re-adds a divider as soon as its row is no longer collapsed.
  const applyCrossSeps = useCallback(() => {
    const items = itemsRef.current;
    const collapsed = collapsedRowsRef.current;
    const remove: string[] = [];
    const add: DataItem[] = [];
    for (const xs of allXsepItemsRef.current) {
      const id = String(xs.id);
      const hidden = collapsed.has(String(xs.group));
      const present = items.get(id) != null;
      if (hidden && present) remove.push(id);
      else if (!hidden && !present) add.push(xs);
    }
    if (remove.length) items.remove(remove);
    if (add.length) items.add(add);
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

    // The animation primitives below touch ONLY inline styles. The vis `visible`
    // data toggles are collected and applied in a SINGLE batched
    // `groupsData.update([...])` per direction (see the dispatch below). vis
    // re-runs Group.setData and schedules a redraw on every groupsData.update,
    // so toggling rows one-by-one turned a focus enter/exit on a large board into
    // hundreds of redraw passes (~hundreds of ms). Batching collapses them to one
    // redraw per direction.

    // Begin the collapse animation for an on-screen row (returns false when the
    // row has no rendered DOM — an off-screen/virtualized row — so the caller
    // hides it immediately instead). The matching `visible:false` is applied by
    // the deferred batch once the 240ms transition has played.
    const animateCollapseStart = (id: string): boolean => {
      const els = rowEls(id);
      if (els.length === 0) return false;
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
      return true;
    };

    // Play 0 → natural for a row whose `visible:true` has already been applied by
    // the batched update above. Wait for vis to (re)create + lay out the row.
    const animateExpand = (id: string): void => {
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

    const allUserIds = groupsRef.current
      .getIds()
      .map(String)
      .filter((id) => USER_GROUP_RE.test(id));
    const keep = keepIds && keepIds.length ? new Set(keepIds) : null; // null = all

    if (!animate) {
      // Instant, forced hide/show — used by the rebuild re-apply. Force the
      // desired visibility for EVERY row (a background rebuild may have reset it
      // and added new rows), in one batched update.
      const batch: { id: string; visible: boolean }[] = [];
      for (const id of allUserIds) {
        const shouldHide = keep != null && !keep.has(id);
        if (shouldHide) collapsedRowsRef.current.add(id);
        else collapsedRowsRef.current.delete(id);
        batch.push({ id, visible: !shouldHide });
      }
      if (batch.length) groupsRef.current.update(batch);
      for (const id of allUserIds) {
        if (!(keep != null && !keep.has(id))) clearInline(id);
      }
    } else {
      const showNow: { id: string; visible: boolean }[] = []; // expands (any)
      const expandAnimate: string[] = []; // on-screen expands to animate
      const hideNow: { id: string; visible: boolean }[] = []; // off-screen collapses
      const hideDeferred: string[] = []; // on-screen collapses (hidden post-anim)
      for (const id of allUserIds) {
        const shouldHide = keep != null && !keep.has(id);
        const isCollapsed = collapsedRowsRef.current.has(id);
        if (shouldHide && !isCollapsed) {
          collapsedRowsRef.current.add(id);
          if (!reduceMotion && animateCollapseStart(id)) hideDeferred.push(id);
          else hideNow.push({ id, visible: false });
        } else if (!shouldHide && isCollapsed) {
          collapsedRowsRef.current.delete(id);
          showNow.push({ id, visible: true });
          if (!reduceMotion) expandAnimate.push(id);
        }
      }
      // Reveal every expanding row in one update so vis lays them out in a single
      // redraw, THEN animate each (the rows now exist in the DOM to measure).
      if (showNow.length) groupsRef.current.update(showNow);
      if (reduceMotion) for (const { id } of showNow) clearInline(id);
      else for (const id of expandAnimate) animateExpand(id);
      // Off-screen collapses hide immediately; on-screen ones hide after their
      // 240ms transition — each direction a single batched update.
      if (hideNow.length) groupsRef.current.update(hideNow);
      if (hideDeferred.length) {
        focusTimersRef.current.push(
          setTimeout(
            () =>
              groupsRef.current.update(
                hideDeferred.map((id) => ({ id, visible: false })),
              ),
            240,
          ),
        );
      }
    }

    focusedGroupIdsRef.current = keep ? (keepIds as string[]) : null;

    // Drop the cross-band divider for any row we just collapsed (and restore it
    // for any we just expanded) — collapsedRowsRef now reflects the new state.
    applyCrossSeps();
  }, [applyCrossSeps]);

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
      prsByIdRef.current,
      prLanesRef.current,
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
        return k.startsWith('ev:') || k.startsWith('cl:') || k.startsWith('xsep:');
      });
    itemsRef.current.remove(stale);
    itemsRef.current.add(items);

    // Remember every cross-band divider, then drop the ones whose row is
    // currently focus-collapsed (a recluster on zoom / a background sync rebuilds
    // them all, so re-gate each time).
    allXsepItemsRef.current = items.filter((it) => String(it.id).startsWith('xsep:'));
    applyCrossSeps();

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
    // Same for a still-fading exit glow (its 3s timer can outlive a recluster).
    if (exitGlowEventRef.current != null) {
      const ev = exitGlowEventRef.current;
      exitGlowItemRef.current = null;
      exitGlowEventRef.current = null;
      applyExitGlow(ev);
    }
  }, [highlightEvent, applyExitGlow, applyCrossSeps]);

  // Within a focused cross-user context, trim each kept row to just the bands
  // that belong to the interaction "actor commented on author's PR":
  //   • the PR AUTHOR's row keeps the discussed PR's lane (`bar:<lane>` +
  //     `ev:<lane>`) plus `cross` — so their PR bar is what you see.
  //   • the COMMENTER's (actor's) row keeps ONLY `cross` — every one of their own
  //     PR bars is hidden, so the row shows nothing but the comment marker itself.
  // Without the author/actor split both rows showed whatever PR happened to sit in
  // the kept lane index, surfacing the commenter's unrelated work. A no-op unless
  // we have both the kept rows and the PR. Always restores the previously-hidden
  // bands first so switching focus / clearing never strands a hidden band.
  const focusSubgroups = useCallback(
    (groupIds: string[] | null, prId: number | null) => {
      const groups = groupsRef.current;

      // Restore whatever the last focus hid.
      for (const [gid, hidden] of hiddenSubgroupsRef.current) {
        if (!groups.get(gid)) continue;
        const reset: Record<string, boolean> = {};
        for (const sg of hidden) reset[sg] = true;
        groups.update({ id: gid, subgroupVisibility: reset });
      }
      hiddenSubgroupsRef.current.clear();

      if (!groupIds || groupIds.length === 0 || prId == null) return;

      const lane = prLanesRef.current.get(prId);
      const pr = prsByIdRef.current.get(prId);
      const authorGroup = pr ? prGroupId(pr) : null;
      const items = itemsRef.current.get() as DataItem[];
      for (const gid of groupIds) {
        // Author's row keeps the discussed PR's lane; the commenter's row keeps
        // only the shared cross band (no PR bars of their own).
        const keep = new Set(['cross']);
        if (gid === authorGroup && lane != null) {
          keep.add(`bar:${lane}`);
          keep.add(`ev:${lane}`);
        }
        const present = new Set<string>();
        for (const it of items) {
          if (it.group === gid && typeof it.subgroup === 'string') {
            present.add(it.subgroup);
          }
        }
        const hide = [...present].filter((sg) => !keep.has(sg));
        if (hide.length === 0) continue;
        const vis: Record<string, boolean> = {};
        for (const sg of hide) vis[sg] = false;
        groups.update({ id: gid, subgroupVisibility: vis });
        hiddenSubgroupsRef.current.set(gid, hide);
      }
    },
    [],
  );

  // Apply (or clear, with null) the whole combined-context overlay at once: the
  // two focused rows, the bands trimmed to the interaction, the linked-PR glow,
  // and the clicked-marker glow. Timeline owns this now (not the popover's
  // unmount) so it persists past "Open in detail pane" and is cleared explicitly
  // on dismiss / back.
  const applyContext = useCallback(
    (ctx: ContextFocus | null) => {
      // A fresh context (or a clear) supersedes any still-fading exit-glow cue —
      // drop it first, else re-opening the just-exited marker would stack the
      // exit glow under the cross-link pulse for the rest of the 3s window.
      if (exitGlowTimerRef.current) {
        clearTimeout(exitGlowTimerRef.current);
        exitGlowTimerRef.current = null;
      }
      applyExitGlow(null);
      focusSubgroups(ctx?.groupIds ?? null, ctx?.prId ?? null);
      focusRows(ctx?.groupIds ?? null);
      highlightPr(ctx?.prId ?? null);
      highlightEvent(ctx?.eventId ?? null);
      // Track whether rows are collapsed so the "Exit focus" button shows. A null
      // context (or one with no kept rows) means we're back to the full view.
      // Mirror it into the store too so the keyboard hook (Escape) can tell
      // focus is up and route to exitFocus instead of clearing the selection.
      const active = !!(ctx?.groupIds && ctx.groupIds.length > 0);
      setFocusActive(active);
      useFilters.getState().setFocusActive(active);
      if (!active) showFocusActiveRef.current = false;
    },
    [focusSubgroups, focusRows, highlightPr, highlightEvent, applyExitGlow],
  );

  // --- Activity "Show" vertical scrolling ----------------------------------
  // vis-timeline's focus() only scrolls vertically to an ALREADY-rendered item
  // (getItemVerticalScroll bails when the item has no rendered parent), and rows
  // virtualize — an off-screen row is a thin stub until scrolled in. So focusing
  // an off-screen activity does nothing. Instead we drive vis's own vertical
  // scroll: vis listens to the native `scroll` of its `.vis-vertical-scroll`
  // panel and mirrors it into the timeline (_setScrollTop + redraw), so setting
  // that element's scrollTop reliably scrolls + materializes rows regardless of
  // what's currently rendered.
  const verticalScrollEl = useCallback((): HTMLElement | null => {
    const c = containerRef.current;
    if (!c) return null;
    return (
      c.querySelector<HTMLElement>('.vis-panel.vis-left.vis-vertical-scroll') ??
      c.querySelector<HTMLElement>('.vis-panel.vis-right.vis-vertical-scroll')
    );
  }, []);

  const setVisScrollTop = useCallback(
    (top: number) => {
      const vs = verticalScrollEl();
      if (!vs) return;
      const max = Math.max(0, vs.scrollHeight - vs.clientHeight);
      vs.scrollTop = Math.max(0, Math.min(max, top));
      // The programmatic set fires a native 'scroll' too, but dispatching now
      // makes vis re-layout synchronously so a follow-up measurement is fresh.
      vs.dispatchEvent(new Event('scroll'));
    },
    [verticalScrollEl],
  );

  // Bring the "Show" target into view and centre it. Called after the row-focus
  // collapse has settled. The target glow is the clicked marker (`ev-cross-linked`)
  // when the event has one, else the PR bar (`pr-cross-linked`) for lifecycle.
  // We coarse-scroll to the row top, then each frame measure the glow's distance
  // from centre and correct by exactly that delta (vis clamps it, so a target on a
  // far band is reached by repeated clamped jumps), holding until it stays centred
  // a few frames running — rendering the tall row keeps reflowing it, and a target
  // on the bottom cross band only becomes reachable once the row grows to full
  // height (~1s+ after the click), so a single pass isn't enough. The ~1.5s frame
  // cap is a backstop; the stable-streak ends it promptly once the layout settles.
  const centerShowTarget = useCallback(
    (
      groupToken: string,
      hasMarker: boolean,
      markerSel = '.ev-cross-linked',
      lifecycleSel = '.pr-cross-linked',
    ) => {
      const container = containerRef.current;
      const vs = verticalScrollEl();
      const center = container?.querySelector<HTMLElement>('.vis-panel.vis-center');
      if (!container || !vs || !center) return;
      const labelSel = `.vis-labelset .vis-label.${groupToken}`;
      // Lifecycle target lock: once we've resolved the glow bar, keep centring on
      // that element even if its glow class is later stripped (the 2s fade ending
      // mid-settle on slow hardware where the frame loop outlives the fade) —
      // re-resolving by selector would otherwise fall back to the row label and
      // shift the final centre.
      let lockedTarget: HTMLElement | undefined;

      const deltaTo = (el: HTMLElement): number => {
        const cRect = center.getBoundingClientRect();
        const tRect = el.getBoundingClientRect();
        return tRect.top + tRect.height / 2 - cRect.top - cRect.height / 2;
      };
      // `settleable` is true only when we're measuring the ACTUAL target (the
      // marker, or the PR bar for lifecycle) — never the row-bottom proxy used to
      // scroll an unrendered marker into view. The loop may only stop once the
      // real target is centred, so it can't settle on the proxy mid-scroll.
      const measureDelta = (): { delta: number; settleable: boolean } | null => {
        const biggest = (sel: string): HTMLElement | undefined =>
          [...container.querySelectorAll<HTMLElement>(sel)]
            .filter((el) => el.offsetHeight > 0)
            .sort((a, b) => b.offsetHeight - a.offsetHeight)[0];
        if (hasMarker) {
          const marker = biggest(markerSel);
          if (marker) return { delta: deltaTo(marker), settleable: true };
          // Marker exists but isn't rendered yet — it's on a band below the
          // viewport (a cross-user marker lives on the row's bottom band). Aim at
          // the actor row's bottom edge to scroll that band into the render range;
          // once the marker materializes the branch above centres it. (Don't fall
          // back to the PR bar — it's in the other row, the wrong direction.)
          const fg = container.querySelector<HTMLElement>(
            `.vis-foreground .vis-group.${groupToken}`,
          );
          if (fg) {
            const cRect = center.getBoundingClientRect();
            const delta =
              fg.getBoundingClientRect().bottom - 12 - (cRect.top + cRect.height / 2);
            return { delta, settleable: false };
          }
          return null;
        }
        // Lifecycle (no marker): centre the PR bar (the strip/search path passes
        // its own glow selector), else just scroll the row in. Reuse the locked
        // bar while it's still on-screen so a mid-settle class strip can't swap us
        // onto the row label.
        if (lockedTarget && lockedTarget.isConnected && lockedTarget.offsetHeight > 0) {
          return { delta: deltaTo(lockedTarget), settleable: true };
        }
        const found = biggest(lifecycleSel);
        if (found) {
          lockedTarget = found;
          return { delta: deltaTo(found), settleable: true };
        }
        const lbl = container.querySelector<HTMLElement>(labelSel);
        return lbl ? { delta: deltaTo(lbl), settleable: true } : null;
      };

      const label = container.querySelector<HTMLElement>(labelSel);
      if (label) setVisScrollTop(label.offsetTop - 8); // coarse: render the row

      let frames = 0;
      let stable = 0;
      const step = (): void => {
        const r = measureDelta();
        if (r != null) {
          if (Math.abs(r.delta) > 6) {
            setVisScrollTop(vs.scrollTop + r.delta);
            stable = 0;
          } else if (r.settleable) {
            stable += 1;
          } else {
            stable = 0; // at the proxy — keep going until the marker renders
          }
        }
        if (stable < 6 && frames++ < 90) requestAnimationFrame(step);
      };
      requestAnimationFrame(() => requestAnimationFrame(step));
    },
    [verticalScrollEl, setVisScrollTop],
  );

  // Leaving focus: instead of letting the row-expand rebuild snap the timeline
  // to the top, re-show the marker that opened the focus with a 3s fade glow and
  // re-centre the viewport on it — "you were here". The glow is set immediately
  // (and survives any recluster); the centring waits for the expand animation to
  // start so the kept row's layout is settling before we drive the scroll.
  const restoreAnchorView = useCallback(
    (eventId: number) => {
      flashExitGlow(eventId);
      const ev = eventsByIdRef.current.get(eventId);
      if (!ev) return;
      const token = groupClassToken(groupOf(ev));
      window.setTimeout(() => centerShowTarget(token, true, '.ev-exit-glow'), 320);
    },
    [flashExitGlow, centerShowTarget],
  );

  // Restore the window captured when the drill-down began (idempotent across the
  // two back steps). Honors reduced-motion like focusRows does.
  const restoreWindow = useCallback(() => {
    const tl = timelineRef.current;
    const win = savedWindowRef.current;
    if (!tl || !win) return;
    // Opening/drilling a marker no longer zooms, so the horizontal window is
    // usually unchanged from when it was captured. Skip the setWindow then: an
    // animated setWindow to the same range still fires `rangechanged`, which
    // schedules a full marker recluster (rebuildMarkers) — wasted work on the
    // back path. Only restore when the window genuinely moved.
    const cur = tl.getWindow();
    const unchanged =
      Math.abs(cur.start.valueOf() - win.start.valueOf()) < 1000 &&
      Math.abs(cur.end.valueOf() - win.end.valueOf()) < 1000;
    if (unchanged) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tl.setWindow(win.start, win.end, { animation: !reduceMotion });
  }, []);

  // Restore the vertical scroll captured when the cluster popover opened. Backing
  // out of a picked comment runs applyContext(null), whose row-expand grows the
  // layout back from the collapsed focus height and leaves the scroll pinned at
  // the top. Re-apply the saved scrollTop across frames — the expanding rows (and
  // the animated window restore) only reach full height over a few hundred ms, so
  // a single set would clamp to the still-short layout — until it sticks, landing
  // back on the cluster instead of the top.
  const restoreScrollTop = useCallback(() => {
    const top = savedScrollTopRef.current;
    if (top == null) return;
    let frames = 0;
    let stable = 0;
    const step = (): void => {
      setVisScrollTop(top);
      const vs = verticalScrollEl();
      const atTarget = vs != null && Math.abs(vs.scrollTop - top) <= 2;
      stable = atTarget ? stable + 1 : 0;
      if (stable < 3 && frames++ < 60) requestAnimationFrame(step);
    };
    requestAnimationFrame(() => requestAnimationFrame(step));
  }, [setVisScrollTop, verticalScrollEl]);

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
      // Preserve an active row-focus when opening another marker/cluster.
      // Clearing it here re-expands every row and snaps the timeline to the top,
      // losing the cluster the user just clicked. Instead: a picked single event
      // re-targets the focus via the popover's own onContextFocus, and a cluster
      // list keeps the current focus (its members live on the focused row). Only
      // a lingering glow with NO row-focus (e.g. a same-user marker left over
      // post-navigate) still needs an explicit clear.
      if (!focusedGroupIdsRef.current) applyContext(null);
      if (drillDepthRef.current === 0) {
        history.pushState({ ghtmDrill: 1 }, '');
      } else if (drillDepthRef.current === 2) {
        // Collapse the extra entry so we sit on a single drill slot.
        suppressPopstateRef.current += 1;
        history.go(-1);
      }
      drillDepthRef.current = 1;
      // Capture before any selection/scroll side effect can move the window — both
      // the horizontal window and the vertical scroll, so a later back-out can
      // return to exactly where the cluster sat.
      savedWindowRef.current = timelineRef.current?.getWindow() ?? null;
      savedScrollTopRef.current = verticalScrollEl()?.scrollTop ?? null;
      setPopover({
        x,
        y,
        eventIds,
        picked: eventIds.length === 1 ? eventIds[0]! : null,
      });
    },
    [applyContext, verticalScrollEl],
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

  // Close the popover modal ONLY (its X button / Escape): the cross-user focus
  // overlay stays put so the user can keep examining the two-row view; the
  // bottom-left "Exit focus" button is what reverts that. We still pop the
  // modal's own history entries so the back button isn't left out of step, but we
  // keep savedWindowRef so a later exitFocus can still restore the window.
  const closeModal = useCallback(() => {
    const depth = drillDepthRef.current;
    setPopover(null);
    if (depth > 0) {
      suppressPopstateRef.current += 1;
      history.go(-depth);
    }
    drillDepthRef.current = 0;
    // When there's no collapsed-row focus to keep examining (e.g. a same-user
    // marker that only glowed its PR), also clear that glow — there'd be no
    // affordance left to clear it, since clicks no longer dismiss.
    if (!focusedGroupIdsRef.current) applyContext(null);
  }, [applyContext]);

  // Full exit (bottom-left button / browser-back): revert the row collapse +
  // glow, restore the window to where the user was when they opened the focus,
  // and close the modal too. `restoreAnchor` (default) re-centres on + glows the
  // marker that opened the focus; callers where that context is gone (e.g. a repo
  // switch) pass false to just clear the overlay.
  const exitFocus = useCallback(
    (restoreAnchor = true) => {
      // Capture the anchor before applyContext(null) clears highlightedEventRef.
      const anchorEvent = restoreAnchor ? highlightedEventRef.current : null;
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
      savedScrollTopRef.current = null;
      if (anchorEvent != null) restoreAnchorView(anchorEvent);
    },
    [applyContext, restoreWindow, restoreAnchorView],
  );

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
        // Back to the cluster list: clear the focus overlay, then restore BOTH the
        // window and the vertical scroll so the view returns to the cluster that
        // was clicked rather than snapping to the top when the rows expand.
        const members = popoverRef.current?.eventIds ?? [];
        drillDepthRef.current = 1;
        setPopover((p) => (p ? { ...p, picked: null } : p));
        applyContext(null);
        restoreWindow();
        restoreScrollTop();
        // Queue a brief glow on the cluster we returned to, so the context the
        // user drilled out of is obvious. Applied in an effect (see below) AFTER
        // the popover's own onContextFocus(null) effect — which clears the overlay
        // and any exit glow — so it isn't immediately wiped. (Child effects run
        // before parent effects, so the Timeline effect wins the ordering.)
        pendingClusterGlowRef.current = members[0] ?? null;
      } else if (depth === 1) {
        // Out of the drill-down entirely — same treatment as the Exit focus
        // button: re-centre on + glow the marker that opened a two-person focus.
        const anchorEvent = highlightedEventRef.current;
        drillDepthRef.current = 0;
        applyContext(null);
        setPopover(null);
        restoreWindow();
        savedWindowRef.current = null;
        savedScrollTopRef.current = null;
        if (anchorEvent != null) restoreAnchorView(anchorEvent);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyContext, restoreWindow, restoreScrollTop, restoreAnchorView]);

  // Apply the queued "returned to this cluster" glow once the popover is back in
  // list mode (picked === null). This Timeline (parent) effect runs AFTER the
  // MarkerPopover (child) effect that fires onContextFocus(null) on the same
  // commit, so the glow lands after the focus-clear instead of being wiped by it.
  useEffect(() => {
    const ev = pendingClusterGlowRef.current;
    if (ev == null || !popover || popover.picked != null) return;
    pendingClusterGlowRef.current = null;
    flashExitGlow(ev);
  }, [popover, flashExitGlow]);

  // Toggling the repo filter changes which contributors are on the timeline, so a
  // two-person focus built from another repo no longer makes sense — drop it just
  // like the "Exit focus" button. We skip the anchor re-centre/glow because the
  // clicked marker may not exist in the new repo set. Only a *genuine* repo change
  // triggers this (not unrelated re-renders, and not member/range/category edits).
  const repoIds = useFilters((s) => s.repoIds);
  const prevRepoIdsRef = useRef(repoIds);
  useEffect(() => {
    const prev = prevRepoIdsRef.current;
    prevRepoIdsRef.current = repoIds;
    if (sameRepoSelection(prev, repoIds)) return;
    if (focusActive || focusedGroupIdsRef.current || showFocusActiveRef.current) {
      exitFocus(false);
    }
  }, [repoIds, focusActive, exitFocus]);

  // Leave focus on the store's edge-triggered exit request (Escape via the
  // keyboard hook, and "Clear all" via resetAllFilters both bump
  // exitFocusSignal). Each bump is a fresh request: run the exact same teardown
  // as the on-canvas "Exit focus" button — restore the rows, re-centre on the
  // marker that opened the focus, and fade-glow it. exitFocus() no-ops cleanly
  // when nothing is focused (anchor null, depth 0), so a stray bump is harmless.
  const exitFocusSignal = useFilters((s) => s.exitFocusSignal);
  const prevExitSignalRef = useRef(exitFocusSignal);
  useEffect(() => {
    if (exitFocusSignal === prevExitSignalRef.current) return;
    prevExitSignalRef.current = exitFocusSignal;
    if (focusActive || focusedGroupIdsRef.current || showFocusActiveRef.current) {
      exitFocus();
    }
  }, [exitFocusSignal, focusActive, exitFocus]);

  // Don't let the glow fade timers fire after unmount.
  useEffect(
    () => () => {
      if (exitGlowTimerRef.current) clearTimeout(exitGlowTimerRef.current);
      if (prFocusGlowTimerRef.current) clearTimeout(prFocusGlowTimerRef.current);
    },
    [],
  );

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
      // Clicking the timeline no longer dismisses the popover or reverts a focus
      // overlay — that's now the explicit "Exit focus" button / the modal's X.
      // So an empty-space click is a no-op, and selecting a PR / opening a marker
      // leaves any open modal + focus alone (opening a new marker re-focuses).
      if (id == null) return;
      const key = String(id);
      const native = props.event?.srcEvent ?? props.event;
      const x = native?.clientX ?? props.pageX ?? 0;
      const y = native?.clientY ?? props.pageY ?? 0;

      if (key.startsWith('pr:')) {
        selectPr(Number.parseInt(key.slice(3), 10));
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
  }, [selectPr, rebuildMarkers, openPopover, applyContext]);

  // Rebuild groups + PR bars when data or the derived-state filter changes.
  useEffect(() => {
    if (!data) return;
    dataRef.current = data;

    // An open PR being focused may be absent from the lean /api/timeline payload
    // (no in-window activity). The focus effect stages it here so its bar can be
    // materialized and then scrolled-to + glowed. Seed it into the rendered PR
    // set; cleared once consumed below so it doesn't linger past this rebuild.
    const extra = forceShowOpenPrRef.current;
    const basePrs: TimelinePr[] =
      extra && !data.prs.some((p) => p.id === extra.id)
        ? [...data.prs, extra]
        : data.prs;

    // Member filter: when set, only render bars for PRs the selected members
    // authored, so the timeline collapses to just those contributors' rows
    // (events are already actor-filtered server-side, and the per-repo memberIds
    // below derive their author rows from this `prs` set). The backend also
    // returns PRs the selected members merely *acted on* — those stay in the
    // payload (so marker attribution can name them) but their bars are dropped.
    const memberFilter = userIds && userIds.length > 0 ? new Set(userIds) : null;
    const authoredByMember = (pr: TimelinePr): boolean =>
      !memberFilter || (pr.authorId != null && memberFilter.has(pr.authorId));

    const prs: TimelinePr[] = basePrs.filter(
      (pr) =>
        // Always render the selected PR's bar so event→PR navigation (and the
        // global PR-title search) has a target even when the member or
        // derived-state filter would otherwise hide it.
        pr.id === selectedPrIdRef.current ||
        (authoredByMember(pr) &&
          (derivedStates.length === 0 ||
            derivedStates.some((s) => pr.threadCounts[s] > 0))),
    );

    const evMap = new Map<number, TimelineEvent>();
    for (const ev of data.events) evMap.set(ev.id, ev);
    eventsByIdRef.current = evMap;

    // PRs with at least one comment (review-thread or issue-level), derived
    // straight from the lean timeline events — no extra fetch, keeps the
    // endpoint lean. Drives the small comment glyph on each PR bar.
    const prsWithComments = new Set<number>();
    for (const ev of data.events) {
      if (
        ev.prId != null &&
        (ev.type === 'review_comment' || ev.type === 'pr_comment')
      ) {
        prsWithComments.add(ev.prId);
      }
    }

    // Pack each row's PRs into lanes so non-overlapping PRs share one line — a
    // prolific author's row is a few lanes tall instead of one line per PR.
    // Computed over the full PR set (not the filtered `prs`) so a PR keeps its
    // lane as filters toggle and own-work markers can resolve their lane even
    // when the bar itself is filtered out. Mirrored into a ref for
    // rebuildMarkers (own-work event bands) + focusSubgroups (kept lane band).
    const prLanes = assignPrLanes(basePrs);
    prLanesRef.current = prLanes;

    // Per-user interaction tallies for the row labels — from the full timeframe
    // (all events + all PRs), so they don't shift with the thread-state filter.
    const userStats = computeUserStats(data.events, basePrs);

    const repoIds = unique([
      ...prs.map((p) => p.repoId),
      ...data.events.map((e) => e.repoId),
    ]);

    const groups: DataGroup[] = [];
    // vis sorts groups (and nested groups within each parent) by the `order`
    // field — default groupOrder='order' — re-evaluated on every redraw, so it
    // survives the in-place DataSet diffing below. We set it explicitly:
    // repos keep their data order; within a repo, maintainers (those with merge
    // rights — see mergersByRepo) float to the top, everyone else keeps their
    // existing relative order beneath them.
    const MAINTAINER_RANK = 0;
    const CONTRIBUTOR_RANK = 1_000_000; // > any per-repo member count
    repoIds.forEach((rid, ridx) => {
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
      const mergerSet = mergersByRepo.get(rid);
      const nested = memberIds.map((uid) => `repo:${rid}:user:${uid}`);
      groups.push({
        id: `repo:${rid}`,
        content: reposById.get(rid) ?? `repo ${rid}`,
        nestedGroups: nested.length ? nested : undefined,
        treeLevel: 1,
        order: ridx,
        // Order this row's subgroup bands by each item's `sortKey` (bar above its
        // own events; cross-user events last). See VIS_OPTIONS / buildMarkerItems.
        subgroupOrder: 'sortKey',
      } as DataGroup);
      memberIds.forEach((uid, i) => {
        const gid = `repo:${rid}:user:${uid}`;
        const isMaintainer = mergerSet?.has(uid) ?? false;
        groups.push({
          id: gid,
          content: labelElement(
            renderUserLabel(usersById.get(uid), uid, userStats.get(uid), isMaintainer),
          ),
          treeLevel: 2,
          // Maintainers first (rank 0), then contributors — `i` preserves the
          // existing relative order within each band.
          order: (isMaintainer ? MAINTAINER_RANK : CONTRIBUTOR_RANK) + i,
          subgroupOrder: 'sortKey',
          // `tl-user-row` scopes the collapse transition; the per-group token
          // lets focusRows find this row's label + bar to animate (Fix 1).
          className: `tl-user-row ${groupClassToken(gid)}`,
        } as DataGroup);
      });
    });

    const prItems: DataItem[] = prs.map((pr) => {
      const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      // The PR creator owns the band in their own row; fall back to the repo
      // row only when the author is unknown.
      const group = prGroupId(pr);
      const lane = prLanes.get(pr.id) ?? 0;
      // Each lane is one bar line (`bar:<lane>`) shared by the row's non-
      // overlapping PRs; that lane's own-work events get the adjacent `ev:<lane>`
      // band just below (sortKey = lane*2 vs lane*2+1), so markers always sit on
      // one line directly under their PR's lane.
      return {
        id: `pr:${pr.id}`,
        group,
        subgroup: `bar:${lane}`,
        sortKey: lane * 2,
        type: 'range',
        start: pr.openedAt,
        end: pr.mergedAt ?? pr.closedAt ?? new Date().toISOString(),
        content: renderPrBar(pr, {
          author: {
            label: userLabel(author, pr.authorId),
            avatarUrl: author?.avatarUrl ?? null,
          },
          hasComments: prsWithComments.has(pr.id),
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

    // Consumed: the staged open-PR bar has been materialized into this rebuild.
    // Clear it so a later background-sync rebuild doesn't keep re-injecting it.
    forceShowOpenPrRef.current = null;
  }, [
    data,
    derivedStates,
    userIds,
    reposById,
    usersById,
    mergersByRepo,
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
      const focusEv = useFilters.getState().timelineFocusEvent;

      // Activity "Show": focus one specific event. Collapse the timeline to the
      // activity's row(s) — the actor's row alone for a same-user action (and
      // lifecycle, whose actor IS the author), or actor + PR author for a
      // cross-user one (the cross-user marker-popover treatment) — glow the PR
      // band and the marker, then centre the marker. We can't use vis.focus()
      // for the vertical scroll: it only scrolls to an already-rendered item and
      // the off-screen target row is a virtualised stub. So we recenter
      // horizontally with setWindow and drive vis's vertical scroll ourselves
      // (centerShowTarget) once the collapse has settled and the row renders.
      // The overlay is sticky: it stays until the next timeline interaction.
      if (focusEv && data) {
        const match = data.events.find(
          (e) =>
            e.prId === timelineFocusPr &&
            e.type === focusEv.type &&
            (focusEv.refId == null || e.refId === focusEv.refId),
        );

        const authorId = inWindow.authorId;
        // Lifecycle events have no marker; their actor is the PR author, so the
        // relevant row (and the PR bar) is the author's.
        const actorId = match?.actorId ?? authorId;
        const crossUser =
          actorId != null && authorId != null && actorId !== authorId;

        const keepGroupIds: string[] = [];
        if (actorId != null) keepGroupIds.push(`repo:${inWindow.repoId}:user:${actorId}`);
        if (crossUser && authorId != null) {
          keepGroupIds.push(`repo:${inWindow.repoId}:user:${authorId}`);
        }
        applyContext({
          groupIds: keepGroupIds.length ? keepGroupIds : null,
          prId: timelineFocusPr,
          eventId: match?.id ?? null,
        });

        // Recenter horizontally on the event instant (independent of rendering).
        if (timelineFocusAt) {
          const c = Date.parse(timelineFocusAt);
          const win = tl.getWindow();
          const width = win.end.valueOf() - win.start.valueOf();
          tl.setWindow(c - width / 2, c + width / 2, { animation: false });
        }
        tl.setSelection([`pr:${timelineFocusPr}`]);

        // Vertically centre the marker after the collapse animation has settled
        // (rows removed from layout) so positions are stable and the kept row
        // can render. The marker sits in the actor's row.
        if (actorId != null) {
          const token = groupClassToken(`repo:${inWindow.repoId}:user:${actorId}`);
          // A real marker (commit/comment/review) — not a lifecycle event, which
          // matches an event but draws no marker (the centre target is the bar).
          const hasMarker =
            match != null &&
            (itemsRef.current.get(`ev:${match.id}`) != null ||
              eventToClusterRef.current.get(match.id) != null);
          window.setTimeout(() => centerShowTarget(token, hasMarker), 300);
        }

        showFocusActiveRef.current = keepGroupIds.length > 0 || match != null;
        useFilters.getState().consumeTimelineFocus();
        return;
      }

      // openPrFocused (strip / my-turn / search): drop ANY active overlay first —
      // a sticky "Show" OR a marker-popover cross-user focus (tracked by
      // focusedGroupIdsRef, which showFocusActiveRef alone misses). This is a
      // fresh navigation, so expand back to all rows and clear the cross-link glow
      // before scrolling+glowing the target — otherwise the rows stay collapsed
      // and the focus glow paints on a hidden bar (and pr-cross-linked can stack
      // under pr-focus-glow). Then recenter horizontally on the clicked event's
      // instant when provided, else the PR bar's midpoint — avoids a big jump when
      // a long-running PR's midpoint is far from the clicked event.
      if (showFocusActiveRef.current || focusedGroupIdsRef.current) {
        showFocusActiveRef.current = false;
        applyContext(null);
      }
      const win = tl.getWindow();
      const width = win.end.valueOf() - win.start.valueOf();
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
      // Vertical scroll: the contributor row may be virtualized off-screen, so
      // vis.focus() can't reach it — drive vis's own vertical scroll via the same
      // settle loop the activity-"Show" path uses (centerShowTarget). hasMarker is
      // false (lifecycle branch); the lifecycle target is the glow selector below,
      // so it centres precisely on the focused PR bar (not the row label). The
      // glow class is applied first so centerShowTarget can find `.pr-focus-glow`.
      const token = groupClassToken(prGroupId(inWindow));
      const focusId = timelineFocusPr;
      // Defer the glow alongside the scroll: when a thread-state filter hides this
      // PR, openPrFocused's selection effect schedules a force-show rebuild to
      // materialize the bar; applying the glow synchronously here would no-op (the
      // `pr:<id>` item isn't in the DataSet yet) and never retry. Running both
      // after the rebuild paints guarantees flashPrFocusGlow finds the bar.
      window.setTimeout(() => {
        flashPrFocusGlow(focusId);
        centerShowTarget(token, false, '.ev-cross-linked', '.pr-focus-glow');
      }, 120);
      useFilters.getState().consumeTimelineFocus();
      return;
    }

    // Not in the member-filtered lean payload, but the global PR-title search can
    // target a PR the member filter hides. If it overlaps the current window it's
    // present in the member-agnostic search payload — force-show its bar in place
    // (the rebuild force-adds its author's row), with no range change since an
    // open/overlapping bar already spans the window. Reuses the same
    // forceShowOpenPrRef path as a PR absent from the lean payload for lack of
    // in-window activity; centerShowTarget then scrolls it vertically into view.
    const hiddenByMember =
      data && !data.prs.some((p) => p.id === timelineFocusPr)
        ? searchData?.prs.find((p) => p.id === timelineFocusPr)
        : undefined;
    if (hiddenByMember) {
      if (showFocusActiveRef.current || focusedGroupIdsRef.current) {
        showFocusActiveRef.current = false;
        applyContext(null);
      }
      forceShowOpenPrRef.current = hiddenByMember;
      setForceShowNonce((n) => n + 1);
      const token = groupClassToken(prGroupId(hiddenByMember));
      const focusId = hiddenByMember.id;
      window.setTimeout(() => {
        // 360ms: after the force-show rebuild paints the bar + its author's row.
        tl.setSelection([`pr:${focusId}`]);
        flashPrFocusGlow(focusId);
        centerShowTarget(token, false, '.ev-cross-linked', '.pr-focus-glow');
      }, 360);
      useFilters.getState().consumeTimelineFocus();
      return;
    }

    // The PR isn't in the lean /api/timeline payload. It can still be focused if
    // it's a currently-open PR (those come from a separate endpoint and may be
    // outside the window or have no in-window activity) — including an out-of-
    // filter open PR surfaced by the global search but with no in-window activity.
    const candidate =
      openPrsData?.prs.find((p) => p.id === timelineFocusPr) ??
      searchOpenPrsData?.prs.find((p) => p.id === timelineFocusPr);
    if (candidate) {
      const { from } = resolveRange(useFilters.getState());
      const openedMs = new Date(candidate.openedAt).getTime();
      if (openedMs < from.getTime()) {
        // Opened before the window — widen the range so it enters data.prs, then
        // the effect re-runs into the openPrFocused sub-path above (which
        // scrolls + glows). Keep the focus pending (don't consume).
        const day = new Date(openedMs - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        useFilters.getState().setCustomRange(day, today);
        return;
      }
      // Open + within the window but absent from data.prs (no in-window activity,
      // so it never entered the lean payload). Stage it for the next rebuild —
      // forceShowOpenPrRef is seeded into the rebuild's PR set so the bar
      // materializes — then bump the nonce to trigger that rebuild. The bar can't
      // be focused until it paints, so we center + glow on a short delay using the
      // open-PR record directly (best-effort; never crashes). Consume the focus.
      if (data && !data.prs.some((p) => p.id === candidate.id)) {
        // Same fresh-navigation teardown as the in-window path above: clear any
        // active "Show" / popover focus so the deferred scroll+glow doesn't land
        // under collapsed rows.
        if (showFocusActiveRef.current || focusedGroupIdsRef.current) {
          showFocusActiveRef.current = false;
          applyContext(null);
        }
        forceShowOpenPrRef.current = candidate;
        setForceShowNonce((n) => n + 1);
        const winC = tl.getWindow();
        const w = winC.end.valueOf() - winC.start.valueOf();
        const sMs = new Date(candidate.openedAt).getTime();
        const eMs = new Date(
          candidate.mergedAt ?? candidate.closedAt ?? new Date().toISOString(),
        ).getTime();
        const c = (sMs + eMs) / 2;
        tl.setWindow(c - w / 2, c + w / 2, { animation: true });
        const token = groupClassToken(prGroupId(candidate));
        window.setTimeout(() => {
          // 360ms: after the force-show rebuild paints the bar.
          tl.setSelection([`pr:${candidate.id}`]);
          flashPrFocusGlow(candidate.id);
          centerShowTarget(token, false, '.ev-cross-linked', '.pr-focus-glow');
        }, 360);
        useFilters.getState().consumeTimelineFocus();
        return;
      }
    }
    // Genuinely unreachable (in neither dataset) — fail gracefully.
    useFilters.getState().consumeTimelineFocus();
  }, [
    timelineFocusPr,
    timelineFocusAt,
    data,
    openPrsData,
    searchData,
    searchOpenPrsData,
    applyContext,
    centerShowTarget,
    flashPrFocusGlow,
  ]);

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
      {focusActive && (
        <button
          type="button"
          onClick={() => exitFocus()}
          className="tl-exit-focus"
          title="Show all rows again and return to where you were"
        >
          <span aria-hidden="true">✕</span> Exit focus
        </button>
      )}
      {popover && (
        <MarkerPopover
          state={popover}
          eventsById={eventsByIdRef.current}
          usersById={usersById}
          prsById={prsById}
          onContextFocus={applyContext}
          onDismiss={closeModal}
          onNavigate={navigatePopover}
          onPick={onPick}
          onBack={onBack}
        />
      )}
    </div>
  );
}
