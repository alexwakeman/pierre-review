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
 * @returns prId -> lane index (0 = topmost lane in the row)
 */
export function assignPrLanes(
  prs: TimelinePr[],
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
    for (const pr of sorted) {
      const start = prStartMs(pr);
      // First lane that has freed up (its last PR ended at or before this one
      // starts). Touching spans (end === start) may share a lane — vis clips a
      // bar's label to its own width, so adjacent bars never bleed together.
      let lane = laneEnds.findIndex((endMs) => endMs <= start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(prEndMs(pr, nowMs));
      } else {
        laneEnds[lane] = prEndMs(pr, nowMs);
      }
      laneOf.set(pr.id, lane);
    }
  }
  return laneOf;
}
