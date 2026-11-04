import { describe, expect, it } from 'vitest';
import type { DependencyAutomationLogItem } from '@pierre-review/shared';
import { automationDetail, automationVerb, groupAutomationByPr } from '../src/lib/dependencyAutomationLog.js';

const item = (over: Partial<DependencyAutomationLogItem>): DependencyAutomationLogItem => ({
  id: 1,
  prId: 2,
  repoFullName: 'acme/web',
  prNumber: 12,
  prTitle: 'Bump react',
  action: 'approve',
  state: 'done',
  detail: null,
  teammate: null,
  at: '2026-11-03T10:00:00Z',
  ...over,
});

describe('the automation log rows', () => {
  it('says Merged only for a landed merge; arming reads as armed', () => {
    expect(automationVerb(item({ action: 'merge_landed' }))).toBe('Merged');
    expect(automationVerb(item({ action: 'arm_merge' }))).toBe('Armed to merge');
  });

  it('names the AI fix states', () => {
    expect(automationVerb(item({ action: 'ai_fix', state: 'running' }))).toBe('Fixing CI with AI');
    expect(automationVerb(item({ action: 'ai_fix', state: 'done' }))).toBe('Fixed CI with AI');
    expect(automationVerb(item({ action: 'ai_fix', state: 'failed' }))).toBe('Couldn’t fix CI');
  });

  it('a teammate’s hold is a skip naming them, never a failure', () => {
    const handling = item({ state: 'skipped', detail: 'robin is handling this', teammate: { login: 'robin', name: 'Robin Dunn', handled: false } });
    expect(automationVerb(handling)).toBe('Skipped approval');
    expect(automationDetail(handling)).toBe('Robin Dunn is handling this');
    const handled = item({ action: 'ai_fix', state: 'skipped', teammate: { login: 'robin', name: null, handled: true } });
    expect(automationDetail(handled)).toBe('robin handled this');
    expect(automationDetail(item({ detail: 'Asked Dependabot to rebase' }))).toBe('Asked Dependabot to rebase');
  });
});

describe('grouping the log by PR', () => {
  it('lists each PR once, its actions newest first, PRs ordered by their newest action', () => {
    const groups = groupAutomationByPr([
      item({ id: 1, prId: 10, prNumber: 1, action: 'approve', at: '2026-11-01T10:00:00Z' }),
      item({ id: 2, prId: 20, prNumber: 2, action: 'approve', at: '2026-11-02T10:00:00Z' }),
      item({ id: 3, prId: 10, prNumber: 1, action: 'arm_merge', at: '2026-11-03T10:00:00Z' }),
      item({ id: 4, prId: 10, prNumber: 1, action: 'merge_landed', at: '2026-11-03T11:00:00Z' }),
      item({ id: 5, prId: 20, prNumber: 2, action: 'rebase_request', at: '2026-11-02T12:00:00Z' }),
    ]);
    expect(groups.map((g) => g.prId)).toEqual([10, 20]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([4, 3, 1]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual([5, 2]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(5);
  });

  it('breaks a time tie by the later row and handles an empty log', () => {
    const same = '2026-11-03T10:00:00Z';
    const groups = groupAutomationByPr([item({ id: 7, prId: 1, at: same }), item({ id: 9, prId: 2, at: same })]);
    expect(groups.map((g) => g.prId)).toEqual([2, 1]);
    expect(groupAutomationByPr([])).toEqual([]);
  });
});
