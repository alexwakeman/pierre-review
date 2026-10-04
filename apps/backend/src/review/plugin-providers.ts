import type { ClaudeReviewTicket } from '@pierre-review/shared';

// OPTIONAL PRO ENRICHMENTS FOR THE FREE AGENTIC FEATURES. Claude Review and AI Fix are core; one
// of their inputs comes from a Pro surface that stayed in the plugin:
//
//   resolveReviewTicket — the Jira fill an AUTO PR review used to ask for. Since the ticket review
//     split a PR review checks no story and core no longer calls it; the member stays so an older
//     plugin still binds.
//   ticketsForPr / ticketMembers / ticketStory / listChangedTicketIdents — the ticket review's
//     membership (which PRs share a Jira ticket) and story, which only the plugin knows. Absent ⇒ a pasted story becomes a
//     one-PR ticket review and nothing cascades.
//
// The plugin registers them through the OPTIONAL `ProContext.registerAgenticProviders` member
// (bind.ts). Best-effort: a throw is treated as "nothing available". (AI Fix's old
// `readCiAnalysisSeed` provider went with its `ci_analysis` seed; a plugin that still registers it
// is ignored.)
export interface AgenticProviders {
  resolveReviewTicket?(
    accountId: number,
    prId: number,
  ): Promise<{
    // The first detected ticket (an older plugin answers only this).
    ticket: ClaudeReviewTicket | null;
    key: string | null;
    // EVERY detected ticket that could be read, in detection order (core keeps at most
    // CLAUDE_REVIEW_MAX_TICKETS). Absent ⇒ read `ticket` as a one-element list.
    tickets?: ClaudeReviewTicket[];
  }>;

  // TICKET REVIEW (core review/ticket-review/): one review per TICKET across every PR that names it.
  // All four OPTIONAL — additive, so apiVersion stays 22; absent ⇒ pasted stories only (a one-PR
  // ticket review each, no cascade). Idents are 'jira:<apiRoot>#<KEY>' (shared `jiraTicketIdent`).
  //   ticketsForPr — the PR's readable detected tickets as review stories (the same clipped,
  //     validated text the auto fill uses). `ticketHash` is informational: core recomputes it.
  ticketsForPr?(
    accountId: number,
    prId: number,
  ): Promise<Array<{ ident: string; ticket: ClaudeReviewTicket; ticketHash: string }>>;
  //   ticketMembers — every PR on the ticket: this account, the same Jira site, ANY workspace,
  //     merged PRs included. Core decides open / merged / closed from pull_requests.
  ticketMembers?(accountId: number, ident: string): Promise<Array<{ prId: number; workspaceId: number }>>;
  //   ticketStory — THE story of a ticket: the freshest stored row across every PR on it. Every
  //     caller that hashes a story (the run, the sweeper, the states route) reads THIS, so the stored
  //     and live fingerprints come from one text. Absent ⇒ core picks the newest `fetchedAt` over
  //     its members' `ticketsForPr` answers.
  ticketStory?(accountId: number, ident: string): Promise<ClaudeReviewTicket | null>;
  //   listChangedTicketIdents — tickets whose membership or story text changed at or after
  //     `sinceMs` (a PR joined or left, the criteria were edited). Feeds the sweeper cheaply.
  listChangedTicketIdents?(accountId: number, sinceMs: number): Promise<string[]>;
}

let providers: AgenticProviders = {};

export function registerAgenticProviders(p: AgenticProviders): void {
  providers = { ...providers, ...p };
}

export function getAgenticProviders(): AgenticProviders {
  return providers;
}

/** Test hook. */
export function _resetAgenticProvidersForTest(): void {
  providers = {};
}
