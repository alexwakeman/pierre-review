// THE TICKET'S OWN STORY, shown to the reader — the pure half of the Story check's "Story"
// disclosure (components/TicketStory.tsx).
//
//   - ONE Story check section: a ticket with a ticket review shows only that; a story known ONLY
//     from an older PR review's verdicts is a block of its own (`legacyOnlyEntries`).
//   - Where the story text comes from, in order: the STORED Jira row (read on receipt by the
//     plugin's worker, fetched here only when the reader opens it), else the ticket as the latest
//     ticket review judged it, else the older run's stored ticket (`storySourceOf`).
import type {
  ClaudeReviewTicket,
  ClaudeReviewTicketEntry,
  SprintBrief,
  TicketRef,
  TicketPrsTicket,
  TicketReviewState,
  TicketStoryResponse,
  TicketStoryTicket,
} from '@pierre-review/shared';
import { isReadingTrackerProvider } from '@pierre-review/shared';
import type { CardTicket } from './cardTickets.js';

const normKey = (k: string | null | undefined): string | null => {
  const s = k?.trim().toUpperCase() ?? '';
  return s === '' ? null : s;
};
const normTitle = (t: string | null | undefined): string | null => {
  const s = t?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
  return s === '' ? null : s;
};

/** What a ticket-review entry is known by: its key and title (the run's stored ticket included). */
export interface KnownTicket {
  ticketKey: string | null;
  ticketTitle: string | null;
  review?: { ticket: Pick<ClaudeReviewTicket, 'key' | 'title'> | null } | null;
}

/**
 * The older PR review's stories that NO ticket review covers — shown in Story check as their own
 * blocks. A story matches a ticket review by its key (case-insensitive), or, when it has no key,
 * by its title. The ones that match are not shown: their ticket review is.
 */
export function legacyOnlyEntries(
  legacy: readonly ClaudeReviewTicketEntry[],
  known: readonly KnownTicket[],
): ClaudeReviewTicketEntry[] {
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const k of known) {
    for (const key of [k.ticketKey, k.review?.ticket?.key]) {
      const n = normKey(key);
      if (n != null) keys.add(n);
    }
    for (const title of [k.ticketTitle, k.review?.ticket?.title]) {
      const n = normTitle(title);
      if (n != null) titles.add(n);
    }
  }
  return legacy.filter((e) => {
    const key = normKey(e.ticket.key);
    if (key != null) return !keys.has(key);
    const title = normTitle(e.ticket.title);
    return title == null || !titles.has(title);
  });
}

/** The PR's detected tracker link for a key, or null (not detected, no key). */
export function jiraRefFor(
  tickets: readonly TicketRef[] | null | undefined,
  key: string | null | undefined,
): TicketRef | null {
  const k = normKey(key);
  if (k == null) return null;
  // Any READING tracker's link (Jira, GitHub Issues, Linear).
  return (tickets ?? []).find((t) => isReadingTrackerProvider(t.provider) && normKey(t.key) === k) ?? null;
}

export type StorySource =
  | { kind: 'jira'; ref: TicketRef }
  | { kind: 'stored'; ticket: ClaudeReviewTicket }
  | { kind: 'none' };

/**
 * Where the Story disclosure reads from: the stored Jira row when Limn can read it for this PR,
 * else the first stored ticket that has any text.
 */
export function storySourceOf(
  jiraRef: TicketRef | null,
  stored: readonly (ClaudeReviewTicket | null | undefined)[],
): StorySource {
  if (jiraRef != null && jiraRef.canFetchDetails === true) return { kind: 'jira', ref: jiraRef };
  for (const t of stored) {
    if (t == null) continue;
    const has = [t.title, t.description, t.acceptanceCriteria].some((s) => s != null && s.trim() !== '');
    if (has) return { kind: 'stored', ticket: t };
  }
  return { kind: 'none' };
}

/** The link a story block's key goes to: the detected link, else the stored ticket's. */
export function storyUrlOf(
  jiraRef: Pick<TicketRef, 'url'> | null,
  stored: readonly (Pick<ClaudeReviewTicket, 'url'> | null | undefined)[],
): string | null {
  if (jiraRef?.url) return jiraRef.url;
  for (const t of stored) if (t?.url) return t.url;
  return null;
}

// ── THE STORY SECTION (Activity/TicketStorySection.tsx): which summary leads it ─────────────────────
//
// ONE fold for its one mount (the story view, always open; the Open PRs board draws no Story section):
//   1. the TICKET REVIEW's result when one exists (per-criterion delivery across every PR);
//   2. else the sprint BRIEF's summary + numbered criteria when it is CURRENT;
//   3. else "Reading this ticket…" while the brief pass will still read it ('pending');
//   4. else nothing.
// Then the ticket's own text (`storyFallbackTicket` when no PR can read the tracker row), then the
// design diagram (`storyDesignOffered`). No dependency or reference cards, ever.

export type StorySummarySource =
  | { kind: 'review'; runId: number }
  | { kind: 'brief'; brief: SprintBrief }
  | { kind: 'reading' }
  | { kind: 'none' };

export function storySummaryOf(
  review: Pick<TicketReviewState, 'latestRunId'> | null | undefined,
  story: Pick<TicketStoryResponse, 'briefState' | 'brief'> | null | undefined,
): StorySummarySource {
  if (review?.latestRunId != null) return { kind: 'review', runId: review.latestRunId };
  if (story?.briefState === 'current' && story.brief != null) return { kind: 'brief', brief: story.brief };
  if (story?.briefState === 'pending') return { kind: 'reading' };
  return { kind: 'none' };
}

/** The ticket's text as the sprint read stored it, shaped as a stored story (for the "As written"
 *  disclosure when no pull request can read the tracker row); null when there is no text. */
export function storyFallbackTicket(
  story: Pick<TicketStoryResponse, 'story' | 'ticket'> | null | undefined,
  key: string,
  url: string | null,
): ClaudeReviewTicket | null {
  const s = story?.story;
  if (s == null) return null;
  if (s.description.trim() === '' && s.acceptanceCriteria.trim() === '') return null;
  return {
    key,
    url,
    title: story?.ticket?.title ?? null,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    source: 'jira',
  };
}

/** The story's design diagram is offered only where agentic AI runs and the ticket has a pull request
 *  (the diagram section itself decides whether one exists or can be drawn). */
export function storyDesignOffered(aiEnabled: boolean, prCount: number): boolean {
  return aiEnabled && prCount >= 1;
}

// ── THE STORY VIEW'S HEADER TICKET ────────────────────────────────────────────────────────────────
//
// The story view (Ticket/TicketTabView.tsx) knows a ticket from two stored reads: the sprint read's row
// (`GET /api/ticket-story` — read every 20 minutes while the ticket is in the sprint, and the only
// source for a ticket with no pull request) and the freshest tracker row on its PRs (`GET
// /api/ticket-prs`). A sprint ticket leads with the sprint row; any other with the PR row; each field
// falls back to the other, then to what the tab captured when it was opened. Pure.

export function storyViewTicket(
  ident: string,
  opened: { key: string; title: string | null },
  prsTicket: TicketPrsTicket | null | undefined,
  storyTicket: TicketStoryTicket | null | undefined,
): CardTicket & { ident: string } {
  const lead = storyTicket?.inSprint === true ? storyTicket : (prsTicket ?? storyTicket ?? null);
  const other = lead === storyTicket ? prsTicket : storyTicket;
  const pick = <T,>(f: (t: TicketPrsTicket | TicketStoryTicket) => T | null | undefined): T | null =>
    (lead != null ? f(lead) : null) ?? (other != null ? f(other) : null) ?? null;
  const out: CardTicket & { ident: string } = {
    ident,
    key: pick((t) => t.key) ?? opened.key,
    title: pick((t) => t.title) ?? opened.title,
    url: pick((t) => t.url),
  };
  const provider = pick((t) => t.provider);
  if (provider != null) out.provider = provider;
  const status = pick((t) => t.status);
  if (status != null) {
    out.status = status.name;
    if (status.category != null) out.statusCategory = status.category;
  }
  // Only the sprint row carries the type and the assignee.
  if (storyTicket?.issueType != null) out.issueType = storyTicket.issueType;
  if (storyTicket?.assignee != null) out.assignee = { name: storyTicket.assignee.name, avatarUrl: storyTicket.assignee.avatarUrl };
  return out;
}
