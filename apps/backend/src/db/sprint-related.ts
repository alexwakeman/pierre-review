import {
  SPRINT_RELATED_MAX,
  storyReferencesByKey,
  canonicalTicketKey,
  ticketBrowseUrl,
  ticketKeyProject,
  ticketMentionsInText,
  trackerTicketIdent,
  type KnownTicket,
  type SprintRelatedTicket,
  type SprintRelation,
  type StoryTicketReference,
  type TicketLinkBlocker,
  type TicketSite,
} from '@pierre-review/shared';

// REPORTS → THIS SPRINT — THE TICKETS A TICKET POINTS AT (`SprintTicketRow.related`; docs/API.md §
// This sprint). Pure; the list route hands in the stored rows (`knownTicketsFor`, ONE read per page).
//
//   • THE BLOCKERS CODE ALREADY HOLDS (the Blocked issue): a tracker link is `blocked_by`, a ticket the
//     current label reads as `depends_on` is `depends_on`; then ITS STORED TRACKER LINKS
//     (`blocked_by_json`): a blocking relation ("is blocked by", "depends on") is `blocked_by`, any
//     other `linked`.
//   • THEN THE CURRENT LABEL'S REFERENCES (rubric 4): each named ticket with the relation the label
//     read in the text — concurrent, builds_on, supersedes, out_of_scope, context (and depends_on).
//   • THEN THE TICKETS ITS TEXT NAMES that neither covered (description + criteria; shared
//     `ticketMentionsInText`) as `mentioned`: a link on this site always counts; a BARE key only when it
//     is in the ticket's own project (or repo, for GitHub) or a stored ticket has that key — `UTF-8`
//     has a key's shape too.
//   • Deduped by key (the first relation wins, so a blocker stays a blocker), the ticket itself left
//     out, ordered blockers → build-alongside → links → the rest, ≤ SPRINT_RELATED_MAX. Title / status /
//     done from the link as the tracker sent it, else the freshest stored row (`knownTicketsFor`: sprint
//     tickets, PR tickets, then the sprint read's referenced-ticket lookup); null when nothing stored
//     names it. No tracker call: a view never reads the tracker.

const BLOCKING_RE = /block|depend/i;

export interface SprintRelatedInput {
  key: string;
  description: string;
  acceptanceCriteria: string;
  links: readonly TicketLinkBlocker[] | null;
  /** The ticket keys code already holds as BLOCKERS (the Blocked issue's `blockers` with a key — from
   *  a link or named in the text by the current label). They list as `blocked_by` whatever their source. */
  blockers?: ReadonlyArray<{
    source?: 'link' | 'text';
    ticketKey: string | null;
    what: string;
    status: string | null;
    category: string | null;
    url: string | null;
  }>;
  /** The CURRENT usable label's references (rubric 4); absent/null = no reading of the text. */
  references?: readonly StoryTicketReference[] | null;
}

/** Every key the text names on this site — what the list route looks up in the store, once. */
export function sprintRelatedCandidateKeys(input: SprintRelatedInput, site: TicketSite): string[] {
  const text = `${input.description}\n${input.acceptanceCriteria}`;
  return [...(input.links ?? []).map((l) => l.key), ...ticketMentionsInText(text, site).map((m) => m.key)];
}

function sameScope(key: string, self: string, provider: TicketSite['provider']): boolean {
  if (provider === 'github') {
    const repo = (k: string) => k.slice(0, k.lastIndexOf('#')).toLowerCase();
    return repo(key) === repo(self);
  }
  const a = ticketKeyProject(key);
  return a != null && a === ticketKeyProject(self);
}

export function sprintRelatedFor(
  input: SprintRelatedInput,
  site: TicketSite,
  known: ReadonlyMap<string, KnownTicket>,
): SprintRelatedTicket[] {
  const canon = (k: string): string => canonicalTicketKey(k) ?? k.trim();
  const self = canon(input.key);
  const out = new Map<string, SprintRelatedTicket>();
  const add = (
    rawKey: string,
    relation: SprintRelation,
    from: { title: string | null; status: string | null; category: string | null; url: string | null } | null,
  ): void => {
    const key = canon(rawKey);
    if (key === '' || key === self || out.has(key)) return;
    const k = known.get(key.toUpperCase()) ?? null;
    const category = from?.category ?? k?.category ?? null;
    const url = [from?.url, k?.url, ticketBrowseUrl(site, key)].find((u): u is string => u != null && /^https:\/\//i.test(u)) ?? null;
    out.set(key, {
      ident: trackerTicketIdent(site.provider, site.root, key),
      key,
      title: from?.title ?? k?.title ?? null,
      status: from?.status ?? k?.status ?? null,
      relation,
      done: category == null ? null : category === 'done',
      url,
    });
  };
  for (const b of input.blockers ?? []) {
    if (b.ticketKey != null) {
      add(b.ticketKey, b.source === 'text' ? 'depends_on' : 'blocked_by', {
        title: b.what.trim() === '' || b.what.trim().toUpperCase() === b.ticketKey.trim().toUpperCase() ? null : b.what,
        status: b.status,
        category: b.category,
        url: b.url,
      });
    }
  }
  for (const l of input.links ?? []) add(l.key, BLOCKING_RE.test(l.relation) ? 'blocked_by' : 'linked', l);
  for (const r of storyReferencesByKey(input.references).values()) add(r.ticketKey, r.relation, null);
  for (const m of ticketMentionsInText(`${input.description}\n${input.acceptanceCriteria}`, site)) {
    if (m.via === 'bare' && !sameScope(m.key, self, site.provider) && !known.has(m.key.toUpperCase())) continue;
    add(m.key, 'mentioned', null);
  }
  const rank: Record<SprintRelation, number> = {
    blocked_by: 0,
    depends_on: 0,
    concurrent: 1,
    linked: 2,
    supersedes: 3,
    builds_on: 3,
    out_of_scope: 3,
    context: 3,
    mentioned: 3,
  };
  return [...out.values()].sort((a, b) => rank[a.relation] - rank[b.relation]).slice(0, SPRINT_RELATED_MAX);
}
