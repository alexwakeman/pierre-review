import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type EventType, type FeedPrEventChip } from '@pierre-review/shared';
import { FEED_PR_EVENT_CHIPS, feedPrEventChip } from '../src/lib/ui.js';
import {
  freshFilterDefaults,
  pickFilterBarState,
  sanitizePersistedFilters,
  useFilters,
  type FilterState,
} from '../src/store/filters.js';

// ── The Feed's "PR events" chip row is a PARTITION of its parent pill ─────────────────────────
//
// The row narrows the pill's bucket by kind, and the whole design rests on one property: the four
// chips cover the six PR-event kinds EXACTLY ONCE EACH. That is what makes "all four pressed" and
// "no chip pressed" the same stream, which is what lets the empty default mean "all four" and
// keeps a fresh feed byte-identical to the behaviour before the row shipped.
//
// The failure this suite exists to catch is silent in every other way: a SEVENTH event literal
// added to `EVENT_TYPES` later would fall through `feedPrEventChip` to `null`, quietly leaving
// the parent pill NARROWER than it was — a filter that stops showing a kind of activity, with no
// error and no symptom except an item that no longer appears.
//
// ⚠ THIS SUITE DOES NOT RUN IN CI AND IS NOT TYPECHECKED (`pnpm test` is recursive vitest and the
// frontend's `test` script is a no-op; its tsconfig includes only `src`). Run it by hand:
//     ./apps/backend/node_modules/.bin/vitest run --root apps/frontend

// Captured before any test touches the singleton store, so the default assertion below reads the
// real fresh-load value rather than whatever a previous test left behind. (`resetAllFilters` is
// no help here: it spreads freshFilterDefaults(), which deliberately does NOT carry this key.)
const DEFAULT_PR_EVENT_KINDS = useFilters.getState().feedPrEventKinds;

// The kinds the PR-events pill has always covered, spelled INDEPENDENTLY of the resolver under
// test — derived from the shared event enum by removing the kinds owned by the other two controls
// (the Comments pill and the Commits fetch toggle). Deriving it this way is the point: a new
// literal joins this set on its own and must then be claimed by a chip, deliberately.
const COMMENT_KINDS: EventType[] = ['review_comment', 'pr_comment'];
const PR_EVENT_KINDS: EventType[] = EVENT_TYPES.filter(
  (t) => !COMMENT_KINDS.includes(t) && t !== 'commit_pushed',
);

describe('the PR-event chip partition', () => {
  it("claims every kind in the pill's bucket, and each one exactly once", () => {
    const byChip = new Map<FeedPrEventChip, EventType[]>();
    for (const kind of PR_EVENT_KINDS) {
      const chip = feedPrEventChip(kind);
      expect(chip, `event kind "${kind}" belongs to no chip`).not.toBeNull();
      if (chip == null) continue;
      byChip.set(chip, [...(byChip.get(chip) ?? []), kind]);
    }
    // Exactly-once falls out of a switch, but assert the union anyway: the union IS the parent's
    // bucket, and that equality is what the row's empty default rests on.
    expect([...byChip.values()].flat().sort()).toEqual([...PR_EVENT_KINDS].sort());
    expect(byChip.get('opened')?.sort()).toEqual(
      ['pr_opened', 'pr_ready_for_review', 'pr_reopened'].sort(),
    );
    expect(byChip.get('reviewed')).toEqual(['review_submitted']);
    expect(byChip.get('merged')).toEqual(['pr_merged']);
    expect(byChip.get('closed')).toEqual(['pr_closed']);
  });

  it('renders one chip per member of the partition, and no others', () => {
    const rendered = FEED_PR_EVENT_CHIPS.map((c) => c.id);
    const claimed = [
      ...new Set(PR_EVENT_KINDS.map((k) => feedPrEventChip(k)).filter((c) => c != null)),
    ];
    expect([...rendered].sort()).toEqual([...claimed].sort());
    expect(rendered.length).toBe(new Set(rendered).size); // no chip drawn twice
  });

  it('claims nothing outside the bucket', () => {
    // The other two controls' kinds, plus the synthesized Feed-only kinds that belong to NO
    // category pill (see FeedView's catMatch) — dragging one in would silently change what the
    // Comments pill, the Commits toggle or the CI lens mean.
    const outside = [
      ...COMMENT_KINDS,
      'commit_pushed',
      'claude_review',
      'ci_failed',
      'trunk_ci_failed',
    ];
    for (const kind of outside) expect(feedPrEventChip(kind), kind).toBeNull();
  });
});

describe('the chip selection in the store', () => {
  it('defaults to EMPTY, which means all four', () => {
    expect(DEFAULT_PR_EVENT_KINDS).toEqual([]);
  });

  it('toggling the last pressed chip back off lands on empty, never on a selection of none', () => {
    const { toggleFeedPrEventKind } = useFilters.getState();
    toggleFeedPrEventKind('merged');
    expect(useFilters.getState().feedPrEventKinds).toEqual(['merged']);
    toggleFeedPrEventKind('closed');
    expect(useFilters.getState().feedPrEventKinds).toEqual(['merged', 'closed']);
    toggleFeedPrEventKind('merged');
    toggleFeedPrEventKind('closed');
    // Empty = all four, so an all-off feed — the one state whose only honest rendering is an
    // empty list — is unreachable by clicking.
    expect(useFilters.getState().feedPrEventKinds).toEqual([]);
  });

  it('is NOT cleared when the parent pill goes off — the selection is remembered', () => {
    const { toggleFeedPrEventKind, toggleFeedCatPrEvents } = useFilters.getState();
    toggleFeedPrEventKind('reviewed');
    toggleFeedCatPrEvents(); // pill on
    toggleFeedCatPrEvents(); // pill off again — the row unmounts, the choice survives
    expect(useFilters.getState().feedPrEventKinds).toEqual(['reviewed']);
    toggleFeedPrEventKind('reviewed'); // leave the store as we found it
  });

  it('stays out of every persistence mechanism, so no storage version moves', () => {
    const s: FilterState = { ...useFilters.getState(), feedPrEventKinds: ['merged'] };
    expect('feedPrEventKinds' in pickFilterBarState(s)).toBe(false);
    expect('feedPrEventKinds' in freshFilterDefaults()).toBe(false);
    expect('feedPrEventKinds' in sanitizePersistedFilters(s)).toBe(false);
  });
});
