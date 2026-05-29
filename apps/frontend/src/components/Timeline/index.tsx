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

const VIS_OPTIONS: TimelineOptions = {
  stack: true,
  stackSubgroups: true,
  orientation: { axis: 'top', item: 'top' },
  zoomMin: 1000 * 60 * 60,
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

  const [popover, setPopover] = useState<PopoverState | null>(null);

  const { data, isLoading, error } = useTimeline();
  const { data: openPrsData } = useOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const derivedStates = useFilters((s) => s.derivedStates);
  const selectPr = useFilters((s) => s.selectPr);

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
        setPopover({ x, y, eventIds: [Number.parseInt(key.slice(3), 10)] });
      } else if (key.startsWith('cl:')) {
        const members = clusterMembersRef.current.get(key) ?? [];
        setPopover({ x, y, eventIds: members });
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
      const memberIds = unique(
        data.events
          .filter((e) => e.repoId === rid && e.actorId != null)
          .map((e) => e.actorId as number),
      );
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

    const prItems: DataItem[] = prs.map((pr) => ({
      id: `pr:${pr.id}`,
      group: `repo:${pr.repoId}`,
      type: 'range',
      start: pr.openedAt,
      end: pr.mergedAt ?? pr.closedAt ?? new Date().toISOString(),
      content: renderPrBar(pr),
      className: prClassName(pr),
      title: `#${pr.number} ${pr.title}`,
    }) as DataItem);

    groupsRef.current.clear();
    groupsRef.current.add(groups);

    // Replace PR bars, then (re)build markers for the new event set.
    const stalePr = itemsRef.current
      .getIds()
      .filter((id) => String(id).startsWith('pr:'));
    itemsRef.current.remove(stalePr);
    itemsRef.current.add(prItems);
    rebuildMarkers();
  }, [data, derivedStates, reposById, usersById, rebuildMarkers]);

  // Move the visible window when the range preset changes.
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    const { from, to } = resolveRange(useFilters.getState());
    tl.setWindow(from, to, { animation: false });
  }, [preset, customFrom, customTo]);

  // Scroll the timeline to a PR opened from the strip / my-turn.
  const timelineFocusPr = useFilters((s) => s.timelineFocusPr);
  useEffect(() => {
    if (timelineFocusPr == null) return;
    const tl = timelineRef.current;
    if (!tl) return;

    const inWindow = data?.prs.find((p) => p.id === timelineFocusPr);
    if (inWindow) {
      const startMs = new Date(inWindow.openedAt).getTime();
      const endMs = new Date(
        inWindow.mergedAt ?? inWindow.closedAt ?? new Date().toISOString(),
      ).getTime();
      const center = (startMs + endMs) / 2;
      const win = tl.getWindow();
      const width = win.end.valueOf() - win.start.valueOf();
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
  }, [timelineFocusPr, data, openPrsData]);

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
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}
