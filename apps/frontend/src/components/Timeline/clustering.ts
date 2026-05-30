import type { DataItem } from 'vis-timeline/standalone';
import type { TimelineEvent, TimelinePr, User } from '@gh-team-monitor/shared';
import { markerHtml, clusterHtml, type ClusterKind } from './markerTemplate.js';
import { eventTooltip } from './eventMarker.js';

// Subgroup sort weight for the shared cross-user band — larger than any PR's
// bar/own-event key (openMs*2[+1] ≈ 3.5e12) so it always orders to the bottom.
const CROSS_SORT = Number.MAX_SAFE_INTEGER;

// A full-width background item dropped into each row's `cross` subgroup draws the
// subtle divider line above the cross-user band. The span just needs to dwarf any
// realistic window so it always covers the visible width (vis clips it).
const SEP_START = '2000-01-01T00:00:00Z';
const SEP_END = '2100-01-01T00:00:00Z';

// Event types that get their own markers. PR lifecycle events are implicit in
// the bar's start/end, so they're not drawn as separate points.
const MARKER_TYPES = new Set([
  'review_comment',
  'pr_comment',
  'review_submitted',
  'commit_pushed',
]);

export function isMarkerEvent(ev: TimelineEvent): boolean {
  return MARKER_TYPES.has(ev.type);
}

// Which cluster bucket an event belongs to (commits / comments / reviews).
function clusterKindOf(ev: TimelineEvent): ClusterKind {
  if (ev.type === 'commit_pushed') return 'commit';
  if (ev.type === 'review_submitted') return 'review';
  return 'comment'; // review_comment + pr_comment
}

export interface ClusterResult {
  items: DataItem[];
  // cluster item id -> member event ids (for the popover list)
  clusterMembers: Map<string, number[]>;
}

/**
 * Build marker + cluster items for the timeline. Events in the same lane that
 * fall within `thresholdPx` of each other at the current zoom are merged into a
 * single "+N" badge so a burst of comments doesn't smear into an unreadable
 * line.
 *
 * Each marker carries a `subgroup` keyed on its PR's lane, so vis bands it under
 * that PR's bar (markers sit directly below their PR instead of in a separate
 * block). Non-overlapping PRs in a row share a lane (see assignPrLanes), so a
 * lane's own-work events share one line below their packed bars.
 * Events on the actor's OWN PR (actor === PR author) get the `ev-own` class,
 * which draws an up-chevron pointing at the bar above; cross-user events (the
 * actor acting on someone else's PR, whose bar lives in another row) don't.
 *
 * @param groupOf   maps an event to its vis group id (member sub-lane / repo)
 * @param prLanes   prId -> lane index, from assignPrLanes (own-work band placement)
 * @param msPerPx   current zoom: how many ms one horizontal pixel spans
 */
export function buildMarkerItems(
  events: TimelineEvent[],
  groupOf: (ev: TimelineEvent) => string,
  usersById: Map<number, User>,
  prsById: Map<number, TimelinePr>,
  prLanes: Map<number, number>,
  msPerPx: number,
  thresholdPx = 8,
): ClusterResult {
  const thresholdMs = Math.max(1, thresholdPx * msPerPx);
  const items: DataItem[] = [];
  const clusterMembers = new Map<string, number[]>();
  // Rows that have any cross-user marker — get a divider above their cross band.
  const crossGroups = new Set<string>();

  // Bucket events so a cluster never mixes kinds, and so each bucket lands in one
  // subgroup band with one own-work flag:
  //   • own-work (actor === PR author) → bucket per (row, kind, PR), but the band
  //     is keyed on the PR's packed LANE: own events become the `ev:<lane>` band
  //     that sits just under that lane's bars (sortKey = lane*2+1, one tick below
  //     the bars' lane*2). Distinct PRs sharing a lane share this line; they're
  //     temporally disjoint, so per-PR bucketing keeps their clusters separate.
  //   • cross-user → ALL of a lane's cross events of a kind merge into one
  //     bucket → the shared `cross` band pinned to the bottom of the row
  //     (sortKey = CROSS_SORT). They're someone else's PRs, with no bar here.
  const byBucket = new Map<
    string,
    {
      group: string;
      kind: ClusterKind;
      ownWork: boolean;
      subgroup: string;
      sortKey: number;
      events: TimelineEvent[];
    }
  >();
  for (const ev of events) {
    if (!isMarkerEvent(ev)) continue;
    const group = groupOf(ev);
    const kind = clusterKindOf(ev);
    const prId = ev.prId;
    const pr = prId != null ? prsById.get(prId) : undefined;
    const ownWork =
      ev.actorId != null && pr?.authorId != null && ev.actorId === pr.authorId;
    const bk = ownWork
      ? `${group}::${kind}::own::${prId}`
      : `${group}::${kind}::cross`;
    const existing = byBucket.get(bk);
    if (existing) {
      existing.events.push(ev);
      continue;
    }
    if (!ownWork) crossGroups.add(group);
    // The PR's lane is always known for own-work events (its PR is in prsById,
    // and lanes are assigned over that same full set); fall back to lane 0.
    const lane = ownWork ? (prLanes.get(prId!) ?? 0) : 0;
    byBucket.set(bk, {
      group,
      kind,
      ownWork,
      subgroup: ownWork ? `ev:${lane}` : 'cross',
      sortKey: ownWork ? lane * 2 + 1 : CROSS_SORT,
      events: [ev],
    });
  }

  for (const { group, kind, ownWork, subgroup, sortKey, events: groupEvents } of byBucket.values()) {
    const cls = (base: string) => (ownWork ? `${base} ev-own` : base);
    const sorted = [...groupEvents].sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );

    let bucket: TimelineEvent[] = [];
    let lastMs = -Infinity;

    const flush = () => {
      if (bucket.length === 0) return;
      if (bucket.length === 1) {
        const ev = bucket[0]!;
        items.push({
          id: `ev:${ev.id}`,
          group,
          subgroup,
          sortKey,
          type: 'point',
          start: ev.occurredAt,
          content: markerHtml(ev),
          className: cls('ev-marker'),
          title: eventTooltip(ev, usersById),
        } as DataItem);
      } else {
        const meanMs =
          bucket.reduce((s, e) => s + Date.parse(e.occurredAt), 0) / bucket.length;
        const id = `cl:${group}:${kind}:${bucket[0]!.id}`;
        clusterMembers.set(
          id,
          bucket.map((e) => e.id),
        );
        items.push({
          id,
          group,
          subgroup,
          sortKey,
          type: 'point',
          start: new Date(meanMs).toISOString(),
          content: clusterHtml(bucket.length, kind),
          className: cls('ev-cluster'),
          title: `${bucket.length} ${kind}s`,
        } as DataItem);
      }
      bucket = [];
    };

    for (const ev of sorted) {
      const ms = Date.parse(ev.occurredAt);
      if (bucket.length > 0 && ms - lastMs > thresholdMs) flush();
      bucket.push(ev);
      lastMs = ms;
    }
    flush();
  }

  // Divider line above each row's cross-user band (a background item confined to
  // the `cross` subgroup; styled via .cross-sep).
  for (const group of crossGroups) {
    items.push({
      id: `xsep:${group}`,
      group,
      subgroup: 'cross',
      sortKey: CROSS_SORT,
      type: 'background',
      start: SEP_START,
      end: SEP_END,
      content: '',
      className: 'cross-sep',
    } as DataItem);
  }

  return { items, clusterMembers };
}
