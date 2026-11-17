import type { TicketMergedPr, TicketMergedPrsResponse, TimelinePr } from '@pierre-review/shared';
import { canonicalTicketKey, landsAfterOf } from '@pierre-review/shared';
import type { CardTicket } from './cardTickets.js';
import { mergeVerdict } from './ui.js';

// THE OPEN PRs TICKET STACKS — the Open PRs tab grouped by Jira/Linear ticket. Pure, so the
// grouping rules are testable; `OpenPrsCards` only renders what this returns.
//
// ONE STACK PER TICKET: a header (the ticket) over its PR cards. The rules:
//   - A PR naming TWO tickets sits in BOTH stacks; each copy carries `alsoIn` (the OTHER tickets)
//     so the card can say "also in BMD-1040". `prCount` still counts it ONCE.
//   - `mergeShared` (Open PRs' grouped rows): tickets that SHARE a PR become ONE group instead —
//     every ticket stacked in its header (`tickets`, in the between-stack order), each PR listed ONCE
//     beneath. Sharing is transitive (A shares with B, B with C ⇒ one group). A row whose PR does not
//     name every ticket of its group carries `ticketKeys` (the ones it names), so the row can say which.
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
  /** A merged group only (`mergeShared`): the group's tickets THIS PR names, when not all of them. */
  ticketKeys?: string[];
}

export interface OpenPrsStack {
  /** Stable id: `ticket:<KEY>`, or `none` for the no-ticket stack. Keys collapse state too. */
  id: string;
  /** null = the "No ticket" stack. With `mergeShared`, the group's FIRST ticket. */
  ticket: CardTicket | null;
  /** Every ticket of the stack, in order: `[ticket]`, more than one for a merged group, `[]` for "No ticket". */
  tickets: CardTicket[];
  rows: StackRow[];
  /** The latest activity time among the stack's PRs (ISO; `updatedAt` unless the caller picks a clock). */
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

const isDone = (s: OpenPrsStack): boolean => s.tickets.length > 0 && s.tickets.every((t) => t.statusCategory === 'done');

const KEY_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function fillGaps(into: CardTicket, from: CardTicket): void {
  into.title ??= from.title;
  into.url ??= from.url;
  if (into.ident == null && from.ident != null) into.ident = from.ident;
  if (into.status == null && from.status != null) into.status = from.status;
  if (into.statusCategory == null && from.statusCategory != null) into.statusCategory = from.statusCategory;
  if (into.assignee == null && from.assignee != null) into.assignee = from.assignee;
  if (into.issueType == null && from.issueType != null) into.issueType = from.issueType;
}

/**
 * Group the (already sorted) open PRs into ticket stacks. `ticketsOf` answers each PR's tickets
 * in the card's own order (`cardTickets`). `activityOf` is the clock a stack's `latestActivity`
 * (and so the between-stack order) reads: `updatedAt` for open work; Open PRs → Merged passes
 * `mergedAt`, since a merged PR's `updatedAt` moves with any later comment or label.
 */
export function stackOpenPrs(
  sortedPrs: readonly TimelinePr[],
  ticketsOf: (pr: TimelinePr) => readonly CardTicket[],
  activityOf: (pr: TimelinePr) => string = (pr) => pr.updatedAt,
  opts: { mergeShared?: boolean } = {},
): StackedOpenPrs {
  const byId = new Map<string, OpenPrsStack>();
  const none: OpenPrsStack = { id: NO_TICKET_STACK_ID, ticket: null, tickets: [], rows: [], latestActivity: '' };
  const seen = new Set<number>();
  let ticketed = 0;

  for (const pr of sortedPrs) {
    if (seen.has(pr.id)) continue; // a duplicated input row is still one PR
    seen.add(pr.id);
    // Dedupe the PR's own keys (case-insensitively) so it never lands twice in one stack.
    const tickets: CardTicket[] = [];
    const keys = new Set<string>();
    for (const t of ticketsOf(pr)) {
      // Jira/Linear keys upper-cased; a GitHub issue key (`owner/repo#12`) lower-cased.
      const key = canonicalTicketKey(t.key) ?? t.key.trim().toUpperCase();
      if (key === '' || keys.has(key)) continue;
      keys.add(key);
      tickets.push(t.key === key ? t : { ...t, key });
    }
    if (tickets.length === 0) {
      none.rows.push({ pr, alsoIn: [] });
      if (activityOf(pr) > none.latestActivity) none.latestActivity = activityOf(pr);
      continue;
    }
    ticketed += 1;
    for (const t of tickets) {
      const id = stackIdFor(t.key);
      let stack = byId.get(id);
      if (stack == null) {
        const ticket = { ...t };
        stack = { id, ticket, tickets: [ticket], rows: [], latestActivity: '' };
        byId.set(id, stack);
      } else if (stack.ticket != null) {
        fillGaps(stack.ticket, t);
      }
      stack.rows.push({ pr, alsoIn: tickets.filter((o) => o.key !== t.key) });
      if (activityOf(pr) > stack.latestActivity) stack.latestActivity = activityOf(pr);
    }
  }

  const order = (a: OpenPrsStack, b: OpenPrsStack): number =>
    Number(isDone(a)) - Number(isDone(b)) ||
    (a.latestActivity < b.latestActivity ? 1 : a.latestActivity > b.latestActivity ? -1 : 0) ||
    KEY_COLLATOR.compare(a.ticket?.key ?? '', b.ticket?.key ?? '');
  let stacks = [...byId.values()].sort(order);
  if (opts.mergeShared === true) {
    const position = new Map<number, number>();
    sortedPrs.forEach((p, i) => {
      if (!position.has(p.id)) position.set(p.id, i);
    });
    stacks = mergeSharedStacks(stacks, position).sort(order);
  }
  if (none.rows.length > 0) stacks.push(none);
  return { stacks, prCount: seen.size, ticketedPrCount: ticketed };
}

/** The merged group's id: its tickets' stack ids, joined (one ticket ⇒ the plain `ticket:<KEY>`). */
export const groupIdFor = (keys: readonly string[]): string => keys.map(stackIdFor).join('+');

/**
 * Tickets that share a PR become ONE stack (transitively). The input is in the between-stack order,
 * so a group's tickets keep it (the first one leads); its rows are each PR once, in the caller's order
 * (`position`: the index in the already-sorted input — never a comparator of this file's own).
 */
function mergeSharedStacks(stacks: readonly OpenPrsStack[], position: ReadonlyMap<number, number>): OpenPrsStack[] {
  const parent = stacks.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const firstStackOf = new Map<number, number>();
  stacks.forEach((st, i) => {
    for (const r of st.rows) {
      const j = firstStackOf.get(r.pr.id);
      if (j == null) firstStackOf.set(r.pr.id, i);
      else {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const groups = new Map<number, OpenPrsStack[]>();
  stacks.forEach((st, i) => {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(st);
    groups.set(root, g);
  });
  const out: OpenPrsStack[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(members[0]!);
      continue;
    }
    const tickets = members.flatMap((m) => m.tickets);
    const keys = new Set(tickets.map((t) => t.key));
    const rows: StackRow[] = [];
    const where = new Map<number, string[]>();
    for (const m of members) {
      for (const r of m.rows) {
        const named = where.get(r.pr.id);
        if (named != null) {
          named.push(...m.tickets.map((t) => t.key));
          continue;
        }
        where.set(r.pr.id, m.tickets.map((t) => t.key));
        rows.push({ pr: r.pr, alsoIn: r.alsoIn.filter((o) => !keys.has(o.key)) });
      }
    }
    rows.sort((a, b) => (position.get(a.pr.id) ?? 0) - (position.get(b.pr.id) ?? 0));
    for (const r of rows) {
      const named = where.get(r.pr.id) ?? [];
      if (named.length < keys.size) r.ticketKeys = tickets.map((t) => t.key).filter((k) => named.includes(k));
    }
    out.push({
      id: groupIdFor(tickets.map((t) => t.key)),
      ticket: tickets[0] ?? null,
      tickets,
      rows,
      latestActivity: members.reduce((acc, m) => (m.latestActivity > acc ? m.latestActivity : acc), ''),
    });
  }
  return out;
}

// ── THE STORY VIEW'S ONE STACK ───────────────────────────────────────────────────────────────────
// The story view (the ticket tab) draws ONE ticket through the same `TicketStack`. Its rows are every PR
// the view's read says is on the ticket — membership is the read's, never detection's — and the stack
// exists with NO PR at all. The header's facts are the view's ticket, with gaps filled from the PRs' own
// ticket links (the same `fillGaps` rule as the board); each row's `alsoIn` is its OTHER tickets.

export interface StoryStackInput {
  /** The ticket (header facts; `ident` is the story view's key). */
  ticket: CardTicket & { ident: string };
  /** The ticket's MERGED PRs — the stack's "Merged (n)" panel. */
  merged: readonly TicketMergedPr[];
  /** The story TAB (not This Sprint's tray): the stack's header is the PAGE header and the stack is
   *  the page itself, with no card around it. */
  page?: boolean;
  /** The PR view's Story tab: the story inside the PR pane (no card while the rail is drawn). */
  embedded?: boolean;
}

/** The story view's stack id — apart from the board's `ticket:<KEY>`, so open state never crosses. */
export const storyStackId = (ident: string): string => `story:${ident}`;

export function storyStack(
  input: StoryStackInput,
  sortedPrs: readonly TimelinePr[],
  ticketsOf: (pr: TimelinePr) => readonly CardTicket[],
): StackedOpenPrs {
  const norm = (k: string): string => canonicalTicketKey(k) ?? k.trim().toUpperCase();
  const own = norm(input.ticket.key);
  const ticket: CardTicket = { ...input.ticket, key: own };
  const rows: StackRow[] = [];
  const seen = new Set<number>();
  let latestActivity = '';
  for (const pr of sortedPrs) {
    if (seen.has(pr.id)) continue;
    seen.add(pr.id);
    const ts = ticketsOf(pr);
    const same = ts.find((t) => norm(t.key) === own);
    if (same != null) fillGaps(ticket, same);
    const alsoIn: CardTicket[] = [];
    const keys = new Set<string>([own]);
    for (const t of ts) {
      const k = norm(t.key);
      if (k === '' || keys.has(k)) continue;
      keys.add(k);
      alsoIn.push(t.key === k ? t : { ...t, key: k });
    }
    rows.push({ pr, alsoIn });
    if (pr.updatedAt > latestActivity) latestActivity = pr.updatedAt;
  }
  return {
    stacks: [{ id: storyStackId(input.ticket.ident), ticket, tickets: [ticket], rows, latestActivity }],
    prCount: seen.size,
    ticketedPrCount: seen.size,
  };
}

// ── THE "MERGED (n)" PANEL ───────────────────────────────────────────────────────────────────
// Under a stack's open PRs, every MERGED PR Limn has linked to the same ticket (any repo of the
// account on the workspace's Jira site; ONE batched `GET /api/ticket-merged-prs`). It never
// creates a stack: a ticket with only merged PRs is not open work, so it is not on this page. The
// stack's "n PRs" count stays the OPEN count; the panel header carries the merged count.

/** The ticket keys to ask about — one per ticket stack, in page order (the no-ticket stack has none). */
export function mergedPanelKeys(stacks: readonly OpenPrsStack[]): string[] {
  const out: string[] = [];
  for (const s of stacks) for (const t of s.tickets) if (!out.includes(t.key)) out.push(t.key);
  return out;
}

/**
 * Stack id → its merged PRs, newest merge first. Only stacks that HAVE merged PRs are present.
 * Matched on the key; when both sides carry an ident (the Jira site) they must agree, so a key on
 * another site is never shown under this one. A PR already listed open in the stack is dropped
 * (the open card wins), and a PR is listed once per stack.
 */
export function mergedByStack(
  stacks: readonly OpenPrsStack[],
  data: TicketMergedPrsResponse | undefined,
): Map<string, TicketMergedPr[]> {
  const out = new Map<string, TicketMergedPr[]>();
  if (data == null) return out;
  const byKey = new Map(data.tickets.map((t) => [t.key.trim().toUpperCase(), t]));
  for (const s of stacks) {
    // A merged group (`mergeShared`) lists every one of its tickets' merged PRs, each once.
    const all: TicketMergedPr[] = [];
    for (const st of s.tickets) {
      const t = byKey.get(st.key.trim().toUpperCase());
      if (t == null) continue;
      if (st.ident != null && t.ident !== st.ident) continue;
      all.push(...t.prs);
    }
    if (all.length === 0) continue;
    const openIds = new Set(s.rows.map((r) => r.pr.id));
    const seen = new Set<number>();
    const prs = all
      .filter((p) => !openIds.has(p.prId) && (seen.has(p.prId) ? false : (seen.add(p.prId), true)))
      .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : a.prId - b.prId));
    if (prs.length > 0) out.set(s.id, prs);
  }
  return out;
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
      const v = mergeVerdict({ mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft, landsAfter: landsAfterOf(pr.branchStack) });
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
