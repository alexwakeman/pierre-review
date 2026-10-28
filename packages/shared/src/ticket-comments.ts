import { automationVendorFor, reviewBotKind } from './types.js';

// TICKET COMMENTS (docs/TRACKERS.md § Ticket comments) — the discussion under a tracker ticket, read in
// the SAME issue read the worker already makes (Jira `fields.comment`, GitHub Issues `comments(last:)`,
// Linear `comments(last:)`) and stored per TICKET (`tracker_ticket_comments`), never per PR.
//
//   • The newest TICKET_COMMENTS_KEPT per ticket are kept; older ones are pruned on the next read.
//   • Each body is markdown, cut to TICKET_COMMENT_BODY_MAX characters.
//   • An automation's comment is STORED with `isBot`, and left out of every prompt and every list a
//     person reads (the story view hides them).
//   • ⚠ Comments are NOT story text: they never move `changed_at`, the story hash or the ticket
//     review's fingerprint, so a new comment never re-bills an automatic review. A run stores what it
//     saw instead, and the SPA says "n new comments since this check".

/** The newest comments kept per ticket. */
export const TICKET_COMMENTS_KEPT = 20;
/** One comment's body, in characters, as stored. */
export const TICKET_COMMENT_BODY_MAX = 4000;
/** Every comment a prompt carries, together, in characters (newest kept when cut). */
export const TICKET_COMMENTS_PROMPT_CHARS = 6000;

/** One person's comment on a ticket, as the story view shows it. */
export interface TicketComment {
  /** The tracker's own id for the comment. */
  id: string;
  /** The author's display name ('' when the tracker named nobody). */
  author: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601; null when the tracker gave none. */
  updatedAt: string | null;
  /** Markdown. */
  body: string;
}

/** A GitHub login that is an automation, not a person: the `[bot]` suffix, or any login the automation
 *  vocabularies claim (`AUTOMATION_VENDORS`, the review bots). GitHub's own `__typename: Bot` is checked by the reader. */
export function isAutomationCommentLogin(login: string | null | undefined): boolean {
  if (login == null || login.trim() === '') return false;
  return /\[bot\]$/i.test(login.trim()) || automationVendorFor(login) != null || reviewBotKind(login) != null;
}

/** "Jira automation", "Automation for Jira", "jira-bot", "Some Bot", "ci-bot" — a Jira author that is
 *  an automation by name, for a Server / Data Center site that has no `accountType`. */
export function isAutomationCommentName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  if (n === '') return false;
  return /\bautomation\b/.test(n) || /(^|[\s_-])bot$/.test(n) || /\[bot\]$/.test(n);
}
