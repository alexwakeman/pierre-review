import { beforeEach, describe, expect, it } from 'vitest';
import type { ConflictAiResolution } from '@pierre-review/shared';
import {
  claudePrefillPlan,
  markIsLive,
  undoAllClaudeChoices,
  useConflictClaudeStore,
} from '../src/store/conflictClaude.js';
import { useConflictResolverStore } from '../src/store/conflictResolver.js';

// "Resolve with Claude" pre-fills the resolver. The mapping is the whole contract: Claude fills
// only what the reader has NOT decided, an `'edited'` choice carries its handle AND its lines, and a
// "Claude" mark is only true while the decision is still Claude's.

function resolution(over: Partial<ConflictAiResolution> = {}): ConflictAiResolution {
  return {
    runId: 'run-1',
    prId: 7,
    sessionId: 's-1',
    headSha: 'h',
    baseSha: 'b',
    modelHash: 'm',
    baseRef: 'main',
    status: 'succeeded',
    error: null,
    model: 'claude-opus-5-5',
    startedAt: '2026-10-09T00:00:00Z',
    finishedAt: '2026-10-09T00:01:00Z',
    choices: [
      { fileIndex: 0, regionId: 1, decision: 'ours', editId: null, lines: null, rationale: 'PR wins', confidence: 'high' },
      { fileIndex: 0, regionId: 2, decision: 'edited', editId: 'e-1', lines: ['merged'], rationale: 'Both', confidence: 'medium' },
      { fileIndex: 1, regionId: 0, decision: 'theirs', editId: null, lines: null, rationale: 'main wins', confidence: 'low' },
      // Unusable: an edited choice with no handle.
      { fileIndex: 1, regionId: 3, decision: 'edited', editId: null, lines: null, rationale: '', confidence: 'low' },
    ],
    decidableTotal: 6,
    summary: null,
    costUsd: 0.4,
    ...over,
  };
}

describe('claudePrefillPlan', () => {
  it('decides only the regions the reader left undecided', () => {
    const plan = claudePrefillPlan(resolution(), { '1:0': 'base' });
    expect(plan.decide).toEqual([
      { fileIndex: 0, regionId: 1, decision: 'ours', editId: null },
      { fileIndex: 0, regionId: 2, decision: 'edited', editId: 'e-1' },
    ]);
    // The reader's region still carries Claude's mark — it simply is not live (see markIsLive).
    expect(Object.keys(plan.marks).sort()).toEqual(['0:1', '0:2', '1:0']);
  });

  it('hands over the edited lines and drops an edit with no handle', () => {
    const plan = claudePrefillPlan(resolution(), {});
    expect(plan.editLines).toEqual({ 'e-1': ['merged'] });
    expect(plan.marks['1:3']).toBeUndefined();
    expect(plan.decide.some((d) => d.regionId === 3)).toBe(false);
  });
});

describe('markIsLive', () => {
  const mark = { decision: 'edited' as const, editId: 'e-1', rationale: '', confidence: 'high' as const };
  it('is live only while the decision and the handle are still Claude’s', () => {
    expect(markIsLive(mark, 'edited', 'e-1')).toBe(true);
    expect(markIsLive(mark, 'edited', 'e-mine')).toBe(false);
    expect(markIsLive(mark, 'ours', undefined)).toBe(false);
    expect(markIsLive(mark, undefined, undefined)).toBe(false);
  });
});

describe('undoAllClaudeChoices', () => {
  beforeEach(() => {
    useConflictResolverStore.setState({ sessions: {}, order: [] });
    useConflictClaudeStore.setState({ activeKey: null, runs: {} });
  });

  it('clears Claude’s live choices and leaves the reader’s own', () => {
    const key = '7:h:b:m';
    const resolver = useConflictResolverStore.getState();
    resolver.seedSession({ key, sessionId: 's-1', conflictCount: 3 });
    // The reader decided 1:0 first.
    resolver.decideRegion({ key, fileIndex: 1, regionId: 0, decision: 'base' });
    const plan = claudePrefillPlan(resolution(), useConflictResolverStore.getState().sessions[key]!.decisions);
    useConflictResolverStore.getState().decideRegions({ key, decisions: plan.decide });
    useConflictClaudeStore.getState().setActiveKey(key);
    useConflictClaudeStore.getState().record({ key, runId: 'run-1', marks: plan.marks, decidableTotal: 6, summary: null });
    // The reader then replaced one of Claude's choices.
    useConflictResolverStore.getState().decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'theirs' });

    undoAllClaudeChoices();
    const decisions = useConflictResolverStore.getState().sessions[key]!.decisions;
    expect(decisions).toEqual({ '1:0': 'base', '0:1': 'theirs' });
  });
});
