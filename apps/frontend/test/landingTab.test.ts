// WHICH BOARD THE APP OPENS ONTO — `landingTabFromUrl`, the one tab decision, made on every load.
//
// The rule the product wants: **always Activity, unless the URL explicitly names a board
// destination.** Activity is the front door; the timeline is somewhere you navigate TO.
//
// THE BUG THIS PINS. The decision used to ride a single boolean —
// `hasUrlParams = window.location.search.length > 1` — that also answered a completely unrelated
// question ("do the filters come from the URL or from localStorage?"). Only the BARE branch set
// Activity. But the app makes its own URL non-bare: `writeToUrl` emits `?workspace=<id>` always,
// once resolved, and `useWorkspaceSync` resolves it within ~1s of every load. So `hasUrlParams`
// is true on effectively every refresh, the Activity branch was reachable only on the very first
// paint of a truly bare `/app`, and every other load fell through to the store's unpersisted
// `activeTab: 'timeline'` default. The app "usually landed on Timeline" — including on F5 from a
// PR tab or a drill-down, neither of which emits `view=` at all.
//
// So the two assertions that matter here are the NEGATIVE ones: a URL carrying only params the
// app stamped on ITSELF (`workspace`, `repos`, …) is not a deep link and must still land on
// Activity. A test that only checked `?view=timeline → timeline` would have passed against the
// broken code.
//
// ⚠ THE TWO HALVES MOVE TOGETHER. Silence now MEANS Activity, so `writeToUrl` must emit the
// AFFIRMATIVE `view=timeline` — otherwise a user who deliberately switches to the board is
// bounced back to Activity on the next refresh. That round trip is the last describe block.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters, type FilterState } from '../src/store/filters.js';
import { prDetailKey, usePinnedTabs } from '../src/store/pinnedTabs.js';

// A minimal `window` for the serializer — same harness as feedCiFailuresToggle.test.ts.
const location = { pathname: '/app/', search: '' };
(globalThis as unknown as { window: unknown }).window = {
  location,
  history: {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      const [path, qs] = String(url).split('?');
      location.pathname = path ?? '/app/';
      location.search = qs ? `?${qs}` : '';
    },
  },
};

const { landingTabFromUrl, writeToUrl } = await import('../src/hooks/useUrlState.js');

function state(over: Partial<FilterState>): FilterState {
  return { ...useFilters.getState(), ...over };
}

describe('landingTabFromUrl — the decision table', () => {
  // A cold start / "open the app": nothing to honour, so the front door.
  it('bare URL → activity', () => {
    expect(landingTabFromUrl('')).toBe('activity');
    expect(landingTabFromUrl('?')).toBe('activity');
  });

  // ⚠ THE REGRESSION. `?workspace=` is stamped by the app itself on every load, so it can never
  // mean "the user asked for the board". This is the case that made the feature look broken.
  it('?workspace=5 → activity (the app stamped that param, the user did not)', () => {
    expect(landingTabFromUrl('?workspace=5')).toBe('activity');
  });

  // Same reasoning one step further: the whole self-stamped filter-bar tail is not a destination.
  it('?workspace=5&repos=1,2 → activity', () => {
    expect(landingTabFromUrl('?workspace=5&repos=1,2')).toBe('activity');
    expect(landingTabFromUrl('?workspace=5&repos=1,2&cats=review&status=open&ci=only')).toBe(
      'activity',
    );
  });

  // A selected PR is a BOARD destination: the DetailPane renders only in the board slot
  // (`paneVisible = selectedPrId != null && !overlayActive`), so landing this on Activity would
  // make the link inert — it would name a PR that nothing on screen displays.
  it('?pr=4123 → timeline', () => {
    expect(landingTabFromUrl('?pr=4123')).toBe('timeline');
    // Still a board link when the app's own scope param rides along, which it always does.
    expect(landingTabFromUrl('?workspace=5&pr=4123')).toBe('timeline');
  });

  it('?view=timeline → timeline', () => {
    expect(landingTabFromUrl('?view=timeline')).toBe('timeline');
    expect(landingTabFromUrl('?workspace=5&view=timeline')).toBe('timeline');
  });

  it('?view=activity → activity', () => {
    expect(landingTabFromUrl('?view=activity')).toBe('activity');
    expect(landingTabFromUrl('?workspace=5&view=activity&activityRepo=bots')).toBe('activity');
  });

  // ⚠ THE ORDERING CASE, and it is not contrived — it is what the FEED produces. Clicking a feed
  // row calls `openPrDetailTab` AND `selectPr`/`selectThread`; clicking the Activity tab chip
  // afterwards changes only the tab, so `selectedPrId` survives and `writeToUrl` emits BOTH.
  // An explicit `view` is the user's actual last board and must beat the inferred one, or every
  // such user is refreshed onto the timeline — the original bug, re-entering by the back door.
  it('an explicit view beats an inherited pr/thread selection', () => {
    expect(landingTabFromUrl('?workspace=5&view=activity&pr=4123')).toBe('activity');
    expect(landingTabFromUrl('?workspace=5&view=activity&pr=4123&thread=88')).toBe('activity');
    // And symmetrically, so the rule reads as "view wins" rather than "activity wins".
    expect(landingTabFromUrl('?workspace=5&view=timeline&pr=4123')).toBe('timeline');
  });

  // `?thread=` is the other board form — a review thread selected inside the detail pane.
  it('?thread=<id> → timeline', () => {
    expect(landingTabFromUrl('?workspace=5&pr=4123&thread=88')).toBe('timeline');
    expect(landingTabFromUrl('?thread=88')).toBe('timeline');
  });

  // The URL is hand-editable and links outlive spellings: an unknown value is normalized to the
  // default rather than treated as an unknown board.
  it('ignores a `view` value that names no board', () => {
    expect(landingTabFromUrl('?view=bogus')).toBe('activity');
    expect(landingTabFromUrl('?view=')).toBe('activity');
    expect(landingTabFromUrl('?view=insights')).toBe('activity');
  });

  // The predicate must mirror `readFromUrl`'s own parse (truthy raw, finite parseInt). A `?pr=`
  // that seats no selection is not a destination — honouring it would open an empty board.
  it('ignores a pr/thread param that names no id', () => {
    expect(landingTabFromUrl('?pr=')).toBe('activity');
    expect(landingTabFromUrl('?pr=nonsense')).toBe('activity');
    expect(landingTabFromUrl('?thread=')).toBe('activity');
  });
});

// ⚠ THE WRITE HALF. Without `view=timeline` on the address bar, the rule above would silently
// undo a deliberate switch to the board on every refresh — the mirror image of the bug it fixes.
describe('writeToUrl emits the board affirmatively (the round trip)', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
  });

  it('emits view=timeline while the board is active, and that URL lands back on the board', () => {
    usePinnedTabs.setState({ activeTab: 'timeline' });
    writeToUrl(state({ workspaceId: 5 }));
    expect(location.search).toContain('view=timeline');
    expect(landingTabFromUrl(location.search)).toBe('timeline');
  });

  it('emits view=activity while Activity is active, and that URL lands back on Activity', () => {
    usePinnedTabs.setState({ activeTab: 'activity' });
    writeToUrl(state({ workspaceId: 5 }));
    expect(location.search).toContain('view=activity');
    expect(landingTabFromUrl(location.search)).toBe('activity');
  });

  // A pinned PR tab / drill-down is not a board and is not URL-addressable, so `view` is omitted
  // and the refresh lands on Activity. The tab itself is still restored into the tab bar — it
  // just isn't what the app opens onto.
  it('emits no view for a pinned tab, so a refresh from one lands on Activity', () => {
    usePinnedTabs.setState({ activeTab: prDetailKey(4123) });
    writeToUrl(state({ workspaceId: 5 }));
    expect(location.search).not.toContain('view=');
    expect(landingTabFromUrl(location.search)).toBe('activity');
  });
});
