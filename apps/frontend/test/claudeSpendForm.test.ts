import { describe, expect, it } from 'vitest';
import type { AiBudgetResponse } from '@pierre-review/shared';
import {
  claudeSpendBodyOf,
  claudeSpendDraftOf,
  draftFiveHourShare,
  type ClaudeSpendDraft,
} from '../src/components/settings/claudeSpendForm.js';

const draft = (over: Partial<ClaudeSpendDraft> = {}): ClaudeSpendDraft => ({
  enabled: true,
  weekSharePct: '5',
  fiveHourSharePct: '',
  subscription: 'max20x',
  weeklyUsd: '',
  ...over,
});

describe('Settings → Claude spend: the 5-hour share follows the week', () => {
  it('a stored null reads as an empty box (same as weekly)', () => {
    const data = {
      settings: { enabled: true, weekSharePct: 7, fiveHourSharePct: null, subscription: null, weeklyUsd: null },
      isDefault: false,
    } as unknown as AiBudgetResponse;
    expect(claudeSpendDraftOf(data).fiveHourSharePct).toBe('');
    expect(draftFiveHourShare(claudeSpendDraftOf(data))).toBe(7);
  });

  it('an empty box sends null; a figure sends itself; clearing returns to null', () => {
    expect(claudeSpendBodyOf(draft(), 'login')).toEqual({
      body: { enabled: true, weekSharePct: 5, fiveHourSharePct: null, subscription: 'max20x' },
    });
    expect(claudeSpendBodyOf(draft({ fiveHourSharePct: '10' }), 'login')).toMatchObject({ body: { fiveHourSharePct: 10 } });
    expect(claudeSpendBodyOf(draft({ fiveHourSharePct: '  ' }), 'login')).toMatchObject({ body: { fiveHourSharePct: null } });
    expect(draftFiveHourShare(draft({ fiveHourSharePct: '10' }))).toBe(10);
  });

  it('refuses a 5-hour share out of range', () => {
    expect(claudeSpendBodyOf(draft({ fiveHourSharePct: '0' }), 'login')).toHaveProperty('error');
    expect(claudeSpendBodyOf(draft({ fiveHourSharePct: '101' }), 'login')).toHaveProperty('error');
    expect(claudeSpendBodyOf(draft({ weekSharePct: '101' }), 'login')).toHaveProperty('error');
    expect(claudeSpendBodyOf(draft({ fiveHourSharePct: '2.5' }), 'login')).toHaveProperty('error');
  });

  it('accepts a share up to the whole allowance (100%)', () => {
    expect(claudeSpendBodyOf(draft({ weekSharePct: '100', fiveHourSharePct: '100' }), 'login')).toMatchObject({
      body: { weekSharePct: 100, fiveHourSharePct: 100 },
    });
  });

  it('API key: no 5-hour setting in the body', () => {
    expect(claudeSpendBodyOf(draft({ weeklyUsd: '25', fiveHourSharePct: '10' }), 'api_key')).toEqual({
      body: { enabled: true, weeklyUsd: 25 },
    });
  });
});
