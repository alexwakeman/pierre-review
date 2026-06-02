import { useEffect, useRef } from 'react';
import {
  ALL_CATEGORIES,
  ALL_PR_STATUSES,
  DEFAULT_CATEGORIES,
  DEFAULT_PR_STATUSES,
  useFilters,
  type FilterState,
  type RangePreset,
  type StripFilter,
} from '../store/filters.js';
import {
  DERIVED_STATES,
  type DerivedState,
  type EventCategory,
  type PrStatus,
} from '@gh-team-monitor/shared';

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
  if (p.get('bots') !== null) out.excludeBots = p.get('bots') !== '0';
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
  const states = p.get('states');
  if (states) {
    const valid = new Set<string>(DERIVED_STATES);
    out.derivedStates = states.split(',').filter((s) => valid.has(s)) as DerivedState[];
  }
  const pr = p.get('pr');
  if (pr) out.selectedPrId = Number.parseInt(pr, 10);
  const thread = p.get('thread');
  if (thread) out.selectedThreadId = Number.parseInt(thread, 10);

  const strip = p.get('strip');
  if (strip === 'my_turn' || strip === 'needs_attention' || strip === 'all') {
    out.stripFilter = strip as StripFilter;
  }

  // `open=1` means the user expanded the Open-PRs strip (non-default; default is
  // collapsed). Absent → keep the collapsed default.
  if (p.get('open') === '1') out.stripCollapsed = false;

  return out;
}

function writeToUrl(s: FilterState): void {
  const p = new URLSearchParams();
  if (s.preset !== '14d') p.set('preset', s.preset);
  if (s.repoIds?.length) p.set('repos', s.repoIds.join(','));
  if (s.userIds?.length) p.set('users', s.userIds.join(','));
  if (!s.excludeBots) p.set('bots', '0');
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
  if (s.derivedStates.length) p.set('states', s.derivedStates.join(','));
  if (s.selectedPrId) p.set('pr', String(s.selectedPrId));
  if (s.selectedThreadId) p.set('thread', String(s.selectedThreadId));
  if (s.stripFilter !== 'all') p.set('strip', s.stripFilter);
  if (!s.stripCollapsed) p.set('open', '1');

  const qs = p.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState(null, '', next);
  }
}

/** Two-way sync between the filter store and the URL query string. */
export function useUrlState(): void {
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current) {
      useFilters.getState().hydrate(readFromUrl());
      hydrated.current = true;
    }
    // Reflect every subsequent change back into the URL.
    const unsub = useFilters.subscribe((s) => writeToUrl(s));
    return unsub;
  }, []);
}
