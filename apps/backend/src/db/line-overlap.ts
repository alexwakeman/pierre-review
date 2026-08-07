// ── THE one "same line" definition ──────────────────────────────────────────────────────────
// Shared ±3-line thread clustering for every surface that claims two bots hit "the same line":
// the per-PR dedup rollup (getBotDedupClusters), the aggregate behaviour stats
// (getBotBehaviourAnalytics.lineOverlapClusters) and the per-bot ROI overlap column
// (getBotAnalytics). The app used to carry TWO disagreeing definitions — the dedup's ±3 window
// vs the behaviour surface's exact-(path,line) equality — so the two screens could not agree on
// what overlap even was; this helper is the single arbiter.
//
// Semantics: threads group per (prId, path); within a file they sort line-ascending and a group
// ANCHORS AT ITS FIRST LINE — a thread joins while `line − anchor <= LINE_OVERLAP_WINDOW`, else
// it starts a new group. Anchoring (rather than chaining off the previous member) bounds a
// cluster's span to the window: a dense single-bot run like 98,98,98,101,104 cannot drift into
// one arbitrarily long cluster. The window exists because two bots reviewing different diff
// revisions legitimately sit on adjacent-but-not-equal lines — exact match undercounts.
//
// `line` is GitHub's CURRENT-diff line and goes NULL when a thread outdates (and on file-level
// comments). `nullLineGroup` decides their fate: the per-PR dedup KEEPS them as one catch-all
// group per file (the reader still wants "both bots piled onto this file" surfaced), while the
// metrics EXCLUDE them (any two chatty bots eventually share a null-line lump — that is
// manufactured overlap, not a redundancy signal).
//
// Clustering is USER-distinct everywhere: the caller gates on `userIds.size >= 2`, so two
// DISTINCT in-house bots (same kind) can overlap. Quality-check-role exclusion is the CALLER's
// job (the dedup filters by role upstream; getBotAnalytics filters its window threads).

export const LINE_OVERLAP_WINDOW = 3;

export interface LineOverlapItem {
  prId: number;
  path: string;
  line: number | null;
  userId: number;
}

export interface LineOverlapCluster<T extends LineOverlapItem> {
  prId: number;
  path: string;
  // The anchor (the group's first, lowest line); null for a null-line catch-all group.
  line: number | null;
  items: T[]; // line-ascending (the catch-all keeps input order)
  userIds: Set<number>; // DISTINCT users — the overlap gate everywhere is `userIds.size >= 2`
}

export function clusterThreadsByLine<T extends LineOverlapItem>(
  items: T[],
  opts: { nullLineGroup: boolean },
): LineOverlapCluster<T>[] {
  // Nested maps, never a `${prId}|${path}` string key — '|' is a legal file-name character.
  const byPr = new Map<number, Map<string, T[]>>();
  for (const it of items) {
    let byPath = byPr.get(it.prId);
    if (!byPath) {
      byPath = new Map();
      byPr.set(it.prId, byPath);
    }
    const arr = byPath.get(it.path) ?? [];
    arr.push(it);
    byPath.set(it.path, arr);
  }

  const out: LineOverlapCluster<T>[] = [];
  for (const [prId, byPath] of byPr) {
    for (const [path, group] of byPath) {
      const withLine = group.filter((t) => t.line != null).sort((a, b) => a.line! - b.line!);
      const nullLine = group.filter((t) => t.line == null);
      let cur: T[] = [];
      let anchor: number | null = null;
      const flush = (): void => {
        if (cur.length === 0) return;
        out.push({
          prId,
          path,
          line: cur[0]!.line,
          items: cur,
          userIds: new Set(cur.map((t) => t.userId)),
        });
      };
      for (const t of withLine) {
        if (anchor != null && t.line! - anchor <= LINE_OVERLAP_WINDOW) {
          cur.push(t);
        } else {
          flush();
          cur = [t];
          anchor = t.line!;
        }
      }
      flush();
      if (opts.nullLineGroup && nullLine.length > 0) {
        out.push({
          prId,
          path,
          line: null,
          items: nullLine,
          userIds: new Set(nullLine.map((t) => t.userId)),
        });
      }
    }
  }
  return out;
}
