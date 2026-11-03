import { describe, expect, it } from 'vitest';
import type { DependencyAutomationLogItem } from '@pierre-review/shared';
import { automationDetail, automationVerb } from '../src/lib/dependencyAutomationLog.js';

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
