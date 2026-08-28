import { useEffect, useRef } from 'react';
import {
  ALL_CATEGORIES,
  ALL_PR_STATUSES,
  ALL_REVIEW_STATES,
  DEFAULT_CATEGORIES,
  DEFAULT_PR_STATUSES,
  DEFAULT_REVIEW_STATES,
  PR_DETAIL_TABS,
  freshFilterDefaults,
  freshUrlOwnedDefaults,
  pickFilterBarState,
  pickScopeState,
  sanitizePersistedFilters,
  sanitizePersistedScope,
  useFilters,
  type FilterState,
  type PrDetailTab,
  type RangePreset,
} from '../store/filters.js';
import {
  DERIVED_STATES,
  type DerivedState,
  type EventCategory,
  type InsightKind,
  type PrStatus,
  type ReviewState,
} from '@pierre-review/shared';
import {
  parseBotDetailKey,
  parseTabKey,
  parseUserActivityKey,
  usePinnedTabs,
  type ActiveTab,
} from '../store/pinnedTabs.js';

const PRESETS: RangePreset[] = ['7d', '14d', '30d', '90d', 'custom'];
// The attention board's isolation kinds. A local list because `InsightKind` ships no runtime
// array; the URL is hand-editable, so an unknown value must seat nothing rather than narrow the
// board to a kind no card has.
//
// ⚠ HAND-WRITTEN, SO NOTHING COMPILES WHEN THE UNION GROWS. A kind missing here is silently
// UN-SEATABLE: `?attn=<kind>` is discarded, which means the daily-brief line that counts it opens
// an un-isolated board and a browser Back cannot return to the narrowed one. EXPORTED purely so
// `test/ciFailingCard.test.ts` can compare it against `KIND_LABEL` — whose exhaustiveness the
// compiler DOES enforce — turning that silent omission into a failing test.
export const INSIGHT_KINDS: readonly InsightKind[] = [
  'my_turn',
  'ci_failing',
  'stalled_review',
  'untouched_thread',
  'reviewer_load',
  'reviewer_routing',
  'merge',
  'update_branch',
  'bot_signal',
  'bot_only_review',
];

/**
 * THE NAVIGATION KEYS — the whole push-vs-replace rule, in one list.
 *
 * A change to any of these is a NAVIGATION: the user is now looking at a different VIEW, so it
 * gets its own history entry (`pushState`) and a browser Back returns to the previous one.
 * Everything else the serializer emits — a filter, a range, a search, a PR/thread SELECTION — is
 * a refinement OF the current view and REPLACES the entry, because a Back that walks backwards
 * through every pill click is a per-keystroke undo stack, not navigation.
 *
 * ⚠ Decided by DIFFING the URL, never by a `push: true` argument threaded through call sites. The
 * serializer runs from an un-debounced store subscription that fires on EVERY write (transient
 * signal bumps included), so a per-write push would blow Safari's ~100-entries/30s limit; and a
 * per-caller flag is exactly the kind of thing the 15th caller forgets. Adding a key here is one
 * decision in one place.
 *
 * ⚠ `pr`/`thread` are deliberately ABSENT. Clicking through PR bars on the board is a selection —
 * historying it would stack an entry per click, and the DetailPane is a pane on the board, not a
 * view of its own. Opening a PR as a TAB is a different gesture and shows up here as `view`.
 *
 * ⚠ `report` is ABSENT TOO, and for a sharper reason: `PeriodReportsPanel` AUTO-SEATS the newest
 * period whenever the selection is empty or names a period the list doesn't have. As a nav key
 * that effect would fight the Back button — the pop lands on a URL with no `report`, the effect
 * immediately re-seats one and PUSHES, and the reader is shoved forward onto the entry they just
 * left. A key an effect owns is a refinement, not a navigation.
 */
const NAV_KEYS = [
  'view',
  'workspace',
  'activityRepo',
  'attn',
  'attnRel',
  // ⚠ RETIRED BUT STILL LISTED. `?attnPersonal=1` shipped, so history entries and bookmarks carry
  // it; it is parsed (as `attnRel=mine`) and never emitted. It stays a NAV key because leaving one
  // of those legacy entries — the emitted URL drops `attnPersonal` and gains `attnRel` — is a real
  // navigation, and the diff has to see BOTH halves of that swap to say so.
  'attnPersonal',
  'feedPr',
  'feedTab',
  'botsTab',
  'prTab',
] as const;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function parseIds(raw: string | null): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter(Number.isFinite);
  return ids.length ? ids : null;
}

/** A workspace id on the wire is a plain positive integer — nothing else parses. */
function parseWorkspaceParam(raw: string | null): number | null {
  if (raw == null || !/^[0-9]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the URL's workspace scope: `?workspace=<int>` wins; with it absent, a LEGACY
 * `?team=<int>` maps across (the workspace migration deliberately preserved team ids, so an
 * integer team id names the workspace that team became). Everything else — an unparseable
 * `?workspace`, and every legacy sentinel `?team=all|none|teams|teams:1,2` — resolves to null,
 * which leaves the store unresolved and lets the workspace-sync effect pick the account's
 * Default. Those sentinels have no image: 'all' spanned the account and 'teams:1,2' spanned two
 * repo sets that are now one workspace each, so any mapping would be a guess.
 */
function readWorkspaceFromUrl(p: URLSearchParams): number | null {
  const explicit = p.get('workspace');
  if (explicit != null) return parseWorkspaceParam(explicit);
  return parseWorkspaceParam(p.get('team'));
}

/**
 * Does a param hold something `readFromUrl` would actually seat as an id? Mirrors its parse
 * exactly (truthy raw, then a finite parseInt) so `?pr=` and `?pr=nonsense` — which set nothing —
 * cannot be read here as a destination the app then honours.
 */
function namesId(p: URLSearchParams, key: string): boolean {
  const raw = p.get(key);
  return !!raw && Number.isFinite(Number.parseInt(raw, 10));
}

/**
 * WHICH BOARD does this URL land on? — the ONE tab decision, made on every load.
 *
 * The rule: **always Activity, unless the URL EXPLICITLY names a board destination.** Activity is
 * the relevance-ranked state of play and the app's front door; the timeline is the secondary
 * surface you navigate TO.
 *
 * ⚠ `?workspace=<id>` IS NOT A DEEP LINK, and structurally never can be: `writeToUrl` stamps it
 * onto the address bar itself as soon as the scope resolves — within ~1s of every load — so its
 * presence says only "this app has run", never "the user asked for the board". This is exactly
 * the bug this function exists to fix. The decision used to ride `hasUrlParams`
 * (`window.location.search.length > 1`), one boolean answering two unrelated questions; because
 * the app makes its own URL non-bare, only the very first paint of a truly bare `/app` ever
 * reached the Activity branch, and any refresh from a PR tab or a drill-down landed on Timeline.
 * The same reasoning disqualifies every other self-stamped param (`repos`, `cats`, `status`, …).
 *
 * The board is named two ways, and they are checked IN THIS ORDER:
 *
 *  1. `view=` — the AFFIRMATIVE statement, written by `writeToUrl` from the live tab. When it
 *     names a board the app knows, it wins outright. (The read and write halves must always
 *     change together, or a deliberate switch to the board is undone on the next F5.)
 *  2. `?pr=<id>` / `?thread=<id>`, and ONLY when `view=` said nothing — the board INFERRED from a
 *     selection that only the board can render: the DetailPane mounts solely in the board slot
 *     (`paneVisible = selectedPrId != null && !overlayActive`, App.tsx), so landing a
 *     hand-written or pre-`view=` link like that on Activity would leave it inert, naming a PR
 *     nothing on screen displays.
 *
 * ⚠ THAT ORDER IS LOAD-BEARING, not stylistic. `selectedPrId` is NOT cleared when a user returns
 * to Activity from a PR they opened out of the feed — FeedView calls `openPrDetailTab` +
 * `selectPr`/`selectThread` together, and the Activity tab chip only changes the tab — so
 * `?view=activity&pr=123` is an ordinary, frequently-produced URL rather than a contrived one.
 * Testing `pr` first would refresh exactly those users onto the board.
 *
 * Anything else in `view=` — a stale spelling, a hand-edited value — falls through to the
 * inference and then to Activity, the right normalization for a destination that no longer exists.
 *
 * `view=` NAMES TABS TOO, not just the two boards, and the spelling is the `Tab.key` VERBATIM
 * (`pr-detail:123`, `pr-focus:123`, `user-activity:45`, `bot-detail:45`) — one vocabulary, not a
 * URL dialect that has to be kept in sync with the store's. Those four kinds are SELF-DESCRIBING:
 * the key alone reconstructs the tab, so a link to one works in a browser that has never seen it
 * (`applyUrlTab` re-creates it). The seed-backed drill-downs (`bot-flagging`, `people-report`,
 * `search`, …) are NOT named by any URL: their identity lives in transient in-memory seeds, and a
 * restored seed could name a tile the strip no longer shows or people this workspace no longer
 * has. They stay ephemeral, and a URL landing on one resolves to Activity — which is exactly what
 * the unknown-value rule below already does.
 *
 * Exported for its unit test — see test/landingTab.test.ts.
 */
export function landingTabFromUrl(search: string): ActiveTab {
  const p = new URLSearchParams(search);
  const view = p.get('view');
  if (view === 'timeline') return 'timeline';
  if (view === 'activity') return 'activity';
  if (
    view != null &&
    (parseTabKey(view) != null ||
      parseUserActivityKey(view) != null ||
      parseBotDetailKey(view) != null)
  ) {
    return view;
  }
  if (namesId(p, 'pr') || namesId(p, 'thread')) return 'timeline';
  return 'activity';
}

/** Exported for its unit test only — see test/feedCiFailuresToggle.test.ts. */
export function readFromUrl(): Partial<FilterState> {
  const p = new URLSearchParams(window.location.search);
  const out: Partial<FilterState> = {};

  const preset = p.get('preset');
  if (preset && PRESETS.includes(preset as RangePreset)) {
    out.preset = preset as RangePreset;
  }
  // ── Scope: the workspace, and the repo narrowing INSIDE it ────────────────────────────────
  // `?repos=` is only meaningful relative to a workspace, so the two are read together.
  //
  // ⚠ THE TRAP THIS CLOSES: `?repos=` used to be parsed unconditionally. A link in the wild
  // (`?team=3&repos=7,9,11`, or any `?repos=` with no scope at all) would then land the user in
  // one workspace while hydrating another's repo ids — a header naming Default over a board
  // showing someone else's repos, and the server honours those ids. So repo ids survive ONLY
  // when the URL actually resolved a workspace; otherwise they are DISCARDED. (Even then they
  // are a hint: the workspace-sync effect PRUNES them to the resolved membership before any
  // query runs. Pruning, never replacing — replacing would revert a per-repo show/hide on every
  // background refetch.)
  const workspaceId = readWorkspaceFromUrl(p);
  if (workspaceId != null) out.workspaceId = workspaceId;
  out.repoIds = workspaceId != null ? parseIds(p.get('repos')) : null;
  out.userIds = parseIds(p.get('users'));
  // Bots are HIDDEN by default now, so a clean URL means "hidden". An explicit `bots=0`
  // turns the exclude-bots filter OFF (show bots); `bots=1` is still honoured for
  // backward-compat with older shared URLs (now redundant with the default). Mirrors the
  // excludeStale pattern below.
  if (p.get('bots') !== null) out.excludeBots = p.get('bots') === '1';
  // Per-repo "allowed bots" (kept visible under excludeBots). Absent → none allow-listed.
  const allowBots = parseIds(p.get('allowBots'));
  if (allowBots) out.allowedBotIds = allowBots;
  // Stale open PRs are hidden by default now, so a clean URL means "hidden". An
  // explicit `stale=0` turns the filter OFF (show stale); `stale=1` is still honoured
  // for backward-compat with older shared URLs (now redundant with the default).
  const stale = p.get('stale');
  if (stale === '0') out.excludeStale = false;
  else if (stale === '1') out.excludeStale = true;
  // The Feed's CI-failure lens — THREE states, defaulting to 'off' (no CI rows fetched), so only
  // the two non-default values appear: `ci=1` interleaves them, `ci=only` narrows to them.
  // `ci=1` has meant "on" since this was a boolean, so links minted under either older shape
  // still read correctly, and an explicit `ci=0` is still honoured as 'off' — it is now merely
  // redundant with the default. ⚠ THIS PARAM IS WHAT MAKES IT SURVIVE A RELOAD: it is
  // persisted with the filter bar, but the persisted blob is read ONLY on a BARE URL, and
  // writeToUrl puts `?workspace=<id>` (and `view=activity`) on the address bar within a second of
  // every load — so a FilterDefaults key that is not serialized here is restored precisely never.
  const ci = p.get('ci');
  if (ci === 'only') out.feedCiLens = 'only';
  else if (ci === '0') out.feedCiLens = 'off';
  else if (ci !== null) out.feedCiLens = 'feed';
  // ⚠ An OLD link that meant 'feed' carried NO `ci` param (it was the default when the link was
  // minted), so it now reads as the new 'off' default. That is deliberate and unavoidable — an
  // absent param cannot be told apart from a bare URL — and it is the same direction as the
  // stored-blob migration below.
  out.customFrom = p.get('from');
  out.customTo = p.get('to');

  const cats = p.get('cats');
  if (cats) {
    const valid = new Set<string>(ALL_CATEGORIES);
    out.categories = cats.split(',').filter((c) => valid.has(c)) as EventCategory[];
  }
  // `status` present (even empty) is an explicit selection — '' means "none
  // selected", which must survive a reload rather than reverting to the default.
  const status = p.get('status');
  if (status !== null) {
    const valid = new Set<string>(ALL_PR_STATUSES);
    out.prStatuses = status.split(',').filter((s) => valid.has(s)) as PrStatus[];
  }
  // `reviews` present (even empty) is an explicit verdict selection — '' = "no review
  // markers", which must survive a reload rather than reverting to "all verdicts".
  const reviews = p.get('reviews');
  if (reviews !== null) {
    const valid = new Set<string>(ALL_REVIEW_STATES);
    out.reviewStates = reviews.split(',').filter((s) => valid.has(s)) as ReviewState[];
  }
  const states = p.get('states');
  if (states) {
    const valid = new Set<string>(DERIVED_STATES);
    out.derivedStates = states.split(',').filter((s) => valid.has(s)) as DerivedState[];
  }
  // My Turn Focus Mode is a transient mode (entered only by opening an inbox entry),
  // so it is deliberately NOT read from / written to the URL — a fresh load is always
  // the full board + the My Turn panel.
  const pr = p.get('pr');
  if (pr) out.selectedPrId = Number.parseInt(pr, 10);
  const thread = p.get('thread');
  if (thread) out.selectedThreadId = Number.parseInt(thread, 10);

  // Activity deep link: `?activityRepo=<id>` selects that repo's console. The active BOARD
  // itself (`view=`) is NOT read here — it lives in the pinnedTabs store, not FilterState, and
  // is decided once per load by `landingTabFromUrl` above. `activityThreadFilter` is
  // intentionally URL-silent.
  const activityRepo = p.get('activityRepo');
  if (activityRepo) {
    if (activityRepo === 'bots') out.activityRepoId = 'bots';
    else if (activityRepo === 'attention') out.activityRepoId = 'attention';
    // ('compare' is deliberately NOT parsed: the "Compare workspaces" rail entry was folded into
    // Reports' "By workspace" axis. A legacy `?activityRepo=compare` link falls through the
    // parseInt branch below — NaN, nothing set — and lands on the 'feed' default, which is the
    // normalization for a value that no longer exists.)
    // 'insights' USED to be write-only-by-omission: a landing default that stayed out of the URL
    // and was not parsed here either. That made the period report unforwardable — `?report=` names
    // a period on a console the link could not select, so the recipient landed on the Feed and saw
    // no report at all. It is parsed and emitted now. (The one-shot landing default that used to
    // auto-select this rail entry for Pro accounts is GONE — the store default is 'feed' on every
    // tier, so making Reports free-visible changes nothing about where the app lands.)
    else if (activityRepo === 'insights') out.activityRepoId = 'insights';
    else {
      const n = Number.parseInt(activityRepo, 10);
      if (Number.isFinite(n)) out.activityRepoId = n;
    }
  }

  // The **Pending** board's single-KIND isolation — the daily brief's lines. THE reason
  // this key exists: a reader clicks "3 PRs stalled awaiting review", lands on a narrowed board,
  // and presses Back. Before the board AND its narrowing were both addressable, that Back left
  // the app entirely, because the whole session had exactly one history entry.
  const attn = p.get('attn');
  if (attn && (INSIGHT_KINDS as readonly string[]).includes(attn)) {
    out.attentionIsolation = attn as InsightKind;
  }
  // The board's RELEVANCE lens — the other half of the same navigation. A banner/badge click sets
  // both, and each is a view the reader can Back out of independently, so both are addressable.
  // Only the two literals seat it: a link carrying anything else means the broad board (the
  // default), never "something truthy".
  const attnRel = p.get('attnRel');
  if (attnRel === 'mine' || attnRel === 'others') out.attentionRelevance = attnRel;
  // ⚠ BACK-COMPAT, ONE DIRECTION ONLY. `?attnPersonal=1` is the retired boolean spelling and it is
  // ALREADY IN THE WILD — shipped links, and every history entry minted before this change, which
  // a browser Back replays verbatim. It still resolves, to the lens that means what it meant
  // ('mine' = direct + maintained = the old `personal`); it is never emitted again. The new key
  // WINS when both appear, so a legacy entry can never override a live one.
  else if (p.get('attnPersonal') === '1') out.attentionRelevance = 'mine';
  // The Feed's single-PR isolation — the attention board's twin, addressable for the same reason.
  const feedPr = p.get('feedPr');
  if (feedPr) {
    const n = Number.parseInt(feedPr, 10);
    if (Number.isFinite(n)) out.feedIsolatedPrId = n;
  }
  // The two Activity sub-tab strips. ⚠ THE RAW CHOICE IS SEATED HERE, never a corrected one:
  // both consumers DERIVE a visible tab from the capabilities they can see (BotsView's
  // `effectiveTab`, ActivityView's `effectiveFeedTab`), and writing a correction back would
  // permanently forget a choice the moment a capability blinked.
  const feedTab = p.get('feedTab');
  if (feedTab === 'themes' || feedTab === 'feed') out.feedInnerTab = feedTab;
  const botsTab = p.get('botsTab');
  if (botsTab === 'roi' || botsTab === 'advisor' || botsTab === 'settings') {
    out.botsInnerTab = botsTab;
  }
  // PrDetail's inner tab, and it is only meaningful PAIRED with the PR tab `view=` names — the
  // store field is a {prId, tab} pair precisely so one PR's tab cannot be read on another's
  // screen. A `?prTab=` with no PR view (or on a `pr-focus`, which renders a timeline) seats
  // nothing rather than arming a pair for a PR nobody is looking at.
  const prTab = p.get('prTab');
  if (prTab && (PR_DETAIL_TABS as readonly string[]).includes(prTab)) {
    const viewed = parseTabKey(p.get('view') ?? '');
    if (viewed?.kind === 'pr-detail') {
      out.prDetailTab = { prId: viewed.prId, tab: prTab as PrDetailTab };
    }
  }

  // Reports deep link: `?report=<periodKey>` names the period being read. Paired with
  // `?activityRepo=insights` above — either alone is a half-link, which is why they landed together.
  // (This used to also seed the Insights SUB-TAB; that apparatus is gone — the pane is
  // Reports-first now, so the console + the period key ARE the whole link.)
  const report = p.get('report');
  if (report) {
    out.insightsReportKey = report;
  }

  return out;
}

// ── Three module-level flags, deliberately NOT store fields: each describes how a write REACHED
// the app (or how the next one should reach the browser), not anything the app renders.
//
// `replaceNextWrite` — armed by `markUrlCorrection()` (below) for a write that is a CORRECTION
// rather than a navigation. `applyingUrl` — true while the URL is being applied TO the stores, so
// the subscriptions do not turn a pop into a fresh history entry. `restoredScopeWorkspaceId` —
// see `consumeRestoredWorkspaceScope`.
let replaceNextWrite = false;
let applyingUrl = false;
let restoredScopeWorkspaceId: number | null = null;

/**
 * "This workspace id arrived FROM THE ADDRESS BAR, and it brought its own `?repos=` with it."
 *
 * ⚠ THE BUG THIS EXISTS FOR: a Back across a workspace switch used to lose `repoIds`, and only
 * `repoIds`. The pop seats the popped URL's narrowing correctly, and then `useWorkspaceSync` sees
 * the workspace id differ from its ref, reads that as "the user switched workspace" and re-derives
 * — `setWorkspace(id, null)` — widening the board straight back to the whole workspace. Every other
 * key in the bundle (`workspace`, `activityRepo`, `attn`, `feedPr`) round-tripped; the reader
 * watched Back restore the view and then un-narrow it a tick later.
 *
 * A CHANGE OF WORKSPACE IS NOT ALWAYS A SWITCH, and the two need telling apart at the one place
 * that acts on the difference. So `applyUrlToStores` arms this marker — SYNCHRONOUSLY, inside the
 * same call that hydrates the stores — whenever the applied URL named BOTH a workspace and a repo
 * narrowing, and `useWorkspaceSync` consumes it in its "changed" branch to take the PRUNE path
 * instead of the REPLACE one.
 *
 * ⚠ It is KEYED ON THE WORKSPACE ID and ONE-SHOT, both to stop it leaking onto a later, genuine
 * switch: a caller asking about a different workspace gets `false` and the marker stays put for the
 * workspace it actually describes, and the first matching read clears it. Every subsequent
 * `applyUrlToStores` re-arms it from scratch (to null when that URL carries no narrowing), so a
 * marker no effect ever consumed dies at the next pop rather than lingering for the session.
 *
 * Exported for `useWorkspaceSync` (components/WorkspaceSelector.tsx) and its unit test.
 */
export function consumeRestoredWorkspaceScope(workspaceId: number): boolean {
  if (restoredScopeWorkspaceId !== workspaceId) return false;
  restoredScopeWorkspaceId = null;
  return true;
}

/**
 * "The next store write is a CORRECTION, not a navigation — REPLACE the history entry."
 *
 * For the one shape of write that changes a navigation key without the user having navigated:
 * the deep-link effects that seat a tab as a view OPENS (PrDetail forcing Threads because the
 * feed row that opened it named a thread). Those fire one tick after the open that already
 * pushed, so without this the reader's first Back lands on the same PR at Overview — an entry
 * nobody asked for, between them and the feed they came from.
 *
 * Consumed by the very next `writeToUrl`, whether or not it changes anything.
 */
export function markUrlCorrection(): void {
  replaceNextWrite = true;
}

// ── ONE URL WRITE PER GESTURE ────────────────────────────────────────────────────────────────
//
// ⚠ THE SERIALIZER MUST NOT RUN PER STORE WRITE, now that a navigation-key change PUSHES. One
// user gesture is routinely several store writes: the Welcome-back banner's line is
// `setWorkspace` → `showActivity` → `setActivityRepo` → `setAttentionIsolation`, each of which
// moves a different navigation key. Written straight through, that single click would stack FOUR
// history entries and the reader would need four Backs to leave the board they just opened —
// which is the same "Back doesn't work" complaint from the other direction.
//
// Coalescing into a MICROTASK fixes it structurally: every store write inside one handler lands
// before the flush, so the URL is computed once, from the final state, and the diff sees the
// whole gesture. (It also stops the un-debounced subscription from serializing on transient
// signal bumps.) Effects that run in a LATER task are genuinely separate writes — that is what
// `markUrlCorrection` is for.
let writeScheduled = false;
function scheduleUrlWrite(): void {
  // ⚠ Checked HERE, synchronously, not inside the microtask: `applyingUrl` is already false by
  // the time a queued callback runs, so a pop's own store notification would sail through and
  // re-write (or re-push) the URL the user just went back to.
  if (applyingUrl || writeScheduled) return;
  writeScheduled = true;
  queueMicrotask(() => {
    writeScheduled = false;
    writeToUrl(useFilters.getState());
  });
}

/** Exported for its unit test only — see test/feedCiFailuresToggle.test.ts. */
export function writeToUrl(s: FilterState): void {
  const p = new URLSearchParams();
  if (s.preset !== '14d') p.set('preset', s.preset);
  if (s.repoIds?.length) p.set('repos', s.repoIds.join(','));
  // The active WORKSPACE — emitted ALWAYS once resolved, never diffed against a default. There
  // is no static default to diff against: the account's Default workspace id varies per account,
  // so omitting "the default" would produce a link that means a different scope for the
  // recipient. It is omitted ONLY while unresolved (null) — writeToUrl runs from the store
  // subscription, which fires on the very first hydrate, so an unconditional set() would write
  // the literal string `?workspace=null` on every bare load.
  // (The legacy `?team=` param is never written; it is still READ once, see readWorkspaceFromUrl.)
  if (s.workspaceId != null) p.set('workspace', String(s.workspaceId));
  if (s.userIds?.length) p.set('users', s.userIds.join(','));
  // Hidden is the default; only encode the non-default "show bots" choice (bots=0) — the
  // excludeStale pattern. Old bots=1 links still parse to the same (now default) state.
  if (!s.excludeBots) p.set('bots', '0');
  // The allow-list only bites under excludeBots — the DEFAULT now — so encode it whenever
  // non-empty: an allow-list picked while bots are shown must survive a reload into the
  // hidden default rather than silently vanishing with the `bots=0` param.
  if (s.allowedBotIds.length) p.set('allowBots', s.allowedBotIds.join(','));
  // Hidden is the default; only encode the non-default "show stale" choice (stale=0).
  if (!s.excludeStale) p.set('stale', '0');
  // 'off' is the default; encode only the two non-default lenses. It is a FilterDefaults key,
  // so — like every other one — it has to round-trip through the URL to survive a reload: this
  // subscription makes the address bar non-bare immediately, and the localStorage restore path
  // only runs on a BARE url. ⚠ The OMITTED value must always be the CURRENT default: when the
  // default flipped, leaving `ci=0` as the emitted one would have written the default onto every
  // URL while the newly non-default 'feed' vanished — i.e. the one state that now needs
  // serializing would be the one state that never survived a reload.
  if (s.feedCiLens === 'only') p.set('ci', 'only');
  else if (s.feedCiLens === 'feed') p.set('ci', '1');
  if (s.preset === 'custom' && s.customFrom) p.set('from', s.customFrom);
  if (s.preset === 'custom' && s.customTo) p.set('to', s.customTo);
  // Serialize the category selection whenever it differs from the fresh-load
  // default (commits hidden). This keeps the URL clean for the common case yet
  // lets a non-default choice — including "all categories incl. commits" —
  // survive a reload, which a plain `length < ALL` check could not encode.
  if (!sameSet(s.categories, DEFAULT_CATEGORIES)) p.set('cats', s.categories.join(','));
  // Same default-diff approach as categories: encode any non-default status
  // selection (incl. empty = none, and "all incl. closed") so it survives reload.
  if (!sameSet(s.prStatuses, DEFAULT_PR_STATUSES)) p.set('status', s.prStatuses.join(','));
  // Encode any non-default review-verdict selection (incl. empty = no review markers)
  // so it survives a reload; the common "all verdicts" case stays out of the URL.
  if (!sameSet(s.reviewStates, DEFAULT_REVIEW_STATES)) p.set('reviews', s.reviewStates.join(','));
  if (s.derivedStates.length) p.set('states', s.derivedStates.join(','));
  // myTurnOnly (My Turn Focus Mode) is transient — intentionally not serialized.
  if (s.selectedPrId) p.set('pr', String(s.selectedPrId));
  if (s.selectedThreadId) p.set('thread', String(s.selectedThreadId));

  // The active BOARD (the only tabs that are URL-deep-linkable; pinned-PR tabs stay
  // localStorage-only). Read the active tab from the pinnedTabs store — a different
  // store than this subscriber's, so useUrlState also subscribes to it. `activityRepo`
  // is emitted only for a single-repo console (the 'all' feed is the default).
  //
  // ⚠ BOTH boards are emitted AFFIRMATIVELY, and the timeline half is not optional. Silence
  // now MEANS Activity (`landingTabFromUrl`), so leaving the board implicit would bounce a
  // user who deliberately switched to the timeline straight back to Activity on the next F5 —
  // the write half and the read half of a URL rule always move together.
  const activeTab = usePinnedTabs.getState().activeTab;
  if (activeTab === 'timeline') {
    p.set('view', 'timeline');
  } else if (activeTab === 'activity') {
    p.set('view', 'activity');
    // The board's own narrowings, each emitted ONLY on the rail entry that renders it — a lens
    // that is not on screen is not part of the view, and a `?feedTab=` riding along on the
    // attention board would be inert noise in every link the app produces.
    if (s.activityRepoId === 'attention' && s.attentionIsolation) {
      p.set('attn', s.attentionIsolation);
    }
    // Emitted independently of `attn` — the two lenses are orthogonal, and a relevance-lensed
    // board showing every kind is a real (if uncommon) view. Same rail gate as its twin: a lens
    // that is not on screen is not part of the view.
    // ⚠ ONLY `attnRel` IS EMITTED. The retired `?attnPersonal=1` is read-only back-compat (see
    // readFromUrl) — writing both would double-encode one lens and leave two keys to keep in step.
    if (s.activityRepoId === 'attention' && s.attentionRelevance != null) {
      p.set('attnRel', s.attentionRelevance);
    }
    if (
      s.feedIsolatedPrId != null &&
      (s.activityRepoId === 'feed' || typeof s.activityRepoId === 'number')
    ) {
      p.set('feedPr', String(s.feedIsolatedPrId));
    }
    if (s.activityRepoId === 'feed' && s.feedInnerTab !== 'feed') {
      p.set('feedTab', s.feedInnerTab);
    }
    if (s.activityRepoId === 'bots' && s.botsInnerTab !== 'roi') {
      p.set('botsTab', s.botsInnerTab);
    }
    // A single-repo console and the CORE Bots / **Pending** consoles are deep-linkable,
    // and so is 'insights' — it is a landing default AND a real destination, and omitting it
    // made the period report's `?report=` link land on the Feed.
    // Only 'feed' stays out of the URL now, because it is the bare state a link means when it
    // says nothing. Emitting a value the read side does not parse would be write-only, so the
    // two halves must always be changed together.
    // (The 'retro' pseudo-row is gone with the Retro panel; the 'compare' pseudo-row is gone
    // with the Compare rail entry — its surface is Reports' "By workspace" axis, reachable via
    // `?activityRepo=insights&report=…`.)
    if (typeof s.activityRepoId === 'number') {
      p.set('activityRepo', String(s.activityRepoId));
    } else if (s.activityRepoId === 'bots') {
      p.set('activityRepo', 'bots');
    } else if (s.activityRepoId === 'attention') {
      p.set('activityRepo', 'attention');
    } else if (s.activityRepoId === 'insights') {
      p.set('activityRepo', 'insights');
      // The period being read, emitted ONLY alongside the console that renders it — a bare
      // `?report=` on the Feed would be inert noise in every link the app produces.
      if (s.insightsReportKey) p.set('report', s.insightsReportKey);
    }
  } else if (
    parseTabKey(activeTab) != null ||
    parseUserActivityKey(activeTab) != null ||
    parseBotDetailKey(activeTab) != null
  ) {
    // A SELF-DESCRIBING tab: the key IS the address (see landingTabFromUrl). Emitted verbatim so
    // a PR read full-screen, a contributor's feed and a bot's depth each have their own URL —
    // which is what makes Back out of them (and a refresh back INTO them) work at all.
    p.set('view', activeTab);
    const viewedPr = parseTabKey(activeTab);
    // PrDetail's inner tab, only for the PR actually on screen and only when it is not the
    // 'overview' default — the diff-against-defaults rule every other key follows.
    if (
      viewedPr?.kind === 'pr-detail' &&
      s.prDetailTab != null &&
      s.prDetailTab.prId === viewedPr.prId &&
      s.prDetailTab.tab !== 'overview'
    ) {
      p.set('prTab', s.prDetailTab.tab);
    }
  }
  // Every remaining `activeTab` is a SEED-BACKED drill-down — the ML-strip flagging list, the
  // People report, a search — whose identity lives in an in-memory seed that is deliberately
  // never persisted (a restored one could name a tile the strip no longer shows). So `view` is
  // omitted, which is itself a distinct URL, and both a refresh and a Forward onto it resolve to
  // Activity rather than to a broken drill-down. The tab is still in the tab bar; it just isn't
  // what the app opens onto.

  const qs = p.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  // ⚠ CONSUMED FIRST, unconditionally — a marker left armed by a write that changed nothing would
  // silently swallow the NEXT real navigation's history entry.
  const correction = replaceNextWrite;
  replaceNextWrite = false;
  if (next === window.location.pathname + window.location.search) return;

  const prev = new URLSearchParams(window.location.search);
  const changedNav = NAV_KEYS.some((k) => prev.get(k) !== p.get(k));
  // ⚠ THE FIRST WORKSPACE RESOLUTION IS NOT A NAVIGATION — `useWorkspaceSync` writes the account's
  // Default within ~1s of every load, stamping BOTH `workspace` and `view` onto a bare URL, and
  // pushing that would burn the user's first Back on an entry they never navigated to. But it is
  // NOT DETECTABLE HERE, and it used to be spelled as one: `prev` names no `workspace` and `p`
  // does. That tests the URL's SHAPE, not "this is the first resolution", and it is wrong in both
  // directions. It is FALSE during the resolution window (a navigation made before
  // `/api/workspaces` lands emits no `workspace` either, so that one already pushed correctly),
  // and it stays TRUE forever afterwards for any entry minted before the scope resolved: a Back
  // onto such an entry deliberately KEEPS the live `workspaceId` (see `applyUrlToStores`), so the
  // reader's next genuine navigation stamps `workspace` onto a workspace-less `prev`, was swallowed
  // as a "first resolve" — and their following Back left the SPA.
  //
  // So the escape hatch belongs to the WRITER, which is the only place that knows: the fallback
  // branch of `syncWorkspaceScope` (components/WorkspaceSelector.tsx) is the sole path that
  // resolves an unresolved-or-dead workspace, and it calls `markUrlCorrection()` itself — as does
  // the mount reconcile in `useUrlState` below. One shape of write, marked at its source.
  if (changedNav && !correction) {
    try {
      window.history.pushState(null, '', next);
      return;
    } catch {
      /* Safari rate-limits pushState (~100/30s) and THROWS; the address bar still has to be
         right, so fall through to a replace rather than losing the URL entirely. */
    }
  }
  window.history.replaceState(null, '', next);
}

// Persist the filter-bar state across tabs/reloads. The URL stays the SHAREABLE
// source of truth: when it carries any query string (a shared deep link, or a
// duplicated tab — which copies the URL), it wins and localStorage is ignored, so
// sharing semantics are untouched. localStorage only fills the gap the URL can't:
// opening a *bare* /app (a fresh tab / bookmark, no params) restores the filters
// you last used instead of snapping back to hard defaults.
const FILTER_STORAGE_KEY = 'pierre:filterBarState';

// The persisted-shape VERSION. Bump it when a stored blob's meaning changes. A version with
// no entry in `migratePersistedFilters` below is DISCARDED WHOLESALE rather than
// half-migrated; a version with one carries forward.
//
// v2 = the workspace refactor, and both halves of the reason matter:
//  • `teamScope` ('all' | 'none' | 'teams' | 'teams:1,2' | a bare team id) has no image in
//    `workspaceId`. Three of the five shapes span sets a single workspace cannot express, and
//    the fourth — a bare number — is the DANGEROUS one: team ids were preserved through the
//    migration, so it would parse as a perfectly plausible workspace id and silently select a
//    workspace whose repo membership is NOT that team's. (sanitizePersistedFilters already
//    drops the key by whitelist; this makes the discard explicit and total.)
//  • `repoIds` in a v1 blob names repos chosen under a team scope, and those repos may now sit
//    in a different workspace entirely. On the URL path a stale id is merely pruned against the
//    resolved membership; here there is no scope to correlate it with, so the honest move is to
//    drop the blob and start from defaults.
// The cost of THAT bump was one reset of the remembered filter bar, once, per user — right for
// v1→v2, where the stored shape had no forward interpretation.
//
// v3 = bots hidden by default. The only change is the `excludeBots` default flipping, so a v2
// blob is still perfectly meaningful — discarding a user's whole remembered filter bar (repos,
// range, statuses) to re-assert one default would be theft. Hence the per-version migration.
//
// v4 = CI failures out of the feed by default (`feedCiLens` 'feed' → 'off'), and the bump is
// REQUIRED rather than cosmetic: `pickFilterBarState` persists the key UNCONDITIONALLY, so every
// blob written under the old default holds a literal 'feed' that no one chose. Without a
// migration the new default would reach new installs only, and every existing user would keep
// the noisy feed forever — the exact failure the v2→v3 note describes, in the other direction.
//
// ⚠ NO BUMP IS OWED for the history work that made `attn` / `feedPr` / `feedTab` / `botsTab` /
// `prTab` URL-visible: not one of them is PERSISTED. This blob's version tracks the meaning of
// what is STORED, and those keys are transient view state that dies with the tab — the version
// moves only when a stored key's meaning changes, or when a default flips on a key
// `pickFilterBarState` writes unconditionally.
const FILTER_STORAGE_VERSION = 4;

// Per-version migrations for the persisted filter blob, applied in loadPersistedFilters before
// the version check (so a migrated blob passes it). Exported for its unit test only.
//
// v2 → v3: drop EXACTLY the two bot keys — `excludeBots` (so every user gets the new
// hidden-by-default baseline once, instead of a persisted `false` pinning the old default
// forever) and `allowedBotIds` (an allow-list picked when excluding was a deliberate opt-in
// choice doesn't carry the same intent into a world where excluding is ambient). Everything
// else carries forward untouched.
//
// v3 → v4: drop EXACTLY `feedCiLens`, for the same reason in the other direction — the key is
// persisted unconditionally, so a stored 'feed' is overwhelmingly the OLD DEFAULT rather than a
// choice, and keeping it would pin the noisy feed for every existing user. A deliberate 'only'
// is lost with it; that is the accepted cost of a default flip on a key whose stored value
// cannot be told apart from the default that produced it. (Note the pill's own state is what
// makes this recoverable in one click.)
//
// ⚠ The steps CHAIN — a v2 blob must land at v4, so this walks them in order rather than
// returning early on a single version. An `if (parsed.v !== N) return parsed` per step would
// carry a v2 blob no further than v3, where the version check below then discards it WHOLE.
export function migratePersistedFilters(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  let out = parsed;
  if (out.v === 2) {
    const { excludeBots: _excludeBots, allowedBotIds: _allowedBotIds, ...rest } = out;
    out = { ...rest, v: 3 };
  }
  if (out.v === 3) {
    const { feedCiLens: _feedCiLens, ...rest } = out;
    out = { ...rest, v: 4 };
  }
  return out;
}

// The SCOPE slice, persisted separately (see filters.ts `pickScopeState`): the active workspace
// is the context filters apply inside, not a filter. Sharing the filter blob would make "Clear
// filters" reset the workspace; sharing the key would let one legacy blob poison both. It is a
// NEW key, so no pre-workspace value can exist under it — the legacy scope only ever lived
// inside the filter blob, under a different name, and there is no path from there to here.
const SCOPE_STORAGE_KEY = 'pierre:workspaceScope';
const SCOPE_STORAGE_VERSION = 1;

function loadPersistedFilters(): Partial<FilterState> | null {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // Migrate a blob a per-version step CAN carry forward (v2 → v3); anything else from an
    // older shape is dropped, not interpreted (see FILTER_STORAGE_VERSION), and removed so it
    // can never be read again by a build that lost this guard.
    const migrated = migratePersistedFilters(parsed as Record<string, unknown>);
    if (migrated.v !== FILTER_STORAGE_VERSION) {
      localStorage.removeItem(FILTER_STORAGE_KEY);
      return null;
    }
    // Sanitize: keep only known persisted filter keys — this also drops the version marker
    // itself, a legacy persisted `myTurnOnly` (now a transient focus mode, which would
    // otherwise force My Turn Focus Mode on a fresh load), and any legacy `teamScope`.
    return sanitizePersistedFilters(migrated as Partial<FilterState>);
  } catch {
    return null;
  }
}

function persistFilters(s: FilterState): void {
  try {
    localStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify({ v: FILTER_STORAGE_VERSION, ...pickFilterBarState(s) }),
    );
  } catch {
    /* quota / private-mode — non-fatal, filters just won't persist */
  }
}

function loadPersistedScope(): number | null {
  try {
    const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as { v?: unknown }).v !== SCOPE_STORAGE_VERSION) {
      localStorage.removeItem(SCOPE_STORAGE_KEY);
      return null;
    }
    return sanitizePersistedScope(parsed).workspaceId ?? null;
  } catch {
    return null;
  }
}

function persistScope(s: FilterState): void {
  // ⚠ NEVER write a null over a good value. The subscription fires on the very first hydrate,
  // when the workspace is still unresolved — persisting that would erase the user's remembered
  // workspace before the sync effect ever resolves one, and every future bare load would land
  // on Default.
  if (s.workspaceId == null) return;
  try {
    localStorage.setItem(
      SCOPE_STORAGE_KEY,
      JSON.stringify({ v: SCOPE_STORAGE_VERSION, ...pickScopeState(s) }),
    );
  } catch {
    /* quota / private-mode — non-fatal, the scope just won't be remembered */
  }
}

/**
 * APPLY THE ADDRESS BAR TO THE STORES — the read half of Back/Forward.
 *
 * ⚠ TOTAL, not partial. `readFromUrl` is partial by design (an absent param sets nothing), which
 * is right on a cold load — the store starts at defaults — and WRONG here: popping off a narrowed
 * attention board onto a URL that says nothing about `attn` would leave the narrowing standing,
 * and the reader would watch Back change the address bar without changing the screen. So every
 * key the URL OWNS is reset to its default first, and the patch is laid over it.
 *
 * ⚠ …but only those keys. Never `freshDefaults()`: that would also wipe `sprintChatThreads`,
 * `syncRound`, `repoConsoleTabs` and every drill-down seed — transient state the URL never
 * serialized, so a "reset" of it is pure loss.
 *
 * ⚠ `workspaceId` survives a URL that names none. `null` does not mean "no workspace", it means
 * "not resolved yet": it blanks every workspace-scoped surface and re-triggers `useWorkspaceSync`
 * into resolving Default — a silent context switch on a Back.
 *
 * `fromPop` reaches `applyUrlTab`, which promotes the pending feed return-item into the one-shot
 * flash ONLY on a real Back (never on the initial load, and never on an ordinary return to
 * Activity via its tab chip).
 *
 * ⚠ THE SCOPE THE URL RESTORED IS ANNOUNCED, not just hydrated. Seating `?repos=` is only half of
 * restoring it: `useWorkspaceSync` runs a tick later, sees a workspace id it did not expect and
 * would widen the board back to the whole workspace. Arming `restoredScopeWorkspaceId` here — in
 * the same synchronous call, from the SAME patch that was applied — is what lets that effect tell
 * "the URL restored a workspace that came with its own repoIds" from "the user switched workspace".
 * See `consumeRestoredWorkspaceScope`.
 *
 * Exported for its unit test — see test/urlHistory.test.ts.
 */
export function applyUrlToStores(opts?: { fromPop?: boolean }): void {
  applyingUrl = true;
  try {
    const patch = readFromUrl();
    const liveWorkspaceId = useFilters.getState().workspaceId;
    // Re-armed from scratch on EVERY apply, null included: a marker is a statement about the URL
    // just applied, so a URL naming no narrowing must clear one left by an earlier pop.
    // (`readFromUrl` already discards `?repos=` when the URL resolved no workspace, so a narrowing
    // present here always belongs to the workspace named alongside it.)
    restoredScopeWorkspaceId =
      patch.workspaceId != null && patch.repoIds != null ? patch.workspaceId : null;
    useFilters.getState().hydrate({
      ...freshFilterDefaults(),
      ...freshUrlOwnedDefaults(),
      ...(patch.workspaceId == null && liveWorkspaceId != null
        ? { workspaceId: liveWorkspaceId }
        : {}),
      ...patch,
    });
    usePinnedTabs.getState().applyUrlTab(landingTabFromUrl(window.location.search), opts);
    // ⚠ RECONCILE THE ADDRESS BAR NOW, exactly as the cold load does (see `useUrlState` below),
    // and for the same reason: after this call the stores hold the CANONICAL reading of the popped
    // URL, which is not always the popped URL itself. A seed-backed drill-down entry emits no
    // `view=` at all (its identity lives in an in-memory seed), and it drops `activityRepo` with
    // it — both are emitted only inside the `activeTab === 'activity'` branch of `writeToUrl` — so
    // popping onto one leaves the store saying `activity` while the address bar says nothing. The
    // next PURE REFINEMENT (a preset, a status pill) then diffs `view` absent → `view=activity`,
    // is read as a NAVIGATION, and PUSHES: the reader's Forward stack is destroyed and a filter
    // click becomes a history entry — the per-click undo stack NAV_KEYS exists to prevent. A
    // legacy `?team=<int>` lands the same way (read as `workspace`, written back as one).
    //
    // Doing it here, eagerly and as a REPLACE, means every later diff is measured against what the
    // app is actually showing. It can only ever rewrite the CURRENT entry, so the forward stack is
    // untouched; a URL that already agrees with the stores costs nothing (`writeToUrl` string-
    // compares and returns).
    markUrlCorrection();
    writeToUrl(useFilters.getState());
  } finally {
    // Both stores notify SYNCHRONOUSLY inside set(), so the flag is already back to false by the
    // time anything else can run — no timer, no ref-in-effect.
    applyingUrl = false;
  }
}

/** Two-way sync between the filter store and the URL query string + localStorage. */
export function useUrlState(): void {
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current) {
      // URL present (?…) → authoritative (shared link / duplicated tab). Bare URL →
      // restore the last ACTIVE saved view by name if there was one (Part 1: the user's
      // explicit "remember my view"), otherwise the generic last-used filter bar blob.
      // Both resolve to the same pickFilterBarState shape, so hydrate handles either.
      const hasUrlParams = window.location.search.length > 1;
      if (hasUrlParams) {
        useFilters.getState().hydrate(readFromUrl());
      } else {
        const persisted = loadPersistedFilters();
        if (persisted) useFilters.getState().hydrate(persisted);
        // The remembered WORKSPACE, restored only on a bare load — a URL WITH params is a deep
        // link whose scope is whatever it names, and §6.2's rule for one that names none is to
        // resolve the account's Default rather than quietly reinterpret it in this browser's
        // last context. Still only a hint: the sync effect corrects an id naming no live
        // workspace, and prunes repoIds to the resolved membership before any query runs.
        const workspaceId = loadPersistedScope();
        if (workspaceId != null) useFilters.getState().hydrate({ workspaceId });
      }
      // ── The BOARD decision — ONE rule, evaluated on EVERY load ─────────────────────────────
      // Deliberately OUTSIDE the branch above, and deliberately not sharing its boolean. That
      // branch answers "where do the FILTERS and the scope come from?" — the URL or
      // localStorage — for which `hasUrlParams` is exactly right, and its behaviour here is
      // unchanged. It is the WRONG test for "which board?", and one boolean answering both
      // questions was the bug: the app stamps `?workspace=<id>` onto its own address bar within
      // ~1s of every load, so the URL is non-bare on effectively every refresh and the
      // Activity branch was reachable only on the very first paint of a truly bare `/app`.
      // Refreshing from a PR tab or a drill-down — neither of which emits `view=` — therefore
      // fell through to the store's unpersisted `activeTab: 'timeline'` default.
      //
      // Placed BEFORE the two subscriptions below on purpose: this write must not itself
      // re-enter the serializer. See `landingTabFromUrl` for the rule it applies. (Unconditional
      // is safe — `activeTab` is never persisted, so a fresh load always starts at the store
      // default and there is no user choice here to overwrite.)
      // `applyUrlTab`, not `setActiveTab`: a `view=` naming a PR / contributor / bot tab this
      // browser has never seen must RE-CREATE it (a shared link, a cleared `pierre:tabs`), or
      // every such link silently redirects to the front door. No `fromPop` — the Back-flash is
      // for a real Back, and a fresh load has nothing pending anyway.
      usePinnedTabs.getState().applyUrlTab(landingTabFromUrl(window.location.search));
      // ⚠ RECONCILE THE ADDRESS BAR NOW, and as a REPLACE. A URL carrying `?workspace=5` and no
      // `view=` (a pre-`view` link, a refresh from a seed-backed drill-down) would otherwise gain
      // `view=activity` on whatever store write happens FIRST — and if that write is the user's
      // first navigation, the diff blames it for a key the load introduced and pushes an entry for
      // a screen nobody navigated to. Doing it here, eagerly, means every later diff is measured
      // against what the app is actually showing. (Marking it a correction is what makes this one
      // a replace; the marker is consumed by this very call, so it can never leak onto a later
      // write.)
      markUrlCorrection();
      writeToUrl(useFilters.getState());
      hydrated.current = true;
    }
    // Reflect every subsequent change back into the URL and localStorage.
    //
    // ⚠ The URL write is SKIPPED while a pop is being applied. Rehydrating the stores from the
    // popped URL notifies these subscriptions synchronously, and re-serializing there would write
    // the URL we just read — at best a duplicate entry, at worst (with the push rule) a new one
    // on top of the entry the user just went back to, so Back would never get anywhere. The
    // localStorage halves still run: the popped state is a real state, and remembering it is
    // right. `writeToUrl`'s string compare is the second line of defence, not the first.
    const unsub = useFilters.subscribe((s) => {
      scheduleUrlWrite();
      persistFilters(s);
      persistScope(s);
    });
    // The active tab (timeline / activity / a pinned PR) lives in a separate store, so
    // mirror its changes into the URL too — switching to/from the Activity tab toggles
    // `?view=activity`. Reads the current filter state for the rest of the query string.
    const unsubTabs = usePinnedTabs.subscribe(() => {
      scheduleUrlWrite();
    });
    // THE ONE popstate handler in the app. It re-reads the address bar and applies it to both
    // stores — the browser's entry is the source of truth, so Back and Forward are symmetric.
    // (It replaced a handler that read only store flags and never looked at the URL, which is
    // why Forward used to change the address bar while leaving the screen where it was.)
    const onPop = (): void => applyUrlToStores({ fromPop: true });
    window.addEventListener('popstate', onPop);
    return () => {
      unsub();
      unsubTabs();
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
