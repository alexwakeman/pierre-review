// THE TICKET'S OWN STORY, shown to the reader — the pure half of the Story check's "Story"
// disclosure (components/TicketStory.tsx) and the Open PRs ticket modal.
//
//   - ONE Story check section: a ticket with a ticket review shows only that; a story known ONLY
//     from an older PR review's verdicts is a block of its own (`legacyOnlyEntries`).
//   - Where the story text comes from, in order: the STORED Jira row (read on receipt by the
//     plugin's worker, fetched here only when the reader opens it), else the ticket as the latest
//     ticket review judged it, else the older run's stored ticket (`storySourceOf`).
//   - The modal's facts (status, type, assignee, title): the stored row's, else the card's.
import type {
  ClaudeReviewTicket,
  ClaudeReviewTicketEntry,
  JiraStatusCategory,
  JiraTicketDetails,
  TicketAssignee,
  TicketRef,
} from '@pierre-review/shared';

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

/** The PR's detected Jira link for a key, or null (Linear, not detected, no key). */
export function jiraRefFor(
  tickets: readonly TicketRef[] | null | undefined,
  key: string | null | undefined,
): TicketRef | null {
  const k = normKey(key);
  if (k == null) return null;
  return (tickets ?? []).find((t) => t.provider === 'jira' && normKey(t.key) === k) ?? null;
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

/** The facts the Open PRs ticket modal shows above the story. */
export interface TicketModalFacts {
  key: string;
  title: string | null;
  status: string | null;
  statusCategory: JiraStatusCategory | null;
  issueType: string | null;
  assignee: TicketAssignee | null;
  /** True only when these facts come from a read of the ticket (the stored row, or a card that
   *  carries a status) — so a null `assignee` may be printed as "Unassigned". */
  read: boolean;
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.replace(/\s+/g, ' ').trim() ?? '';
  return t === '' ? null : t;
};

/** The stored row's facts where it has them, else what the card already knew. */
export function ticketModalFacts(
  card: {
    key: string;
    title: string | null;
    status?: string;
    statusCategory?: JiraStatusCategory;
    issueType?: string;
    assignee?: TicketAssignee;
  },
  details: JiraTicketDetails | null | undefined,
): TicketModalFacts {
  const assignee = details?.assignee ?? card.assignee ?? null;
  return {
    key: card.key,
    title: clean(details?.title) ?? card.title,
    status: clean(details?.status) ?? clean(card.status),
    statusCategory: details?.statusCategory ?? card.statusCategory ?? null,
    issueType: clean(details?.issueType?.name) ?? clean(card.issueType),
    assignee: assignee != null && assignee.name.trim() !== '' ? assignee : null,
    read: details != null || clean(card.status) != null,
  };
}

/** The modal's title: "BMD-1040 · New designs", or the key alone. */
export function ticketModalTitle(f: Pick<TicketModalFacts, 'key' | 'title'>): string {
  return f.title != null ? `${f.key} · ${f.title}` : f.key;
}
