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
import { buildMarkerItems } from './clustering.js';
import { MarkerPopover, type PopoverState } from './MarkerPopover.js';

const ZOOM_MIN_MS = 1000 * 60 * 60;

const VIS_OPTIONS: TimelineOptions = {
  stack: true,
  stackSubgroups: true,
  orientation: { axis: 'top', item: 'top' },
  zoomMin: ZOOM_MIN_MS,
  zoomMax: 1000 * 60 * 60 * 24 * 365 * 2,
  margin: { item: 4, axis: 8 },
  tooltip: { followMouse: true, overflowMethod: 'flip' },
  verticalScroll: true,
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

function groupOf(ev: TimelineEvent): string {
  return ev.actorId != null
    ? `repo:${ev.repoId}:user:${ev.actorId}`
    : `repo:${ev.repoId}`;
}

export function Timeline(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<VisTimeline | null>(null);
  const itemsRef = useRef(new DataSet<DataItem>());
  const groupsRef = useRef(new DataSet<DataGroup>());
  const eventsByIdRef = useRef(new Map<number, TimelineEvent>());
  const clusterMembersRef = useRef(new Map<string, number[]>());
  const dataRef = useRef<TimelineResponse | null>(null);
  const usersByIdRef = useRef(new Map<number, User>());
  // The PR bar currently glowing as the "linked" partner of an open marker
  // modal, so we can clear it when the modal closes or moves to another PR.
  const highlightedPrRef = useRef<number | null>(null);

  const [popover, setPopover] = useState<PopoverState | null>(null);

  const { data, isLoading, error } = useTimeline();
  const { data: openPrsData } = useOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const derivedStates = useFilters((s) => s.derivedStates);
  const selectPr = useFilters((s) => s.selectPr);
  const selectedPrId = useFilters((s) => s.selectedPrId);

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

    const stale = itemsRef.current
      .getIds()
      .filter((id) => {
        const k = String(id);
        return k.startsWith('ev:') || k.startsWith('cl:');
      });
    itemsRef.current.remove(stale);
    itemsRef.current.add(items);
  }, []);

  // Create the timeline once.
  useEffect(() => {
    if (!containerRef.current) return;
    const { from, to } = resolveRange(useFilters.getState());
    const timeline = new VisTimeline(
      containerRef.current,
      itemsRef.current,
      groupsRef.current,
      { ...VIS_OPTIONS, start: from, end: to },
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
        setPopover({ x, y, eventIds: [evId] });
      } else if (key.startsWith('cl:')) {
        // Zoom into the cluster's time-span so it unpacks into individual
        // markers (the rangechanged handler re-clusters at the finer zoom).
        // When members are too tight to separate even at max zoom, fall back to
        // the list popover.
        const members = clusterMembersRef.current.get(key) ?? [];
        const times = members
          .map((mid) => eventsByIdRef.current.get(mid)?.occurredAt)
          .filter((t): t is string => t != null)
          .map((t) => Date.parse(t));
        if (times.length > 0) {
          const min = Math.min(...times);
          const max = Math.max(...times);
          const pad = Math.max((max - min) * 0.15, 60_000);
          if (max - min + 2 * pad >= ZOOM_MIN_MS) {
            timeline.setWindow(min - pad, max + pad, { animation: true });
            setPopover(null);
          } else {
            setPopover({ x, y, eventIds: members });
          }
        } else {
          setPopover({ x, y, eventIds: members });
        }
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
  }, [selectPr, rebuildMarkers]);

  // Rebuild groups + PR bars when data or the derived-state filter changes.
  useEffect(() => {
    if (!data) return;
    dataRef.current = data;

    const prs: TimelinePr[] = data.prs.filter(
      (pr) =>
        // Always render the selected PR's bar so event→PR navigation has a
        // target even when the derived-state filter would otherwise hide it.
        pr.id === selectedPrId ||
        derivedStates.length === 0 ||
        derivedStates.some((s) => pr.threadCounts[s] > 0),
    );

    const evMap = new Map<number, TimelineEvent>();
    for (const ev of data.events) evMap.set(ev.id, ev);
    eventsByIdRef.current = evMap;

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
        groups.push({
          id: `repo:${rid}:user:${uid}`,
          content: userLabel(usersById.get(uid), uid),
          treeLevel: 2,
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

    groupsRef.current.clear();
    groupsRef.current.add(groups);

    // Replace PR bars, then (re)build markers for the new event set.
    const stalePr = itemsRef.current
      .getIds()
      .filter((id) => String(id).startsWith('pr:'));
    itemsRef.current.remove(stalePr);
    itemsRef.current.add(prItems);
    rebuildMarkers();

    // Re-adding the bars clears vis's selection, so restore the highlight for
    // the currently-selected PR (also keeps it highlighted across refetches).
    if (selectedPrId != null) {
      timelineRef.current?.setSelection([`pr:${selectedPrId}`]);
    }
  }, [data, derivedStates, reposById, usersById, selectedPrId, rebuildMarkers]);

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
          onHighlightPr={highlightPr}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}
