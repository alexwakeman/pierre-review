// Advisor hook keys + the Tune/Drop store entry point. Run with:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// Three pinned properties:
//  • every advisor query key carries the `ws:<id>` segment ('ws:pending' while unresolved —
//    the skipToken guard's cache-key twin);
//  • the refine mutation key is deterministic across mounts (the CiAnalysisCard double-bill
//    lesson: a paid run must read as in-flight everywhere, so key order cannot depend on
//    selection order);
//  • the Tune/Drop pills' store action focuses the advisor AND switches the Bots tab in one
//    set, and clearing the focus does NOT yank the user off the tab.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advisorConfigPrMutationKey,
  advisorFindingsQueryKey,
  advisorRefineMutationKey,
} from '../src/hooks/useAdvisor.js';
import { useFilters } from '../src/store/filters.js';

describe('advisor query keys are workspace-scoped', () => {
  it('carries ws:<id>, or ws:pending while the scope is unresolved', () => {
    expect(advisorFindingsQueryKey(3)).toEqual(['advisor-findings', 'ws:3']);
    expect(advisorFindingsQueryKey(null)).toEqual(['advisor-findings', 'ws:pending']);
  });
});

describe('advisor mutation keys are shared + deterministic', () => {
  it('refine key sorts its dedupe keys so selection order cannot fork the key', () => {
    const a = advisorRefineMutationKey(['B|2|x|rolling_30', 'A|1|y|rolling_30'], 'bot.md');
    const b = advisorRefineMutationKey(['A|1|y|rolling_30', 'B|2|x|rolling_30'], 'bot.md');
    expect(a).toEqual(b);
    expect(a[0]).toBe('advisor-refine');
    expect(a[2]).toBe('bot.md');
  });

  it('config-pr key is per bot', () => {
    expect(advisorConfigPrMutationKey(12)).toEqual(['advisor-config-pr', 12]);
  });
});

describe('the Tune/Drop pills store action', () => {
  beforeEach(() => {
    useFilters.setState({ botsInnerTab: 'roi', advisorFocus: null });
  });

  it('focusAdvisor sets the focus AND switches the Bots inner tab in one action', () => {
    useFilters.getState().focusAdvisor('u12', 'tune');
    const s = useFilters.getState();
    expect(s.botsInnerTab).toBe('advisor');
    expect(s.advisorFocus).toEqual({ botKey: 'u12', intent: 'tune' });
  });

  it('drop carries its intent', () => {
    useFilters.getState().focusAdvisor('u9', 'drop');
    expect(useFilters.getState().advisorFocus).toEqual({ botKey: 'u9', intent: 'drop' });
  });

  it('clearAdvisorFocus drops the focus without yanking the user off the tab', () => {
    useFilters.getState().focusAdvisor('u12', 'tune');
    useFilters.getState().clearAdvisorFocus();
    const s = useFilters.getState();
    expect(s.advisorFocus).toBeNull();
    expect(s.botsInnerTab).toBe('advisor');
  });

  it('advisorFocus is transient — not part of the persisted filter slice', () => {
    useFilters.getState().focusAdvisor('u12', 'tune');
    // The persisted-filter picker must not carry it (it would resurrect a stale focus on
    // reload); it lives alongside botsInnerTab as session-only state.
    const persisted = JSON.stringify(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (useFilters as any).persist?.getOptions?.().partialize?.(useFilters.getState()) ?? {},
    );
    expect(persisted.includes('advisorFocus')).toBe(false);
  });
});
