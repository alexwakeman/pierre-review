import type { ConflictRegionKind } from '@pierre-review/shared';

/**
 * The diff engine and the three-way chunker. Pure: no git, no I/O, no config.
 *
 * WHY WE COMPUTE REGIONS OURSELVES INSTEAD OF PARSING `merge-file --diff3`. diff3 output
 * emits only the CONTESTED regions; everything git merged silently is folded into the stream
 * indistinguishable from unchanged base text. The resolver needs `ours_only` / `theirs_only`
 * as first-class objects — the reader can apply and un-apply a one-sided change — and the
 * wand has to be able to say exactly what it did. Both need ranges on all three sides, which
 * diff3 output does not carry. So: two line diffs against the base, the classic diff3
 * chunker, then the SAME chunker again over word tokens to test disjointness.
 *
 * ⚠ MYERS, NOT PATIENCE OR HISTOGRAM. Git's own xdiff default is Myers, and the oracle
 * (`git merge-file`, run per file in model.ts) is git. A unique-line heuristic moves chunk
 * boundaries, and the oracle would then flag files we merged perfectly well.
 */

/** One changed range: `a[aStart, aEnd)` was replaced by `b[bStart, bEnd)`. Either may be
 *  empty — an empty `a` range is an insertion, an empty `b` range a deletion. */
export interface DiffChange {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Myers O(ND) with the linear-space divide-and-conquer refinement, common prefix and suffix
 * trimmed at every level.
 *
 * `maxD` is a BUDGET over the whole recursion, not per call: a pathological pair (a file
 * rewritten wholesale) would otherwise spend minutes proving what a single whole-file region
 * says just as well. Returns `null` when the budget runs out — the caller degrades that file
 * to one conflict spanning everything, which is honest and still resolvable.
 */
export function diffTokens(
  a: readonly number[],
  b: readonly number[],
  maxD: number,
): DiffChange[] | null {
  const out: DiffChange[] = [];
  const budget = { left: Math.max(1, maxD) };
  if (!bisectInto(a, b, 0, a.length, 0, b.length, out, budget)) return null;
  return coalesce(out);
}

/** Merge changes that touch, so the caller never sees two adjacent ranges with nothing
 *  between them. The recursion can produce those at a split point. */
function coalesce(changes: DiffChange[]): DiffChange[] {
  const out: DiffChange[] = [];
  for (const c of changes) {
    const prev = out[out.length - 1];
    if (prev && prev.aEnd === c.aStart && prev.bEnd === c.bStart) {
      prev.aEnd = c.aEnd;
      prev.bEnd = c.bEnd;
      continue;
    }
    out.push({ ...c });
  }
  return out.filter((c) => c.aEnd > c.aStart || c.bEnd > c.bStart);
}

function bisectInto(
  a: readonly number[],
  b: readonly number[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  out: DiffChange[],
  budget: { left: number },
): boolean {
  // Trim the common prefix and suffix first: it is what keeps `d` small on a real edit, and
  // it is also what makes the base cases below reachable at all.
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    a0++;
    b0++;
  }
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
    a1--;
    b1--;
  }
  if (a0 === a1 && b0 === b1) return true;
  if (a0 === a1 || b0 === b1) {
    // Pure insertion or pure deletion — nothing left to align.
    out.push({ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 });
    return true;
  }

  const split = middleSnake(a, b, a0, a1, b0, b1, budget);
  if (split.kind === 'budget') return false;
  if (split.kind === 'replace') {
    // The frontiers never met inside `max`, which for a correct Myers should not happen.
    // Falling back to a whole-range replacement is coarser than optimal but never WRONG,
    // and it is a great deal better than reporting a wrong split.
    out.push({ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 });
    return true;
  }
  if (!bisectInto(a, b, a0, split.x, b0, split.y, out, budget)) return false;
  if (!bisectInto(a, b, split.x, a1, split.y, b1, out, budget)) return false;
  return true;
}

type SnakeResult =
  | { kind: 'split'; x: number; y: number }
  | { kind: 'replace' }
  | { kind: 'budget' };

/**
 * Find the middle snake of the optimal edit script (Myers §4b) — the forward and reverse
 * frontiers advance one `d` at a time until they overlap, and the overlap point splits the
 * problem in half with O(N+M) memory.
 */
function middleSnake(
  a: readonly number[],
  b: readonly number[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  budget: { left: number },
): SnakeResult {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = Math.ceil((n + m) / 2);
  const offset = max;
  const len = 2 * max + 2;
  const vf = new Int32Array(len).fill(-1);
  const vr = new Int32Array(len).fill(-1);
  vf[offset + 1] = 0;
  vr[offset + 1] = 0;
  const delta = n - m;
  // When delta is odd the frontiers can only meet on a FORWARD step, and vice versa.
  const front = (delta & 1) !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  // ⚠ `d <= max`, not `d < max`. The frontiers meet at `d = ceil(D/2)` and `D` can be the
  // full `n + m` — a one-token replacement is D = 2, max = 1, and a `d < max` loop never
  // runs the step that finds it. That off-by-one turns every small edit into a whole-range
  // replacement, which still merges correctly and reads as one enormous conflict on screen.
  for (let d = 0; d <= max; d++) {
    if (budget.left-- <= 0) return { kind: 'budget' };

    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1off = offset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && (vf[k1off - 1] ?? -1) < (vf[k1off + 1] ?? -1))) {
        x1 = vf[k1off + 1] ?? 0;
      } else {
        x1 = (vf[k1off - 1] ?? 0) + 1;
      }
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[a0 + x1] === b[b0 + y1]) {
        x1++;
        y1++;
      }
      vf[k1off] = x1;
      if (x1 > n) {
        k1end += 2;
      } else if (y1 > m) {
        k1start += 2;
      } else if (front) {
        const k2off = offset + delta - k1;
        if (k2off >= 0 && k2off < len && (vr[k2off] ?? -1) !== -1) {
          const x2 = n - (vr[k2off] ?? 0);
          if (x1 >= x2) return { kind: 'split', x: a0 + x1, y: b0 + y1 };
        }
      }
    }

    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2off = offset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && (vr[k2off - 1] ?? -1) < (vr[k2off + 1] ?? -1))) {
        x2 = vr[k2off + 1] ?? 0;
      } else {
        x2 = (vr[k2off - 1] ?? 0) + 1;
      }
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[a0 + n - x2 - 1] === b[b0 + m - y2 - 1]) {
        x2++;
        y2++;
      }
      vr[k2off] = x2;
      if (x2 > n) {
        k2end += 2;
      } else if (y2 > m) {
        k2start += 2;
      } else if (!front) {
        const k1off = offset + delta - k2;
        if (k1off >= 0 && k1off < len && (vf[k1off] ?? -1) !== -1) {
          const x1 = vf[k1off] ?? 0;
          const y1 = x1 - (k1off - offset);
          if (x1 >= n - x2) return { kind: 'split', x: a0 + x1, y: b0 + y1 };
        }
      }
    }
  }
  return { kind: 'replace' };
}

/* ═════════════════════════════ the three-way chunker ═════════════════════════════ */

/** One region of the three-way model. Ranges are half-open indices into each side's token
 *  array; `unchanged` regions carry real ranges here (the word pass needs them) and are
 *  emptied only at the wire. */
export interface ThreeWayRegion {
  kind: ConflictRegionKind;
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
}

/** A side's change list expressed against BASE positions. */
interface SideHunk {
  baseStart: number;
  baseEnd: number;
  sideStart: number;
  sideEnd: number;
}

function toHunks(changes: readonly DiffChange[]): SideHunk[] {
  return changes.map((c) => ({
    baseStart: c.aStart,
    baseEnd: c.aEnd,
    sideStart: c.bStart,
    sideEnd: c.bEnd,
  }));
}

/**
 * The classic diff3 chunker. Takes both sides' diffs AGAINST THE BASE and produces one
 * ordered region list covering the base end to end.
 *
 * ⚠ ADJACENT CHANGES ABSORB INTO ONE REGION (`hunk.baseStart <= hi`, zero unchanged tokens
 * between). Two edits that touch are one contested region: offering them separately lets the
 * reader take ours from the first and theirs from the second and produce text neither author
 * wrote.
 *
 * ⚠ `both_same` is a real kind and is NOT collapsed into `ours_only`. Collapsing it makes the
 * wand's "what I did" count wrong — it settled nothing there, both authors already agreed.
 */
export function threeWayChunks(
  base: readonly number[],
  ours: readonly number[],
  theirs: readonly number[],
  oursChanges: readonly DiffChange[],
  theirsChanges: readonly DiffChange[],
): ThreeWayRegion[] {
  const oursHunks = toHunks(oursChanges);
  const theirsHunks = toHunks(theirsChanges);
  const regions: ThreeWayRegion[] = [];

  let i = 0;
  let j = 0;
  let basePos = 0;

  while (i < oursHunks.length || j < theirsHunks.length) {
    const nextOurs = oursHunks[i];
    const nextTheirs = theirsHunks[j];
    let lo: number;
    if (nextOurs && nextTheirs) lo = Math.min(nextOurs.baseStart, nextTheirs.baseStart);
    else if (nextOurs) lo = nextOurs.baseStart;
    else if (nextTheirs) lo = nextTheirs.baseStart;
    else break;

    let hi = lo;
    const groupOurs: SideHunk[] = [];
    const groupTheirs: SideHunk[] = [];
    // Absorb every hunk from either side that starts at or before the group's current end.
    for (;;) {
      const o = oursHunks[i];
      const t = theirsHunks[j];
      if (o && o.baseStart <= hi) {
        groupOurs.push(o);
        hi = Math.max(hi, o.baseEnd);
        i++;
        continue;
      }
      if (t && t.baseStart <= hi) {
        groupTheirs.push(t);
        hi = Math.max(hi, t.baseEnd);
        j++;
        continue;
      }
      break;
    }

    if (lo > basePos) {
      regions.push(unchangedRegion(basePos, lo, oursHunks, theirsHunks));
    }

    const oursRange = mapRange(lo, hi, groupOurs, oursHunks);
    const theirsRange = mapRange(lo, hi, groupTheirs, theirsHunks);
    const kind = classify(
      base.slice(lo, hi),
      ours.slice(oursRange.start, oursRange.end),
      theirs.slice(theirsRange.start, theirsRange.end),
    );
    regions.push({
      kind,
      baseStart: lo,
      baseEnd: hi,
      oursStart: oursRange.start,
      oursEnd: oursRange.end,
      theirsStart: theirsRange.start,
      theirsEnd: theirsRange.end,
    });
    basePos = hi;
  }

  if (basePos < base.length) {
    regions.push(unchangedRegion(basePos, base.length, oursHunks, theirsHunks));
  }
  return regions;
}

function unchangedRegion(
  lo: number,
  hi: number,
  oursHunks: readonly SideHunk[],
  theirsHunks: readonly SideHunk[],
): ThreeWayRegion {
  const o = mapRange(lo, hi, [], oursHunks);
  const t = mapRange(lo, hi, [], theirsHunks);
  return {
    kind: 'unchanged',
    baseStart: lo,
    baseEnd: hi,
    oursStart: o.start,
    oursEnd: o.end,
    theirsStart: t.start,
    theirsEnd: t.end,
  };
}

/**
 * Map a base range onto one side.
 *
 * With hunks in the group, the group's own first and last hunk anchor it: the run between
 * `lo` and the first hunk's start is unchanged on this side, so it shifts by the same amount,
 * and likewise at the tail. Without any, the whole range is unchanged on this side and the
 * mapping is the cumulative offset of every hunk that ended before `lo`.
 */
function mapRange(
  lo: number,
  hi: number,
  group: readonly SideHunk[],
  allHunks: readonly SideHunk[],
): { start: number; end: number } {
  const first = group[0];
  const last = group[group.length - 1];
  if (first && last) {
    return {
      start: first.sideStart - (first.baseStart - lo),
      end: last.sideEnd + (hi - last.baseEnd),
    };
  }
  let offset = 0;
  for (const h of allHunks) {
    if (h.baseEnd <= lo) offset += h.sideEnd - h.sideStart - (h.baseEnd - h.baseStart);
    else break;
  }
  return { start: lo + offset, end: hi + offset };
}

function sameTokens(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Classify by CONTENT, not by which hunk lists contributed. After absorption a group can
 *  hold a hunk from a side whose net text is identical to the base's, and calling that a
 *  change would show the reader a choice between two identical things. */
function classify(
  base: readonly number[],
  ours: readonly number[],
  theirs: readonly number[],
): ConflictRegionKind {
  const oursSame = sameTokens(base, ours);
  const theirsSame = sameTokens(base, theirs);
  if (oursSame && theirsSame) return 'unchanged';
  if (theirsSame) return 'ours_only';
  if (oursSame) return 'theirs_only';
  if (sameTokens(ours, theirs)) return 'both_same';
  return 'conflict';
}
