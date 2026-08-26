// BROWSER BACK/FORWARD — the push-vs-replace rule and the pop that rehydrates the stores.
//
// THE BUG THIS PINS, in the reporter's words: "pressing Back from Needs Attention does not take
// me back to the previous view". It didn't, and it couldn't: the URL layer's only history call
// was `replaceState`, so an entire session lived in ONE history entry. Clicking a brief line
// MUTATED that entry, and Back was therefore a cross-document navigation out of the app — to the
// landing page, or to whatever the user was reading before. The screen the reader wanted back
// (the un-narrowed attention board) had never been an entry at all.
//
// The fix has three halves, and each fails silently on its own:
//
//   1. NAVIGATIONS PUSH, REFINEMENTS REPLACE, decided by diffing NAV_KEYS between the old URL and
//      the new one. A per-caller `push:true` argument is what the 15th caller forgets; a push per
//      store write would stack four entries for one banner click (and blow Safari's rate limit).
//   2. EVERY VIEW IS IN THE URL — including the two narrowings a reader actually navigates to
//      (`attn`, `feedPr`) and the tab keys — or Back moves the address bar without moving the app.
//   3. THE POP IS TOTAL. `readFromUrl` is partial by design (an absent param sets nothing), which
//      is right on a cold load and wrong on a pop: popping off a narrowed board onto a URL that
//      says nothing about `attn` must CLEAR the narrowing, not leave it standing.
//
// The harness below is a real history STACK — the other URL tests stub `replaceState` alone, so
// they cannot tell a push from a replace and would pass against every broken version of this.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters } from '../src/store/filters.js';
import { prDetailKey, usePinnedTabs } from '../src/store/pinnedTabs.js';

const location = { pathname: '/app/', search: '' };
// The browser's session history: entries[cursor] is the current one. `pushState` truncates the
// forward entries and appends; `replaceState` overwrites in place — the distinction the whole
// feature turns on.
let entries: string[] = ['/app/'];
let cursor = 0;

function seat(url: string): void {
  const [path, qs] = String(url).split('?');
  location.pathname = path ?? '/app/';
  location.search = qs ? `?${qs}` : '';
}

(globalThis as unknown as { window: unknown }).window = {
  location,
  history: {
    pushState: (_s: unknown, _t: string, url: string): void => {
      entries = entries.slice(0, cursor + 1);
      entries.push(String(url));
      cursor = entries.length - 1;
      seat(String(url));
    },
    replaceState: (_s: unknown, _t: string, url: string): void => {
      entries[cursor] = String(url);
      seat(String(url));
    },
  },
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

const { applyUrlToStores, consumeRestoredWorkspaceScope, writeToUrl } = await import(
  '../src/hooks/useUrlState.js'
);
// The body of `useWorkspaceSync`'s effect, as a plain function — the second half of the pop, and
// the half that used to undo the first (see the last describe block).
const { syncWorkspaceScope } = await import('../src/components/WorkspaceSelector.js');

/**
 * One user GESTURE: mutate the stores, then serialize once.
 *
 * That "once" is the contract, not a shortcut: the live subscriptions coalesce every write inside
 * a handler into ONE microtask flush (see `scheduleUrlWrite`), precisely so a four-setter action
 * like `openMyTurnInWorkspace` produces one entry rather than four.
 */
function gesture(fn: () => void): void {
  fn();
  writeToUrl(useFilters.getState());
}

// The account's live workspaces, module-level because BOTH the push-vs-replace rules and the
// repoIds rules turn on `syncWorkspaceScope` — it is the only path that resolves an unresolved or
// dead workspace, so it owns "the first resolution is not a navigation" as well.
const WORKSPACES = [
  {
    id: 5,
    name: 'Default',
    repoIds: [7, 9, 11],
    repoCount: 3,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 9,
    name: 'Platform',
    repoIds: [21, 22],
    repoCount: 2,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

/** One run of the sync effect over the live store, with an explicit "previously observed" ref. */
function syncEffect(prevWorkspaceRef: { current: number | null }): void {
  syncWorkspaceScope({
    workspaces: WORKSPACES,
    workspaceId: useFilters.getState().workspaceId,
    prevWorkspaceRef,
    setWorkspace: useFilters.getState().setWorkspace,
    setRepoIds: useFilters.getState().setRepoIds,
  });
}

/** The browser's Back button. Throws if there is nothing left — i.e. if we just left the app. */
function back(): void {
  if (cursor === 0) throw new Error('Back left the app — no entry to return to');
  cursor -= 1;
  seat(entries[cursor] as string);
  applyUrlToStores({ fromPop: true });
}

function forward(): void {
  if (cursor >= entries.length - 1) throw new Error('nothing to go forward to');
  cursor += 1;
  seat(entries[cursor] as string);
  applyUrlToStores({ fromPop: true });
}

beforeEach(() => {
  // A clean filter bar as well as a clean history — these tests assert on the whole query string,
  // and vitest shares one module-level store across a file.
  useFilters.getState().resetAllFilters();
  entries = ['/app/?workspace=5&view=activity'];
  cursor = 0;
  seat(entries[0] as string);
  useFilters.setState({
    workspaceId: 5,
    repoIds: null,
    activityRepoId: 'feed',
    attentionIsolation: null,
    feedIsolatedPrId: null,
    feedInnerTab: 'feed',
    botsInnerTab: 'roi',
    prDetailTab: null,
    selectedPrId: null,
    selectedThreadId: null,
    insightsReportKey: null,
  });
  usePinnedTabs.setState({ activeTab: 'activity', tabs: [], activityReturnItemId: null });
});

describe('the verb: navigations push, refinements replace', () => {
  it('a rail switch PUSHES', () => {
    gesture(() => useFilters.getState().setActivityRepo('attention'));
    expect(entries).toHaveLength(2);
    expect(location.search).toContain('activityRepo=attention');
  });

  it('a filter change REPLACES — Back is not a per-click undo stack', () => {
    gesture(() => useFilters.getState().setPreset('30d'));
    gesture(() => useFilters.getState().setExcludeStale(false));
    gesture(() => useFilters.getState().setPrStatuses(['open']));
    expect(entries).toHaveLength(1);
    expect(location.search).toContain('preset=30d');
  });

  // A SELECTION is a refinement of the board, not a view of its own: clicking through PR bars
  // would otherwise stack an entry per click.
  it('selecting a PR / thread REPLACES', () => {
    gesture(() => useFilters.getState().selectPr(4123));
    gesture(() => useFilters.getState().selectThread(4123, 88));
    expect(entries).toHaveLength(1);
    expect(location.search).toContain('pr=4123');
    expect(location.search).toContain('thread=88');
  });

  // ⚠ A KEY AN EFFECT OWNS IS NOT A NAVIGATION. `PeriodReportsPanel` auto-seats the newest period
  // whenever the selection is empty, so as a nav key `report` would fight Back: the pop lands on a
  // URL without it, the effect re-seats one and pushes, and the reader is shoved back forward.
  it('picking a report period REPLACES', () => {
    gesture(() => useFilters.getState().setActivityRepo('insights'));
    const afterConsole = entries.length;
    gesture(() => useFilters.getState().setInsightsReportKey('sprint-2026-08-18'));
    gesture(() => useFilters.getState().setInsightsReportKey('sprint-2026-08-04'));
    expect(entries).toHaveLength(afterConsole);
    expect(location.search).toContain('report=sprint-2026-08-04');
  });

  // The escape hatch for a write that moves a nav key without the user having navigated — the
  // deep-link effects that seat PrDetail's tab as the view opens (see `seedTab`).
  it('a marked CORRECTION replaces, even on a navigation key', async () => {
    const { markUrlCorrection } = await import('../src/hooks/useUrlState.js');
    markUrlCorrection();
    gesture(() => useFilters.getState().setActivityRepo('attention'));
    expect(entries).toHaveLength(1);
    expect(location.search).toContain('activityRepo=attention');
    // …and it is a ONE-SHOT: the next real navigation pushes again.
    gesture(() => useFilters.getState().setActivityRepo('bots'));
    expect(entries).toHaveLength(2);
  });

  // ⚠ The app stamps `?workspace=<id>` on its own address bar within ~1s of every load. Pushing
  // that would burn the user's FIRST Back on an entry they never navigated to. Driven through the
  // effect that actually does it — the rule is owned by the WRITER (`syncWorkspaceScope` marks its
  // own fallback write a correction), never inferred from the URL's shape by `writeToUrl`.
  it('the first workspace resolution REPLACES', () => {
    entries = ['/app/'];
    cursor = 0;
    seat(entries[0] as string);
    useFilters.setState({ workspaceId: null });
    gesture(() => syncEffect({ current: null }));
    expect(entries).toHaveLength(1);
    expect(location.search).toContain('workspace=5');
  });

  // ⚠ …and that hatch must MEAN "the first resolution", not "the previous URL happened to name no
  // workspace". Spelled as a URL shape it also swallowed every genuine navigation made FROM an
  // entry minted before the scope resolved — an entry keeps that shape forever — so the reader's
  // next Back left the SPA instead of returning to it.
  it('a genuine navigation from a workspace-less entry still PUSHES', () => {
    entries = ['/app/?view=activity'];
    cursor = 0;
    seat(entries[0] as string);
    useFilters.setState({ workspaceId: null });
    gesture(() => useFilters.getState().openMyTurnInWorkspace(9));
    expect(location.search).toContain('workspace=9');
    expect(entries).toHaveLength(2);
    back();
    expect(cursor).toBe(0);
  });

  // ⚠ A CORRECTION THAT RECONCILES STATE THE USER DID NOT ASK FOR IS A REPLACE — and `workspace`
  // is a NAV key, so this one is a trap rather than an extra entry. A workspace the URL still
  // names but the account no longer has (deleted mid-session, a stale bookmark, a cross-account
  // link) sends `syncWorkspaceScope` down its fallback branch one tick after the pop. Pushed, that
  // lands a new entry ON TOP of the one the reader just reached; the entry behind it still names
  // the dead id, so the next Back pops straight back into the same branch and pushes again — Back
  // is a permanent no-op and the reader can neither reach an earlier view nor leave the app.
  it('adopting Default over a DEAD workspace replaces, so Back keeps working', () => {
    entries = [
      '/app/?workspace=5&view=activity',
      '/app/?workspace=77&view=activity&activityRepo=bots',
      '/app/?workspace=5&view=timeline',
    ];
    cursor = 2;
    seat(entries[2] as string);
    useFilters.setState({ workspaceId: 5 });
    const ref = { current: 5 };

    back(); // onto the entry naming workspace 77, which no longer exists
    expect(cursor).toBe(1);
    expect(useFilters.getState().workspaceId).toBe(77);

    gesture(() => syncEffect(ref)); // the sync effect adopts Default a tick later
    expect(useFilters.getState().workspaceId).toBe(5);
    expect(entries).toHaveLength(3);
    expect(cursor).toBe(1);

    // The whole point: the reader can still keep going back.
    back();
    expect(cursor).toBe(0);
  });
});

describe('Back from Needs attention (the reported bug)', () => {
  // The exact sequence the reporter described: read the feed → click a brief line → Back.
  it('returns to the launching board, and clears the narrowing on the way', () => {
    gesture(() => {
      // The daily brief's ordering rule: switch the rail FIRST, isolate SECOND.
      useFilters.getState().setActivityRepo('attention');
      useFilters.getState().setAttentionIsolation('stalled_review');
    });
    expect(location.search).toContain('activityRepo=attention');
    expect(location.search).toContain('attn=stalled_review');
    // ONE entry for one gesture, even though it was two setters.
    expect(entries).toHaveLength(2);

    back();
    expect(useFilters.getState().activityRepoId).toBe('feed');
    // ⚠ The narrowing must be GONE, not merely off-screen: the popped URL does not mention it,
    // and a partial pop would leave the next visit to the board silently filtered.
    expect(useFilters.getState().attentionIsolation).toBeNull();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
  });

  // Two steps down, two steps back — and Forward is symmetric, because the pop applies the URL
  // rather than replaying a store flag (the old handler could only go one way).
  it('walks back through board → narrowed board, and Forward returns', () => {
    gesture(() => useFilters.getState().setActivityRepo('attention'));
    gesture(() => useFilters.getState().setAttentionIsolation('my_turn'));
    expect(entries).toHaveLength(3);

    back();
    expect(useFilters.getState().activityRepoId).toBe('attention');
    expect(useFilters.getState().attentionIsolation).toBeNull();

    forward();
    expect(useFilters.getState().attentionIsolation).toBe('my_turn');
  });

  // The banner's one-gesture cross-workspace deep link is FOUR store writes; the reader pressed
  // one thing, so one Back must undo it.
  it('openMyTurnInWorkspace is ONE entry, not four', () => {
    gesture(() => useFilters.getState().openMyTurnInWorkspace(9));
    expect(entries).toHaveLength(2);
    expect(useFilters.getState().attentionIsolation).toBe('my_turn');

    back();
    expect(useFilters.getState().workspaceId).toBe(5);
    expect(useFilters.getState().attentionIsolation).toBeNull();
    expect(useFilters.getState().activityRepoId).toBe('feed');
  });
});

describe('Back after a workspace switch', () => {
  it('restores the workspace AND the narrowings the switch cleared', () => {
    gesture(() => {
      useFilters.getState().setActivityRepo('attention');
      useFilters.getState().setAttentionIsolation('untouched_thread');
    });
    // Switching workspace clears `repoIds` / `feedIsolatedPrId` / `attentionIsolation`…
    gesture(() => useFilters.getState().setWorkspace(9, null));
    expect(useFilters.getState().attentionIsolation).toBeNull();
    expect(location.search).toContain('workspace=9');

    // …and because all of them are in the URL, one Back restores the whole bundle rather than
    // half of it.
    back();
    expect(useFilters.getState().workspaceId).toBe(5);
    expect(useFilters.getState().activityRepoId).toBe('attention');
    expect(useFilters.getState().attentionIsolation).toBe('untouched_thread');
  });

  it('a workspace switch is a navigation, so it never silently mutates the entry', () => {
    gesture(() => useFilters.getState().setWorkspace(9, null));
    expect(entries).toHaveLength(2);
  });
});

describe('a pop onto a URL that omits a key', () => {
  // THE `readFromUrl`-IS-PARTIAL TRAP. Every one of these keys is set on the way out and absent
  // on the way back, so each would stay seated under a naive re-parse.
  it('resets every URL-owned key the popped URL does not name', () => {
    gesture(() => {
      useFilters.getState().setActivityRepo('insights');
      useFilters.getState().setInsightsReportKey('sprint-2026-08-18');
    });
    back();
    expect(useFilters.getState().activityRepoId).toBe('feed');
    expect(useFilters.getState().insightsReportKey).toBeNull();
  });

  it('resets a filter the popped URL does not name', () => {
    gesture(() => useFilters.getState().setActivityRepo('bots')); // an entry to come back to
    gesture(() => {
      useFilters.getState().setPreset('90d');
      useFilters.getState().setActivityRepo('attention');
    });
    expect(location.search).toContain('preset=90d');
    back();
    expect(useFilters.getState().preset).toBe('14d');
  });

  // ⚠ …but only the keys the URL OWNS. A pop must not double as "reset the session": the seeds,
  // the chat threads and the sync round were never serialized, so there is nothing to restore
  // them from and clearing them is pure loss.
  it('leaves transient state the URL never serialized alone', () => {
    useFilters.setState({
      repoConsoleTabs: { 7: 'bots' },
      searchSeed: { query: 'flaky' } as never,
    });
    gesture(() => useFilters.getState().setActivityRepo('attention'));
    back();
    expect(useFilters.getState().repoConsoleTabs).toEqual({ 7: 'bots' });
    expect(useFilters.getState().searchSeed).not.toBeNull();
  });

  // ⚠ `workspaceId: null` does not mean "no workspace", it means "not resolved yet" — it blanks
  // every workspace-scoped surface and sends the sync effect off to Default. A URL naming no
  // workspace must therefore leave the live one alone.
  it('never writes a null workspace from a URL that names none', () => {
    entries = ['/app/?view=activity', '/app/?view=activity&activityRepo=bots'];
    cursor = 1;
    seat(entries[1] as string);
    back();
    expect(useFilters.getState().workspaceId).toBe(5);
  });
});

describe('tabs are views: opening one is a navigation', () => {
  it('opening a PR tab pushes, and Back returns to the console that launched it', () => {
    gesture(() =>
      usePinnedTabs.getState().openPrDetailTab(
        {
          id: 4123,
          number: 12,
          title: 'Fix the thing',
          repoFullName: 'acme/web',
          authorLogin: 'ada',
          authorDisplayName: null,
          authorAvatarUrl: null,
        },
        { fromActivity: true, returnItemId: 'feed-item-1' },
      ),
    );
    expect(entries).toHaveLength(2);
    expect(usePinnedTabs.getState().activeTab).toBe(prDetailKey(4123));

    back();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
    // The shipped Back-flash survived the move off `{pierreTab}`: the feed scrolls to and flashes
    // the exact card that was clicked, and ONLY on a real Back.
    expect(usePinnedTabs.getState().activityFlashItemId).toBe('feed-item-1');
  });

  // PrDetail's inner tab is store state precisely so it can be addressed; the pair keeps one PR's
  // tab off another PR's screen.
  it('a PR tab round-trips its inner tab', () => {
    gesture(() =>
      usePinnedTabs
        .getState()
        .openPrDetailTab({
          id: 4123,
          number: 12,
          title: 'Fix the thing',
          repoFullName: 'acme/web',
          authorLogin: null,
          authorDisplayName: null,
          authorAvatarUrl: null,
        }),
    );
    gesture(() => useFilters.getState().setPrDetailTab(4123, 'changes'));
    expect(location.search).toContain('prTab=changes');

    back();
    expect(useFilters.getState().prDetailTab).toBeNull();
    expect(usePinnedTabs.getState().activeTab).toBe(prDetailKey(4123));
  });

  // A seed-backed drill-down emits no `view` at all, so the pop resolves to Activity rather than
  // to a drill-down whose seed died with the session — and the entry BEFORE it is still the
  // console that launched it.
  it('a Back that lands on a drill-down URL resolves to Activity, not to a broken tab', () => {
    gesture(() => useFilters.getState().setActivityRepo('bots'));
    gesture(() => usePinnedTabs.getState().openBotFlaggingTab({ fromActivity: true }));
    expect(location.search).not.toContain('view=');

    back();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
    expect(useFilters.getState().activityRepoId).toBe('bots');

    // Forward onto the drill-down's own entry: it must land somewhere coherent, never crash or
    // strand the reader on an empty tab.
    forward();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
  });

  // ⚠ A POP MUST RECONCILE THE ADDRESS BAR, exactly as the cold load does. A seed-backed
  // drill-down's entry emits no `view` at all — and drops `activityRepo` with it, since both are
  // emitted only inside `writeToUrl`'s `activity` branch — so popping onto one leaves the store
  // saying `activity` while the URL says nothing. The next PURE REFINEMENT then diffs `view`
  // absent → `view=activity`, is read as a NAVIGATION and PUSHES: a filter click becomes a
  // history entry and the reader's Forward stack is destroyed.
  it('reconciles the address bar after a pop, so the next refinement is not read as a navigation', () => {
    entries = [
      '/app/?workspace=5&view=activity',
      '/app/?workspace=5', // the drill-down entry: no `view`, no `activityRepo`
      '/app/?workspace=5&view=pr-detail%3A4123',
    ];
    cursor = 2;
    seat(entries[2] as string);
    usePinnedTabs.setState({ activeTab: prDetailKey(4123) });

    back();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
    expect(location.search).toContain('view=activity');
    // A REPLACE, so the forward entry is still there.
    expect(entries).toHaveLength(3);
    expect(cursor).toBe(1);

    gesture(() => useFilters.getState().setPreset('30d'));
    expect(entries).toHaveLength(3);
    expect(cursor).toBe(1);

    forward();
    expect(usePinnedTabs.getState().activeTab).toBe(prDetailKey(4123));
  });

  // A link to a PR tab in a browser that has never seen it: the tab is RE-CREATED from the key.
  it('re-creates a tab a popped URL names but this browser has no record of', () => {
    entries = ['/app/?workspace=5&view=activity', '/app/?workspace=5&view=pr-detail%3A777'];
    cursor = 1;
    seat(entries[1] as string);
    applyUrlToStores({ fromPop: true });
    expect(usePinnedTabs.getState().activeTab).toBe(prDetailKey(777));
    expect(usePinnedTabs.getState().tabs.map((t) => t.key)).toContain(prDetailKey(777));
  });
});

describe('the Activity sub-tab strips', () => {
  it('switching the Bots sub-tab pushes and round-trips', () => {
    gesture(() => useFilters.getState().setActivityRepo('bots'));
    gesture(() => useFilters.getState().setBotsInnerTab('settings'));
    expect(location.search).toContain('botsTab=settings');
    expect(entries).toHaveLength(3);

    back();
    expect(useFilters.getState().botsInnerTab).toBe('roi');
  });

  // ⚠ The RAW choice is seated on a pop; the visible tab stays DERIVED in the components. A
  // corrective write here would permanently forget a choice the moment a capability blinked.
  it('seats a sub-tab the current tier may not render, rather than correcting it', () => {
    seat('/app/?workspace=5&view=activity&feedTab=themes');
    applyUrlToStores({ fromPop: true });
    expect(useFilters.getState().feedInnerTab).toBe('themes');
  });
});

// ── THE SECOND HALF OF A POP ─────────────────────────────────────────────────────────────────
//
// Seating the popped URL is not the same as RESTORING the view. `useWorkspaceSync` runs a tick
// after every pop, and its job — keep `workspaceId` resolved and `repoIds` honest — makes it the
// one effect that can undo what the pop just did: it sees a workspace id that differs from its
// ref, reads that as "the user switched workspace" and re-derives `setWorkspace(id, null)`.
//
// THE BUG THAT PINS: `repoIds` was the ONE key in the whole history bundle that did not survive a
// Back. `workspace`, `activityRepo`, `attn` and `feedPr` all round-tripped; the reader watched
// their repo narrowing come back and then vanish a frame later, on a screen with no control on it
// to put it back (the repo picker is Timeline-only).
//
// So a CHANGE OF WORKSPACE IS NOT ALWAYS A SWITCH, and these cases are about telling the two
// apart — without handing branch (2) a flag that stays on and swallows the next real switch.
describe('repoIds across a Back over a workspace switch', () => {
  it('restores the narrowing, and the sync effect leaves it standing', () => {
    // Narrow inside workspace 5 (a refinement — same entry), then switch to 9 (a navigation).
    gesture(() => useFilters.getState().setRepoIds([7, 9]));
    expect(location.search).toContain('repos=7%2C9');
    gesture(() => useFilters.getState().setWorkspace(9, null));
    expect(entries).toHaveLength(2);

    // The effect has of course already run for the switch: its ref now says 9.
    const ref = { current: 9 };
    syncEffect(ref);
    expect(useFilters.getState().repoIds).toBeNull();

    back();
    // Half one: the pop seats the popped URL. This always worked.
    expect(useFilters.getState().workspaceId).toBe(5);
    expect(useFilters.getState().repoIds).toEqual([7, 9]);

    // Half two: the effect runs again, sees 9 → 5, and must NOT read that as a switch.
    syncEffect(ref);
    expect(useFilters.getState().workspaceId).toBe(5);
    expect(useFilters.getState().repoIds).toEqual([7, 9]);
  });

  // The restore takes the PRUNE path, not a free pass: a `?repos=` naming a repo that has since
  // left the workspace is still corrected against the live membership.
  it('prunes a restored narrowing against the workspace it landed in', () => {
    seat('/app/?workspace=5&repos=7,999&view=activity');
    useFilters.setState({ workspaceId: 9 });
    applyUrlToStores({ fromPop: true });
    expect(useFilters.getState().repoIds).toEqual([7, 999]);

    syncEffect({ current: 9 });
    expect(useFilters.getState().repoIds).toEqual([7]);
  });

  // ⚠ THE OTHER HALF OF THE CONTRACT. A signal that suppressed branch (2) generally would trade
  // this bug for a worse one: a subset belonging to the workspace you LEFT, silently applied to
  // the one you arrived in. The marker is keyed on the id and consumed on first read.
  it('still widens on a genuine switch — the marker is one-shot and id-keyed', () => {
    gesture(() => useFilters.getState().setRepoIds([7, 9]));
    gesture(() => useFilters.getState().setWorkspace(9, null));
    back();
    const ref = { current: 9 };
    syncEffect(ref); // consumes the marker for workspace 5
    expect(useFilters.getState().repoIds).toEqual([7, 9]);

    // Now a REAL switch to 9, carrying a stale subset (as a caller that forgot `null` would).
    useFilters.setState({ workspaceId: 9, repoIds: [7, 9] });
    syncEffect(ref);
    expect(useFilters.getState().repoIds).toBeNull();

    // …and back to 5 by hand: the consumed marker cannot resurrect itself.
    useFilters.setState({ workspaceId: 5, repoIds: [7] });
    syncEffect(ref);
    expect(useFilters.getState().repoIds).toBeNull();
  });

  // The marker describes the URL that was just applied, so a pop onto a URL with no narrowing
  // must not arm it — and must not leave one armed by an earlier pop standing either.
  it('arms nothing for a popped URL that carries no repos', () => {
    seat('/app/?workspace=5&repos=7,9&view=activity');
    applyUrlToStores({ fromPop: true });
    seat('/app/?workspace=9&view=activity');
    applyUrlToStores({ fromPop: true });
    expect(consumeRestoredWorkspaceScope(9)).toBe(false);
    expect(consumeRestoredWorkspaceScope(5)).toBe(false);
  });
});
