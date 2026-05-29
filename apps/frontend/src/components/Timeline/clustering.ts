import type { DataItem } from 'vis-timeline/standalone';
import type { TimelineEvent, User } from '@gh-team-monitor/shared';
import { markerHtml, clusterHtml } from './markerTemplate.js';
import { eventTooltip } from './eventMarker.js';

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
 * @param groupOf   maps an event to its vis group id (member sub-lane / repo)
 * @param msPerPx   current zoom: how many ms one horizontal pixel spans
 */
export function buildMarkerItems(
  events: TimelineEvent[],
  groupOf: (ev: TimelineEvent) => string,
  usersById: Map<number, User>,
  msPerPx: number,
  thresholdPx = 8,
): ClusterResult {
  const thresholdMs = Math.max(1, thresholdPx * msPerPx);
  const items: DataItem[] = [];
  const clusterMembers = new Map<string, number[]>();

  // bucket events by lane
  const byGroup = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    if (!isMarkerEvent(ev)) continue;
    const g = groupOf(ev);
    const arr = byGroup.get(g) ?? [];
    arr.push(ev);
    byGroup.set(g, arr);
  }

  for (const [group, groupEvents] of byGroup) {
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
          type: 'point',
          start: ev.occurredAt,
          content: markerHtml(ev),
          className: 'ev-marker',
          title: eventTooltip(ev, usersById),
        } as DataItem);
      } else {
        const meanMs =
          bucket.reduce((s, e) => s + Date.parse(e.occurredAt), 0) / bucket.length;
        const id = `cl:${group}:${bucket[0]!.id}`;
        clusterMembers.set(
          id,
          bucket.map((e) => e.id),
        );
        items.push({
          id,
          group,
          type: 'point',
          start: new Date(meanMs).toISOString(),
          content: clusterHtml(bucket.length),
          className: 'ev-cluster',
          title: `${bucket.length} events`,
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

  return { items, clusterMembers };
}
