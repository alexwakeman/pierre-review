import type { DataItem } from 'vis-timeline/standalone';
import type { TimelineEvent, TimelinePr, User } from '@pierre-review/shared';
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
// Spacing model for the anti-overlap pass (deconflictBands). Every marker/cluster
// is rendered centred on its timestamp (translateX(-50%)), so two neighbours
// visually collide unless their centres are at least (halfWidthA + halfWidthB)
// apart. A plain marker is a 16px SVG (half ≈ 8px); a cluster "+N" pill is much
// wider and grows with its digit count — a single fixed gap can't cover both, so
// the pass spaces each pair by its actual glyph half-widths plus a little
// padding. Items that fall closer than that at the current zoom are nudged apart
// in time: they no longer sit exactly on their timestamp, but every glyph stays
// separately visible + clickable.
const MARKER_HALF_PX = 9; // 8px svg half + 1px breathing room
const GLYPH_PAD_PX = 3; // minimum clear gap between two adjacent glyph edges

// Approximate rendered half-width (px) of a cluster pill: padding (4+4) + border
// (1+1) + the 11px kind glyph + a 2px gap + the "+N" text (~6.5px per char at the
// pill's 10px bold font). Deliberately a touch generous so glyphs never quite
// touch even when the count grows to several digits.
function clusterHalfPx(count: number): number {
  const chars = 1 + String(count).length; // '+' followed by the digits
  return (23 + chars * 6.5) / 2;
}

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
  // Per-point glyph half-width (px), consumed by the anti-overlap pass so wide
  // cluster pills get spaced apart from their narrower marker neighbours.
  const halfPx = new Map<string, number>();
  // Rows that have any cross-user marker — get a divider above their cross band.
  const crossGroups = new Set<string>();

  // Bucket events so a cluster never mixes kinds, and so each bucket lands in one
  // subgroup band with one own-work flag:
  //   • own-work (actor === PR author) → bucket per (row, kind, PR), but the band
  //     is keyed on the PR's packed LANE: own events become the `ev:<lane>` band
  //     that sits just under that lane's bars (sortKey = lane*2+1, one tick below
  //     the bars' lane*2). Distinct PRs sharing a lane share this line; they're
  //     temporally disjoint, so per-PR bucketing keeps their clusters separate.
  //   • cross-user → bucket per (row, kind, PR) too, so a cluster only ever holds
  //     ONE PR's events (a click then has an unambiguous PR to focus). They still
  //     render on the shared `cross` band pinned to the bottom of the row (subgroup
  //     'cross', sortKey = CROSS_SORT) — someone else's PRs, no bar here; sibling
  //     PRs' clusters on that one line are spaced apart by deconflictBands.
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
      : `${group}::${kind}::cross::${prId ?? 'none'}`;
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
    // Tag every marker with its direction so CSS can style it on its own (a
    // per-marker cue that reads even when the row is collapsed or zoomed in), not
    // just by which band it lands in: own-work (actor === PR author) gets `ev-own`
    // (the stem tethering it up to its bar); cross-user gets `ev-cross` (the
    // outbound chip). Clusters inherit the same class from their bucket.
    const cls = (base: string) => `${base} ${ownWork ? 'ev-own' : 'ev-cross'}`;
    const sorted = [...groupEvents].sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );

    let bucket: TimelineEvent[] = [];
    let lastMs = -Infinity;

    const flush = () => {
      if (bucket.length === 0) return;
      if (bucket.length === 1) {
        const ev = bucket[0]!;
        const id = `ev:${ev.id}`;
        items.push({
          id,
          group,
          subgroup,
          sortKey,
          type: 'point',
          start: ev.occurredAt,
          content: markerHtml(ev),
          // `ev-key-<id>` lets the popover locate this marker's DOM element by event
          // id (vis copies className onto the .vis-item), so it can anchor beside the
          // marker even after a focus-entry rebuild re-clusters/moves it.
          className: `${cls('ev-marker')} ev-key-${ev.id}`,
          title: eventTooltip(ev, usersById),
          // Markers carry their OWN highlight (the custom `ev-selected` glow); we
          // never want vis-timeline's native selection on them. Left selectable,
          // vis paints its stock yellow box (.vis-selected) on click — invisible in
          // dev only because our override happens to win on CSS source order, but it
          // leaks through in the production bundle. selectable:false stops vis ever
          // selecting them; click events (which drive the popover) still fire.
          selectable: false,
        } as DataItem);
        halfPx.set(id, MARKER_HALF_PX);
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
          // One `ev-key-<id>` per member so any member event (incl. the popover's
          // anchor) locates this pill by event id, regardless of how re-clustering in
          // focus regroups them (see the single-marker note above).
          className: `${cls('ev-cluster')} ${bucket.map((e) => `ev-key-${e.id}`).join(' ')}`,
          title: `${bucket.length} ${kind}s`,
          selectable: false, // see the single-marker note above
        } as DataItem);
        halfPx.set(id, clusterHalfPx(bucket.length));
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

  // Anti-overlap pass. Clustering only merges events of the SAME kind within one
  // bucket, so a band can still hold differently-shaped neighbours (e.g. a
  // commit square abutting a comment circle on the same `ev:<lane>` line, or a
  // wide "+N" cluster pill sitting on top of a single marker on the shared
  // `cross` line) whose glyphs collide on the time axis. Within each rendered
  // band (group + subgroup) we walk the items in time order and push any that
  // sit closer than the two glyphs' combined half-widths to their left neighbour
  // out to exactly that distance — a small, zoom-scaled time nudge that keeps
  // every marker/cluster distinct and clickable (vis routes clicks by item id,
  // and the nudge only shifts the `start` timestamp, so handlers/focus/clustering
  // are unaffected). Background dividers carry no glyph and are skipped.
  deconflictBands(items, msPerPx, halfPx);

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

// Spread point items within each rendered band (group + subgroup) so adjacent
// glyphs never overlap on the time axis. Items are bucketed by their band,
// sorted by start time, and each one that crowds its left neighbour is pushed
// right until the two centres are `prevHalf + half + GLYPH_PAD_PX` pixels apart
// (converted to ms via `msPerPx`). Because the gap is derived from each item's
// own half-width (`halfPx`, defaulting to a plain marker), a wide "+N" cluster
// pill reserves enough room that its narrower marker neighbours no longer sit
// underneath it. The nudge is forward-only, so the time order stays stable and
// the visual drift is one-sided + minimal. Only `point` items (markers +
// clusters) are spread; ranges/backgrounds are left untouched. The item objects
// are mutated in place — they're freshly built above.
function deconflictBands(
  items: DataItem[],
  msPerPx: number,
  halfPx: Map<string, number>,
): void {
  if (msPerPx <= 0) return;
  const bands = new Map<string, DataItem[]>();
  for (const it of items) {
    if (it.type !== 'point') continue;
    const key = `${String(it.group)} ${String(it.subgroup ?? '')}`;
    const list = bands.get(key);
    if (list) list.push(it);
    else bands.set(key, [it]);
  }
  for (const list of bands.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => startMs(a) - startMs(b));
    let prevMs = -Infinity;
    let prevHalf = 0;
    for (const it of list) {
      const half = halfPx.get(String(it.id)) ?? MARKER_HALF_PX;
      let ms = startMs(it);
      const minGapMs = (prevHalf + half + GLYPH_PAD_PX) * msPerPx;
      if (ms - prevMs < minGapMs) {
        ms = prevMs + minGapMs;
        it.start = new Date(ms).toISOString();
      }
      prevMs = ms;
      prevHalf = half;
    }
  }
}

function startMs(it: DataItem): number {
  const s = it.start;
  if (s instanceof Date) return s.valueOf();
  if (typeof s === 'number') return s;
  return Date.parse(String(s));
}
