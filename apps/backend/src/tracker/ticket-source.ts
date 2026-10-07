import type { ClaudeReviewTicket } from '@pierre-review/shared';

// ⚠ LAZY on purpose: ./runtime.ts opens the database client at import time, and this module sits in
// the import graph of review modules that tests load STATICALLY before they point DATABASE_URL at a
// throwaway file. A static import here once made such a test write into the developer's real
// database. Each member therefore imports the reader on first call.
const load = async () => {
  const [peers, runtime] = await Promise.all([import('./peers.js'), import('./runtime.js')]);
  return { peers, ctx: runtime.trackerContext() };
};

// WHERE THE TICKET REVIEW (and a deep PR review's "Related PRs") READS TICKETS FROM. It was the
// OPTIONAL plugin seam `AgenticProviders` (review/plugin-providers.ts, apiVersion 22) — absent
// meant "pasted stories only, nothing cascades". Since apiVersion 23 the tracker is CORE, so the
// source is ALWAYS present: these four are core's own stored-row reads (./peers.ts) over the
// process's TrackerContext. Tests swap members with `_overrideTicketSourceForTest`.
//
// Idents are `<provider>:<root>#<KEY>` (shared `ticketIdent`); Jira's are unchanged from the
// plugin era, so every stored ticket review keeps its key.

export interface TicketSource {
  //   ticketsForPr — the PR's readable detected tickets as review stories (STORED rows only).
  //     `ticketHash` is informational: core recomputes it.
  ticketsForPr(accountId: number, prId: number): Promise<Array<{ ident: string; ticket: ClaudeReviewTicket; ticketHash: string }>>;
  //   ticketMembers — every PR on the ticket: this account, the same site, ANY workspace, merged
  //     PRs included. The caller decides open / merged / closed from pull_requests.
  ticketMembers(accountId: number, ident: string): Promise<Array<{ prId: number; workspaceId: number }>>;
  //   ticketStory — THE story of a ticket: the freshest stored row across every PR on it.
  ticketStory(accountId: number, ident: string): Promise<ClaudeReviewTicket | null>;
  //   listChangedTicketIdents — tickets whose membership or story text changed at or after
  //     `sinceMs`. Feeds the sweeper cheaply.
  listChangedTicketIdents(accountId: number, sinceMs: number): Promise<string[]>;
}

const core: TicketSource = {
  ticketsForPr: async (a, p) => {
    const { peers, ctx } = await load();
    return peers.ticketsForPr(ctx, a, p);
  },
  ticketMembers: async (a, i) => {
    const { peers, ctx } = await load();
    return peers.ticketMembers(ctx, a, i);
  },
  ticketStory: async (a, i) => {
    const { peers, ctx } = await load();
    return peers.ticketStory(ctx, a, i);
  },
  listChangedTicketIdents: async (a, s) => {
    const { peers, ctx } = await load();
    return peers.listChangedTicketIdents(ctx, a, s);
  },
};

let override: Partial<TicketSource> = {};

export function getTicketSource(): TicketSource {
  return { ...core, ...override };
}

/** Test hook: replace some members (merged over any earlier override; `undefined` restores core's). */
export function _overrideTicketSourceForTest(p: Partial<TicketSource>): void {
  const next: Record<string, unknown> = { ...override };
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  override = next as Partial<TicketSource>;
}

/** Test hook: back to core's own reads. */
export function _resetTicketSourceForTest(): void {
  override = {};
}
