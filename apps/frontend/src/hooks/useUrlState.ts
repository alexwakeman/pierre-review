import { useEffect, useRef } from 'react';
import {
  ALL_CATEGORIES,
  ALL_PR_STATUSES,
  ALL_REVIEW_STATES,
  DEFAULT_CATEGORIES,
  DEFAULT_PR_STATUSES,
  DEFAULT_REVIEW_STATES,
  pickFilterBarState,
  pickScopeState,
  sanitizePersistedFilters,
  sanitizePersistedScope,
  useFilters,
  type FilterState,
  type RangePreset,
} from '../store/filters.js';
import {
  DERIVED_STATES,
  type DerivedState,
  type EventCategory,
  type PrStatus,
  type ReviewState,
} from '@pierre-review/shared';
import { usePinnedTabs } from '../store/pinnedTabs.js';

const PRESETS: RangePreset[] = ['7d', '14d', '30d', '90d', 'custom'];

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

  // Activity deep link: `?activityRepo=<id>` selects that repo's console (the active TAB
  // itself — `?view=activity` — lives in the pinnedTabs store and is applied separately
  // in useUrlState). `activityThreadFilter` is intentionally URL-silent.
  const activityRepo = p.get('activityRepo');
  if (activityRepo) {
    if (activityRepo === 'bots') out.activityRepoId = 'bots';
    else if (activityRepo === 'attention') out.activityRepoId = 'attention';
    // The cross-WORKSPACE comparison rail entry. Deep-linkable like the other pseudo-rows; the
    // rail GATES it on the account having 2+ workspaces and falls back to 'feed' for the render
    // without writing a correction back (a corrective set() permanently forgets the choice).
    else if (activityRepo === 'compare') out.activityRepoId = 'compare';
    else {
      const n = Number.parseInt(activityRepo, 10);
      if (Number.isFinite(n)) out.activityRepoId = n;
    }
  }

  return out;
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

  // Activity tab (the only overlay tab that's URL-deep-linkable; pinned-PR tabs stay
  // localStorage-only). Read the active tab from the pinnedTabs store — a different
  // store than this subscriber's, so useUrlState also subscribes to it. `activityRepo`
  // is emitted only for a single-repo console (the 'all' feed is the default).
  if (usePinnedTabs.getState().activeTab === 'activity') {
    p.set('view', 'activity');
    // A single-repo console, the CORE Bots console, the CORE "Needs attention" console and the
    // CORE cross-workspace "Compare" console are deep-linkable; the 'feed' / 'insights'
    // pseudo-rows are landing defaults and deliberately stay out of the URL (they are not
    // parsed on the read side either, so emitting them would be write-only).
    // (The 'retro' pseudo-row is gone with the Retro panel; it was never parsed on the read side
    // either, so no legacy `?activityRepo=retro` link ever selected it.)
    if (typeof s.activityRepoId === 'number') {
      p.set('activityRepo', String(s.activityRepoId));
    } else if (s.activityRepoId === 'bots') {
      p.set('activityRepo', 'bots');
    } else if (s.activityRepoId === 'attention') {
      p.set('activityRepo', 'attention');
    } else if (s.activityRepoId === 'compare') {
      p.set('activityRepo', 'compare');
    }
  }

  const qs = p.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState(null, '', next);
  }
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
        // The active tab lives in the pinnedTabs store, so apply `?view=activity` here
        // (after the filter hydrate that carries `?activityRepo`).
        if (new URLSearchParams(window.location.search).get('view') === 'activity') {
          usePinnedTabs.getState().setActiveTab('activity');
        }
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
        // Activity-first: a bare load (a fresh sign-in / "open the app") lands on the
        // Activity — the relevance-ranked state of play — with the timeline secondary.
        // (A URL WITH params is a deep link: it keeps timeline unless `?view=activity`.)
        usePinnedTabs.getState().setActiveTab('activity');
      }
      hydrated.current = true;
    }
    // Reflect every subsequent change back into the URL and localStorage.
    const unsub = useFilters.subscribe((s) => {
      writeToUrl(s);
      persistFilters(s);
      persistScope(s);
    });
    // The active tab (timeline / inbox / pinned PR) lives in a separate store, so
    // mirror its changes into the URL too — switching to/from the Activity tab toggles
    // `?view=activity`. Reads the current filter state for the rest of the query string.
    const unsubTabs = usePinnedTabs.subscribe(() => {
      writeToUrl(useFilters.getState());
    });
    return () => {
      unsub();
      unsubTabs();
    };
  }, []);
}
