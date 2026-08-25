import type { DigestPrRef, PersonMetricKey, PersonPeriodEvidence } from '@pierre-review/shared';
import { PERSON_METRIC_KEYS } from '@pierre-review/shared';
import type { PeopleReportSelection } from '../store/filters.js';

// The People report's pure folds — extracted from PeopleReportDetail so the load-bearing rules
// (alphabetical sections, one narrative generation at a time, the disclosed where-it-works
// sample, ref → card anchors) are unit-tested rather than asserted in comments
// (test/peopleReport.test.ts).

/**
 * The section render order: ALPHABETICAL by the selection's label, humans and bots INTERLEAVED —
 * never metric-sorted, never kind-grouped-then-sorted by anything numeric (PREP, NOT SCORING).
 * The seed preserves click order; the render calls this and ignores it. Returns a new array
 * (the seed is store state and must not be mutated); ties (two identical labels) fall back to
 * userId so the order is total and stable across renders.
 */
export function orderSelections(selections: PeopleReportSelection[]): PeopleReportSelection[] {
  return [...selections].sort(
    (a, b) => a.label.localeCompare(b.label) || a.userId - b.userId,
  );
}

// ── Human-evidence PR groups ───────────────────────────────────────────────────────────────────

export interface EvidencePrGroup {
  key: PersonMetricKey;
  rows: DigestPrRef[];
  more: number;
}

/**
 * The evidence PR groups in the VECTOR's own key order (PERSON_METRIC_KEYS — never a
 * metric-sorted or size-sorted rearrangement; the section order mirrors the table above it).
 * Zero-row groups are dropped (the wire's `Partial` shape omits empty populations, but a
 * present-and-empty group must not render a heading over nothing either).
 */
export function evidencePrGroups(prs: PersonPeriodEvidence['prs']): EvidencePrGroup[] {
  return PERSON_METRIC_KEYS.flatMap((key) => {
    const g = prs[key];
    return g && g.rows.length > 0 ? [{ key, rows: g.rows, more: g.more }] : [];
  });
}

// ── "Begin report" gating ──────────────────────────────────────────────────────────────────────
//
// Enabled iff ≥1 chip AND the Reports selection resolves to a listed period (the panel's
// seating effect guarantees the key lands once the list loads; until then the button explains
// which precondition is missing rather than silently doing nothing). Returns null when Begin
// may fire; otherwise the disabled title.

export function beginDisabledReason(input: {
  chipCount: number;
  reportKey: string | null;
  periodKeys: string[];
  listLoading: boolean;
}): string | null {
  const keyResolved =
    input.reportKey != null && input.periodKeys.includes(input.reportKey);
  if (input.chipCount >= 1 && keyResolved) return null;
  if (input.chipCount === 0) return 'Pick at least one person or bot first';
  if (input.listLoading) return 'Waiting for the period list to load';
  if (input.periodKeys.length === 0) {
    return 'No completed periods yet — the report covers one completed sprint period';
  }
  return 'Waiting for the Reports period selection to resolve';
}

// ── "Where it works" — the disclosed client-side sample over a bot's fetched comment rows ──────
//
// A small code-computed rollup (top repos + top two-segment path prefixes) over EXACTLY the rows
// the cards below it render — a disclosed sample, never presented as a population figure (the
// tile-number-vs-hydration lesson). The caption must name the sample size ("across the N most
// recent comments below") and N is the input's length, nothing else.

export interface WhereItWorks {
  /** [repoFullName, count], most-comments-first (ties alphabetical), capped by the caller. */
  repos: Array<[string, number]>;
  /** [pathBucket, count] over rows that carry a path (inline comments), same ordering. */
  areas: Array<[string, number]>;
  /** The sample size the caption must disclose — the number of rows folded. */
  sampleSize: number;
}

/** The core evidence fold's bucket rule, mirrored: >2 segments → `s0/s1/**`, ≤2 → the path
 *  itself. Keeping the spelling identical means a narrative ref's `pe<v>:area:` bucket and this
 *  client-side rollup name the same area the same way — the `<v>` is PERSON_REPORT_VERSION, so
 *  do not hard-code it here; a bump must not make this comment name a version nothing emits. */
export function pathBucket(path: string): string {
  const segments = path.split('/');
  return segments.length > 2 ? `${segments[0]}/${segments[1]}/**` : path;
}

export function foldWhereItWorks(
  rows: Array<{ repoFullName: string; path: string | null }>,
  cap = 5,
): WhereItWorks {
  const repoCounts = new Map<string, number>();
  const areaCounts = new Map<string, number>();
  for (const r of rows) {
    repoCounts.set(r.repoFullName, (repoCounts.get(r.repoFullName) ?? 0) + 1);
    if (r.path != null && r.path !== '') {
      const bucket = pathBucket(r.path);
      areaCounts.set(bucket, (areaCounts.get(bucket) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>): Array<[string, number]> =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, cap);
  return { repos: top(repoCounts), areas: top(areaCounts), sampleSize: rows.length };
}

// ── The sequential narrative queue ─────────────────────────────────────────────────────────────
//
// The report generates person_report narratives ONE selection at a time: the server's
// per-account in-flight claim answers a concurrent POST with `throttled` (cached row served,
// nothing billed), so strict client sequencing is what turns an N-person first build into N
// clean generations instead of N−1 throttles re-queued at random. A pure reducer, so "never two
// grants at once" is a tested invariant rather than an effect-ordering accident.
//
// Shape: at most ONE `current` (the granted section); `queue` is FIFO — sections request in
// mount order, which is alphabetical because the sections render alphabetically, and a
// throttled re-request goes to the back.

export interface NarrationQueueState {
  queue: number[]; // userIds waiting, FIFO
  current: number | null; // the ONE granted userId (null = idle)
}

export type NarrationQueueAction =
  | { type: 'request'; userId: number } // a section wants to generate (idempotent)
  | { type: 'release'; userId: number }; // its turn ended (settled) — or it no longer needs one

export const NARRATION_QUEUE_IDLE: NarrationQueueState = { queue: [], current: null };

export function reduceNarrationQueue(
  s: NarrationQueueState,
  a: NarrationQueueAction,
): NarrationQueueState {
  switch (a.type) {
    case 'request': {
      // Already granted or already waiting — idempotent (effects re-fire on unrelated renders).
      if (s.current === a.userId || s.queue.includes(a.userId)) return s;
      if (s.current == null) return { queue: s.queue, current: a.userId };
      return { queue: [...s.queue, a.userId], current: s.current };
    }
    case 'release': {
      if (s.current === a.userId) {
        // The grant ends; the next waiter (if any) is promoted in the same transition, so
        // there is never a state with a stale grant alongside a promotable waiter.
        const [next, ...rest] = s.queue;
        return { queue: rest, current: next ?? null };
      }
      // A waiter withdrawing (its cache landed via another path) just leaves the line.
      if (s.queue.includes(a.userId)) {
        return { queue: s.queue.filter((u) => u !== a.userId), current: s.current };
      }
      return s;
    }
  }
}

// ── Narrative ref → evidence-card anchor ───────────────────────────────────────────────────────
//
// The person_report items core mints: `pm<v>:<metricKey>:<value>` (vector lines) and the
// `pe<v>:` evidence families (`pr:<prId>` / `rc:<id>` / `pc:<id>` / `th:<threadId>` /
// `area:<bucket>:<files>`). A section's `refs` cite these ids; the panel renders them as chips
// that scroll to the cited card. This maps a ref to the STABLE anchor key the cards register
// under — version-tolerant (`pe2:` still anchors) because a version bump changes the ids, not
// where the evidence lives on the page. Unknown/malformed refs → null (chip renders inert).

export function refAnchorKey(ref: string): string | null {
  let m = /^pm\d+:([a-z_]+):/.exec(ref);
  if (m) return `metric:${m[1]}`;
  m = /^pe\d+:(pr|rc|pc|th):(\d+)$/.exec(ref);
  if (m) return `${m[1]}:${m[2]}`;
  // `area:<bucket>:<files>` — the bucket may itself contain no colon today, but parse from the
  // END (strip the trailing count) so a future path with one degrades to the right bucket.
  m = /^pe\d+:area:(.+):\d+$/.exec(ref);
  if (m) return `area:${m[1]}`;
  return null;
}
