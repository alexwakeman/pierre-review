import type { ClaudeReviewVerdict, InsightCard, PendingTabKey } from '@pierre-review/shared';

// ── COLOUR AND ICONS FOR EVERY SLACK MESSAGE ─────────────────────────────────────────────────
//
// Every part of a Slack message sits in an ATTACHMENT whose `color` paints the bar beside it, one
// TONE per part: merged = purple, ready/approved = green, failing/blocked = red, waiting on someone
// = amber, everything else = grey. Pure: no ctx, no I/O.
//
// ⚠ COLOUR IS NEVER THE ONLY SIGNAL. Every coloured part keeps its words ("Needs fixing",
// "Verdict: Request changes", "Merged") and the bar only repeats them. A reader on a screen reader,
// a colour-blind reader, or a notification preview loses nothing.
//
// ⚠ EMOJI ARE SPARING: at most ONE per line or heading, always a standard Slack shortcode (a custom
// one renders as `:name:` text in any other Slack workspace), and always beside words that say the
// same thing.

export type SlackTone = 'merged' | 'good' | 'bad' | 'waiting' | 'info';

/** The bar colour per tone. GitHub's own merged purple and Primer's success / danger / attention /
 *  muted hues, so the bar reads like the PR state a reader already knows. */
export const SLACK_TONE_COLOUR: Record<SlackTone, string> = {
  merged: '#8250df',
  good: '#1f883d',
  bad: '#cf222e',
  waiting: '#d4a72c',
  info: '#8c959f',
};

export interface SlackAttachment {
  color: string;
  /** Plain text for clients that cannot draw blocks (and for notifications). */
  fallback: string;
  blocks: unknown[];
}

/** One coloured attachment. */
export function toneAttachment(tone: SlackTone, fallback: string, blocks: unknown[]): SlackAttachment {
  return { color: SLACK_TONE_COLOUR[tone], fallback, blocks };
}

type TeamTab = Exclude<PendingTabKey, 'my_turn' | 'claude'>;

/** Each team Pending tab's tone: broken work red, work waiting on a person amber, work ready to
 *  land green, dependency upkeep grey. ⚠ A new tab key fails to compile here until it has one. */
export const PENDING_TAB_TONE: Record<TeamTab, SlackTone> = {
  fixing: 'bad',
  review: 'waiting',
  threads: 'waiting',
  land: 'good',
  deps: 'info',
};

/** The one emoji beside each team tab's heading. */
export const PENDING_TAB_EMOJI: Record<TeamTab, string> = {
  fixing: ':rotating_light:',
  review: ':eyes:',
  threads: ':speech_balloon:',
  land: ':rocket:',
  deps: ':package:',
};

/** The digest's other headings. */
export const SPRINT_EMOJI = ':spiral_calendar_pad:';
export const BOTS_EMOJI = ':robot_face:';

/** The icon that opens a Pending line, in place of a bullet: what kind of thing the card is. Every
 *  line also says it in words (`pendingCardText`). */
export function pendingCardEmoji(card: InsightCard): string {
  switch (card.kind) {
    case 'ci_failing':
      return card.arm === 'trunk' ? ':red_circle:' : ':x:';
    case 'my_turn':
      if (card.reason === 'trunk_red') return ':red_circle:';
      if (card.reason === 'own_ci_red') return ':x:';
      if (card.reason === 'own_conflicts') return ':crossed_swords:';
      if (card.reason === 'own_ready' || card.reason === 'pr_approved') return ':white_check_mark:';
      return ':small_blue_diamond:';
    case 'conflicts':
      return ':crossed_swords:';
    case 'stalled_review':
      return ':hourglass_flowing_sand:';
    case 'reviewer_routing':
      return ':bust_in_silhouette:';
    case 'untouched_thread':
      return ':speech_balloon:';
    case 'merge':
      return ':white_check_mark:';
    case 'update_branch':
      return ':arrows_counterclockwise:';
    case 'security':
      return ':lock:';
    case 'dependency_bump':
      return ':package:';
    case 'reviewer_load':
    case 'bot_signal':
    case 'bot_only_review':
      return '•';
  }
}

/** A review's tone by its verdict: approve green, request changes red, a comment (or none) grey. */
export function verdictTone(verdict: ClaudeReviewVerdict | null): SlackTone {
  if (verdict === 'APPROVE') return 'good';
  if (verdict === 'REQUEST_CHANGES') return 'bad';
  return 'info';
}

/** The emoji beside a review's heading, by its verdict. */
export function verdictEmoji(verdict: ClaudeReviewVerdict | null): string {
  if (verdict === 'APPROVE') return ':white_check_mark:';
  if (verdict === 'REQUEST_CHANGES') return ':warning:';
  return ':mag:';
}

export const MERGED_EMOJI = ':tada:';
