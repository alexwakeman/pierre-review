import type { DerivedState, Repo, TimelineEvent, TimelinePr } from '@pierre-review/shared';

// THE TIMELINE AS A LIST (a phone's default reading — components/Timeline/TimelineList.tsx). The SAME
// population the board draws bars for, never a second filter: the payload is the board's own
// `/api/timeline` answer (repos, members' activity, status, range, events and bots already applied by
// the server), and the two client-side narrowings the board's rebuild adds are mirrored here exactly
// (components/Timeline/index.tsx, the rebuild's `prs` filter):
//   • Members — only PRs a selected member AUTHORED (the payload also carries PRs they only acted on,
//     for marker attribution; the board drops those bars).
//   • Threads — only PRs with at least one review-comment event IN THE WINDOW whose thread is in a
//     selected state.
// The selected PR always stays (the board force-shows its bar too). Grouped by repository; within a
// repo the most recently active PR first. Pure, so it is a test.

export interface TimelineListRow {
  pr: TimelinePr;
  /** Events on this PR in the window (what the board draws as markers). */
  events: number;
  /** The latest event in the window, else the PR's own updatedAt (ms). */
  lastAt: number;
}

export interface TimelineListGroup {
  repoId: number;
  /** owner/name, or "Repository <id>" while the repo list loads. */
  name: string;
  rows: TimelineListRow[];
}

export function timelineListModel({
  prs,
  events,
  repos,
  userIds,
  derivedStates,
  selectedPrId,
}: {
  prs: readonly TimelinePr[];
  events: readonly TimelineEvent[];
  repos: ReadonlyMap<number, Pick<Repo, 'fullName'>>;
  userIds: readonly number[] | null;
  derivedStates: readonly DerivedState[];
  selectedPrId: number | null;
}): TimelineListGroup[] {
  const members = userIds != null && userIds.length > 0 ? new Set(userIds) : null;
  const threadStates = derivedStates.length > 0 ? new Set(derivedStates) : null;
  const matchingThreadPrs = new Set<number>();
  const counts = new Map<number, number>();
  const latest = new Map<number, number>();
  for (const e of events) {
    if (e.prId == null) continue;
    counts.set(e.prId, (counts.get(e.prId) ?? 0) + 1);
    const t = Date.parse(e.occurredAt);
    if (Number.isFinite(t) && t > (latest.get(e.prId) ?? -Infinity)) latest.set(e.prId, t);
    if (threadStates != null && e.type === 'review_comment' && e.derivedState != null && threadStates.has(e.derivedState)) {
      matchingThreadPrs.add(e.prId);
    }
  }
  const keep = (p: TimelinePr): boolean =>
    p.id === selectedPrId ||
    ((members == null || (p.authorId != null && members.has(p.authorId))) && (threadStates == null || matchingThreadPrs.has(p.id)));

  const groups = new Map<number, TimelineListGroup>();
  for (const pr of prs) {
    if (!keep(pr)) continue;
    let g = groups.get(pr.repoId);
    if (g == null) {
      g = { repoId: pr.repoId, name: repos.get(pr.repoId)?.fullName ?? `Repository ${pr.repoId}`, rows: [] };
      groups.set(pr.repoId, g);
    }
    const updated = Date.parse(pr.updatedAt);
    g.rows.push({ pr, events: counts.get(pr.id) ?? 0, lastAt: latest.get(pr.id) ?? (Number.isFinite(updated) ? updated : 0) });
  }
  const out = [...groups.values()];
  for (const g of out) g.rows.sort((a, b) => b.lastAt - a.lastAt || b.pr.number - a.pr.number);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
