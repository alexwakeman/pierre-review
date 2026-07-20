import { useEffect, useRef } from 'react';
import {
  ALL_CATEGORIES,
  ALL_PR_STATUSES,
  ALL_REVIEW_STATES,
  DEFAULT_CATEGORIES,
  DEFAULT_PR_STATUSES,
  DEFAULT_REVIEW_STATES,
  pickFilterBarState,
  sanitizePersistedFilters,
  scopeToParam,
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

function readFromUrl(): Partial<FilterState> {
  const p = new URLSearchParams(window.location.search);
  const out: Partial<FilterState> = {};

  const preset = p.get('preset');
  if (preset && PRESETS.includes(preset as RangePreset)) {
    out.preset = preset as RangePreset;
  }
  out.repoIds = parseIds(p.get('repos'));
  out.userIds = parseIds(p.get('users'));
  // Team scope: 'all' (default, omitted) | 'teams' | 'none' | '<teamId>'. We only have the raw
  // scope on read — set teamScope and leave the repoIds derivation to a component effect (once
  // the teams list has loaded). An unparseable value falls back to the default 'all'.
  const team = p.get('team');
  if (team === 'none') out.teamScope = 'none';
  else if (team === 'teams') out.teamScope = 'teams';
  else if (team === 'all') out.teamScope = 'all';
  else if (team != null) {
    const n = Number.parseInt(team, 10);
    if (Number.isFinite(n)) out.teamScope = n;
  }
  // Bots are SHOWN by default now, so a clean URL means "shown". Only an explicit
  // `bots=1` turns the exclude-bots filter ON (a legacy `bots=0` correctly resolves
  // to off, matching the new default).
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
    else {
      const n = Number.parseInt(activityRepo, 10);
      if (Number.isFinite(n)) out.activityRepoId = n;
    }
  }

  return out;
}

function writeToUrl(s: FilterState): void {
  const p = new URLSearchParams();
  if (s.preset !== '14d') p.set('preset', s.preset);
  if (s.repoIds?.length) p.set('repos', s.repoIds.join(','));
  // Team scope: emit only the non-default ('all') selection so a clean URL stays clean.
  if (s.teamScope !== 'all') p.set('team', scopeToParam(s.teamScope));
  if (s.userIds?.length) p.set('users', s.userIds.join(','));
  // Shown is the default; only encode the non-default "exclude bots" choice (bots=1).
  if (s.excludeBots) p.set('bots', '1');
  // Only meaningful under excludeBots; encode the allow-list so it survives a reload.
  if (s.excludeBots && s.allowedBotIds.length) p.set('allowBots', s.allowedBotIds.join(','));
  // Hidden is the default; only encode the non-default "show stale" choice (stale=0).
  if (!s.excludeStale) p.set('stale', '0');
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
    // A single-repo console and the CORE Bots console are deep-linkable; the 'feed' /
    // 'insights' / 'retro' pseudo-rows are defaults and stay out of the URL.
    if (typeof s.activityRepoId === 'number') {
      p.set('activityRepo', String(s.activityRepoId));
    } else if (s.activityRepoId === 'bots') {
      p.set('activityRepo', 'bots');
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

function loadPersistedFilters(): Partial<FilterState> | null {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Sanitize: keep only known persisted filter keys. Drops a legacy persisted
    // `myTurnOnly` (now a transient focus mode) so an upgraded user's stale blob
    // can't force My Turn Focus Mode on a fresh load.
    return parsed && typeof parsed === 'object'
      ? sanitizePersistedFilters(parsed as Partial<FilterState>)
      : null;
  } catch {
    return null;
  }
}

function persistFilters(s: FilterState): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(pickFilterBarState(s)));
  } catch {
    /* quota / private-mode — non-fatal, filters just won't persist */
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
