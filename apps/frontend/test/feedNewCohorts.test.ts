// The Activity Feed's auto-insert + "New" marker, which replaced the cross-panel
// "↑ New activity — Refresh" button. Two rules carry the whole feature, and both are the kind
// that look obviously right and are silently wrong in one direction:
//
//  1. planFeedHeadMerge — WHICH head rows may be prepended. Paging is by OFFSET, so the loaded
//     pages must stay a contiguous PREFIX of the server's stream. Splice a row from the middle
//     (or splice at all when the head and the loaded list share nothing) and every subsequent
//     `offset` fetch is shifted: "Load more" silently skips or repeats a page. Nothing throws.
//
//  2. The cohort rule — WHEN a marker clears. "Removed when further new content arrives AND the
//     user has already seen the earlier content" has two halves, and dropping the second half
//     (clear every old cohort on each batch) is the tempting simplification: it passes every
//     at-the-top test and hides exactly the content the marker exists to point at for the
//     reader who was scrolled down.
//
//  3. countHeadArrivals — HOW FAR the reader's window must move so a prepend doesn't drag the
//     page under them. Both of its guards fail silently and in opposite directions: counting the
//     RAW arrival instead of the rows that survive the pills slides the window past the reader's
//     anchor, and treating "the two lists share nothing" as "everything is new" scrolls by a
//     whole list's height.
//
// Neither directory runs in CI (see CLAUDE.md § Known gaps). By hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { countHeadArrivals, planFeedHeadMerge } from '../src/hooks/useConsolidatedFeed.js';
import {
  pickFilterBarState,
  sanitizePersistedFilters,
  useFilters,
  type FilterState,
} from '../src/store/filters.js';

const SCOPE = 'ws:3|workspace=3';

function markerIds(): string[] {
  const { cohorts } = useFilters.getState().feedNewCohorts;
  return cohorts.flatMap((c) => c.ids);
}

describe('planFeedHeadMerge', () => {
  it('inserts only the head PREFIX above the first already-loaded id', () => {
    const plan = planFeedHeadMerge(['e', 'd', 'c', 'b', 'a'], new Set(['c', 'b', 'a']));
    expect(plan.verdict).toBe('insert');
    expect(plan.insert).toEqual(['e', 'd']);
  });

  it('ignores an unloaded id BELOW the overlap — a mid-stream backfill would shift the offsets', () => {
    // 'x' sits between two loaded rows: splicing it in would push every tail page down one.
    const plan = planFeedHeadMerge(['d', 'c', 'x', 'b', 'a'], new Set(['c', 'b', 'a']));
    expect(plan.insert).toEqual(['d']);
  });

  it('is a no-op when the head is already loaded', () => {
    expect(planFeedHeadMerge(['c', 'b', 'a'], new Set(['c', 'b', 'a'])).verdict).toBe('none');
  });

  it('reports a GAP — never an insert — when head and loaded share nothing', () => {
    // More than a page landed at once. There is a hole between the two lists, so prepending
    // would leave the loaded pages non-contiguous and misalign every later offset.
    const plan = planFeedHeadMerge(['z', 'y'], new Set(['c', 'b', 'a']));
    expect(plan.verdict).toBe('gap');
    expect(plan.insert).toEqual([]);
  });

  it('does nothing when nothing is loaded yet — page 0 is about to arrive with these rows', () => {
    expect(planFeedHeadMerge(['b', 'a'], new Set()).verdict).toBe('none');
  });
});

describe('countHeadArrivals', () => {
  type Row = { id: string; bot?: boolean };
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
  const all = (r: Row[]): Row[] => r;

  it('counts the rows prepended above the previous head', () => {
    expect(countHeadArrivals(rows('c', 'b', 'a'), rows('e', 'd', 'c', 'b', 'a'), all)).toBe(2);
  });

  it('is 0 when nothing landed above the head', () => {
    expect(countHeadArrivals(rows('c', 'b', 'a'), rows('c', 'b', 'a'), all)).toBe(0);
    // "Load more" appended older rows below — the reader asked for those; nothing moved above.
    expect(countHeadArrivals(rows('c', 'b'), rows('c', 'b', 'a'), all)).toBe(0);
  });

  it('is 0 — never the whole list — when the two lists share NOTHING', () => {
    // A gap refetch / scope re-key / server-side window roll is a REPLACEMENT, not a prepend.
    // Reading -1 as "everything is new" would scroll the pane by the whole list's height.
    expect(countHeadArrivals(rows('c', 'b', 'a'), rows('z', 'y'), all)).toBe(0);
    expect(countHeadArrivals([], rows('z', 'y'), all)).toBe(0);
    expect(countHeadArrivals(rows('c'), [], all)).toBe(0);
  });

  it('counts only the arrivals that survive the client-side pills', () => {
    // The window indexes the NARROWED list, so a bot row that an active lens drops never reaches
    // it. Shifting by the raw 3 would slide the window past the reader's anchor.
    const prev: Row[] = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    const next: Row[] = [
      { id: 'f', bot: true },
      { id: 'e' },
      { id: 'd', bot: true },
      ...prev,
    ];
    expect(countHeadArrivals(prev, next, (r) => r.filter((i) => !i.bot))).toBe(1);
    expect(countHeadArrivals(prev, next, all)).toBe(3);
  });

  it('narrows the ARRIVING PREFIX only — never the rows already on screen', () => {
    const prev = rows('c', 'b', 'a');
    const seen: string[][] = [];
    countHeadArrivals(prev, rows('e', 'd', 'c', 'b', 'a'), (r) => {
      seen.push(r.map((i) => i.id));
      return r;
    });
    expect(seen).toEqual([['e', 'd']]);
  });
});

describe('feedNewCohorts', () => {
  beforeEach(() => {
    useFilters.setState({ feedNewCohorts: { scopeKey: null, cohorts: [] } });
  });

  it('starts empty — a freshly-opened feed marks nothing', () => {
    expect(useFilters.getState().feedNewCohorts.cohorts).toEqual([]);
  });

  it('marks an arriving batch, and clears it on the NEXT batch once seen', () => {
    const { pushFeedNewCohort } = useFilters.getState();
    pushFeedNewCohort(SCOPE, ['a', 'b'], /* atTop */ true);
    expect(markerIds()).toEqual(['a', 'b']);
    pushFeedNewCohort(SCOPE, ['c'], true);
    // The first cohort landed in front of the reader, so it was seen — and more has arrived.
    expect(markerIds()).toEqual(['c']);
  });

  it('KEEPS an unseen cohort when the next batch arrives', () => {
    const { pushFeedNewCohort } = useFilters.getState();
    pushFeedNewCohort(SCOPE, ['a'], /* atTop */ false); // reader was scrolled down
    pushFeedNewCohort(SCOPE, ['b'], false);
    // 'a' was never seen: dropping it would hide the news it exists to announce.
    expect(markerIds()).toEqual(['a', 'b']);
  });

  it('clears an earlier cohort once the reader reaches the top and more lands', () => {
    const { pushFeedNewCohort, markFeedNewCohortsSeen } = useFilters.getState();
    pushFeedNewCohort(SCOPE, ['a'], false);
    markFeedNewCohortsSeen(SCOPE); // scrolled back to the top
    expect(markerIds()).toEqual(['a']); // still marked — nothing new has arrived yet
    pushFeedNewCohort(SCOPE, ['b'], false);
    expect(markerIds()).toEqual(['b']);
  });

  it('ignores a seen-credit from another scope', () => {
    const { pushFeedNewCohort, markFeedNewCohortsSeen } = useFilters.getState();
    pushFeedNewCohort(SCOPE, ['a'], false);
    markFeedNewCohortsSeen('ws:9|workspace=9');
    pushFeedNewCohort(SCOPE, ['b'], false);
    expect(markerIds()).toEqual(['a', 'b']);
  });

  it('discards every remembered id when the scope changes', () => {
    const { pushFeedNewCohort } = useFilters.getState();
    pushFeedNewCohort(SCOPE, ['a'], false);
    pushFeedNewCohort('ws:9|workspace=9', ['z'], false);
    expect(markerIds()).toEqual(['z']);
    expect(useFilters.getState().feedNewCohorts.scopeKey).toBe('ws:9|workspace=9');
  });

  it('bounds unseen cohorts — a reader who never returns to the top cannot grow it forever', () => {
    const { pushFeedNewCohort } = useFilters.getState();
    for (let i = 0; i < 30; i++) pushFeedNewCohort(SCOPE, [`i${i}`], false);
    expect(useFilters.getState().feedNewCohorts.cohorts.length).toBeLessThanOrEqual(8);
    // The newest batch is always kept.
    expect(markerIds()).toContain('i29');
  });

  it('is TRANSIENT: never persisted, never restorable', () => {
    const { pushFeedNewCohort } = useFilters.getState();
    pushFeedNewCohort(SCOPE, ['a'], false);
    expect(pickFilterBarState(useFilters.getState())).not.toHaveProperty('feedNewCohorts');
    const restored = sanitizePersistedFilters({
      feedNewCohorts: { scopeKey: SCOPE, cohorts: [{ ids: ['a'], seen: false }] },
    } as unknown as Partial<FilterState>);
    expect(restored).not.toHaveProperty('feedNewCohorts');
  });
});
