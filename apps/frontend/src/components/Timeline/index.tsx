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
import { renderPrBar, prClassName, barIsTall } from './prBar.js';
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

// A PR bar's PREFERRED minimum width (px). A near-instant PR is grown rightward to
// this so it's spottable — but only as far as the next bar in its lane: fitLaneBars
// CLIPS the overhang rather than clamping every short bar to one size, so the bars
// keep their relative (proportional) widths. The CSS `.vis-item.pr-bar` min-width is
// a much smaller absolute floor (clickability); a crowded bar shrinks below this
// preferred width toward that floor instead of overlapping its neighbour. Tunable.
const MIN_BAR_PX = 12;

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// The CENTER drawing area's width (px) — what the window maps onto, so fitLaneBars
// can convert the bars' pixel min-width to ms. Reads vis's own laid-out width
// (body.domProps.center.width), falling back to the panel/container DOM width. 0
// when nothing is measurable yet (the gutter is sized asynchronously by vis).
function barDrawCenterPx(
  tl: VisTimeline | null,
  container: HTMLElement | null,
): number {
  if (!tl) return 0;
  const body = (
    tl as unknown as { body?: { domProps?: { center?: { width?: number } } } }
  ).body;
  const center = container?.querySelector<HTMLElement>('.vis-panel.vis-center');
  return (
    body?.domProps?.center?.width ||
    center?.clientWidth ||
    container?.clientWidth ||
    0
  );
}

function barStartMs(it: DataItem): number {
  return Date.parse(String(it.start));
}
function barEndMs(it: DataItem): number {
  return it.end != null ? Date.parse(String(it.end)) : barStartMs(it);
}

// Give short PR bars a spottable minimum WITHOUT flattening them all to one size.
// Lanes are packed by real time spans (assignPrLanes), so within a lane the bars'
// real spans never overlap; only a near-instant bar's min-width growth can cover the
// next one. For each bar we keep its REAL span — anchored at its true start — grown
// rightward toward MIN_BAR_PX, but CLIPPED so it never overhangs the next bar's
// start. So a long PR keeps its full width, a sliver grows to the floor when it has
// room and is clipped shorter when crowded (its width then tracks the gap, staying
// proportional), and nothing overlaps (down to the small CSS floor, which only bites
// in extreme density). The clip never cuts into the real span — same-lane spans
// don't overlap, so the next start is always ≥ this bar's real end. Runs on
// freshly-built items (real start/end) at the current zoom, so it re-fits on zoom;
// only item.end is touched (true start preserved) and PR navigation reads pr data.
function fitLaneBars(items: DataItem[], msPerPx: number): void {
  if (msPerPx <= 0) return;
  const minMs = MIN_BAR_PX * msPerPx;
  const byLane = new Map<string, DataItem[]>();
  for (const it of items) {
    const key = `${String(it.group)}|${String(it.subgroup ?? '')}`;
    const list = byLane.get(key);
    if (list) list.push(it);
    else byLane.set(key, [it]);
  }
  for (const bars of byLane.values()) {
    if (bars.length === 0) continue;
    bars.sort((a, b) => barStartMs(a) - barStartMs(b));
    for (let i = 0; i < bars.length; i++) {
      const it = bars[i]!;
      const s = barStartMs(it);
      const realEnd = barEndMs(it);
      const nextStart =
        i + 1 < bars.length ? barStartMs(bars[i + 1]!) : Number.POSITIVE_INFINITY;
      const end = Math.min(Math.max(realEnd, s + minMs), nextStart);
      if (end !== realEnd) it.end = new Date(end).toISOString();
    }
  }
}

// Pad the VISIBLE window around a resolved {from, to} range so the "current time"
// line (at `to` for a preset, since to === now) isn't flush against the right edge,
// with a little breathing room at the start too. A fraction of the span, with a
// few-hour floor so even a 1-day custom range gets a visible margin. The data query
// stays unpadded (buildTimelineSearch) — these margins are just empty viewport.
function paddedViewport(from: Date, to: Date): { start: Date; end: Date } {
  const span = to.getTime() - from.getTime();
  const right = Math.max(span * 0.06, 4 * 60 * 60 * 1000);
  const left = Math.max(span * 0.03, 2 * 60 * 60 * 1000);
  return { start: new Date(from.getTime() - left), end: new Date(to.getTime() + right) };
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

// Midpoint (ms) of a PR's lifetime — opened → merged/closed/now — used to centre
// the window on a PR bar when no specific event instant is in play.
function prMidpointMs(pr: TimelinePr): number {
  const startMs = new Date(pr.openedAt).getTime();
  const endMs = new Date(
    pr.mergedAt ?? pr.closedAt ?? new Date().toISOString(),
  ).getTime();
  return (startMs + endMs) / 2;
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
  // User-collapsed contributor rows (Item 6): `repo:<rid>:user:<uid>` ids whose
  // bars + markers are hidden so the row shrinks to just its name. DISTINCT from
  // collapsedRowsRef (which hides whole rows via visible:false during focus) —
  // these hide the row's SUBGROUPS via subgroupVisibility, leaving a thin labelled
  // row. Persisted to localStorage so the choice survives reloads; loaded once.
  const collapsedRowsByUserRef = useRef<Set<string>>(new Set());
  const collapsedRowsLoadedRef = useRef(false);
  if (!collapsedRowsLoadedRef.current) {
    collapsedRowsLoadedRef.current = true;
    try {
      const raw = localStorage.getItem('ghtm:collapsedRows');
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) collapsedRowsByUserRef.current = new Set(arr.map(String));
      }
    } catch {
      /* ignore malformed persisted state */
    }
  }
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
  // The marker that opened the current focus, re-shown with a persistent soft
  // pulse (no marching ants) when the user leaves focus so they can relocate where
  // they were — anchoring them in a large repo. Mirrors highlightedEvent/Item but
  // for the `ev-exit-glow` class; it stays until the next applyContext clears it.
  const exitGlowEventRef = useRef<number | null>(null);
  const exitGlowItemRef = useRef<string | null>(null);
  // The strip / search "locate the bar" cue: a finite sky glow (no marching ants)
  // on a focused PR bar, plus a timer that strips it once the ~2s fade completes.
  const prFocusGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An open PR opened *within* the window but absent from the lean /api/timeline
  // payload (it had no in-window activity). The focus path stages it here so the
  // next rebuild materializes its bar; cleared once the rebuild consumes it.
  const forceShowOpenPrRef = useRef<TimelinePr | null>(null);
  // Window width (ms) the current bar fit was computed for. The min-width floor is
  // in pixels, so fitLaneBars is zoom-dependent — a real zoom (width change) re-fits
  // via laneNonce; a pan (same width) does not.
  const lanedWindowMsRef = useRef<number | null>(null);
  // Bar-fit deferral: vis sizes the label gutter asynchronously, so the CENTER draw
  // width isn't known synchronously during a rebuild. We poll for it (cancellable
  // rAF) and cache the last settled width so an unchanged-gutter rebuild (zoom,
  // background sync) can fit synchronously with no flash.
  const barFitRafRef = useRef<number | null>(null);
  const settledCenterWidthRef = useRef(0);
  // True while a sticky "Show on timeline" overlay (from the activity panel) is
  // applied — a glowing marker plus, for a cross-user action, the collapsed
  // two-person row focus. Unlike the marker popover it has nothing to dismiss
  // it, so it persists until the next timeline interaction; the click handler
  // and openPrFocused read this to expand back to all users.
  const showFocusActiveRef = useRef(false);
  // Sticky "Focus" (PR-isolation) overlay from the PR panel: collapse to a PR's
  // contributors and show only its bar, then explore freely — clicks never exit,
  // only the Exit-focus button / Escape clears it. prFocusPrIdRef is the isolated
  // PR, used to recentre + glow it on exit when no specific event was last clicked.
  const prFocusActiveRef = useRef(false);
  const prFocusPrIdRef = useRef<number | null>(null);
  // Popover depth mirrored onto the History API (0 closed / 1 popover open), the
  // window captured when the popover opened (restored on back-out), and a counter of
  // popstate events to swallow when we unwind history ourselves.
  const drillDepthRef = useRef(0);
  const savedWindowRef = useRef<{ start: Date; end: Date } | null>(null);
  // The selected marker's persistent "you're looking at this" pulse (the soft sky
  // halo, no marching ants), tracked like the other glows so a re-cluster can
  // re-apply it to whichever item now holds the event — a lone `ev:` marker or
  // the `cl:` cluster pill it folds into. Driven by the open popover whenever
  // we're NOT in cross-user focus (focus uses the cross-link ring instead).
  const selectedGlowEventRef = useRef<number | null>(null);
  const selectedGlowItemRef = useRef<string | null>(null);
  const suppressPopstateRef = useRef(0);

  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Latest popover state, readable from stable callbacks without re-binding.
  const popoverRef = useRef<PopoverState | null>(null);
  popoverRef.current = popover;
  // True whenever a row-collapse focus overlay is active (a cross-user marker or
  // an activity "Show"). Drives the bottom-right "Exit focus" button. Clicking the
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
  // Bumped (debounced) when the zoom changes, to re-run the rebuild so fitLaneBars
  // re-resolves min-width bar overlaps against the new px↔ms scale.
  const [laneNonce, setLaneNonce] = useState(0);

  const preset = useFilters((s) => s.preset);
  const customFrom = useFilters((s) => s.customFrom);
  const customTo = useFilters((s) => s.customTo);
  const rangeResetSignal = useFilters((s) => s.rangeResetSignal);

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

  // Add / move / clear the `ev-exit-glow` class on whichever item currently holds
  // `eventId` (a lone `ev:` marker or the `cl:` cluster it folded into). Mirrors
  // highlightEvent, but the class drives a persistent soft pulse (no marching-ants
  // ring) — the "you exited focus here" anchor, held until applyContext clears it.
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

  // Persistent "this marker is selected" pulse — the soft sky halo (no marching
  // ants), kept on whichever item currently shows `eventId` for as long as the
  // popover is open and we're not in cross-user focus. Mirrors applyExitGlow's
  // strip-all-then-reapply (so a re-cluster can't strand the class on a detached
  // copy), but loops forever with no strip timer; re-applied across reclusters in
  // rebuildMarkers.
  const applySelectGlow = useCallback((eventId: number | null) => {
    const items = itemsRef.current;
    for (const id of items.getIds()) {
      const it = items.get(id) as DataItem | null;
      if (it && typeof it.className === 'string' && it.className.includes('ev-selected')) {
        items.update({ id, className: it.className.replace(/\s*ev-selected/g, '') });
      }
    }
    selectedGlowItemRef.current = null;
    selectedGlowEventRef.current = eventId;
    if (eventId == null) return;
    const targetId = items.get(`ev:${eventId}`)
      ? `ev:${eventId}`
      : (eventToClusterRef.current.get(eventId) ?? null);
    if (targetId == null) return; // event not currently rendered
    const item = items.get(targetId) as DataItem | null;
    if (
      item &&
      typeof item.className === 'string' &&
      !item.className.includes('ev-selected')
    ) {
      items.update({ id: targetId, className: `${item.className} ev-selected` });
      selectedGlowItemRef.current = targetId;
    }
  }, []);

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
    // While a focus overlay owns the rows, per-row collapse is suspended on the kept
    // rows (Req 2/3) — their cross-band divider must show like any other kept row.
    // Only honour per-row collapse when NO focus overlay is active.
    const inFocus = focusedGroupIdsRef.current != null;
    for (const xs of allXsepItemsRef.current) {
      const id = String(xs.id);
      const hidden =
        collapsed.has(String(xs.group)) ||
        (!inFocus && collapsedRowsByUserRef.current.has(String(xs.group)));
      const present = items.get(id) != null;
      if (hidden && present) remove.push(id);
      else if (!hidden && !present) add.push(xs);
    }
    if (remove.length) items.remove(remove);
    if (add.length) items.add(add);
  }, []);

  // Persist the user-collapsed row set so the choice survives reloads. A plain ref
  // + manual localStorage (not useLocalStorage) to match the imperative vis style
  // and avoid a React re-render on every toggle.
  const persistCollapsedRows = useCallback(() => {
    try {
      localStorage.setItem(
        'ghtm:collapsedRows',
        JSON.stringify([...collapsedRowsByUserRef.current]),
      );
    } catch {
      /* ignore quota / disabled storage */
    }
  }, []);

  // Collapse (or expand) one contributor row to just its name by hiding (or
  // re-showing) ALL of its subgroup bands via subgroupVisibility — the same
  // mechanism focusSubgroups uses, driven per-row and persisted. Rebuilds the map
  // over the row's CURRENTLY-present subgroups so a freshly-added lane (background
  // sync) is hidden too; re-asserted after each rebuild and after focus exit.
  const setRowCollapsed = useCallback(
    (gid: string, collapsed: boolean) => {
      const groups = groupsRef.current;
      if (!groups.get(gid)) return;
      const items = itemsRef.current.get() as DataItem[];
      const present = new Set<string>();
      for (const it of items) {
        if (it.group === gid && typeof it.subgroup === 'string') present.add(it.subgroup);
      }
      const vis: Record<string, boolean> = {};
      for (const sg of present) vis[sg] = !collapsed;
      groups.update({ id: gid, subgroupVisibility: vis });
      if (collapsed) collapsedRowsByUserRef.current.add(gid);
      else collapsedRowsByUserRef.current.delete(gid);
      persistCollapsedRows();
      // The row's cross-band divider must drop / restore alongside it.
      applyCrossSeps();
      // vis applies subgroupVisibility only during a group RESTACK, and a bare
      // groups.update / redraw doesn't mark the group dirty — so without an items
      // mutation to dirty it (e.g. a row with no cross-band xsep to remove above),
      // the visibility change wouldn't paint. Force the restack explicitly.
      const tl = timelineRef.current as
        | (VisTimeline & { itemSet?: { markDirty?: (o: { restackGroups?: boolean }) => void } })
        | null;
      tl?.itemSet?.markDirty?.({ restackGroups: true });
      tl?.redraw();
    },
    [persistCollapsedRows, applyCrossSeps],
  );

  // Cross-user / PR-isolation row focus: collapse every user row except `keepIds`
  // (and re-show the rest) so only the focused PR's contributors remain.
  // `keepIds === null` (or empty) restores all rows. Every visibility toggle is
  // collected and applied in ONE batched groupsData.update — vis re-stacks the
  // group tree once (~14ms even on a large board); toggling rows one-by-one
  // scheduled hundreds of redraws. Collapse is INSTANT: the earlier accordion
  // animation read offsetHeight in a loop (a forced-reflow storm) and forced layout
  // against isolatePrBars's updates, costing ~1.3s on a three.js-scale board for no
  // real benefit, so it was dropped.
  const focusRows = useCallback((keepIds: string[] | null) => {
    const allUserIds = groupsRef.current
      .getIds()
      .map(String)
      .filter((id) => USER_GROUP_RE.test(id));
    const keep = keepIds && keepIds.length ? new Set(keepIds) : null; // null = all
    // Force the desired visibility for EVERY row (a background rebuild may have reset
    // it and added new rows) in one batched update.
    const batch: { id: string; visible: boolean }[] = [];
    for (const id of allUserIds) {
      const shouldHide = keep != null && !keep.has(id);
      if (shouldHide) collapsedRowsRef.current.add(id);
      else collapsedRowsRef.current.delete(id);
      batch.push({ id, visible: !shouldHide });
    }
    if (batch.length) groupsRef.current.update(batch);
    focusedGroupIdsRef.current = keep ? (keepIds as string[]) : null;
    // Drop the cross-band divider for any row we just collapsed (and restore it for
    // any we just expanded) — collapsedRowsRef now reflects the new state.
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

    // In the sticky PR-isolation focus, only this PR's events get markers — the
    // shared `cross` band can't be trimmed per-PR via subgroups, so we filter here
    // so a contributor row shows only their activity on the focused PR. The full
    // set is restored when the focus tears down (applyContext(null) → rebuild).
    const events =
      prFocusActiveRef.current && prFocusPrIdRef.current != null
        ? cur.events.filter((e) => e.prId === prFocusPrIdRef.current)
        : cur.events;
    const { items, clusterMembers } = buildMarkerItems(
      events,
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
    // And the persistent selection pulse — it outlives a recluster for as long as
    // the popover stays open, so re-resolve it onto the new marker/cluster item.
    if (selectedGlowEventRef.current != null) {
      const ev = selectedGlowEventRef.current;
      selectedGlowItemRef.current = null;
      selectedGlowEventRef.current = null;
      applySelectGlow(ev);
    }
  }, [highlightEvent, applyExitGlow, applySelectGlow, applyCrossSeps]);

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
        const vis: Record<string, boolean> = {};
        for (const sg of hide) vis[sg] = false;
        // Req 2: focus SUSPENDS any per-row collapse on a kept row — force its kept
        // bands visible so a contributor whose row the user collapsed (its subgroups
        // hidden via setRowCollapsed) still shows the focused PR's activity. The
        // collapse is restored on exit (applyContext re-collapses on !active).
        for (const sg of present) if (keep.has(sg)) vis[sg] = true;
        if (Object.keys(vis).length === 0) continue;
        groups.update({ id: gid, subgroupVisibility: vis });
        if (hide.length) hiddenSubgroupsRef.current.set(gid, hide);
      }
    },
    [],
  );

  // Hide every PR bar except `keepPrId` (null = show all). The PR-isolation focus
  // keeps the author's whole packed lane visible (focusSubgroups can only gate by
  // lane), so a sibling PR sharing that lane would still show its bar — markers are
  // filtered in rebuildMarkers, and bars are hidden here, via a `display:none`
  // class. Re-asserted after each rebuild (which re-creates bar items fresh).
  const isolatePrBars = useCallback((keepPrId: number | null) => {
    const items = itemsRef.current;
    // Collect every className change and apply them in ONE items.update([...]).
    // Updating per-item in the loop fires a DataSet event + schedules a redraw for
    // each PR bar — on a large repo (hundreds of PRs) that was ~270ms on its own,
    // and ~1.5s when the changes forced layout against the in-flight collapse
    // animation. A single batched update is one event → one redraw. (Scanning all
    // items rather than prsById is deliberate: it also catches force-shown bars —
    // open PRs surfaced via search/strip that aren't in the lean timeline payload.)
    const updates: DataItem[] = [];
    for (const id of items.getIds()) {
      const sid = String(id);
      if (!sid.startsWith('pr:')) continue;
      const it = items.get(id) as DataItem | null;
      if (!it || typeof it.className !== 'string') continue;
      const prId = Number.parseInt(sid.slice(3), 10);
      const hidden = it.className.includes('pr-focus-hidden');
      const shouldHide = keepPrId != null && prId !== keepPrId;
      if (shouldHide && !hidden) {
        updates.push({ id, className: `${it.className} pr-focus-hidden` } as DataItem);
      } else if (!shouldHide && hidden) {
        updates.push({
          id,
          className: it.className.replace(/\s*pr-focus-hidden/g, ''),
        } as DataItem);
      }
    }
    if (updates.length) items.update(updates);
  }, []);

  // Apply (or clear, with null) the whole combined-context overlay at once: the
  // two focused rows, the bands trimmed to the interaction, the linked-PR glow,
  // and the clicked-marker glow. Timeline owns this now (not the popover's
  // unmount) so it persists past "Open in detail pane" and is cleared explicitly
  // on dismiss / back.
  const applyContext = useCallback(
    (ctx: ContextFocus | null) => {
      // A fresh context (or a clear) supersedes any lingering exit-anchor pulse —
      // drop it first so a re-opened marker doesn't carry both the exit glow and
      // the new cross-link / select pulse at once.
      applyExitGlow(null);
      const wasPrFocus = prFocusActiveRef.current;
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
      if (!active) {
        showFocusActiveRef.current = false;
        prFocusActiveRef.current = false;
        prFocusPrIdRef.current = null;
      }
      // On focus ENTRY, load the focused PR into the Overview/detail pane so the
      // two-person context the user is inspecting shows there by default. Guard on
      // a real change so this stays idempotent — it must NOT clobber an existing
      // thread selection on the activity/thread "Show" path (which already has the
      // PR selected). Exit never clears selectedPrId, so the PR persists in the
      // Overview after the user leaves focus.
      if (active && ctx?.prId != null) {
        const store = useFilters.getState();
        if (store.selectedPrId !== ctx.prId) store.selectPr(ctx.prId);
      }
      // Leaving a PR-isolation focus (any teardown path lands here): restore the
      // hidden sibling bars and the full, unfiltered marker set it had narrowed to.
      if (!active && wasPrFocus) {
        isolatePrBars(null);
        rebuildMarkers();
      }
      // focusSubgroups(null) above re-showed EVERY subgroup, including the bands of
      // any user-collapsed row. Re-collapse those rows so a per-row collapse
      // survives entering and leaving focus mode.
      if (!active && collapsedRowsByUserRef.current.size > 0) {
        for (const gid of collapsedRowsByUserRef.current) setRowCollapsed(gid, true);
      }
    },
    [
      focusSubgroups,
      focusRows,
      highlightPr,
      highlightEvent,
      applyExitGlow,
      isolatePrBars,
      rebuildMarkers,
      setRowCollapsed,
    ],
  );

  // The open popover reports its PR so we can glow that PR's band. In the sticky
  // PR-isolation focus we must NOT honour it — every contributor row stays up and the
  // clicked marker's highlight is set by the click handler. Outside focus, apply it.
  const onPopoverContext = useCallback(
    (ctx: ContextFocus) => {
      if (prFocusActiveRef.current) return;
      applyContext(ctx);
    },
    [applyContext],
  );

  // Enter the unified PR-isolation focus on `prId`: collapse to every contributor
  // to the PR, show ONLY that PR's bar (siblings sharing its packed lane hidden via
  // isolatePrBars) and markers (the shared `cross` band is filtered in
  // rebuildMarkers), and — unless opts.fitWindow === false — fit the window to the
  // PR's activity span. Both the PR-detail "Focus" link and a cross-user marker
  // click funnel through here so they reach a byte-for-byte identical end state.
  // Reads REFS (not the `data` closure) so it stays stable and never recreates the
  // vis-init effect. Centring + consumeTimelineFocus are left to the caller.
  const enterPrFocus = useCallback(
    (prId: number, opts?: { anchorEventId?: number | null; fitWindow?: boolean }) => {
      const tl = timelineRef.current;
      const cur = dataRef.current;
      if (!tl || !cur) return;
      const pr = prsByIdRef.current.get(prId);
      if (!pr) return;
      const repoId = pr.repoId;
      const contributors = new Set<number>();
      if (pr.authorId != null) contributors.add(pr.authorId);
      let minT = Infinity;
      let maxT = -Infinity;
      const span = (ms: number): void => {
        if (ms < minT) minT = ms;
        if (ms > maxT) maxT = ms;
      };
      span(new Date(pr.openedAt).getTime());
      if (pr.mergedAt) span(new Date(pr.mergedAt).getTime());
      if (pr.closedAt) span(new Date(pr.closedAt).getTime());
      for (const e of cur.events) {
        if (e.prId !== prId) continue;
        if (e.actorId != null) contributors.add(e.actorId);
        span(new Date(e.occurredAt).getTime());
      }
      const keepGroupIds = [...contributors].map((uid) => `repo:${repoId}:user:${uid}`);

      // Fit the window to the PR's activity span (+8% padding, min 12h).
      if (opts?.fitWindow !== false && Number.isFinite(minT) && Number.isFinite(maxT)) {
        const pad = Math.max((maxT - minT) * 0.08, 12 * 60 * 60 * 1000);
        tl.setWindow(minT - pad, maxT + pad, { animation: true });
      }

      // Req 1 (browser-back leaves Focus): push a dedicated history entry so the
      // mouse/browser back button has a focus-owned slot to consume. The popstate
      // handler detects prFocusActiveRef and tears the whole focus down (restoring
      // the anchor) rather than only stepping through popover drill levels. One
      // entry per session — enterPrFocus only runs when not already focused.
      history.pushState({ ghtmFocus: 1 }, '');
      prFocusActiveRef.current = true;
      prFocusPrIdRef.current = prId;
      applyContext({
        groupIds: keepGroupIds.length ? keepGroupIds : null,
        prId,
        eventId: opts?.anchorEventId ?? null,
      });
      rebuildMarkers(); // re-render markers filtered to just this PR
      isolatePrBars(prId); // hide sibling bars sharing its lane
      tl.setSelection([`pr:${prId}`]);
      if (opts?.anchorEventId != null) highlightEvent(opts.anchorEventId);
    },
    [applyContext, rebuildMarkers, isolatePrBars, highlightEvent],
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
  // to the top, re-show the marker that opened the focus with a persistent soft
  // pulse and re-centre the viewport on it — "you were here". The glow stays
  // (anchoring the user in a large repo) until their next marker / focus action
  // clears it via applyContext, and survives reclusters (rebuildMarkers re-asserts
  // exitGlowEventRef). The collapse is instant now (no animation to wait out), so we
  // drive the scroll on the next frame — the board snaps to the anchor as it paints
  // rather than appearing, pausing, then visibly scrolling.
  const restoreAnchorView = useCallback(
    (eventId: number) => {
      applyExitGlow(eventId);
      const ev = eventsByIdRef.current.get(eventId);
      if (!ev) return;
      const token = groupClassToken(groupOf(ev));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => centerShowTarget(token, true, '.ev-exit-glow')),
      );
    },
    [applyExitGlow, centerShowTarget],
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


  // Pin the vertical scroll to a captured value across the next few frames. Used
  // by the groups/markers rebuild: rebuildMarkers() does a wholesale remove()+add()
  // of every marker, which momentarily empties each row's event/cross bands so vis
  // clamps the scroll toward the top before they re-render. Re-apply synchronously
  // (best-effort, in case the relayout was already flushed) and over a short rAF
  // budget until it sticks — it bails the moment the target holds, so it never
  // fights an active user scroll.
  const reapplyScrollTop = useCallback(
    (top: number) => {
      setVisScrollTop(top);
      let frames = 0;
      const step = (): void => {
        setVisScrollTop(top);
        const vs = verticalScrollEl();
        const atTarget = vs != null && Math.abs(vs.scrollTop - top) <= 2;
        if (!atTarget && frames++ < 4) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [setVisScrollTop, verticalScrollEl],
  );

  // --- Marker popover + browser/mouse-back navigation ----------------------
  // The popover is mirrored onto the History API so the mouse/browser back button
  // closes it (and, in a sticky PR-isolation focus, leaves focus): one pushed entry
  // per open popover. Backing out restores the pre-open window. drillDepthRef is the
  // source of truth (0 closed / 1 open); suppressPopstateRef swallows the popstate(s)
  // our own history.go/back emit.

  const openPopover = useCallback(
    (x: number, y: number, eventIds: number[]) => {
      if (eventIds.length === 0) return;
      // Preserve an active row-focus when opening another marker/cluster: clearing
      // it here would re-expand every row and snap the timeline to the top, losing
      // the cluster the user just clicked. The popover re-targets the focus via its
      // own onContextFocus (the events live on the focused row). Only a lingering
      // glow with NO row-focus (e.g. a same-user marker left over post-navigate)
      // still needs an explicit clear.
      if (!focusedGroupIdsRef.current) applyContext(null);
      if (drillDepthRef.current === 0) history.pushState({ ghtmDrill: 1 }, '');
      drillDepthRef.current = 1;
      // Capture before any selection side effect can move the window, so a later
      // back-out returns to where the marker/cluster sat.
      savedWindowRef.current = timelineRef.current?.getWindow() ?? null;
      setPopover({ x, y, eventIds });
    },
    [applyContext],
  );

  // Close the popover modal ONLY (its X button / Escape): the cross-user focus
  // overlay stays put so the user can keep examining the two-row view; the
  // bottom-right "Exit focus" button is what reverts that. We still pop the
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

  // Focus teardown WITHOUT touching the History API (callers manage history): revert
  // the row collapse + glow, restore the window to where the user was when they
  // opened the focus, and close the modal too. `restoreAnchor` (default) re-centres
  // on + glows the marker that opened the focus; callers where that context is gone
  // (e.g. a repo switch) pass false to just clear the overlay. Used by the browser-
  // back popstate path (which has already consumed the focus entry) and, via
  // exitFocus, by the Exit-focus button / Esc.
  const exitFocusCore = useCallback(
    (restoreAnchor = true) => {
      // Capture the anchor + PR-focus state before applyContext(null) clears them.
      const anchorEvent = restoreAnchor ? highlightedEventRef.current : null;
      const wasPrFocus = prFocusActiveRef.current;
      const prId = prFocusPrIdRef.current;
      applyContext(null);
      setPopover(null);
      drillDepthRef.current = 0;
      savedWindowRef.current = null;

      if (wasPrFocus && restoreAnchor) {
        // PR-isolation exit: don't snap back to a saved pre-focus window — stay in
        // the PR's neighbourhood. Centre the window on the last-clicked event (or
        // the PR itself if none), re-select the PR (→ glow pulse) and give the
        // anchor a persistent pulse so it's clearly the thing you were looking at.
        const tl = timelineRef.current;
        const ev =
          anchorEvent != null ? eventsByIdRef.current.get(anchorEvent) : undefined;
        const pr = prId != null ? prsByIdRef.current.get(prId) : undefined;
        if (tl) {
          const centerMs = ev
            ? new Date(ev.occurredAt).getTime()
            : pr
              ? prMidpointMs(pr)
              : null;
          if (centerMs != null) {
            const win = tl.getWindow();
            const width = win.end.valueOf() - win.start.valueOf();
            // Instant re-center (no pan): the board should snap back to its final
            // position once, not appear and then animate horizontally into place.
            tl.setWindow(centerMs - width / 2, centerMs + width / 2, {
              animation: false,
            });
          }
          if (prId != null) tl.setSelection([`pr:${prId}`]);
        }
        if (anchorEvent != null) {
          restoreAnchorView(anchorEvent);
        } else if (pr) {
          const token = groupClassToken(prGroupId(pr));
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              centerShowTarget(token, false, '.ev-cross-linked', '.pr-bar.vis-selected'),
            ),
          );
        }
        return;
      }

      restoreWindow();
      if (anchorEvent != null) restoreAnchorView(anchorEvent);
    },
    [applyContext, restoreWindow, restoreAnchorView, centerShowTarget],
  );

  // Full exit driven by the Exit-focus button / Esc / a repo switch (NOT a browser
  // back). Unwind every focus-owned history entry — the focus marker enterPrFocus
  // pushed (1 when in PR focus) plus any open popover drill entries — so the back
  // button isn't left with stale focus slots, then tear focus down. The single net
  // popstate the unwind emits is swallowed by suppressPopstateRef.
  const exitFocus = useCallback(
    (restoreAnchor = true) => {
      const entries = (prFocusActiveRef.current ? 1 : 0) + drillDepthRef.current;
      if (entries > 0) {
        suppressPopstateRef.current += 1;
        history.go(-entries);
      }
      exitFocusCore(restoreAnchor);
    },
    [exitFocusCore],
  );

  // A fresh strip / my-turn / search navigation abandons any active overlay (a
  // sticky "Show" or a PR-isolation Focus). Unwind the focus-owned history entries
  // first — the {ghtmFocus} marker enterPrFocus pushed plus any open popover drill —
  // so a later browser-back isn't left consuming stale focus slots, THEN clear the
  // overlay. Reading prFocusActiveRef before applyContext(null) (which resets it) is
  // load-bearing. No-ops when nothing is active.
  const dropOverlayForNavigation = useCallback(() => {
    if (!showFocusActiveRef.current && !focusedGroupIdsRef.current) return;
    const entries = (prFocusActiveRef.current ? 1 : 0) + drillDepthRef.current;
    if (entries > 0) {
      suppressPopstateRef.current += 1;
      history.go(-entries);
    }
    drillDepthRef.current = 0;
    showFocusActiveRef.current = false;
    applyContext(null);
  }, [applyContext]);

  // Open-in-detail: close the popover but KEEP the overlay + one history entry,
  // so a later back press clears the overlay and restores the window (the detail
  // pane itself stays open).
  const navigatePopover = useCallback(() => {
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
      if (prFocusActiveRef.current) {
        // The mouse/browser back button LEAVES a sticky PR-isolation focus, returning
        // to the main timeline with the anchor (the clicked event, else the PR)
        // re-selected and glowing — the same teardown as Esc / the Exit-focus button.
        // This popstate already consumed one focus-owned entry; unwind the remaining
        // popover entry (if one's open) so the stack returns to the pre-focus
        // baseline, then tear focus down without further history ops.
        if (depth > 0) {
          suppressPopstateRef.current += 1;
          history.go(-depth);
        }
        exitFocusCore(true);
        return;
      }
      if (depth === 1) {
        // Close the popover — same treatment as the Exit-focus button: re-centre on +
        // glow the marker/PR that opened it.
        const anchorEvent = highlightedEventRef.current;
        drillDepthRef.current = 0;
        applyContext(null);
        setPopover(null);
        restoreWindow();
        savedWindowRef.current = null;
        if (anchorEvent != null) restoreAnchorView(anchorEvent);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyContext, restoreWindow, restoreAnchorView, exitFocusCore]);

  // Persistently pulse the marker/cluster the open popover refers to, so the user
  // can always see which one they're looking at — but only when we're NOT in
  // cross-user focus (focus marks that marker with the marching-ants cross-link
  // ring instead, and the CSS keeps the two from stacking). The popover's first
  // event resolves to whichever item renders it (a lone marker or a cluster pill).
  useEffect(() => {
    applySelectGlow(popover && !focusActive ? (popover.eventIds[0] ?? null) : null);
  }, [popover, focusActive, applySelectGlow]);

  // Clicking any marker/cluster loads its PR into the detail pane. Every popover
  // (a single event or a PR-partitioned cluster) belongs to one PR, so select that
  // PR. PR-level (selectPr); the popover's "Open in detail pane" remains the route to
  // a specific thread.
  const popoverEventId = popover?.eventIds[0] ?? null;
  useEffect(() => {
    if (popoverEventId == null) return;
    const ev = eventsByIdRef.current.get(popoverEventId);
    if (ev?.prId != null) useFilters.getState().selectPr(ev.prId);
  }, [popoverEventId]);

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

  // Don't let the PR-focus glow fade timer fire after unmount.
  useEffect(
    () => () => {
      if (prFocusGlowTimerRef.current) clearTimeout(prFocusGlowTimerRef.current);
    },
    [],
  );

  // Create the timeline once.
  useEffect(() => {
    if (!containerRef.current) return;
    const { from, to } = resolveRange(useFilters.getState());
    const { start, end } = paddedViewport(from, to);
    const timeline = new VisTimeline(
      containerRef.current,
      itemsRef.current,
      groupsRef.current,
      { ...VIS_OPTIONS, start, end, zoomKey: zoomModifierKey() },
    );

    timeline.on('click', (props: {
      item: string | number | null;
      event: { srcEvent?: MouseEvent } & Partial<MouseEvent>;
      pageX?: number;
      pageY?: number;
    }) => {
      const id = props.item;
      const native = props.event?.srcEvent ?? props.event;
      const x = native?.clientX ?? props.pageX ?? 0;
      const y = native?.clientY ?? props.pageY ?? 0;

      // A row-collapse caret click is handled by its own capturing listener; ignore
      // it here so it never doubles as a row / empty-canvas click (which would
      // clear the selection).
      const tgt = (native?.target ?? null) as HTMLElement | null;
      if (tgt?.closest?.('[data-collapse-gid]')) return;

      // Empty-canvas click. An open marker/cluster popover always closes first —
      // even inside a focus overlay (closeModal keeps the focus up since a focus is
      // active, so this can't accidentally tear the overlay down; focus is left only
      // via the bottom-right "Exit focus" button / Esc). With no popover open and
      // OUTSIDE focus, it dismisses ONE more level at a time: a selected PR bar is
      // deselected; else a lingering exit-anchor glow (left after leaving focus) is
      // cleared. So a popover-and-bar combo clears the popover without yanking the PR
      // out of the detail pane, and a final click tidies the leftover anchor pulse.
      if (id == null) {
        if (popoverRef.current) {
          closeModal();
        } else if (!focusedGroupIdsRef.current) {
          if (selectedPrIdRef.current != null) useFilters.getState().clearSelection();
          else if (exitGlowEventRef.current != null) applyExitGlow(null);
        }
        return;
      }
      const key = String(id);

      if (key.startsWith('pr:')) {
        selectPr(Number.parseInt(key.slice(3), 10));
      } else if (key.startsWith('ev:')) {
        const evId = Number.parseInt(key.slice(3), 10);
        // Sticky PR-isolation focus: clicking an event highlights it (it becomes the
        // exit anchor) and opens its popover — we never leave focus here, so the
        // user can explore the whole PR. The popover's own cross-user re-collapse is
        // suppressed (see onPopoverContext).
        if (prFocusActiveRef.current) {
          highlightEvent(evId);
          openPopover(x, y, [evId]);
          return;
        }

        const ev = eventsByIdRef.current.get(evId);
        const pr = ev?.prId != null ? prsByIdRef.current.get(ev.prId) : undefined;
        // Cross-user iff actor and author are both known and differ — anything else
        // (incl. unknown actor/author) is own-work.
        const crossUser =
          ev != null &&
          ev.actorId != null &&
          pr?.authorId != null &&
          ev.actorId !== pr.authorId;

        // Cross-user marker → the UNIFIED PR-isolation focus, anchored on this
        // event: collapse to the PR's contributors, isolate its bar, fit nothing
        // (we recentre on the clicked instant instead), open the popover, then glow
        // + centre the marker. Identical end state to the PR-detail "Focus" link.
        // This supersedes the old two-row marker collapse.
        if (crossUser && ev.prId != null) {
          enterPrFocus(ev.prId, { anchorEventId: evId, fitWindow: false });
          // Recentre the window on the clicked instant (the showEvent pattern).
          const tlc = timelineRef.current;
          if (tlc) {
            const c = new Date(ev.occurredAt).getTime();
            const win = tlc.getWindow();
            const width = win.end.valueOf() - win.start.valueOf();
            tlc.setWindow(c - width / 2, c + width / 2, { animation: false });
          }
          openPopover(x, y, [evId]);
          // The popover's select-pulse is auto-suppressed (focusActive is true), so
          // only the `ev-cross-linked` ring shows; centre on it once rows settle.
          const token = groupClassToken(groupOf(ev));
          window.setTimeout(
            () => centerShowTarget(token, true, '.ev-cross-linked'),
            320,
          );
          return;
        }

        // Own-work marker clicked while a legacy "Show" overlay is up: hand off
        // cleanly OUT of focus into a normal single-event selection rather than
        // silently re-expanding the rows and losing the marker. The soft
        // `ev-selected` pulse is applied automatically once focusActive flips false.
        if (focusedGroupIdsRef.current) {
          exitFocus(false);
          openPopover(x, y, [evId]);
          if (ev) {
            const token = groupClassToken(groupOf(ev));
            window.setTimeout(
              () => centerShowTarget(token, true, '.ev-selected'),
              320,
            );
          }
          return;
        }

        // Default: same-user / own-work marker, no focus — open the marker modal
        // (the related PR band glows via highlightPr through MarkerPopover).
        openPopover(x, y, [evId]);
      } else if (key.startsWith('cl:')) {
        const members = clusterMembersRef.current.get(key) ?? [];
        if (members.length === 0) return;
        const firstId = members[0]!;

        // Already inside a sticky PR-isolation focus: anchor on this cluster and show
        // its expanded popover; never re-enter or leave focus (mirrors the ev: branch
        // above — only the Exit-focus button / Esc / back leaves).
        if (prFocusActiveRef.current) {
          highlightEvent(firstId);
          openPopover(x, y, members);
          return;
        }

        // Clusters are single-PR and homogeneous (all own-work OR all cross-user)
        // after PR-partitioned bucketing, so the first member decides cross-person
        // status — exactly as for a single marker.
        const firstEv = eventsByIdRef.current.get(firstId);
        const pr =
          firstEv?.prId != null ? prsByIdRef.current.get(firstEv.prId) : undefined;
        const crossUser =
          firstEv != null &&
          firstEv.actorId != null &&
          pr?.authorId != null &&
          firstEv.actorId !== pr.authorId;

        // Cross-person cluster → the unified PR-isolation focus, anchored on the
        // cluster and recentred on its instant, then the expanded popover. Identical
        // to clicking a cross-user single marker.
        if (crossUser && firstEv.prId != null) {
          enterPrFocus(firstEv.prId, { anchorEventId: firstId, fitWindow: false });
          const tlc = timelineRef.current;
          if (tlc) {
            const c = new Date(firstEv.occurredAt).getTime();
            const win = tlc.getWindow();
            const width = win.end.valueOf() - win.start.valueOf();
            tlc.setWindow(c - width / 2, c + width / 2, { animation: false });
          }
          openPopover(x, y, members);
          const token = groupClassToken(groupOf(firstEv));
          window.setTimeout(
            () => centerShowTarget(token, true, '.ev-cross-linked'),
            320,
          );
          return;
        }

        // A legacy "Show" overlay is up (not a sticky PR focus): hand off cleanly OUT
        // into a normal selection, like the own-work ev: branch.
        if (focusedGroupIdsRef.current) {
          exitFocus(false);
          openPopover(x, y, members);
          if (firstEv) {
            const token = groupClassToken(groupOf(firstEv));
            window.setTimeout(
              () => centerShowTarget(token, true, '.ev-selected'),
              320,
            );
          }
          return;
        }

        // Own-work cluster, no focus → just the expanded popover.
        openPopover(x, y, members);
      }
    });

    // Double-clicking a PR bar enters the unified PR-isolation focus — same end
    // state as the PR-detail "Focus" link (the preceding single click just selects
    // it, which enterPrFocus does anyway). Other items ignore double-click.
    timeline.on('doubleClick', (props: { item: string | number | null }) => {
      const id = props.item;
      if (id == null) return;
      const key = String(id);
      if (!key.startsWith('pr:')) return;
      const prId = Number.parseInt(key.slice(3), 10);
      enterPrFocus(prId, { fitWindow: true });
      // Vertically centre the PR bar once the collapse + window change settle.
      const pr = prsByIdRef.current.get(prId);
      if (pr) {
        const token = groupClassToken(prGroupId(pr));
        window.setTimeout(() => centerShowTarget(token, false), 320);
      }
    });

    // Re-cluster when the zoom level changes (a burst that smears at one zoom
    // may separate at another).
    let reclusterTimer: ReturnType<typeof setTimeout> | null = null;
    let relaneTimer: ReturnType<typeof setTimeout> | null = null;
    timeline.on('rangechanged', () => {
      if (reclusterTimer) clearTimeout(reclusterTimer);
      reclusterTimer = setTimeout(() => rebuildMarkers(), 120);

      // A bar's min-width floor is pixel-based, so fitLaneBars depends on the px↔ms
      // scale. When the WIDTH changes (a real zoom — a pan keeps it constant) re-run
      // the rebuild so the bar fit re-resolves at the new zoom (lanes themselves are
      // zoom-stable now). Skip in focus mode (rows are collapsed to one PR; the
      // re-fit is pointless and risks disturbing the locked view). Debounced; a >2%
      // width delta gates out settle/pan jitter.
      const lastMs = lanedWindowMsRef.current;
      if (lastMs == null || prFocusActiveRef.current || focusedGroupIdsRef.current) return;
      const w = timeline.getWindow();
      const curMs = w.end.valueOf() - w.start.valueOf();
      if (Math.abs(curMs - lastMs) / lastMs <= 0.02) return;
      if (relaneTimer) clearTimeout(relaneTimer);
      relaneTimer = setTimeout(() => setLaneNonce((n) => n + 1), 160);
    });

    timelineRef.current = timeline;
    return () => {
      if (reclusterTimer) clearTimeout(reclusterTimer);
      if (relaneTimer) clearTimeout(relaneTimer);
      timeline.destroy();
      timelineRef.current = null;
    };
  }, [
    selectPr,
    rebuildMarkers,
    openPopover,
    applyContext,
    closeModal,
    exitFocus,
    centerShowTarget,
    highlightEvent,
    enterPrFocus,
    applyExitGlow,
  ]);

  // Per-row collapse caret (Item 6). vis re-parses / re-appends label HTML on every
  // group update, so an inline React handler can't survive — instead delegate from
  // ONE capturing listener on the stable container. Capture phase + stopPropagation
  // keep the click from also registering as a vis row click. The caret glyph/title
  // is flipped inline (the next rebuild regenerates the label with the right state).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest?.('[data-collapse-gid]') as HTMLElement | null;
      if (!btn) return;
      const gid = btn.getAttribute('data-collapse-gid');
      if (!gid) return;
      e.stopPropagation();
      e.preventDefault();
      // Req 3: per-row collapse is suspended in focus mode — a kept row must stay
      // expanded. Ignore caret clicks while any focus overlay is active (the caret is
      // also CSS-hidden then; this is the defensive backstop).
      if (prFocusActiveRef.current || focusedGroupIdsRef.current) return;
      const willCollapse = !collapsedRowsByUserRef.current.has(gid);
      setRowCollapsed(gid, willCollapse);
      btn.textContent = willCollapse ? '▸' : '▾';
      const title = willCollapse ? 'Expand row' : 'Collapse row';
      btn.setAttribute('title', title);
      btn.setAttribute('aria-label', title);
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, [setRowCollapsed]);

  // Fit min-width PR bars (resolve their pixel overlap) once the CENTER draw width
  // is known. vis sizes the label gutter asynchronously after a rebuild, so the
  // width can be wrong synchronously; we fit immediately when it matches the last
  // settled width (zoom / background sync — no gutter change, no flash), else poll
  // a few frames until it stabilises. `items` hold REAL start/end (freshly built),
  // so fitLaneBars always reasons from the true geometry. Supersedes any pending fit.
  const applyBarFit = useCallback((items: DataItem[]) => {
    if (barFitRafRef.current != null) {
      cancelAnimationFrame(barFitRafRef.current);
      barFitRafRef.current = null;
    }
    const fitAt = (w: number): void => {
      const tl = timelineRef.current;
      if (!tl || w <= 0) return;
      const win = tl.getWindow();
      fitLaneBars(items, (win.end.valueOf() - win.start.valueOf()) / w);
      itemsRef.current.update(items);
      settledCenterWidthRef.current = w;
    };
    const w0 = barDrawCenterPx(timelineRef.current, containerRef.current);
    if (w0 > 0 && Math.abs(w0 - settledCenterWidthRef.current) < 1) {
      fitAt(w0); // gutter already settled at this width — fit now, no flash
      return;
    }
    let lastW = -1;
    let stable = 0;
    let frames = 0;
    const step = (): void => {
      const w = barDrawCenterPx(timelineRef.current, containerRef.current);
      if (w > 0 && w === lastW) stable += 1;
      else {
        stable = 0;
        lastW = w;
      }
      if ((w > 0 && stable >= 2) || frames++ > 40) {
        barFitRafRef.current = null;
        fitAt(w);
        return;
      }
      barFitRafRef.current = requestAnimationFrame(step);
    };
    barFitRafRef.current = requestAnimationFrame(step);
  }, []);

  // Cancel a pending bar-fit on unmount.
  useEffect(
    () => () => {
      if (barFitRafRef.current != null) cancelAnimationFrame(barFitRafRef.current);
    },
    [],
  );

  // A viewport resize changes the CENTER draw width (px↔ms), so re-run the rebuild
  // to re-fit the bars at the new scale. Debounced; laneNonce drives the rebuild.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setLaneNonce((n) => n + 1), 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (t) clearTimeout(t);
    };
  }, []);

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
    // tierOf keeps tall (open + status line) and short (merged/closed) bars in
    // separate lanes so each lane's band height is uniform — otherwise a short bar
    // sharing a lane with a tall one floats above the band bottom and strands its
    // own-work markers far below it. hasComments mirrors renderPrBar's input.
    // Lanes pack by real spans now (zoom-stable, compact); the pixel-overlap of
    // min-width bars is resolved by fitLaneBars after the diff below (which needs
    // the laid-out draw width, so it runs post-redraw). Track the window width for
    // the zoom-change detector that re-fits via laneNonce.
    const winForLanes = timelineRef.current?.getWindow();
    lanedWindowMsRef.current = winForLanes
      ? winForLanes.end.valueOf() - winForLanes.start.valueOf()
      : null;
    const prLanes = assignPrLanes(basePrs, (pr) =>
      barIsTall(pr, prsWithComments.has(pr.id)) ? 1 : 0,
    );
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
            renderUserLabel(
              usersById.get(uid),
              uid,
              userStats.get(uid),
              isMaintainer,
              gid,
              collapsedRowsByUserRef.current.has(gid),
            ),
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
    // Preserve the vertical scroll across the rebuild so a background-sync refetch
    // (SyncStatus invalidates ['timeline'] when a sync lands) doesn't yank a
    // scrolled-down view to the top when rebuildMarkers() re-adds every marker.
    // Skip when a navigation has staged an off-window bar (forceShowOpenPrRef /
    // `extra`): the timelineFocusPr effect drives its own scroll-to-PR afterward,
    // and re-pinning the old position would fight it.
    const scrollBefore = extra ? null : verticalScrollEl()?.scrollTop ?? null;

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

    // Nudge overlapping min-width bars apart (so close-succession PRs don't each
    // need their own row), once the CENTER draw width is known (deferred — the
    // gutter is sized async). prItems still hold REAL start/end here.
    applyBarFit(prItems);

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
      focusRows(focusedGroupIdsRef.current); // re-assert collapse after rebuild
    }
    if (prFocusActiveRef.current && prFocusPrIdRef.current != null) {
      isolatePrBars(prFocusPrIdRef.current); // re-hide sibling bars after rebuild
    }
    // Re-assert user-collapsed rows: a background sync can add brand-new subgroups
    // (a fresh lane) to a collapsed row that would otherwise default to visible.
    // Skip while a focus overlay owns subgroupVisibility (per-row collapse is
    // re-applied on focus exit by applyContext); guarding avoids clobbering it.
    if (
      !focusedGroupIdsRef.current &&
      !prFocusActiveRef.current &&
      collapsedRowsByUserRef.current.size > 0
    ) {
      for (const gid of collapsedRowsByUserRef.current) setRowCollapsed(gid, true);
    }

    // Consumed: the staged open-PR bar has been materialized into this rebuild.
    // Clear it so a later background-sync rebuild doesn't keep re-injecting it.
    forceShowOpenPrRef.current = null;

    // Re-pin the vertical scroll the marker remove()+add() above clamped away.
    if (scrollBefore != null) reapplyScrollTop(scrollBefore);
  }, [
    data,
    derivedStates,
    userIds,
    reposById,
    usersById,
    mergersByRepo,
    forceShowNonce,
    laneNonce,
    rebuildMarkers,
    highlightPr,
    focusRows,
    isolatePrBars,
    setRowCollapsed,
    verticalScrollEl,
    reapplyScrollTop,
    applyBarFit,
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

  // Move the visible window when the range preset changes — and re-apply it on
  // every preset click via rangeResetSignal, so re-selecting the already-active
  // preset snaps the view back to that range after panning/zooming away.
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    const { from, to } = resolveRange(useFilters.getState());
    const { start, end } = paddedViewport(from, to);
    tl.setWindow(start, end, { animation: false });
  }, [preset, customFrom, customTo, rangeResetSignal]);

  // "Now" button: recenter the window on the current instant, keeping the
  // current zoom width. A transient store signal (epoch ms) the button bumps and
  // this effect consumes.
  const timelineCenterAt = useFilters((s) => s.timelineCenterAt);
  useEffect(() => {
    if (timelineCenterAt == null) return;
    const tl = timelineRef.current;
    if (!tl) return;
    const win = tl.getWindow();
    const width = win.end.valueOf() - win.start.valueOf();
    tl.setWindow(timelineCenterAt - width / 2, timelineCenterAt + width / 2, {
      animation: true,
    });
    useFilters.getState().consumeTimelineCenter();
  }, [timelineCenterAt]);

  // Scroll the timeline to a PR opened from the strip / my-turn / an event.
  const timelineFocusPr = useFilters((s) => s.timelineFocusPr);
  const timelineFocusAt = useFilters((s) => s.timelineFocusAt);
  useEffect(() => {
    if (timelineFocusPr == null) return;
    const tl = timelineRef.current;
    if (!tl) return;
    const inWindow = data?.prs.find((p) => p.id === timelineFocusPr);
    if (inWindow) {
      // "Focus" link: isolate this PR. Collapse to every contributor's row, show
      // only this PR's bar + activity, fit the window to its span, and stay there
      // (sticky) — only Exit focus / Escape leaves. This is the PR-isolation
      // overlay; the click handler keeps it up while the user explores.
      if (useFilters.getState().timelineIsolate && data) {
        // The "Focus" link and a cross-user marker click both funnel through the one
        // enterPrFocus path so they reach an identical end state. Here we fit the
        // window to the PR's span and centre its bar vertically once rows settle.
        enterPrFocus(timelineFocusPr, { fitWindow: true });
        const token = groupClassToken(prGroupId(inWindow));
        window.setTimeout(() => centerShowTarget(token, false), 320);
        useFilters.getState().consumeTimelineFocus();
        return;
      }

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
        // Among events matching (pr, type, refId), prefer the one at the requested
        // instant: review-comment replies all share their thread's refId, so the
        // occurredAt is what distinguishes a specific reply's marker. Falls back to
        // the first match (unchanged behaviour for thread/PR-comment/etc. links).
        const candidates = data.events.filter(
          (e) =>
            e.prId === timelineFocusPr &&
            e.type === focusEv.type &&
            (focusEv.refId == null || e.refId === focusEv.refId),
        );
        const match =
          (timelineFocusAt != null &&
            candidates.find((e) => e.occurredAt === timelineFocusAt)) ||
          candidates[0];

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
      dropOverlayForNavigation();
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
      dropOverlayForNavigation();
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
        dropOverlayForNavigation();
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
    rebuildMarkers,
    isolatePrBars,
    enterPrFocus,
    dropOverlayForNavigation,
  ]);

  return (
    <div className={`relative h-full w-full${focusActive ? ' tl-focus-active' : ''}`}>
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
          focusPrId={focusActive ? prFocusPrIdRef.current : null}
          onContextFocus={onPopoverContext}
          onDismiss={closeModal}
          onNavigate={navigatePopover}
        />
      )}
    </div>
  );
}
