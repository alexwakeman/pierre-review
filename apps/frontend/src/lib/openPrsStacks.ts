import type { TimelinePr } from '@pierre-review/shared';
import type { CardTicket } from './cardTickets.js';
import { mergeVerdict } from './ui.js';

// THE OPEN PRs TICKET STACKS — the Open PRs tab grouped by Jira/Linear ticket. Pure, so the
// grouping rules are testable; `OpenPrsCards` only renders what this returns.
//
// ONE STACK PER TICKET: a header (the ticket) over its PR cards. The rules:
//   - A PR naming TWO tickets sits in BOTH stacks; each copy carries `alsoIn` (the OTHER tickets)
//     so the card can say "also in BMD-1040". `prCount` still counts it ONCE.
//   - A PR naming no ticket goes in ONE final "No ticket" stack (`ticket: null`).
//   - WITHIN a stack the PRs keep the order they arrived in — the caller passes the list already
//     in the Sort menu's order, so the menu orders every stack the same way and this file never
//     re-implements a comparator.
//   - BETWEEN stacks the order is FIXED (the Sort menu does not move stacks): open tickets first,
//     then tickets whose status category is `done`; within each, the stack whose most recent PR
//     update is latest leads; ties by key, numerically ("BMD-9" before "BMD-10"). "No ticket" is
//     always last. A ticket with no known status is treated as open — unknown is never "done".
//
// ⚠ THE TICKET'S DETAILS ARE MERGED ACROSS ITS PRs: the first PR to name it wins each field, a
// later PR fills only a gap (the same key answered twice is the same stored Jira row).

export type OpenPrsView = 'grouped' | 'list';

export const OPEN_PRS_VIEWS: readonly OpenPrsView[] = ['grouped', 'list'];
export const DEFAULT_OPEN_PRS_VIEW: OpenPrsView = 'grouped';

export interface StackRow {
  pr: TimelinePr;
  /** The PR's OTHER tickets — each one a stack of its own on this page. [] for most PRs. */
  alsoIn: CardTicket[];
}

export interface OpenPrsStack {
  /** Stable id: `ticket:<KEY>`, or `none` for the no-ticket stack. Keys collapse state too. */
  id: string;
  /** null = the "No ticket" stack. */
  ticket: CardTicket | null;
  rows: StackRow[];
  /** The latest `updatedAt` among the stack's PRs (ISO). */
  latestActivity: string;
}

export interface StackedOpenPrs {
  stacks: OpenPrsStack[];
  /** Distinct PRs on the page — a PR in two stacks counts once. */
  prCount: number;
  /** How many of those name at least one ticket. */
  ticketedPrCount: number;
}

export const NO_TICKET_STACK_ID = 'none';

export const stackIdFor = (key: string): string => `ticket:${key}`;

/** The DOM id a stack's section carries, so "also in" can scroll to it. */
export const stackDomId = (stackId: string): string =>
  `open-prs-stack-${stackId.replace(/[^A-Za-z0-9_-]/g, '-')}`;

const isDone = (s: OpenPrsStack): boolean => s.ticket?.statusCategory === 'done';

const KEY_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function fillGaps(into: CardTicket, from: CardTicket): void {
  into.title ??= from.title;
  into.url ??= from.url;
  if (into.status == null && from.status != null) into.status = from.status;
  if (into.statusCategory == null && from.statusCategory != null) into.statusCategory = from.statusCategory;
  if (into.assignee == null && from.assignee != null) into.assignee = from.assignee;
  if (into.issueType == null && from.issueType != null) into.issueType = from.issueType;
}

/**
 * Group the (already sorted) open PRs into ticket stacks. `ticketsOf` answers each PR's tickets
 * in the card's own order (`cardTickets`).
 */
export function stackOpenPrs(
  sortedPrs: readonly TimelinePr[],
  ticketsOf: (pr: TimelinePr) => readonly CardTicket[],
): StackedOpenPrs {
  const byId = new Map<string, OpenPrsStack>();
  const none: OpenPrsStack = { id: NO_TICKET_STACK_ID, ticket: null, rows: [], latestActivity: '' };
  const seen = new Set<number>();
  let ticketed = 0;

  for (const pr of sortedPrs) {
    if (seen.has(pr.id)) continue; // a duplicated input row is still one PR
    seen.add(pr.id);
    // Dedupe the PR's own keys (case-insensitively) so it never lands twice in one stack.
    const tickets: CardTicket[] = [];
    const keys = new Set<string>();
    for (const t of ticketsOf(pr)) {
      const key = t.key.trim().toUpperCase();
      if (key === '' || keys.has(key)) continue;
      keys.add(key);
      tickets.push(t.key === key ? t : { ...t, key });
    }
    if (tickets.length === 0) {
      none.rows.push({ pr, alsoIn: [] });
      if (pr.updatedAt > none.latestActivity) none.latestActivity = pr.updatedAt;
      continue;
    }
    ticketed += 1;
    for (const t of tickets) {
      const id = stackIdFor(t.key);
      let stack = byId.get(id);
      if (stack == null) {
        stack = { id, ticket: { ...t }, rows: [], latestActivity: '' };
        byId.set(id, stack);
      } else if (stack.ticket != null) {
        fillGaps(stack.ticket, t);
      }
      stack.rows.push({ pr, alsoIn: tickets.filter((o) => o.key !== t.key) });
      if (pr.updatedAt > stack.latestActivity) stack.latestActivity = pr.updatedAt;
    }
  }

  const stacks = [...byId.values()].sort(
    (a, b) =>
      Number(isDone(a)) - Number(isDone(b)) ||
      (a.latestActivity < b.latestActivity ? 1 : a.latestActivity > b.latestActivity ? -1 : 0) ||
      KEY_COLLATOR.compare(a.ticket?.key ?? '', b.ticket?.key ?? ''),
  );
  if (none.rows.length > 0) stacks.push(none);
  return { stacks, prCount: seen.size, ticketedPrCount: ticketed };
}

/** Grouping says something only when at least one PR names a ticket; otherwise the page would be
 *  a lone "No ticket" header over the plain list, so the caller renders the list instead. */
export function stacksWorthShowing(s: StackedOpenPrs): boolean {
  return s.ticketedPrCount > 0;
}

/** "1 PR" / "3 PRs". */
export function prCountLabel(n: number): string {
  return `${n} PR${n === 1 ? '' : 's'}`;
}

export interface StackRollup {
  ciFailing: number;
  changesRequested: number;
  readyToMerge: number;
}

/** The header's quiet roll-up over the stack's PRs, from fields every card already carries. */
export function stackRollup(rows: readonly StackRow[]): StackRollup {
  let ciFailing = 0;
  let changesRequested = 0;
  let readyToMerge = 0;
  for (const { pr } of rows) {
    if (pr.ciStatus === 'failure' || pr.ciStatus === 'error') ciFailing += 1;
    if (pr.isChangesRequested) changesRequested += 1;
    if (!pr.isDraft) {
      const v = mergeVerdict({ mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft });
      if (v.canMerge) readyToMerge += 1;
    }
  }
  return { ciFailing, changesRequested, readyToMerge };
}

/** The roll-up's words, only the non-zero parts, most pressing first; [] = say nothing. */
export function stackRollupParts(r: StackRollup): { text: string; tone: 'bad' | 'good' }[] {
  const out: { text: string; tone: 'bad' | 'good' }[] = [];
  if (r.ciFailing > 0) out.push({ text: `${r.ciFailing} failing CI`, tone: 'bad' });
  if (r.changesRequested > 0) out.push({ text: `${r.changesRequested} changes requested`, tone: 'bad' });
  if (r.readyToMerge > 0) out.push({ text: `${r.readyToMerge} ready to merge`, tone: 'good' });
  return out;
}

/** "david buckley" → "DB", "Cher" → "CH". The CSP blocks Jira's avatar host, so a person is
 *  drawn as initials. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0] ?? ''}${(words[words.length - 1] as string)[0] ?? ''}`.toUpperCase();
}
