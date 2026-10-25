import { AI_BUDGET_SHARE_MAX, type AiBudgetBody, type AiBudgetResponse, type AiSubscriptionKind } from '@pierre-review/shared';

// The pure half of Settings → Claude spend (ClaudeSpendSection.tsx): the draft, its parse and the
// PUT body, so tests can import it without React.
//
// THE 5-HOUR SHARE FOLLOWS THE WEEK. `fiveHourSharePct: ''` in the draft = no separate setting: the
// body sends `null` and the server uses the weekly share ("5% a week → 5% a session"). A typed figure
// is the reader's own 5-hour share; clearing the box returns it to "same as weekly".

export interface ClaudeSpendDraft {
  enabled: boolean;
  weekSharePct: string;
  /** '' = the same as the weekly share. */
  fiveHourSharePct: string;
  subscription: AiSubscriptionKind | null;
  weeklyUsd: string;
}

export function claudeSpendDraftOf(data: AiBudgetResponse): ClaudeSpendDraft {
  const s = data.settings;
  return {
    enabled: s.enabled,
    weekSharePct: String(s.weekSharePct),
    fiveHourSharePct: s.fiveHourSharePct == null ? '' : String(s.fiveHourSharePct),
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
  if (route === 'api_key') {
    const weeklyUsd = parseUsd(d.weeklyUsd);
    if (weeklyUsd == null) return { error: 'Enter a weekly US$ amount.' };
    return { body: { enabled: true, weeklyUsd } };
  }
  const weekSharePct = parseShare(d.weekSharePct);
  if (weekSharePct == null) return { error: `Enter a whole number from 1 to ${AI_BUDGET_SHARE_MAX}.` };
  let fiveHourSharePct: number | null = null;
  if (d.fiveHourSharePct.trim() !== '') {
    fiveHourSharePct = parseShare(d.fiveHourSharePct);
    if (fiveHourSharePct == null) {
      return { error: `Enter a 5-hour share from 1 to ${AI_BUDGET_SHARE_MAX}, or leave it empty to use the weekly share.` };
    }
  }
  return { body: { enabled: true, weekSharePct, fiveHourSharePct, subscription: d.subscription } };
}

/** The 5-hour share the draft would put in force: its own figure, else the weekly one (null if neither parses). */
export function draftFiveHourShare(d: ClaudeSpendDraft): number | null {
  return d.fiveHourSharePct.trim() === '' ? parseShare(d.weekSharePct) : parseShare(d.fiveHourSharePct);
}
