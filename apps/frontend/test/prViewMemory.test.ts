import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetAllPrViews,
  PR_VIEW_MEMORY_CAP,
  rememberedPrScroll,
  rememberedPrTab,
  rememberedPrThreadsOnly,
  rememberPrScroll,
  rememberPrTab,
  rememberPrThreadsOnly,
  restoreStep,
} from '../src/lib/prViewMemory.js';
import { AI_EDGE_COLOR, threadEdgeColor } from '../src/lib/threadEdge.js';
import { DERIVED_STATE_META } from '../src/lib/ui.js';

describe('prViewMemory — where the reader was in each PR (this session)', () => {
  beforeEach(() => forgetAllPrViews());

  it('knows nothing about a PR it has not seen', () => {
    expect(rememberedPrTab(1)).toBeNull();
    expect(rememberedPrScroll(1, 'changes')).toBeNull();
    expect(rememberedPrThreadsOnly(1)).toBe(false);
  });

  it('remembers the last tab and a scroll position PER TAB, per PR', () => {
    rememberPrTab(1, 'changes');
    rememberPrScroll(1, 'changes', 4200.4);
    rememberPrScroll(1, 'overview', 300);
    rememberPrTab(2, 'comments');
    expect(rememberedPrTab(1)).toBe('changes');
    expect(rememberedPrScroll(1, 'changes')).toBe(4200);
    expect(rememberedPrScroll(1, 'overview')).toBe(300);
    expect(rememberedPrScroll(1, 'comments')).toBeNull();
    expect(rememberedPrTab(2)).toBe('comments');
    expect(rememberedPrScroll(2, 'changes')).toBeNull();
  });

  it("remembers 'activity' as Overview (it is Overview with a section open)", () => {
    rememberPrTab(1, 'activity');
    rememberPrScroll(1, 'activity', 90);
    expect(rememberedPrTab(1)).toBe('overview');
    expect(rememberedPrScroll(1, 'overview')).toBe(90);
  });

  it('never stores a negative or non-finite scroll', () => {
    rememberPrScroll(1, 'changes', -5);
    expect(rememberedPrScroll(1, 'changes')).toBe(0);
    rememberPrScroll(1, 'changes', Number.NaN);
    expect(rememberedPrScroll(1, 'changes')).toBe(0);
  });

  it('remembers Threads only once turned on, and its turning off', () => {
    rememberPrThreadsOnly(1, false);
    expect(rememberedPrTab(1)).toBeNull(); // a mount's `false` makes no entry
    rememberPrThreadsOnly(1, true);
    expect(rememberedPrThreadsOnly(1)).toBe(true);
    rememberPrThreadsOnly(1, false);
    expect(rememberedPrThreadsOnly(1)).toBe(false);
  });

  it('forgets the least recently touched PR past the cap', () => {
    for (let id = 1; id <= PR_VIEW_MEMORY_CAP; id++) rememberPrTab(id, 'changes');
    rememberPrScroll(1, 'changes', 10); // PR 1 is now the most recent
    rememberPrTab(PR_VIEW_MEMORY_CAP + 1, 'comments');
    expect(rememberedPrTab(1)).toBe('changes');
    expect(rememberedPrTab(2)).toBeNull();
    expect(rememberedPrTab(PR_VIEW_MEMORY_CAP + 1)).toBe('comments');
  });
});

describe('restoreStep — holding a remembered scroll while the content grows', () => {
  it('applies while the pane is off a target it can reach', () => {
    expect(restoreStep({ scrollTop: 0, maxScrollTop: 5000, target: 3000, heightStableForMs: 0 })).toBe('apply');
  });
  it('scrolls as far as the content allows, then waits for more content', () => {
    expect(restoreStep({ scrollTop: 0, maxScrollTop: 800, target: 3000, heightStableForMs: 0 })).toBe('apply');
    expect(restoreStep({ scrollTop: 800, maxScrollTop: 800, target: 3000, heightStableForMs: 2000 })).toBe('wait');
  });
  it('is done only at the target once the height has held still', () => {
    expect(restoreStep({ scrollTop: 3000, maxScrollTop: 5000, target: 3000, heightStableForMs: 100 })).toBe('wait');
    expect(restoreStep({ scrollTop: 3000, maxScrollTop: 5000, target: 3000, heightStableForMs: 500 })).toBe('done');
  });
  it('re-applies when content above moved the pane off the target', () => {
    expect(restoreStep({ scrollTop: 2600, maxScrollTop: 5000, target: 3000, heightStableForMs: 900 })).toBe('apply');
  });
});

describe('threadEdgeColor — every thread state wears the edge', () => {
  it('draws resolved in green, never transparent', () => {
    expect(threadEdgeColor('resolved', false)).toBe(DERIVED_STATE_META.resolved.color);
    // A resolved thread stays green even when an AI run judged it.
    expect(threadEdgeColor('resolved', true)).toBe(DERIVED_STATE_META.resolved.color);
  });
  it('keeps every open state its own colour, and the AI colour once a run judged it', () => {
    for (const s of ['untouched', 'replied_unresolved', 'likely_addressed'] as const) {
      expect(threadEdgeColor(s, false)).toBe(DERIVED_STATE_META[s].color);
      expect(threadEdgeColor(s, true)).toBe(AI_EDGE_COLOR);
    }
  });
});
