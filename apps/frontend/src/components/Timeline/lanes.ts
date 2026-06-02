import type { TimelinePr } from '@gh-team-monitor/shared';

// The vis group id a PR's bar lives in: the author's member row, or the repo
// row when the author is unknown. Shared by the bar build and the marker build
// (clustering) so a PR's bar, its lane, and its own-work events all land in the
// same row.
export function prGroupId(pr: TimelinePr): string {
  return pr.authorId != null
    ? `repo:${pr.repoId}:user:${pr.authorId}`
    : `repo:${pr.repoId}`;
}

function prStartMs(pr: TimelinePr): number {
  return Date.parse(pr.openedAt);
}

// An open PR's bar runs to "now"; a closed/merged one ends when it closed.
function prEndMs(pr: TimelinePr, nowMs: number): number {
  const end = pr.mergedAt ?? pr.closedAt;
  return end ? Date.parse(end) : nowMs;
}

/**
 * Greedy interval partitioning, per group (user row): pack PRs whose time spans
 * don't overlap onto the same horizontal lane, so a prolific author's row is a
 * few lanes tall instead of one line per PR.
 *
 * Within a group, PRs are sorted by open time and each is dropped into the
 * lowest-indexed lane whose previous PR has already ended; a new lane opens only
 * when every existing lane is still occupied. The resulting lane count equals
 * the row's peak concurrent-PR depth — the minimum possible. Lanes are assigned
 * over the full PR set (not the derived-state-filtered subset) so a PR keeps the
 * same lane as filters toggle, and own-work event markers can resolve their PR's
 * lane regardless of whether that PR's bar is currently shown.
 *
 * `tierOf` groups PRs by rendered bar HEIGHT: a lane only ever holds bars of one
 * tier, so the lane's band height is uniform and every bar sits flush against the
 * own-work marker band just below it. Without this, a short merged bar packed into
 * a lane sized by a tall open bar floats at the band top, leaving its `ev:<lane>`
 * markers stranded ~15px below (vis top-aligns items within a band). The cost is at
 * most one extra lane per row for a user with both tall and short non-overlapping
 * PRs. Defaults to a single tier (the original packing) when omitted.
 *
 * `minBarMs` is the time-equivalent (at the current zoom) of a bar's rendered
 * minimum width (`.vis-item.pr-bar` min-width in index.css). A PR whose real span
 * is shorter still paints that many ms wide, so the packer treats each PR's
 * footprint as running at least `minBarMs` past its start — otherwise two short,
 * time-disjoint PRs created in close succession share a lane and their min-width
 * bars visually overlap. Pass 0 (the default) to pack purely by real time span.
 *
 * @returns prId -> lane index (0 = topmost lane in the row)
 */
export function assignPrLanes(
  prs: TimelinePr[],
  tierOf: (pr: TimelinePr) => number | string = () => 0,
  minBarMs = 0,
  nowMs = Date.now(),
): Map<number, number> {
  const byGroup = new Map<string, TimelinePr[]>();
  for (const pr of prs) {
    const g = prGroupId(pr);
    const list = byGroup.get(g);
    if (list) list.push(pr);
    else byGroup.set(g, [pr]);
  }

  const laneOf = new Map<number, number>();
  for (const list of byGroup.values()) {
    const sorted = [...list].sort((a, b) => prStartMs(a) - prStartMs(b));
    const laneEnds: number[] = []; // laneEnds[i] = end-ms of the last PR in lane i
    const laneTier: (number | string)[] = []; // laneTier[i] = the height tier lane i holds
    for (const pr of sorted) {
      const start = prStartMs(pr);
      const tier = tierOf(pr);
      // The bar's footprint is its real span OR its min-width floor, whichever is
      // wider — so a near-instant PR still reserves `minBarMs` of lane space.
      const end = Math.max(prEndMs(pr, nowMs), start + minBarMs);
      // First lane that has freed up (its last bar's footprint ended at or before
      // this one starts) AND holds this PR's tier, so a lane never mixes bar
      // heights. Touching spans (end === start) may share a lane — vis clips a
      // bar's label to its own width, so adjacent bars never bleed together.
      let lane = laneEnds.findIndex(
        (endMs, i) => endMs <= start && laneTier[i] === tier,
      );
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
        laneTier.push(tier);
      } else {
        laneEnds[lane] = end;
      }
      laneOf.set(pr.id, lane);
    }
  }
  return laneOf;
}
