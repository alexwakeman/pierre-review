import { describe, expect, it } from 'vitest';
import type { AiBudgetResponse } from '@pierre-review/shared';
import { claudeSpendBodyOf, claudeSpendDraftOf, type ClaudeSpendDraft } from '../src/components/settings/claudeSpendForm.js';

const draft = (over: Partial<ClaudeSpendDraft> = {}): ClaudeSpendDraft => ({
  enabled: true,
  weekSharePct: '50',
  daySharePct: '10',
  subscription: 'max20x',
  weeklyUsd: '',
  ...over,
});

describe('Settings → AI spend: the daily and weekly quotas', () => {
  it('reads both quotas; an older server with no daily share reads the default 10', () => {
    const data = (day: number | undefined) =>
      ({
        settings: { enabled: true, weekSharePct: 40, daySharePct: day, fiveHourSharePct: 12, subscription: null, weeklyUsd: null },
        isDefault: false,
      }) as unknown as AiBudgetResponse;
    expect(claudeSpendDraftOf(data(15))).toMatchObject({ weekSharePct: '40', daySharePct: '15' });
    expect(claudeSpendDraftOf(data(undefined)).daySharePct).toBe('10');
  });

  it('a login save sends both quotas and clears any hidden 5-hour share', () => {
    expect(claudeSpendBodyOf(draft(), 'login')).toEqual({
      body: { enabled: true, weekSharePct: 50, daySharePct: 10, fiveHourSharePct: null, subscription: 'max20x' },
    });
  });

  it('refuses a quota out of range or not a whole number', () => {
    for (const bad of ['0', '101', '2.5', '']) {
      expect(claudeSpendBodyOf(draft({ daySharePct: bad }), 'login')).toHaveProperty('error');
      expect(claudeSpendBodyOf(draft({ weekSharePct: bad }), 'login')).toHaveProperty('error');
    }
    expect(claudeSpendBodyOf(draft({ weekSharePct: '100', daySharePct: '100' }), 'login')).toMatchObject({
      body: { weekSharePct: 100, daySharePct: 100 },
    });
  });

  it('API key: the weekly US$ and the daily share of it', () => {
    expect(claudeSpendBodyOf(draft({ weeklyUsd: '25' }), 'api_key')).toEqual({
      body: { enabled: true, weeklyUsd: 25, daySharePct: 10 },
    });
  });

  it('switched off sends only that', () => {
    expect(claudeSpendBodyOf(draft({ enabled: false, daySharePct: 'x' }), 'login')).toEqual({ body: { enabled: false } });
  });
});
