import type { BotResponsiveness } from '@pierre-review/shared';

// The two headline tiles on Bots Monitoring → ROI ("Time to first review", "Follow-ups after first
// review"), formatted from the workspace block of `/api/pro/bot-behaviour`. Pure, so the wording
// and the unknown-is-never-zero rule are tested without a render.
//
// ⚠ A NULL FIGURE IS A DASH, NEVER 0. The server returns null for every figure when no review bot
// first-reviewed a PR in the window (`prs === 0`); "0h" there would read as "instant".

export interface ResponsivenessTile {
  value: string;
  sub: string;
}

const NO_PRS = 'No PR reviewed by a bot in this window';

/** Hours → "<1m" / "45m" / "3.5h" / "20h" / "2.1d". Never "0h": a sub-minute time is "<1m". */
export function formatHours(hours: number): string {
  const mins = hours * 60;
  if (mins < 1) return '<1m';
  if (mins < 60) return `${Math.round(mins)}m`;
  if (hours < 10) return `${Math.round(hours * 10) / 10}h`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)}d`;
}

function prsText(n: number): string {
  return `${n} PR${n === 1 ? '' : 's'}`;
}

export function formatResponsivenessTiles(ws: BotResponsiveness | null | undefined): {
  ttfr: ResponsivenessTile;
  followups: ResponsivenessTile;
} {
  if (ws == null || ws.prs === 0) {
    return { ttfr: { value: '—', sub: NO_PRS }, followups: { value: '—', sub: NO_PRS } };
  }
  const prs = prsText(ws.prs);
  const ttfr: ResponsivenessTile = {
    value: ws.ttfrMedianHours == null ? '—' : formatHours(ws.ttfrMedianHours),
    sub: ws.ttfrP90Hours == null ? prs : `p90 ${formatHours(ws.ttfrP90Hours)} · ${prs}`,
  };
  const followups: ResponsivenessTile = {
    value: ws.followupRatePct == null ? '—' : `${Math.round(ws.followupRatePct)}%`,
    sub:
      ws.avgFollowups == null
        ? prs
        : `avg ${Math.round(ws.avgFollowups * 10) / 10} more per PR · ${prs}`,
  };
  return { ttfr, followups };
}
