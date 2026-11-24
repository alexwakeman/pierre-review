import { AI_BUDGET_DEFAULTS, AI_BUDGET_SHARE_MAX, type AiBudgetBody, type AiBudgetResponse, type AiSubscriptionKind } from '@pierre-review/shared';

// The pure half of Settings → Claude spend (ClaudeSpendSection.tsx): the draft, its parse and the
// PUT body, so tests can import it without React.
//
// TWO QUOTAS: the DAILY share (`daySharePct`, Ensemble's spend since midnight as a share of the week;
// on an API key, of the weekly US$) and the WEEKLY share. THE 5-HOUR SHARE IS NOT SHOWN: it follows
// the weekly one, and every save sends `fiveHourSharePct: null` so no hidden figure stays in force.

export interface ClaudeSpendDraft {
  enabled: boolean;
  weekSharePct: string;
  /** The daily quota, % of the week. */
  daySharePct: string;
  subscription: AiSubscriptionKind | null;
  weeklyUsd: string;
}

export function claudeSpendDraftOf(data: AiBudgetResponse): ClaudeSpendDraft {
  const s = data.settings;
  return {
    enabled: s.enabled,
    weekSharePct: String(s.weekSharePct),
    // An older server sends no daily share: the default.
    daySharePct: String(s.daySharePct ?? AI_BUDGET_DEFAULTS.daySharePct),
    subscription: s.subscription,
    // Never set on an API key: the reader types their own figure (the default is the placeholder).
    weeklyUsd: data.isDefault || s.weeklyUsd == null ? '' : String(s.weeklyUsd),
  };
}

export function parseShare(v: string): number | null {
  const t = v.trim().replace(/%$/, '');
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= AI_BUDGET_SHARE_MAX ? n : null;
}

export function parseUsd(v: string): number | null {
  const t = v.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 100_000 ? n : null;
}

/** The PUT body for the draft, or an error to show instead. */
export function claudeSpendBodyOf(
  d: ClaudeSpendDraft,
  route: 'login' | 'api_key' | 'none',
): { body: AiBudgetBody } | { error: string } {
  if (!d.enabled) return { body: { enabled: false } };
  const daySharePct = parseShare(d.daySharePct);
  if (daySharePct == null) return { error: `Enter a daily quota from 1 to ${AI_BUDGET_SHARE_MAX}.` };
  if (route === 'api_key') {
    const weeklyUsd = parseUsd(d.weeklyUsd);
    if (weeklyUsd == null) return { error: 'Enter a weekly US$ amount.' };
    return { body: { enabled: true, weeklyUsd, daySharePct } };
  }
  const weekSharePct = parseShare(d.weekSharePct);
  if (weekSharePct == null) return { error: `Enter a weekly quota from 1 to ${AI_BUDGET_SHARE_MAX}.` };
  return { body: { enabled: true, weekSharePct, daySharePct, fiveHourSharePct: null, subscription: d.subscription } };
}
