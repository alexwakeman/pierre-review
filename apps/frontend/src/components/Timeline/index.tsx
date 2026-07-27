import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DataSet,
  Timeline as VisTimeline,
  type DataGroup,
  type DataItem,
  type TimelineOptions,
} from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.css';
import type {
  DerivedState,
  EventCategory,
  Repo,
  TimelineEvent,
  TimelinePr,
  TimelineResponse,
  User,
} from '@pierre-review/shared';
import {
  useMergers,
  useSearchTimeline,
  useTimeline,
  useRepos,
  useUsers,
} from '../../hooks/useTimeline.js';
import { useOpenPrs, useSearchOpenPrs } from '../../hooks/useTriage.js';
import { categoriesToTypes, resolveRange, useFilters } from '../../store/filters.js';
import {
  usePinnedTabs,
  type TabMeta,
  type TimelineMode,
} from '../../store/pinnedTabs.js';
import { escapeHtml, indexUsers, userLabel, watchedGlyphHtml } from '../../lib/ui.js';
import { SkeletonBlock, SkeletonLine } from '../Skeleton.js';
import { renderPrBar, prClassName, prTooltip } from './prBar.js';
import { renderUserLabel } from './userRow.js';
import { UserProfilePopover } from '../UserProfilePopover.js';
import { buildMarkerItems } from './clustering.js';
import { assignPrLanes, prGroupId } from './lanes.js';
import {
  MarkerPopover,
  type ContextFocus,
  type PopoverState,
} from './MarkerPopover.js';

const ZOOM_MIN_MS = 1000 * 60 * 60;

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
  // Compute each row's height from ALL its items, not just the ones in the visible
  // time window — so a horizontal pan can't collapse a row whose markers scrolled out
  // of view (the vertical-jump bug: vis's default 'auto' derives height from in-window
  // items only, so tall rows collapse/grow as you pan and the board reflows). The cost
  // is rows always reserving their full height (a taller board) — an accepted trade for
  // stable navigation. Per-group override to 'auto' for user-COLLAPSED rows (see
  // setRowCollapsed) so collapse can still shrink them, since 'fixed' ignores
  // subgroupVisibility.
  groupHeightMode: 'fixed',
  orientation: { axis: 'top', item: 'top' },
  zoomMin: ZOOM_MIN_MS,
  zoomMax: 1000 * 60 * 60 * 24 * 365 * 2,
  margin: { item: 4, axis: 8 },
  // delay: how long to hover a bar before its tooltip shows. vis defaults to 500ms,
  // which feels sluggish for the PR detail tooltip — drop to 150ms (still long enough
  // that sweeping the cursor across bars doesn't flash tooltips).
  tooltip: { followMouse: true, overflowMethod: 'flip', delay: 150 },
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

// Number of alternating per-repo background tints (see `.tl-repo-tint-N` in
// index.css). Repos are tinted in a two-colour ZEBRA — adjacent repos alternate
// between two muted hues (blue / purple) so each repo's block is set off from its
// neighbours without a loud rainbow. The tint is keyed off each repo's index in the
// RENDERED order (not a global id-rank), so the two hues always alternate row-to-row
// no matter which repos are currently shown. Two is the whole scheme; bumping this
// would need matching `.tl-repo-tint-N` rules.
const REPO_TINT_COUNT = 2;

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

// The PR bar's visible right edge (ms): its merged/closed instant, else "now" for
// an open PR (whose bar runs to the present — see the bar item's `end` in the
// rebuild). Fitting a focus window to a PR must reach this, not just the last
// event, or an open PR's bar overflows the viewport.
function prBarEndMs(pr: TimelinePr): number {
  return new Date(pr.mergedAt ?? pr.closedAt ?? new Date().toISOString()).getTime();
}

// A captured vertical-scroll position, by CONTENT (the contributor row at the
// viewport top + its offset) rather than raw pixels, so it survives height changes
// above the viewport. `scrollTop` is the pixel fallback used when the anchor row is
// gone after a sync. Used both across a rebuild and across a focus enter→exit.
type ScrollAnchor = { token: string | null; offset: number; scrollTop: number };

// First-load placeholder for the timeline: a left label gutter of repo → contributor
// rows next to horizontal PR-bar silhouettes, so the board's shape is legible before the
// (heavy) vis instance mounts. Purely structural — mirrors the Activity console's
// animate-pulse pattern via the shared Skeleton primitives. Absolutely positioned so it
// overlays the (empty) vis container without shifting layout.
const TL_SKELETON_GROUPS: { o: number; w: number }[][] = [
  [
    { o: 4, w: 46 },
    { o: 24, w: 34 },
  ],
  [
    { o: 10, w: 58 },
    { o: 40, w: 28 },
  ],
  [
    { o: 6, w: 40 },
    { o: 30, w: 50 },
  ],
];

function TimelineSkeleton(): JSX.Element {
  return (
    <div className="absolute inset-0 flex gap-4 overflow-hidden p-4" aria-hidden="true">
      {/* Left label gutter: repo header line + its contributor rows. */}
      <div className="flex w-44 shrink-0 flex-col gap-4">
        {TL_SKELETON_GROUPS.map((rows, gi) => (
          <div key={gi} className="flex flex-col gap-2">
            <SkeletonLine className="h-3.5 w-28" />
            {rows.map((_, ri) => (
              <SkeletonLine key={ri} className="ml-4 h-3 w-24" />
            ))}
          </div>
        ))}
      </div>
      {/* Right canvas: a header spacer (aligns with the repo label) then staggered
          horizontal PR-bar placeholders. */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {TL_SKELETON_GROUPS.map((rows, gi) => (
          <div key={gi} className="flex flex-col gap-2">
            <div className="h-3.5" />
            {rows.map((bar, ri) => (
              <SkeletonBlock
                key={ri}
                className="h-3"
                style={{ marginLeft: `${bar.o}%`, width: `${bar.w}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// `mode` turns this into an EMBEDDED per-tab instance (App keys the remount, so only
// ONE Timeline is ever mounted — the isolation is purely component-LOCAL):
//   • { kind: 'isolate', prId } — boots DIRECTLY into PR-isolation focus for prId, its
//     initial + only state (exit = closing/switching the tab → unmount).
// Absent = the full shared board (the base timeline), behaving as before minus the
// removed overlay entry paths.
export function Timeline({ mode }: { mode?: TimelineMode } = {}): JSX.Element {
  const embeddedPrId = mode?.kind === 'isolate' ? mode.prId : null;
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
  // The active "Threads" (derived thread-state) filter, mirrored into a ref so the
  // standalone rebuildMarkers (zoom reclusters call it directly) can drop the
  // markers of PRs the filter hides — keeping the event markers consistent with the
  // PR bars. Without this a Threads filter hid the bars (line 2065) but left every
  // event marker on the board, so picking e.g. "Replied" showed an unrelated jumble
  // of markers (incl. PR-comment markers, which aren't threads at all) with no bars.
  // `active` = the filter is on; `states` = the selected thread states. Markers are
  // narrowed to review_comment events whose own thread is in one of these states
  // (per-event `derivedState`), not just every comment on a matching PR.
  const derivedPassRef = useRef<{ active: boolean; states: DerivedState[] }>({
    active: false,
    states: [],
  });
  // The active event-category selection, mirrored into a ref so rebuildMarkers (which
  // also runs standalone on a zoom recluster, and in an isolate tab where the fetch
  // bypasses the server-side `types` filter) can drop markers for toggled-off
  // categories. On the shared board this is a redundant no-op (the server already
  // filters via the `types` query param); it's load-bearing ONLY on the prIds-scoped
  // focus/isolate path, which fetches every event type regardless of the header toggles.
  const categoriesRef = useRef<EventCategory[]>([]);
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
      const raw = localStorage.getItem('pierre:collapsedRows');
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
  // An open PR opened *within* the window but absent from the lean /api/timeline
  // payload (it had no in-window activity). The focus path stages it here so the
  // next rebuild materializes its bar; cleared once the rebuild consumes it.
  const forceShowOpenPrRef = useRef<TimelinePr | null>(null);
  // The pending deferred "enter focus / centre after the force-show rebuild paints"
  // timer (forceShowThen). Held so a rapid second search-pick cancels the first —
  // otherwise both timeouts fire and the focus flickers between the two PRs.
  const forceShowFocusTimerRef = useRef<number | null>(null);
  // Window width (ms) the current bar fit was computed for. The min-width floor is
  // in pixels, so fitLaneBars is zoom-dependent — a real zoom (width change) re-fits
  // via laneNonce; a pan (same width) does not.
  const lanedWindowMsRef = useRef<number | null>(null);
  // Window WIDTH (ms) at the last marker rebuild — gates the rangechanged recluster
  // so a pure horizontal PAN (width unchanged) doesn't rebuild identical markers.
  const reclusterWindowMsRef = useRef<number | null>(null);
  // Bar-fit deferral: vis sizes the label gutter asynchronously, so the CENTER draw
  // width isn't known synchronously during a rebuild. We poll for it (cancellable
  // rAF) and cache the last settled width so an unchanged-gutter rebuild (zoom,
  // background sync) can fit synchronously with no flash.
  const barFitRafRef = useRef<number | null>(null);
  const settledCenterWidthRef = useRef(0);
  // Sticky "Focus" (PR-isolation) overlay: collapse to a PR's contributors and show
  // only its bar. In an isolate-mode tab this is the tab's whole, permanent state
  // (booted once, left only by unmounting the tab). prFocusPrIdRef is the isolated PR.
  const prFocusActiveRef = useRef(false);
  const prFocusPrIdRef = useRef<number | null>(null);
  // PR-isolation focus connector overlay. The own-work CSS stem (index.css,
  // `.ev-own …::after`) joins a marker to its bar by SUBGROUP ADJACENCY — it only
  // works because the marker sits directly beneath its bar in the SAME row. A
  // CROSS-person marker lives in the actor's row while the bar lives in the
  // author's row, an unbounded number of rows away, so a fixed-height pseudo-element
  // can never reach it. Instead, in focus mode ONLY, this read-only SVG draws a
  // stem-styled line from each visible cross marker up/down to the focused PR's bar.
  // It only READS vis's rendered DOM rects (never writes scrollTop / calls focus()),
  // so it can't disturb the load-bearing scroll gate or any vis internal. The rAF
  // ref coalesces the many repaint signals (vis `changed`, vertical scroll) into one
  // paint per frame.
  const connectorSvgRef = useRef<SVGSVGElement | null>(null);
  const connectorRafRef = useRef<number | null>(null);
  // Sticky repo-name header (mirrors the Changes-tab sticky filename): an
  // absolutely-positioned DOM overlay over the LEFT label gutter that pins the repo
  // currently at the viewport top as you scroll vertically. A PURE READER of scroll
  // position + label rects — it never writes scrollTop / calls focus(), so it can't
  // disturb the load-bearing vertical-scroll gate. The rAF ref coalesces the many
  // repaint signals (vis `changed`, native vertical scroll, window resize) into one
  // paint per frame, exactly like the cross-connector overlay above.
  const stickyHeaderRef = useRef<HTMLDivElement | null>(null);
  const stickyHeaderRafRef = useRef<number | null>(null);
  // The selected marker's persistent "you're looking at this" pulse (the soft sky
  // halo, no marching ants), tracked like the other glows so a re-cluster can
  // re-apply it to whichever item now holds the event — a lone `ev:` marker or
  // the `cl:` cluster pill it folds into. Driven by the open popover whenever
  // we're NOT in cross-user focus (focus uses the cross-link ring instead).
  const selectedGlowEventRef = useRef<number | null>(null);
  const selectedGlowItemRef = useRef<string | null>(null);

  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Latest popover state, readable from stable callbacks without re-binding.
  const popoverRef = useRef<PopoverState | null>(null);
  popoverRef.current = popover;
  // The contributor popover (opened by clicking a row-label name). Holds the row's group
  // id + the clicked uid + the row's repo (which scopes the popover's numbers) + the click
  // point (fallback anchor). Local state, like `popover` — transient UI, not filter/URL state.
  const [statsPopover, setStatsPopover] = useState<{
    gid: string;
    uid: number;
    repoId: number;
    x: number;
    y: number;
  } | null>(null);
  // True whenever a row-collapse focus overlay is active (a cross-user marker or
  // an activity "Show"). Drives the bottom-right "Exit focus" button. Clicking the
  // timeline no longer reverts focus — this button (or browser-back) is the way
  // out, so it must be visible the whole time the timeline is collapsed.
  const [focusActive, setFocusActive] = useState(false);

  const { data, isLoading, error } = useTimeline(
    // A pr-focus tab fetches EXACTLY its subject PR (+ all its events) by id, so the PR loads +
    // highlights regardless of the board's repo/date/status filters — and cheaply (one PR, not
    // its whole repo's 90-day window). The isolate boot then collapses to just this PR.
    embeddedPrId != null ? { prIds: [embeddedPrId] } : undefined,
  );
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
  const queryClient = useQueryClient();
  const derivedStates = useFilters((s) => s.derivedStates);
  // Event-category toggles (Commits is off by default). Drives the client-side marker
  // gate in rebuildMarkers so a focus/isolate tab — whose prIds fetch has no server
  // `types` filter — still honours the header toggles (was: commits always showed there).
  const categories = useFilters((s) => s.categories);

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

  // repoId → its full metadata (owner / name / fullName). Backs both the repo row
  // label and the owner-grouped ordering of the rendered repos (see the rebuild).
  const reposById = useMemo(() => {
    const m = new Map<number, Repo>();
    for (const r of repos ?? []) m.set(r.id, r);
    return m;
  }, [repos]);
  // Mirror reposById into a ref so the once-bound vis handlers (metaOf) read current
  // repo metadata without re-binding.
  const reposByIdRef = useRef(reposById);
  reposByIdRef.current = reposById;
  // repoId → set of userIds with merge rights there (have merged a PR). Drives
  // the maintainer shield on each contributor row label.
  const mergersByRepo = useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const e of mergers ?? []) m.set(e.repoId, new Set(e.userIds));
    return m;
  }, [mergers]);
  const usersById = useMemo(() => indexUsers(users), [users]);
  usersByIdRef.current = usersById;

  // A freshly-synced repo (esp. a just-added one mid-backfill) surfaces events
  // and PR bars whose authors aren't in the cached ['users'] roster yet — the
  // lean /timeline payload refreshes independently of the user list, so those
  // rows would read "user 8401" until the next users refetch (or a full page
  // reload). Detect any referenced actor/author id we can't name and pull a
  // fresh roster. The events↔users FK guarantees the user row exists in the DB
  // once its event does, so this self-heals in a single refetch; React Query's
  // structural sharing means an unchanged roster returns the same reference, so
  // usersById doesn't change and this effect doesn't loop.
  const usersRefetchPendingRef = useRef(false);
  useEffect(() => {
    if (!data) return;
    let missing = false;
    for (const e of data.events) {
      if (e.actorId != null && !usersById.has(e.actorId)) {
        missing = true;
        break;
      }
    }
    if (!missing) {
      for (const p of data.prs) {
        if (p.authorId != null && !usersById.has(p.authorId)) {
          missing = true;
          break;
        }
      }
    }
    if (!missing) {
      usersRefetchPendingRef.current = false;
      return;
    }
    if (usersRefetchPendingRef.current) return; // a refetch is already in flight
    usersRefetchPendingRef.current = true;
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  }, [data, usersById, queryClient]);

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
        'pierre:collapsedRows',
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
      // heightMode must flip with collapse: an EXPANDED row is 'fixed' (height from ALL
      // items, so a horizontal pan can't collapse it — see VIS_OPTIONS groupHeightMode),
      // but 'fixed' IGNORES subgroupVisibility, so a collapsed row would stay tall. A
      // COLLAPSED row uses 'auto' so it shrinks to its label. vis reads heightMode ONLY
      // in the Group constructor (Group.setData ignores it), so we must RECONSTRUCT the
      // group (remove + re-add) to change it — a plain update won't take.
      const existing = groups.get(gid) as DataGroup | null;
      if (existing) {
        groups.remove(gid);
        groups.add({
          ...existing,
          subgroupVisibility: vis,
          heightMode: collapsed ? 'auto' : 'fixed',
        } as unknown as DataGroup);
      }
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
    // Record the width we're clustering at, so the rangechanged handler can skip a
    // recluster on a pure pan (same width) — see the recluster gate.
    reclusterWindowMsRef.current = rangeMs;
    const px = container.clientWidth || 1000;
    const msPerPx = rangeMs / px;

    // In the sticky PR-isolation focus, only this PR's events get markers — the
    // shared `cross` band can't be trimmed per-PR via subgroups, so we filter here
    // so a contributor row shows only their activity on the focused PR. The full
    // set is restored when the focus tears down (applyContext(null) → rebuild).
    let events: TimelineEvent[];
    if (prFocusActiveRef.current && prFocusPrIdRef.current != null) {
      // The sticky PR-isolation focus overrides the board filters: just this PR.
      events = cur.events.filter((e) => e.prId === prFocusPrIdRef.current);
    } else {
      // Outside focus the "Threads" thread-state filter narrows the markers.
      events = cur.events;
      if (derivedPassRef.current.active) {
        // A "Threads" filter is on. Restrict markers to review-thread comments only:
        // `review_comment` is the ONLY event type that maps to a review thread, so
        // every other type (PR reviews, PR comments, commits, lifecycle) doesn't fit a
        // thread-state filter and just reads as a confusing jumble. Each event carries
        // its thread's `derivedState`, so we keep ONLY the comments whose own thread is
        // in a selected state — selecting "Resolved" shows just the resolved threads'
        // comments, not every comment on a PR that happens to also have a resolved one.
        const { states } = derivedPassRef.current;
        events = events.filter(
          (e) =>
            e.type === 'review_comment' &&
            e.prId != null &&
            e.derivedState != null &&
            states.includes(e.derivedState),
        );
      }
    }
    // Category gate: drop markers for toggled-off categories (Commits is off by
    // default). On the shared board the server already filtered via `types`, so this
    // is a no-op there; on a prIds-scoped focus/isolate tab — which fetches EVERY
    // event type — this is what actually enforces the header toggles (the fix for
    // commits, and any other category, always showing on a focused PR). Reuses the
    // same category→type mapping the server uses (lifecycle + reviews always included).
    const allowedTypes = new Set(categoriesToTypes(categoriesRef.current));
    events = events.filter((e) => allowedTypes.has(e.type));
    const { items, clusterMembers } = buildMarkerItems(
      events,
      groupOf,
      usersByIdRef.current,
      prsByIdRef.current,
      prLanesRef.current,
      msPerPx,
      8,
      { start: win.start.valueOf(), end: win.end.valueOf() },
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

  // Repaint the focus-mode cross-person connectors (see connectorSvgRef). Endpoints
  // are real rendered DOM nodes, so reading their live rects handles re-clustering
  // and deconflict-nudged timestamps for free — we draw where vis actually placed
  // them, not where the data says. Pure read + SVG-path write; self-clears and bails
  // out cheaply whenever a PR-isolation focus isn't active.
  const drawCrossConnectors = useCallback(() => {
    const svg = connectorSvgRef.current;
    if (!svg) return;
    const clear = (): void => {
      if (svg.childElementCount) svg.replaceChildren();
      svg.style.display = 'none';
    };
    const container = containerRef.current;
    const prId = prFocusPrIdRef.current;
    if (!prFocusActiveRef.current || prId == null || !container) {
      clear();
      return;
    }
    const center = container.querySelector<HTMLElement>('.vis-panel.vis-center');
    const pr = prsByIdRef.current.get(prId);
    if (!center || !pr) {
      clear();
      return;
    }

    // The focused PR's bar is the only SELECTED bar; scope to its author row so a
    // stray selection elsewhere can't match, and fall back to the lone non-hidden
    // bar in that row. Bail (clear) when it's virtualized off-screen.
    const token = groupClassToken(prGroupId(pr));
    const barEl =
      container.querySelector<HTMLElement>(
        `.vis-foreground .vis-group.${token} .vis-item.pr-bar.vis-selected`,
      ) ??
      container.querySelector<HTMLElement>(
        `.vis-foreground .vis-group.${token} .vis-item.pr-bar:not(.pr-focus-hidden)`,
      );
    if (!barEl || barEl.offsetHeight === 0) {
      clear();
      return;
    }

    // Lay the overlay exactly over the center panel — its top-left becomes the
    // coordinate origin, and the SVG's own overflow:hidden clips lines to the panel
    // so they never paint over the label gutter or the time axis.
    const wrap = svg.parentElement ?? container;
    const wrapRect = wrap.getBoundingClientRect();
    const centerRect = center.getBoundingClientRect();
    svg.style.display = 'block';
    svg.style.left = `${centerRect.left - wrapRect.left}px`;
    svg.style.top = `${centerRect.top - wrapRect.top}px`;
    svg.style.width = `${centerRect.width}px`;
    svg.style.height = `${centerRect.height}px`;

    const barRect = barEl.getBoundingClientRect();
    const barTop = barRect.top - centerRect.top;
    const barBottom = barRect.bottom - centerRect.top;
    const barLeft = barRect.left - centerRect.left;
    const barRight = barRect.right - centerRect.left;

    const NS = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    // In focus, rebuildMarkers filtered events to this PR, so every rendered
    // `.ev-cross` glyph belongs to it (own-work markers carry `.ev-own` + the CSS
    // stem and are correctly excluded here).
    const markers = container.querySelectorAll<HTMLElement>(
      '.vis-foreground .vis-item.ev-cross',
    );
    for (const m of markers) {
      if (m.offsetHeight === 0) continue; // virtualized off-screen — no endpoint
      const glyph =
        m.querySelector<HTMLElement>('.ev-marker-inner, .ev-cluster-inner') ?? m;
      const gr = glyph.getBoundingClientRect();
      const mx = gr.left + gr.width / 2 - centerRect.left;
      const mTop = gr.top - centerRect.top;
      const mBottom = gr.bottom - centerRect.top;
      // Land the bar-side anchor ON the bar even when the marker's centre sits a hair
      // past the bar's edge (a near-instant PR, or a deconflict nudge). Within the
      // span — the common case — bx === mx, giving a clean vertical line like the stem.
      const bx = Math.max(barLeft, Math.min(mx, barRight));
      let y1: number;
      let y2: number;
      if (mTop >= barBottom) {
        y1 = mTop; // marker below the bar → stem upward into the bar's bottom edge
        y2 = barBottom;
      } else if (mBottom <= barTop) {
        y1 = mBottom; // marker above the bar → stem downward to the bar's top edge
        y2 = barTop;
      } else {
        continue; // marker overlaps the bar vertically — no meaningful line
      }
      const path = document.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        `M ${mx.toFixed(1)} ${y1.toFixed(1)} L ${bx.toFixed(1)} ${y2.toFixed(1)}`,
      );
      frag.appendChild(path);
    }
    svg.replaceChildren(frag);
  }, []);

  // Coalesce the many repaint signals (vis `changed` per redraw, native vertical
  // scroll) into one connector paint per frame. Skip entirely when there's nothing
  // to draw or clear, so the unfocused board pays only a couple of ref reads per
  // vis redraw.
  const scheduleConnectors = useCallback(() => {
    const inFocus = prFocusActiveRef.current && prFocusPrIdRef.current != null;
    const hasLines = (connectorSvgRef.current?.childElementCount ?? 0) > 0;
    if (!inFocus && !hasLines) return;
    if (connectorRafRef.current != null) return;
    connectorRafRef.current = requestAnimationFrame(() => {
      connectorRafRef.current = null;
      drawCrossConnectors();
    });
  }, [drawCrossConnectors]);

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
      // A PR force-shown for a filter-free focus (search) isn't in the filtered
      // prsByIdRef; recover its row from the rendered bar item's group so its lane
      // band is KEPT — otherwise focusSubgroups would hide the very bar we isolate.
      const barItem = itemsRef.current.get(`pr:${prId}`) as DataItem | null;
      const authorGroup = pr
        ? prGroupId(pr)
        : barItem && typeof barItem.group === 'string'
          ? barItem.group
          : null;
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
      // context (or one with no kept rows) means we're back to the full view. Purely
      // LOCAL React state now — it drives the tl-focus-active class, the connector gate,
      // and the on-canvas exit button; there's no shared store flag any more (the
      // isolation is component-local — only one Timeline is ever mounted).
      const active = !!(ctx?.groupIds && ctx.groupIds.length > 0);
      setFocusActive(active);
      if (!active) {
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

  // Resolve vis's own vertical-scroll panel — the element whose native `scroll` vis
  // mirrors into the timeline. Driving its scrollTop is how we scroll + materialize
  // virtualized rows (see the "Activity Show vertical scrolling" note below). Defined
  // here (above enterPrFocus) so the focus-entry path can capture the scroll anchor.
  const verticalScrollEl = useCallback((): HTMLElement | null => {
    const c = containerRef.current;
    if (!c) return null;
    return (
      c.querySelector<HTMLElement>('.vis-panel.vis-left.vis-vertical-scroll') ??
      c.querySelector<HTMLElement>('.vis-panel.vis-right.vis-vertical-scroll')
    );
  }, []);

  // Recompute the sticky repo-name header: find the repo block currently spanning the
  // viewport top and pin its name over the left label gutter. Pure DOM read + a couple
  // of direct writes to the overlay node (no React re-render, no scroll write) — the
  // same spirit as drawCrossConnectors. Guards every read against a torn-down instance.
  const updateStickyRepoHeader = useCallback((): void => {
    const host = stickyHeaderRef.current;
    const container = containerRef.current;
    if (!host || !container) return;
    const hide = (): void => {
      if (host.style.display !== 'none') host.style.display = 'none';
    };
    const vs = verticalScrollEl();
    if (!vs) {
      hide();
      return;
    }
    const wrap = host.parentElement ?? container;
    const wrapRect = wrap.getBoundingClientRect();
    const panelRect = vs.getBoundingClientRect();
    const panelTop = panelRect.top;
    const EPS = 1;

    // Repo headers in DOM/vertical order; the LAST one whose top has reached (or passed
    // above) the viewport top is the repo currently at the top. vis keeps every group
    // label in the DOM even when scrolled off (see captureScrollAnchor), so a header far
    // above stays findable — the name never drops out deep inside a big repo block.
    let current: HTMLElement | null = null;
    for (const h of container.querySelectorAll<HTMLElement>(
      '.vis-labelset .vis-label.tl-repo-header',
    )) {
      const r = h.getBoundingClientRect();
      if (r.height < 1) continue; // detached / not laid out
      if (r.top <= panelTop + EPS) current = h;
    }
    // Nothing at/above the top → we're at the very top and the real first header is
    // fully visible; a sticky copy would just double it. Same when the current repo's
    // OWN header is still sitting at the top (not yet scrolled above) — hide until it
    // scrolls up, so there's never a double header.
    if (!current) {
      hide();
      return;
    }
    const curRect = current.getBoundingClientRect();
    if (curRect.top >= panelTop - EPS) {
      hide();
      return;
    }

    const inner = current.querySelector<HTMLElement>('.vis-inner') ?? current;
    const name = (inner.textContent ?? '').trim();
    if (!name) {
      hide();
      return;
    }
    // Echo the current repo's zebra tint by carrying its `tl-repo-tint-N` class (which
    // sets `--tl-tint`; our CSS reads it for a faint wash over the opaque base).
    const tintClass = [...current.classList].find((c) => c.startsWith('tl-repo-tint-')) ?? '';

    if (host.dataset.repo !== name) {
      host.textContent = name;
      host.dataset.repo = name;
    }
    if (host.dataset.tint !== tintClass) {
      host.className = `tl-repo-sticky${tintClass ? ` ${tintClass}` : ''}`;
      host.dataset.tint = tintClass;
    }
    // Align to the left label panel's edge + width; both are stable (the panel is the
    // scroll viewport, its content scrolls within), so this is a couple of writes/frame.
    host.style.left = `${panelRect.left - wrapRect.left}px`;
    host.style.top = `${panelRect.top - wrapRect.top}px`;
    host.style.width = `${panelRect.width}px`;
    if (host.style.display !== 'block') host.style.display = 'block';
  }, [verticalScrollEl]);

  // Coalesce the repaint signals (vis `changed`, native vertical scroll, window resize)
  // into one sticky-header recompute per frame — mirrors scheduleConnectors.
  const scheduleStickyHeader = useCallback((): void => {
    if (stickyHeaderRafRef.current != null) return;
    stickyHeaderRafRef.current = requestAnimationFrame(() => {
      stickyHeaderRafRef.current = null;
      updateStickyRepoHeader();
    });
  }, [updateStickyRepoHeader]);

  // Capture the vertical scroll by CONTENT anchor — the contributor label nearest the
  // viewport top + its offset — so it can be re-placed after a rebuild OR a focus
  // enter→exit even when rows above change height. Contributor rows carry a `tlg-…`
  // token class; thin repo-header rows don't, so they're skipped. Falls back to the
  // raw pixel scrollTop when the anchor row is gone. (Full rationale at the rebuild
  // call site.)
  const captureScrollAnchor = useCallback((): ScrollAnchor | null => {
    const vs = verticalScrollEl();
    const container = containerRef.current;
    if (!vs || !container) return null;
    const vsTop = vs.getBoundingClientRect().top;
    let bestTok: string | null = null;
    let bestOffset = 0;
    let bestDist = Infinity;
    for (const l of container.querySelectorAll<HTMLElement>(
      '.vis-labelset .vis-label',
    )) {
      const r = l.getBoundingClientRect();
      if (r.height < 4 || r.bottom <= vsTop + 1) continue; // scrolled off the top
      const tok = [...l.classList].find((c) => c.startsWith('tlg-'));
      if (!tok) continue;
      const dist = Math.abs(r.top - vsTop);
      if (dist < bestDist) {
        bestDist = dist;
        bestTok = tok;
        bestOffset = r.top - vsTop;
      }
    }
    return { token: bestTok, offset: bestOffset, scrollTop: vs.scrollTop };
  }, [verticalScrollEl]);

  // Enter the unified PR-isolation focus on `prId`: collapse to every contributor
  // to the PR, show ONLY that PR's bar (siblings sharing its packed lane hidden via
  // isolatePrBars) and markers (the shared `cross` band is filtered in
  // rebuildMarkers), and — unless opts.fitWindow === false — fit the window to the
  // PR's activity span. Both the PR-detail "Focus" link and a cross-user marker
  // click funnel through here so they reach a byte-for-byte identical end state.
  // Reads REFS (not the `data` closure) so it stays stable and never recreates the
  // vis-init effect. Centring + consumeTimelineFocus are left to the caller.
  const enterPrFocus = useCallback(
    (
      prId: number,
      opts?: {
        anchorEventId?: number | null;
        fitWindow?: boolean;
        // The PR record, for the search path where the PR is force-shown but not yet
        // in the (filtered) `prsByIdRef` — pass it so focus can isolate a PR the
        // active filters would otherwise hide. Falls back to the in-payload lookup.
        pr?: TimelinePr;
      },
    ) => {
      const tl = timelineRef.current;
      const cur = dataRef.current;
      if (!tl || !cur) return;
      const pr = opts?.pr ?? prsByIdRef.current.get(prId);
      if (!pr) return;
      // Entering focus supersedes any open marker popover. Once we isolate this PR
      // and re-render markers filtered to it, a popover left over from another
      // marker would show stale content — or, if it pointed at a now-hidden PR, the
      // MarkerPopover's focusPrId filter empties it (an empty, headers-only modal).
      // Close it here. Callers that DO want a popover in focus (a cross-user marker
      // click / a marker double-click) re-open it right after, anchored on the PR.
      setPopover(null);
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
      // The bar's visible RIGHT edge — "now" for an open PR, not its last event —
      // so the fitted window below covers the whole bar (Number.isFinite always
      // holds with this + openedAt seeded).
      span(prBarEndMs(pr));
      for (const e of cur.events) {
        if (e.prId !== prId) continue;
        if (e.actorId != null) contributors.add(e.actorId);
        span(new Date(e.occurredAt).getTime());
      }
      const keepGroupIds = [...contributors].map((uid) => `repo:${repoId}:user:${uid}`);

      // Fit the window to the PR's activity span (+8% padding, min 12h). Horizontal
      // only — the boot effect's deferred centerShowTarget owns the vertical scroll.
      if (opts?.fitWindow !== false && Number.isFinite(minT) && Number.isFinite(maxT)) {
        const pad = Math.max((maxT - minT) * 0.08, 12 * 60 * 60 * 1000);
        tl.setWindow(minT - pad, maxT + pad, { animation: true });
      }

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
  // what's currently rendered. (`verticalScrollEl`, which resolves that panel, is
  // defined above so the focus-entry path can capture the scroll anchor.)
  const setVisScrollTop = useCallback(
    (top: number) => {
      const vs = verticalScrollEl();
      // Bail if the instance is torn down or the scroll panel is detached: the
      // synthetic 'scroll' dispatch below would otherwise reach vis's own scroll
      // handler on destroyed internals (_updateScrollTop → null). Guards the rare
      // race where a settle loop frame fires just as a focus tab unmounts.
      if (!vs || timelineRef.current == null || !vs.isConnected) return;
      const max = Math.max(0, vs.scrollHeight - vs.clientHeight);
      vs.scrollTop = Math.max(0, Math.min(max, top));
      // The programmatic set fires a native 'scroll' too, but dispatching now
      // makes vis re-layout synchronously so a follow-up measurement is fresh.
      vs.dispatchEvent(new Event('scroll'));
    },
    [verticalScrollEl],
  );

  // True while an intentional vertical scroll (centerShowTarget) is animating, so
  // the rebuild's DEFERRED onSettled re-pin doesn't fight it on the rare overlap of
  // a background-sync rebuild with a "Show"/focus centring. The synchronous
  // restoreScrollAnchor in the rebuild still runs — only the late re-anchor is gated.
  const intentionalScrollRef = useRef(false);
  // Monotonic id of the in-flight centerShowTarget settle loop. A newer call
  // supersedes any older one, so two settle loops can never write `.vis-vertical-
  // scroll`'s scrollTop on alternating frames (the source of focus-exit jitter); only
  // the current loop releases the intentional-scroll gate.
  const scrollLoopRef = useRef(0);

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
      // Supersede any prior in-flight settle loop: only the latest owns the scroll
      // and the gate. A backstop releases the gate even if rAF stalls mid-settle
      // (e.g. the tab is backgrounded), so a stuck-true gate can't permanently
      // disable the background-sync anchor restore.
      const myLoop = ++scrollLoopRef.current;
      intentionalScrollRef.current = true;
      window.setTimeout(() => {
        if (scrollLoopRef.current === myLoop) intentionalScrollRef.current = false;
      }, 2500);
      const step = (): void => {
        if (scrollLoopRef.current !== myLoop) return; // superseded — newer loop owns the gate
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
        else intentionalScrollRef.current = false; // settled — release the gate
      };
      requestAnimationFrame(() => requestAnimationFrame(step));
    },
    [verticalScrollEl, setVisScrollTop],
  );

  // Re-place a captured CONTENT anchor (see captureScrollAnchor, defined above near
  // enterPrFocus). Used to preserve the vertical scroll across the groups/markers
  // rebuild. Two things move the scroll during a rebuild: (1) rebuildMarkers() does a
  // wholesale remove()+add() of every marker, which momentarily empties each row's
  // bands so vis clamps the scroll toward the top before they re-render — a TRANSIENT
  // artifact to undo; and (2) a background sync can change the HEIGHT of rows ABOVE
  // the viewport (a new PR/event grows a contributor's row, or the rows re-sort) — a
  // REAL layout change. Re-pinning the old pixel scrollTop fixes (1) but mishandles
  // (2): the same offset then shows different content, so a scrolled-down board
  // visibly rides upward. Re-placing the captured row at the same offset keeps the
  // user's view put regardless of what changed above it; falls back to the captured
  // pixel scrollTop when that row no longer exists after the sync.
  const restoreScrollAnchor = useCallback(
    (anchor: ScrollAnchor) => {
      const container = containerRef.current;
      // One correction pass: nudge the anchor row back to its captured offset.
      // Returns true once it's within 1px (or the anchor is gone and the pixel
      // fallback has stuck). setVisScrollTop clamps to the panel's CURRENT
      // scrollHeight, which only grows back to full over several frames after the
      // marker remove()+add() (slower on a hundreds-of-rows board), so a single
      // on-target frame can still be a short-clamp mid-relayout.
      const applyOnce = (): boolean => {
        const vs = verticalScrollEl();
        if (!vs || !container) return true;
        if (anchor.token) {
          const lbl = container.querySelector<HTMLElement>(
            `.vis-labelset .vis-label.${anchor.token}`,
          );
          if (lbl && lbl.offsetHeight > 0) {
            const cur = lbl.getBoundingClientRect().top - vs.getBoundingClientRect().top;
            const corr = cur - anchor.offset;
            if (Math.abs(corr) > 1) {
              setVisScrollTop(vs.scrollTop + corr);
              return false;
            }
            return true;
          }
        }
        // Anchor row gone (its contributor dropped out of the synced data) — fall
        // back to pinning the captured pixel offset.
        setVisScrollTop(anchor.scrollTop);
        return Math.abs((verticalScrollEl()?.scrollTop ?? anchor.scrollTop) - anchor.scrollTop) <= 2;
      };
      applyOnce();
      let frames = 0;
      let stable = 0;
      // Hold until the anchor stays put for 3 consecutive frames (the layout has
      // settled); the 30-frame cap is only a backstop. It bails the moment the
      // anchor holds, so it never fights an active user scroll.
      const step = (): void => {
        if (applyOnce()) stable += 1;
        else stable = 0;
        if (stable < 3 && frames++ < 30) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [verticalScrollEl, setVisScrollTop],
  );

  // --- Marker popover -------------------------------------------------------
  // The popover is plain local state now (no History-API mirroring): it closes via
  // its X / Escape / a click on empty canvas, not the browser Back button.
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
      // The marker popover and the metrics popover are mutually exclusive — opening
      // one closes the other so two floating panels never overlap.
      setStatsPopover(null);
      setPopover({ x, y, eventIds });
    },
    [applyContext],
  );

  // Close the popover modal ONLY (its X button / Escape): a PR-isolation focus
  // (an isolate tab) stays put — its rows are the tab's whole state. When there's no
  // collapsed-row focus to keep examining (a same-user marker that only glowed its
  // PR) also clear that glow, since clicks no longer dismiss it.
  const closeModal = useCallback(() => {
    setPopover(null);
    if (!focusedGroupIdsRef.current) applyContext(null);
  }, [applyContext]);

  // A click on empty timeline canvas, dismissing ONE level at a time: an open
  // marker/cluster popover closes first — even inside a focus overlay (closeModal
  // keeps the focus up since a focus is active, so this can't tear the overlay
  // down; focus is left only via the "Exit focus" button / Esc). With no popover
  // open and OUTSIDE focus, a selected PR bar is deselected, else a lingering
  // exit-anchor glow (left after leaving focus) is cleared. So a popover-and-bar
  // combo clears the popover without yanking the PR out of the detail pane, and a
  // final click tidies the leftover anchor pulse. Shared by vis's own empty-canvas
  // click and the pane-gap click (the timeline pane beyond vis's drawn surface).
  const dismissEmptyCanvas = useCallback(() => {
    if (popoverRef.current) {
      closeModal();
    } else if (!focusedGroupIdsRef.current) {
      if (selectedPrIdRef.current != null) useFilters.getState().clearSelection();
      else if (exitGlowEventRef.current != null) applyExitGlow(null);
    }
  }, [closeModal, applyExitGlow]);

  // Open-in-detail: close the popover. The isolate tab's focus + detail pane stay.
  const navigatePopover = useCallback(() => {
    setPopover(null);
  }, []);

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

  // An isolate tab's focus is the tab's whole state — it's left by closing / switching
  // the tab (this Timeline unmounts), never torn down in place. So there's
  // no in-Timeline exit signal or browser-history unwind any more (App owns the single
  // popstate handler + the one Back-to-Activity marker).

  // Build a tab-label meta from a TimelinePr, for opening a PR-focus tab from a
  // double-click. Reads REFS (current repo/user metadata) so it stays stable and never
  // recreates the once-bound vis handlers.
  const metaOf = useCallback((pr: TimelinePr): TabMeta => {
    const repo = reposByIdRef.current.get(pr.repoId);
    const author = pr.authorId != null ? usersByIdRef.current.get(pr.authorId) : undefined;
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: repo?.fullName ?? `repo ${pr.repoId}`,
      authorLogin: author?.githubLogin ?? null,
      authorDisplayName: author?.displayName ?? null,
      authorAvatarUrl: author?.avatarUrl ?? null,
    };
  }, []);

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

      // A row-collapse caret OR a metrics-toggle click is handled by its own capturing
      // listener; ignore it here so it never doubles as a row / empty-canvas click
      // (which would clear the selection).
      const tgt = (native?.target ?? null) as HTMLElement | null;
      if (tgt?.closest?.('[data-collapse-gid]') || tgt?.closest?.('[data-user-gid]')) return;

      // Empty-canvas click → one-level-at-a-time dismissal (see dismissEmptyCanvas).
      if (id == null) {
        // The synthesized SECOND click of a double-click (native detail === 2) on a
        // marker that just entered focus lands on empty canvas (item:null) — click1's
        // rebuild + window-recenter moved the marker out from under the cursor. Don't
        // treat it as an intentional empty-canvas dismissal: it would tear down the
        // popover click1 just opened. The trailing doubleClick fires next and bails
        // (focus is active). A genuine single empty-canvas click is detail===1 and
        // still dismisses. (Timing can't discriminate — click1's focus-entry work
        // makes the gap to click2 vary widely; the click count is exact.)
        if ((native?.detail ?? 0) >= 2) return;
        dismissEmptyCanvas();
        return;
      }
      const key = String(id);

      if (key.startsWith('pr:')) {
        // Clicking a PR bar starts a fresh context. If a marker popover is open
        // (its event marker glowing, the event's PR selected + band-glowed), tear
        // that down first so the clicked PR becomes the SOLE selection — closeModal
        // clears the marker/PR glow (applyContext(null)) and pops the modal's
        // history entry. Skip inside a sticky focus overlay, where a bar click only
        // explores (the focused PR's bar is the lone clickable one and keeps focus).
        if (
          popoverRef.current &&
          !prFocusActiveRef.current &&
          !focusedGroupIdsRef.current
        ) {
          closeModal();
        }
        selectPr(Number.parseInt(key.slice(3), 10));
      } else if (key.startsWith('ev:')) {
        const evId = Number.parseInt(key.slice(3), 10);
        // Isolate-focus tab: clicking an event highlights it and opens its popover —
        // never leaves focus (the tab IS the focus). The popover's own cross-user
        // re-collapse is suppressed (see onPopoverContext).
        if (prFocusActiveRef.current) {
          highlightEvent(evId);
          openPopover(x, y, [evId]);
          return;
        }
        // Base board: open the marker popover in place (read the event). Isolating a
        // PR is a DOUBLE-click (→ a PR-focus tab); a single click no longer collapses
        // the board into an overlay.
        openPopover(x, y, [evId]);
      } else if (key.startsWith('cl:')) {
        const members = clusterMembersRef.current.get(key) ?? [];
        if (members.length === 0) return;
        const firstId = members[0]!;
        // Isolate-focus tab: anchor on this cluster and show its expanded popover.
        if (prFocusActiveRef.current) {
          highlightEvent(firstId);
          openPopover(x, y, members);
          return;
        }
        // Base board: open the expanded popover in place.
        openPopover(x, y, members);
      }
    });

    // Double-click → open the PR as its OWN isolated PR-focus TAB (a fresh <Timeline
    // mode='isolate'> that boots into isolation). A PR bar opens its PR; an event
    // marker / cluster opens the event's PR. In an isolate tab a double-click is a no-op —
    // the isolate tab is already focused.
    timeline.on('doubleClick', (props: {
      item: string | number | null;
      event?: { srcEvent?: MouseEvent } & Partial<MouseEvent>;
      pageX?: number;
      pageY?: number;
    }) => {
      const id = props.item;
      if (id == null) return;
      if (prFocusActiveRef.current) return;
      const key = String(id);

      if (key.startsWith('pr:')) {
        const prId = Number.parseInt(key.slice(3), 10);
        const pr = prsByIdRef.current.get(prId);
        if (pr) usePinnedTabs.getState().openPrFocusTab(metaOf(pr));
        return;
      }

      if (key.startsWith('ev:') || key.startsWith('cl:')) {
        const members = key.startsWith('ev:')
          ? [Number.parseInt(key.slice(3), 10)]
          : (clusterMembersRef.current.get(key) ?? []);
        const evId = members[0] ?? null;
        if (evId == null) return;
        const ev = eventsByIdRef.current.get(evId);
        if (ev?.prId == null) return;
        const pr = prsByIdRef.current.get(ev.prId);
        if (pr) usePinnedTabs.getState().openPrFocusTab(metaOf(pr));
      }
    });

    // Re-cluster when the zoom level changes (a burst that smears at one zoom
    // may separate at another).
    let reclusterTimer: ReturnType<typeof setTimeout> | null = null;
    let relaneTimer: ReturnType<typeof setTimeout> | null = null;
    timeline.on('rangechanged', () => {
      // Only RECLUSTER when the window WIDTH (zoom) actually changed. Clustering is
      // bucketed by absolute time at a fixed msPerPx, so a pure horizontal PAN (width
      // constant) produces byte-identical markers — rebuilding is pure churn that, even
      // with groupHeightMode:fixed, nudges band heights at pan-end (the residual jump).
      // A pan no longer collapses rows (fixed heights), so there's nothing to re-anchor
      // either. Same >2% tolerance the relane guard below uses.
      const wNow = timeline.getWindow();
      const curReclusterMs = wNow.end.valueOf() - wNow.start.valueOf();
      const lastReclusterMs = reclusterWindowMsRef.current;
      const zoomChanged =
        lastReclusterMs == null ||
        Math.abs(curReclusterMs - lastReclusterMs) / lastReclusterMs > 0.02;
      if (!zoomChanged) {
        // pure pan — markers + heights are unchanged; skip the rebuild entirely.
      } else {
      if (reclusterTimer) clearTimeout(reclusterTimer);
      const recluster = (): void => {
        // Don't recluster while an intentional scroll (a focus-exit restore or a
        // "Show" centring) owns the scroll — the two fight and the board jitters.
        // Re-arm past the settle instead; the recluster still runs, just never
        // mid-scroll.
        if (intentionalScrollRef.current) {
          reclusterTimer = setTimeout(recluster, 120);
          return;
        }
        reclusterTimer = null;
        // rebuildMarkers() re-renders every marker at the current zoom. At a coarser
        // zoom (e.g. just after leaving focus, when the window animated back out)
        // markers cluster differently, which can change the HEIGHT of a row — and a
        // height change in a row ABOVE the viewport shifts the visible rows even
        // though scrollTop is unchanged (the "events shuffle, then the board jumps"
        // symptom on focus exit). Pin the CONTENT anchor (the row at the viewport top)
        // across the rebuild so the visible rows stay put; restoreScrollAnchor's rAF
        // settle loop absorbs the async height change after vis redraws the markers.
        // Safe from races: this branch only runs while NO intentional scroll owns the
        // gate, and restoreScrollAnchor bails the moment the anchor holds.
        const anchor = captureScrollAnchor();
        rebuildMarkers();
        // rebuildMarkers' remove()+add() leaves vis to relayout ASYNCHRONOUSLY, so the
        // rows' bands are momentarily empty and scrollHeight transiently short. Without
        // a flush, the synchronous restore below clamps scrollTop against that short
        // height and vis paints ONE wrong-position frame (the pan-back row FLICKER) before
        // the rAF settle loop corrects it. Flush vis's relayout NOW so scrollHeight is
        // full and the anchor lands before the next paint — no intermediate frame. This
        // adds NO new scroll writer (restoreScrollAnchor stays the sole authority, gate
        // untouched); same redraw() flush setRowCollapsed uses for the same reason.
        timeline.redraw();
        if (anchor) restoreScrollAnchor(anchor);
      };
      reclusterTimer = setTimeout(recluster, 120);
      }

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

    // Repaint the focus-mode cross-person connectors whenever vis repaints (item
    // changes, pan, zoom — `changed` fires after the DOM is repositioned) and on
    // native vertical scroll, both coalesced to one rAF paint. The draw self-clears
    // outside focus, so on the normal board this is a couple of ref reads per redraw.
    timeline.on('changed', scheduleConnectors);
    const vScroll = verticalScrollEl();
    vScroll?.addEventListener('scroll', scheduleConnectors, { passive: true });

    // Sticky repo-name header: recompute on the same repaint signals as the connectors
    // (vis redraw + native vertical scroll) plus window resize (panel geometry), and
    // once now so it's correct before the first scroll. Pure reader; see
    // updateStickyRepoHeader. Listeners torn down in the cleanup below.
    timeline.on('changed', scheduleStickyHeader);
    vScroll?.addEventListener('scroll', scheduleStickyHeader, { passive: true });
    window.addEventListener('resize', scheduleStickyHeader, { passive: true });
    scheduleStickyHeader();

    timelineRef.current = timeline;
    return () => {
      // Supersede any in-flight centerShowTarget settle loop so its next rAF `step`
      // bails (scrollLoopRef.current !== myLoop) instead of writing scrollTop on the
      // now-destroyed vis instance — that write would fire vis's own scroll handler on
      // torn-down internals (_updateScrollTop → null). Matters when a focus / My-Turn
      // tab is closed within the ~2.5s settle window right after its boot centre.
      scrollLoopRef.current += 1;
      intentionalScrollRef.current = false;
      if (reclusterTimer) clearTimeout(reclusterTimer);
      if (relaneTimer) clearTimeout(relaneTimer);
      vScroll?.removeEventListener('scroll', scheduleConnectors);
      vScroll?.removeEventListener('scroll', scheduleStickyHeader);
      window.removeEventListener('resize', scheduleStickyHeader);
      if (connectorRafRef.current != null) {
        cancelAnimationFrame(connectorRafRef.current);
        connectorRafRef.current = null;
      }
      if (stickyHeaderRafRef.current != null) {
        cancelAnimationFrame(stickyHeaderRafRef.current);
        stickyHeaderRafRef.current = null;
      }
      timeline.destroy();
      timelineRef.current = null;
    };
  }, [
    selectPr,
    rebuildMarkers,
    openPopover,
    dismissEmptyCanvas,
    closeModal,
    highlightEvent,
    metaOf,
    captureScrollAnchor,
    restoreScrollAnchor,
    scheduleConnectors,
    scheduleStickyHeader,
    verticalScrollEl,
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

  // Contributor name click (each row label) → the shared user popover. Same delegated-capture
  // pattern as the collapse caret — vis re-creates labels on every rebuild, so an inline React
  // handler can't survive; capture + stopPropagation keep the click from registering as a vis
  // row click. Allowed during focus mode (it's read-only and harmless).
  //
  // The label is a real <a> to the GitHub profile, so a MODIFIED click (⌘/ctrl/shift/alt) or a
  // non-primary button is deliberately left alone — "open my profile in a new tab" still works
  // exactly as it did. Only a plain left click is intercepted and preventDefaulted.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const link = target?.closest?.('[data-user-gid]') as HTMLElement | null;
      if (!link) return;
      const gid = link.getAttribute('data-user-gid');
      if (!gid) return;
      // gids are `repo:<rid>:user:<uid>`. Both halves must parse or we leave the click alone
      // (the <a> then does what it always did).
      const m = /^repo:(\d+):user:(\d+)$/.exec(gid);
      if (!m) return;
      const repoId = Number(m[1]);
      const uid = Number(m[2]);
      if (!Number.isFinite(uid) || !Number.isFinite(repoId)) return;
      e.stopPropagation();
      e.preventDefault();
      // Mutually exclusive with the marker popover.
      setPopover(null);
      setStatsPopover((cur) =>
        cur && cur.gid === gid ? null : { gid, uid, repoId, x: e.clientX, y: e.clientY },
      );
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, []);

  // Clicking the timeline PANE outside vis's own drawn surface — the empty gap
  // under a short, few-row board (between the rows and the detail pane) — dismisses
  // like empty canvas too. vis's `click` handler only fires within `.vis-timeline`
  // itself (sized to content via maxHeight:'100%'), so that gap was a dead zone
  // where a click did nothing and an open popover lingered. We listen on the
  // container — the PARENT of `.vis-timeline` — and act only on clicks that land
  // OUTSIDE `.vis-timeline`: clicks INSIDE it are left to vis (it closes on empty
  // canvas, reopens on a marker); clicks OUTSIDE the container entirely (PR detail
  // pane, filter panels) never reach here; and the popover is portaled to <body>,
  // so its own clicks don't bubble in either.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPaneClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      // A marker click that enters focus calls enterPrFocus → rebuildMarkers(),
      // which removes+re-adds the clicked marker node mid-bubble. By the time the
      // click reaches here its target is detached, so closest('.vis-timeline')
      // wrongly returns null and we'd fall through to dismissEmptyCanvas() — closing
      // the popover focus just opened. A genuine pane-gap click always targets a
      // still-connected element, so a detached target means the click WAS inside vis.
      if (!target || !target.isConnected) return;
      if (target.closest('.vis-timeline')) return; // vis owns its own surface
      dismissEmptyCanvas();
    };
    container.addEventListener('click', onPaneClick);
    return () => container.removeEventListener('click', onPaneClick);
  }, [dismissEmptyCanvas]);

  // Fit min-width PR bars (resolve their pixel overlap) once the CENTER draw width
  // is known. vis sizes the label gutter asynchronously after a rebuild, so the
  // width can be wrong synchronously; we fit immediately when it matches the last
  // settled width (zoom / background sync — no gutter change, no flash), else poll
  // a few frames until it stabilises. `items` hold REAL start/end (freshly built),
  // so fitLaneBars always reasons from the true geometry. Supersedes any pending fit.
  const applyBarFit = useCallback((items: DataItem[], onSettled?: () => void) => {
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
      // This items.update fires a vis _redraw → _updateScrollTop clamp that can
      // land up to ~40 frames after the rebuild's own restoreScrollAnchor budget has
      // already expired. Let the caller re-anchor the saved scroll once it flushes.
      onSettled?.();
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

  // Set when a data change arrives while the tab is hidden, so the deferred
  // rebuild runs once when the tab becomes visible again (see the rebuild effect).
  const pendingHiddenRebuildRef = useRef(false);
  useEffect(() => {
    const onVisible = (): void => {
      if (!document.hidden && pendingHiddenRebuildRef.current) {
        pendingHiddenRebuildRef.current = false;
        setLaneNonce((n) => n + 1); // re-run the rebuild with the latest data
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Rebuild groups + PR bars when data or the derived-state filter changes.
  useEffect(() => {
    if (!data) return;
    dataRef.current = data;

    // Skip the expensive groups+bars+markers rebuild while the tab is hidden: a
    // background sync (the */5 cron keeps refetching) would otherwise run a
    // multi-second main-thread rebuild on a tab nobody is looking at, and several
    // queued landings would all fire the instant the tab is foregrounded (a big
    // part of the "foreground → stall" report). Defer to a single rebuild when the
    // tab becomes visible — the visibilitychange listener above bumps laneNonce.
    if (document.hidden) {
      pendingHiddenRebuildRef.current = true;
      return;
    }
    pendingHiddenRebuildRef.current = false;

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

    // The active "Threads" (derived thread-state) filter. A PR's bar shows only when
    // it has at least one review-thread COMMENT *in this window* whose thread is in a
    // selected state — the very events rebuildMarkers turns into markers. Keying the
    // bar on the matching in-window events (rather than the all-time `threadCounts`,
    // which would leave a PR whose only resolved thread sits outside the window
    // showing an empty bar) keeps bars and markers consistent: every shown bar has
    // its matching thread's comment markers, and only those. Empty selection = off.
    const derivedActive = derivedStates.length > 0;
    const matchingThreadPrIds = new Set<number>();
    if (derivedActive) {
      const sel = new Set(derivedStates);
      for (const e of data.events) {
        if (
          e.type === 'review_comment' &&
          e.prId != null &&
          e.derivedState != null &&
          sel.has(e.derivedState)
        ) {
          matchingThreadPrIds.add(e.prId);
        }
      }
    }
    const passesDerived = (pr: TimelinePr): boolean =>
      !derivedActive || matchingThreadPrIds.has(pr.id);

    const prs: TimelinePr[] = basePrs.filter(
      (pr) =>
        // An isolate (pr-focus) tab ALWAYS keeps its subject PR: the board's member/thread
        // filters must never hide it (the isolate fetch already returns only that PR), and it
        // must survive the very first rebuild — before the boot marks focus active.
        pr.id === embeddedPrId ||
        // Always render the selected PR's bar so event→PR navigation (and the global
        // PR-title search) has a target even when a filter would otherwise hide it,
        // and the bar a search/strip navigation force-staged (`extra`) so an
        // out-of-payload PR materializes regardless of the active filters.
        pr.id === selectedPrIdRef.current ||
        pr.id === extra?.id ||
        (authoredByMember(pr) && passesDerived(pr)),
    );

    // Mirror the thread-state filter into a ref so rebuildMarkers (which also runs
    // standalone on a zoom recluster) narrows the review-comment markers to those
    // whose own thread is in a selected state — only the matching thread's comments
    // show, not every comment on a PR that merely has one matching thread.
    derivedPassRef.current = {
      active: derivedActive,
      states: derivedStates,
    };
    // Keep the category gate current whenever a full rebuild runs (e.g. on a data
    // refetch). A pure category toggle is handled by the dedicated marker-only effect
    // below — `categories` is deliberately NOT a dep of this heavy effect.
    categoriesRef.current = categories;

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
    // Every bar is now a single uniform row (open and closed alike — the old taller
    // open-bar status line moved to the hover tooltip), so one lane tier suffices and
    // any bar can share a lane with any other.
    // Lanes pack by real spans now (zoom-stable, compact); the pixel-overlap of
    // min-width bars is resolved by fitLaneBars after the diff below (which needs
    // the laid-out draw width, so it runs post-redraw). Track the window width for
    // the zoom-change detector that re-fits via laneNonce.
    const winForLanes = timelineRef.current?.getWindow();
    lanedWindowMsRef.current = winForLanes
      ? winForLanes.end.valueOf() - winForLanes.start.valueOf()
      : null;
    const prLanes = assignPrLanes(basePrs);
    prLanesRef.current = prLanes;

    // Which events drive the contributor ROWS. When the client-side Threads filter is
    // active we collapse the board to just the people in the surviving events — otherwise
    // every actor in the payload keeps an (empty) row, which defeats the filter. Mirrors
    // rebuildMarkers' non-focus filtering so rows and markers agree. Left as the full set
    // under PR-isolation focus, which owns its own row collapse and must keep every
    // contributor row available to re-show.
    let rowEvents = data.events;
    // An isolate tab keeps ALL its subject PR's events driving the rows — never narrowed by the
    // board's Threads filter (and it must hold on the FIRST rebuild, before focus is marked active).
    if (embeddedPrId == null && !prFocusActiveRef.current && derivedActive) {
      const sel = new Set(derivedStates);
      rowEvents = data.events.filter(
        (e) =>
          e.type === 'review_comment' &&
          e.prId != null &&
          e.derivedState != null &&
          sel.has(e.derivedState),
      );
    }

    // Render the repos GROUPED BY OWNER so a multi-repo board keeps each org's repos
    // adjacent instead of scattering them in activity-appearance order. Sort by owner,
    // then repo name, then id (stable, deterministic); repos with no loaded metadata
    // sort last. `ridx` below (this array's index) then drives BOTH the vis group
    // `order` AND the zebra tint, so adjacent repos always alternate hues.
    const repoIds = unique([
      ...prs.map((p) => p.repoId),
      ...rowEvents.map((e) => e.repoId),
    ]).sort((a, b) => {
      const ra = reposById.get(a);
      const rb = reposById.get(b);
      if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1) || a - b;
      return (
        ra.owner.localeCompare(rb.owner) ||
        ra.name.localeCompare(rb.name) ||
        a - b
      );
    });

    const groups: DataGroup[] = [];
    // vis sorts groups (and nested groups within each parent) by the `order`
    // field — default groupOrder='order' — re-evaluated on every redraw, so it
    // survives the in-place DataSet diffing below. We set it explicitly: repos
    // follow the owner-grouped `repoIds` order computed above (so an org's repos
    // stay adjacent); within a repo, maintainers (those with merge rights — see
    // mergersByRepo) float to the top, everyone else keeps their existing relative
    // order beneath them.
    const MAINTAINER_RANK = 0;
    const CONTRIBUTOR_RANK = 1_000_000; // > any per-repo member count
    repoIds.forEach((rid, ridx) => {
      // A member sub-row exists for anyone who either acted in this repo or
      // authored a PR shown here. The latter keeps a row for PR authors with no
      // events (so their bar has a home); the former keeps a row for pure
      // reviewers (markers, no bar) — every contributor stays visible.
      const memberIds = unique([
        ...rowEvents
          .filter((e) => e.repoId === rid && e.actorId != null)
          .map((e) => e.actorId as number),
        ...prs
          .filter((p) => p.repoId === rid && p.authorId != null)
          .map((p) => p.authorId as number),
      ]);
      const mergerSet = mergersByRepo.get(rid);
      const nested = memberIds.map((uid) => `repo:${rid}:user:${uid}`);
      // Subtle per-repo background tint, shared by the repo header AND every one of
      // its contributor rows so the whole repo block (title + user column + its
      // timeline) reads as one tinted band. Carried on the className; the CSS
      // palette class sets a `--tl-tint` var the tint rule reads (see index.css).
      const tintClass = `tl-repo-tint-${ridx % REPO_TINT_COUNT}`;
      const repoMeta = reposById.get(rid);
      const repoName = repoMeta?.fullName ?? `repo ${rid}`;
      // Repo-header label is an HTML string (vis renders it via innerHTML, sanitizer
      // disabled — see VIS_OPTIONS) so a watched repo gets a small eye next to its
      // name. The name is GitHub-controlled, so escape it; the glyph SVG is static.
      const repoContent = repoMeta?.inboxWatch
        ? `${escapeHtml(repoName)}${watchedGlyphHtml()}`
        : escapeHtml(repoName);
      groups.push({
        id: `repo:${rid}`,
        content: repoContent,
        nestedGroups: nested.length ? nested : undefined,
        treeLevel: 1,
        order: ridx,
        // Order this row's subgroup bands by each item's `sortKey` (bar above its
        // own events; cross-user events last). See VIS_OPTIONS / buildMarkerItems.
        subgroupOrder: 'sortKey',
        // `tl-repo-header` scopes the repo-tint rule to the title row (it has no
        // `tl-user-row`); the tint class carries the hue.
        className: `tl-repo-header ${tintClass}`,
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
          // 'fixed' height (from ALL items) keeps the row stable during a horizontal
          // pan; a user-collapsed row uses 'auto' so it can still shrink to its label
          // (collapse hides bands via subgroupVisibility, which 'fixed' ignores).
          // Re-asserted on toggle in setRowCollapsed.
          heightMode: collapsedRowsByUserRef.current.has(gid) ? 'auto' : 'fixed',
          // `tl-user-row` scopes the collapse transition; the per-group token
          // lets focusRows find this row's label + bar to animate (Fix 1); the
          // repo tint class shares the hue with the repo header + sibling rows.
          className: `tl-user-row ${groupClassToken(gid)} ${tintClass}`,
        } as DataGroup);
      });
    });

    // While a PR-isolation focus is active, bake the `pr-focus-hidden` class into
    // every sibling bar's className up front. isolatePrBars re-hides them after this
    // rebuild too (below), but applyBarFit's DEFERRED items.update(prItems) — it
    // adjusts each bar's `end` a few frames later, once the gutter width settles —
    // would otherwise re-apply the un-hidden className straight from this array and
    // un-hide the siblings. That's the intermittent "focus suddenly shows the
    // author's other PRs" bug. Baking it in keeps prItems self-consistent so the
    // deferred fit can't undo the isolation.
    const focusHiddenPrId = prFocusActiveRef.current ? prFocusPrIdRef.current : null;

    const prItems: DataItem[] = prs.map((pr) => {
      const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      // The PR creator owns the band in their own row; fall back to the repo
      // row only when the author is unknown.
      const group = prGroupId(pr);
      const lane = prLanes.get(pr.id) ?? 0;
      const barMeta = {
        author: {
          label: userLabel(author, pr.authorId),
          avatarUrl: author?.avatarUrl ?? null,
        },
        hasComments: prsWithComments.has(pr.id),
      };
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
        content: renderPrBar(pr, barMeta),
        className: (() => {
          const base = prClassName(pr, barMeta.hasComments);
          return focusHiddenPrId != null && pr.id !== focusHiddenPrId
            ? `${base} pr-focus-hidden`
            : base;
        })(),
        title: prTooltip(pr, barMeta),
      } as DataItem;
    });

    // Diff the DataSets in place rather than clear()+add(). update() merges by
    // id and only ever adds/updates — vis keeps the existing DOM rows, so the
    // vertical scroll, the visible window, and the selection all survive a
    // background-sync refetch (Fix 3). Only genuinely-gone ids are removed.
    const tl = timelineRef.current;
    const win = tl?.getWindow();
    // Preserve the vertical scroll across the rebuild so a background-sync refetch
    // (SyncStatus invalidates ['timeline'] when a sync lands) neither yanks a
    // scrolled-down view to the top when rebuildMarkers() re-adds every marker, nor
    // lets it ride upward when rows above the viewport grow/re-sort — captured by
    // CONTENT anchor (the row at the viewport top), not raw pixels (see
    // captureScrollAnchor). Skip when a navigation has staged an off-window bar
    // (forceShowOpenPrRef / `extra`): the timelineFocusPr effect drives its own
    // scroll-to-PR afterward, and restoring the old position would fight it.
    const scrollAnchor = extra ? null : captureScrollAnchor();
    // Whether an intentional scroll (a "Show"/focus-exit centring) owned the scroll
    // when we captured the anchor. If so the anchor reflects a TRANSIENT mid-scroll
    // position and centerShowTarget is the authority on where the view ends up — the
    // deferred onSettled re-anchor below must not fire from it even once the loop has
    // settled (it lands up to ~40 frames out, by which time the gate may have cleared).
    const intentionalAtCapture = intentionalScrollRef.current;

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
    // gutter is sized async). prItems still hold REAL start/end here. The deferred
    // items.update re-clamps the vertical scroll long after restoreScrollAnchor
    // (below) has finished, so re-anchor once it settles to close that second window.
    applyBarFit(prItems, () => {
      // Skip the late re-anchor if an intentional scroll (a "Show"/focus centring)
      // is animating, OR was animating when we captured the anchor — this onSettled
      // lands ~40 frames out, by which time a short settle may have cleared the gate,
      // and re-anchoring to that stale mid-scroll position would yank the view off the
      // just-centred target. centerShowTarget self-corrects, so deferring to it is safe.
      // The synchronous restoreScrollAnchor below already covered the normal background-
      // sync case, so the scroll is never left unguarded by gating only here.
      if (scrollAnchor && !intentionalScrollRef.current && !intentionalAtCapture) {
        restoreScrollAnchor(scrollAnchor);
      }
    });

    rebuildMarkers();

    // Pin the window across the rebuild ONLY if the diff actually moved it. An
    // unconditional setWindow — even same-range with animation:false — fires
    // `rangechanged`, which schedules a recluster → a SECOND full rebuildMarkers
    // ~120ms later: a duplicate of the work just done, and on a large board the
    // dominant per-sync cost. The diff shouldn't move the window, so in the common
    // unchanged case skip the setWindow (and the recluster it would trigger).
    if (tl && win) {
      const now = tl.getWindow();
      if (
        now.start.valueOf() !== win.start.valueOf() ||
        now.end.valueOf() !== win.end.valueOf()
      ) {
        tl.setWindow(win.start, win.end, { animation: false });
      }
    }

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

    // KEEP re-injecting the force-staged open-PR bar while it's the PR the user is
    // still looking at (selected or PR-isolation-focused) AND it remains absent from
    // the lean payload. Otherwise the very next rebuild — a background timeline
    // refetch (the query is always stale), or a users/mergers refetch — drops `extra`
    // from basePrs and the bar vanishes ~half a second after the PR was opened from a
    // place that force-shows it (e.g. the Insights open-PR list, where focus then has
    // no bar). Clear it once the PR enters the payload, or the user moves off it, so a
    // stale forced bar never lingers.
    const fs = forceShowOpenPrRef.current;
    if (
      !fs ||
      data.prs.some((p) => p.id === fs.id) ||
      (selectedPrIdRef.current !== fs.id && prFocusPrIdRef.current !== fs.id)
    ) {
      forceShowOpenPrRef.current = null;
    }

    // Restore the captured content anchor: undo the marker remove()+add() clamp and
    // absorb any height change in the rows above the viewport. Gate on
    // intentionalScrollRef like the deferred re-anchor above: when a focus-exit
    // recenter / "Show" centring owns the scroll, its centerShowTarget loop is the
    // single authority — re-pinning here would fight it frame-for-frame (the
    // intermittent exit jitter). A later non-intentional rebuild re-anchors, and the
    // recenter lands on the intended target anyway.
    if (scrollAnchor && !intentionalScrollRef.current) restoreScrollAnchor(scrollAnchor);
  }, [
    data,
    derivedStates,
    openPrsData,
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
    captureScrollAnchor,
    restoreScrollAnchor,
    applyBarFit,
  ]);

  // Category toggles re-apply the marker gate WITHOUT a full groups+bars rebuild. Kept
  // out of the heavy rebuild effect above (which is why `categories` isn't a dep there):
  // on the SHARED board a toggle changes the timeline query key → a refetch, and the heavy
  // effect runs once when new `data` lands; running it here too would double the rebuild on
  // a large board. This lightweight pass gives instant marker feedback (esp. a "hide"
  // toggle, which the stale placeholder data can satisfy immediately) and — crucially — is
  // the ONLY re-apply path on an isolate/focus tab, whose `prIds` fetch never refetches on
  // a category change.
  useEffect(() => {
    categoriesRef.current = categories;
    if (timelineRef.current && dataRef.current) rebuildMarkers();
  }, [categories, rebuildMarkers]);

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

  // Boot an ISOLATE-mode tab DIRECTLY into PR-isolation focus for `mode.prId` — the
  // tab's initial + only state (exit = closing / switching the tab → unmount). Runs
  // UNCONDITIONALLY (the mode gate is INSIDE the body, so no conditional hook), once
  // per mount (bootedRef), only after the first payload carrying the PR has built its
  // bar (declared AFTER the rebuild effect → dataRef + bars are ready).
  //
  // LANDMINE-SAFE: enterPrFocus does horizontal setWindow + collapse/isolate/markers
  // only (NO vertical scroll, NO focus()). The SINGLE deferred centerShowTarget is the
  // ONLY vertical-scroll authority at boot, and it CLAIMS the scroll gate (++scrollLoopRef
  // / intentionalScrollRef=true) so nothing else fights it. A keyed remount means a fresh
  // instance, so no competing scroll loop exists. enterPrFocus/applyContext only selectPr
  // when selectedPrId !== prId, so a caller that pre-selected a thread keeps it.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (embeddedPrId == null || bootedRef.current) return;
    const tl = timelineRef.current;
    if (!tl || !dataRef.current) return; // wait for vis + the first payload/rebuild
    // Select the PR up front so its detail pane populates even if it turns out to be
    // outside this tab's ~90-day window (an old merged PR reached via the PrDetail
    // "Focus" link) and can't be isolated on the board — graceful degradation instead
    // of a bare un-isolated board. Respects a caller's pre-selected thread (only sets
    // when the PR isn't already the selection).
    if (useFilters.getState().selectedPrId !== embeddedPrId) {
      useFilters.getState().selectPr(embeddedPrId);
    }
    const record =
      prsByIdRef.current.get(embeddedPrId) ??
      data?.prs.find((p) => p.id === embeddedPrId) ??
      openPrsData?.prs.find((p) => p.id === embeddedPrId) ??
      searchOpenPrsData?.prs.find((p) => p.id === embeddedPrId);
    if (!record) return; // absent from this payload — retry on the next one (pane already shows it)
    bootedRef.current = true;
    enterPrFocus(embeddedPrId, { fitWindow: true, pr: record });
    const token = groupClassToken(prGroupId(record));
    // When the tab was opened to reveal a SPECIFIC event (item 11: a thread/comment
    // magnifier sets timelineFocusPr/At/Event for this PR), let the timelineFocusPr consumer
    // own the vertical centre — it scrolls to the event's marker row + glows it. Scheduling
    // our own centre here would win the scrollLoopRef arbitration (later timer supersedes)
    // and land on the PR bar instead. enterPrFocus already did the horizontal fit/isolate.
    const fs = useFilters.getState();
    const pendingEventFocus =
      fs.timelineFocusPr === embeddedPrId && fs.timelineFocusEvent != null;
    // Cleared on unmount so a fast tab-close before the deferred centre can't start a
    // settle loop on a torn-down instance.
    const t = pendingEventFocus
      ? null
      : window.setTimeout(() => centerShowTarget(token, false), 320);
    return () => {
      if (t != null) window.clearTimeout(t);
    };
  }, [embeddedPrId, data, openPrsData, searchOpenPrsData, enterPrFocus, centerShowTarget]);

  // Move the visible window when the range preset changes — and re-apply it on
  // every preset click via rangeResetSignal, so re-selecting the already-active
  // preset snaps the view back to that range after panning/zooming away. This whole
  // effect is inert in an isolate tab (the boot effect / enterPrFocus own the window
  // there).
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    if (embeddedPrId != null) return; // an isolate tab: the boot effect / enterPrFocus own the window
    const { from, to } = resolveRange(useFilters.getState());
    const { start, end } = paddedViewport(from, to);
    tl.setWindow(start, end, { animation: false });
  }, [preset, customFrom, customTo, rangeResetSignal, embeddedPrId]);

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

  // Scroll the SHARED board to a PR opened from the strip / j-k cycle / a PrDetail
  // "Show" link. BASE-BOARD navigation only: centre on the PR (or a clicked event's
  // instant), select it, and glow the matching marker. PR isolation is now a separate TAB
  // (a fresh keyed <Timeline mode>), never entered from here — so this
  // effect no longer has any focus / overlay / history branches. (These setters call
  // showTimeline() first, so this runs on the base board.)
  const timelineFocusPr = useFilters((s) => s.timelineFocusPr);
  const timelineFocusAt = useFilters((s) => s.timelineFocusAt);
  useEffect(() => {
    if (timelineFocusPr == null) return;
    const tl = timelineRef.current;
    if (!tl) return;

    const inWindow = data?.prs.find((p) => p.id === timelineFocusPr);
    if (inWindow) {
      const focusEv = useFilters.getState().timelineFocusEvent;

      // A "Show" link (PR comment / thread / activity entry): reveal one specific
      // event. Recenter horizontally on its instant, select the PR, glow its marker,
      // and scroll the marker's row into view. We can't use vis.focus() for the
      // vertical scroll (it only reaches already-rendered items, and the target row may
      // be a virtualised stub), so we drive vis's vertical scroll (centerShowTarget).
      if (focusEv && data) {
        // Among events matching (pr, type, refId), prefer the one at the requested
        // instant: review-comment replies share their thread's refId, so occurredAt is
        // what distinguishes a specific reply's marker. Falls back to the first match.
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

        const actorId = match?.actorId ?? inWindow.authorId;
        const hasMarker =
          match != null &&
          (itemsRef.current.get(`ev:${match.id}`) != null ||
            eventToClusterRef.current.get(match.id) != null);
        if (timelineFocusAt) {
          const c = Date.parse(timelineFocusAt);
          const win = tl.getWindow();
          const width = win.end.valueOf() - win.start.valueOf();
          tl.setWindow(c - width / 2, c + width / 2, { animation: true });
        }
        tl.setSelection([`pr:${timelineFocusPr}`]);
        if (match != null) highlightEvent(match.id);
        // The marker sits in the actor's row; a lifecycle event has no marker, so we
        // centre on the PR bar instead (hasMarker false).
        if (actorId != null) {
          const token = groupClassToken(`repo:${inWindow.repoId}:user:${actorId}`);
          window.setTimeout(() => centerShowTarget(token, hasMarker), 120);
        }
        useFilters.getState().consumeTimelineFocus();
        return;
      }

      // openPrFocused (strip / j-k): recenter on the clicked event's instant when
      // provided, else the PR bar's midpoint (avoids a big jump when a long-running
      // PR's midpoint is far from the clicked event), select it, and scroll its bar in.
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
      const token = groupClassToken(prGroupId(inWindow));
      // Defer the scroll: when a thread-state filter hides this PR, openPrFocused's
      // selection effect schedules a force-show rebuild to materialize the bar;
      // scrolling synchronously would miss it, so run after the rebuild paints.
      window.setTimeout(() => {
        centerShowTarget(token, false, '.ev-cross-linked', '.pr-bar.vis-selected');
      }, 120);
      useFilters.getState().consumeTimelineFocus();
      return;
    }

    // Force-show helper: stage an off-payload bar into the next rebuild, then select +
    // centre it once it paints.
    const forceShowThen = (record: TimelinePr): void => {
      forceShowOpenPrRef.current = record;
      setForceShowNonce((n) => n + 1);
      const token = groupClassToken(prGroupId(record));
      if (forceShowFocusTimerRef.current != null) {
        window.clearTimeout(forceShowFocusTimerRef.current);
      }
      forceShowFocusTimerRef.current = window.setTimeout(() => {
        forceShowFocusTimerRef.current = null;
        tl.setSelection([`pr:${record.id}`]);
        centerShowTarget(token, false, '.ev-cross-linked', '.pr-bar.vis-selected');
      }, 360);
      useFilters.getState().consumeTimelineFocus();
    };

    // Hidden by the member filter but present in the member-agnostic search payload —
    // force its bar in place (no range change; an open/overlapping bar spans the window).
    const hiddenByMember =
      data && !data.prs.some((p) => p.id === timelineFocusPr)
        ? searchData?.prs.find((p) => p.id === timelineFocusPr)
        : undefined;
    if (hiddenByMember) {
      forceShowThen(hiddenByMember);
      return;
    }

    // A currently-open PR (separate endpoint) outside the window / with no in-window
    // activity. Widen the range if it opened before the window, else force-show it.
    const candidate =
      openPrsData?.prs.find((p) => p.id === timelineFocusPr) ??
      searchOpenPrsData?.prs.find((p) => p.id === timelineFocusPr);
    if (candidate) {
      const { from } = resolveRange(useFilters.getState());
      const openedMs = new Date(candidate.openedAt).getTime();
      if (openedMs < from.getTime()) {
        // Opened before the window — widen the range so it enters data.prs, then the
        // effect re-runs into the in-window path above. Keep the focus pending.
        const day = new Date(openedMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        useFilters.getState().setCustomRange(day, today);
        return;
      }
      if (data && !data.prs.some((p) => p.id === candidate.id)) {
        forceShowThen(candidate);
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
    centerShowTarget,
    highlightEvent,
  ]);

  return (
    <div className={`relative h-full w-full${focusActive ? ' tl-focus-active' : ''}`}>
      {isLoading && !data && <TimelineSkeleton />}
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
      {/* Focus-mode cross-person → PR-bar connectors. Read-only, pointer-events:none,
          drawn (and sized over the center panel) only while a PR-isolation focus is
          active; see drawCrossConnectors. */}
      <svg
        ref={connectorSvgRef}
        className="tl-cross-connectors"
        aria-hidden="true"
        style={{ display: 'none' }}
      />
      {/* Sticky repo-name header. A read-only, pointer-events:none DOM overlay pinned
          over the left label gutter, showing the repo currently at the viewport top as
          you scroll vertically (mirrors the Changes-tab sticky filename). Positioned +
          filled directly by updateStickyRepoHeader; never intercepts row clicks. */}
      <div
        ref={stickyHeaderRef}
        className="tl-repo-sticky"
        aria-hidden="true"
        style={{ display: 'none' }}
      />
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
      {statsPopover && (
        <UserProfilePopover
          userId={statsPopover.uid}
          user={usersById.get(statsPopover.uid)}
          repoId={statsPopover.repoId}
          // The row label is destroyed + rebuilt on every vis rebuild, so anchor by SELECTOR
          // (re-resolved each frame) rather than by node, with the click point as the fallback.
          // The gid is `repo:<n>:user:<n>` — digits + colons only, safe in a quoted selector.
          anchor={{
            kind: 'selector',
            selector: `[data-user-gid="${statsPopover.gid}"]`,
            x: statsPopover.x,
            y: statsPopover.y,
          }}
          onDismiss={() => setStatsPopover(null)}
        />
      )}
    </div>
  );
}
