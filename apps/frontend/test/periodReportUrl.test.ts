// The period report's FORWARDABLE LINK — `?activityRepo=insights&report=<periodKey>`.
//
// This is not a cosmetic deep link. The whole product argument for a period report is that it is
// an artifact you can send to someone; a report you can read but cannot link to is a dashboard
// with extra steps. So the link is pinned here, and it is pinned as a ROUND TRIP through the real
// serializer rather than as two independent assertions, because the failure mode this feature
// actually shipped with was a HALF link:
//
//   • The panel captured `?report=` at module load and nothing ever emitted it, so a hand-written
//     link worked and the app produced none.
//   • `activityRepo=insights` was neither emitted NOR parsed — the Insights rail row was a
//     landing default that deliberately stayed out of the URL — so even a correct `?report=`
//     landed the recipient on the Feed, where no report renders at all.
//
// Either half alone reads as "deep linking works" in a manual test by whoever wrote it (their tab
// is already on Insights). The round trip is the only assertion that catches it.
//
// ⚠ `writeToUrl` rebuilds the query string from a FIXED WHITELIST and `replaceState`s it, so any
// param it does not know about is erased on the first store write after hydrate. That is why an
// emit-only or parse-only key is silently useless here, and why both halves must always move
// together.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters, type FilterState } from '../src/store/filters.js';
import { usePinnedTabs } from '../src/store/pinnedTabs.js';

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

const { readFromUrl, writeToUrl } = await import('../src/hooks/useUrlState.js');

function state(over: Partial<FilterState>): FilterState {
  return { ...useFilters.getState(), ...over };
}

/** The serializer only emits `activityRepo` when the Activity tab is the active one. */
function onActivityTab(): void {
  usePinnedTabs.setState({ activeTab: 'activity' });
}

describe('the period report link', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
    onActivityTab();
  });

  it('defaults to no selection — a bare load names no period', () => {
    expect(useFilters.getState().insightsReportKey).toBeNull();
  });

  // THE ASSERTION THAT MATTERS. Both halves, through the real serializer, in one trip.
  it('round-trips the console AND the period through writeToUrl → readFromUrl', () => {
    writeToUrl(state({ activityRepoId: 'insights', insightsReportKey: 'sprint-2026-08-18' }));

    expect(location.search).toContain('activityRepo=insights');
    expect(location.search).toContain('report=sprint-2026-08-18');

    const back = readFromUrl();
    expect(back.activityRepoId).toBe('insights');
    expect(back.insightsReportKey).toBe('sprint-2026-08-18');
    // THE THIRD HALF. Insights seeds its sub-tab from the store and falls back to 'overview', so a
    // link carrying the console and the period still opened on the ad-hoc chat with no report in
    // sight. `?report=` can only mean the Reports pane.
    expect(back.insightsSubTab).toBe('reports');
  });

  // The recipient must land on the console that renders the report. Before this fix `?report=`
  // parsed fine and the reader still saw the Feed, which looks identical to the report being
  // broken.
  it('a link naming a period selects the Insights console, not the Feed', () => {
    location.search = '?activityRepo=insights&report=sprint-2026-08-04';
    const back = readFromUrl();
    expect(back.activityRepoId).toBe('insights');
    expect(back.insightsReportKey).toBe('sprint-2026-08-04');
    expect(back.insightsSubTab).toBe('reports');
  });

  // A link with no `?report=` must not force the pane — the reader's own remembered sub-tab wins.
  it('does not touch the sub-tab when the link names no period', () => {
    location.search = '?activityRepo=insights';
    expect('insightsSubTab' in readFromUrl()).toBe(false);
  });

  // `report` rides WITH the console and never alone: a bare `?report=` on the Feed would be inert
  // noise in every link the app produces, and would survive as a stale selection if the reader
  // later opened Insights.
  it('emits no `report` when the reader is not on the Insights console', () => {
    writeToUrl(state({ activityRepoId: 'bots', insightsReportKey: 'sprint-2026-08-18' }));
    expect(location.search).toContain('activityRepo=bots');
    expect(location.search).not.toContain('report=');
  });

  // 'feed' remains the one console that stays out of the URL — it is the bare state a link means
  // when it says nothing. Pinned so a later "emit every console" tidy-up has to think about it.
  it("still omits the Feed, which is what a link with no console means", () => {
    writeToUrl(state({ activityRepoId: 'feed', insightsReportKey: null }));
    expect(location.search).not.toContain('activityRepo=');
  });

  // The selection is not a FILTER. "Clear filters" must not throw away the period the reader is
  // looking at — same reasoning that keeps `workspaceId` out of FilterDefaults.
  it('survives "Clear filters"', () => {
    useFilters.getState().setInsightsReportKey('sprint-2026-08-18');
    useFilters.getState().resetAllFilters();
    expect(useFilters.getState().insightsReportKey).toBe('sprint-2026-08-18');
  });
});
