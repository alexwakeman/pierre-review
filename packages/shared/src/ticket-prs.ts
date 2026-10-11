import type { JiraStatusCategory, TimelinePr, TrackerProvider } from './types.js';

// THE TICKET TAB — one ticket's pull requests, in isolation (docs/FRONTEND.md § The ticket tab;
// docs/API.md § GET /api/ticket-prs). CORE and FREE: PR data is free, so the tab is free wherever it
// is opened from (a Pro surface's button still needs that surface to be open).
//
//   GET /api/ticket-prs?workspace=<id>&ident=<trackerTicketIdent>  →  TicketPrsResponse
//
// DB-only (`read` tier): the stored ticket rows (`tracker_tickets`, incl. manual links) on the
// workspace tracker's CURRENT site, joined to `pull_requests`, built into the SAME `TimelinePr` rows the
// Open PRs cards draw (`buildTimelinePrs`) so the tab reuses `OpenPrsCards` (open, and
// `variant="merged"`). NO tracker call, NO GitHub call.
//
//   • MEMBERSHIP is the ticket review's (`ticketMembers`): this account, the same site + key, any
//     workspace, state 'ok'. Rows are LISTED only for repos in THIS workspace; PRs in other workspaces'
//     repos are COUNTED (`outsideWorkspace`), never listed.
//   • `?workspace=` resolves like every scoped route (absent / unknown / another tenant's → Default) and
//     is echoed. An ident that does not parse, or names another tracker / site than the workspace's,
//     answers `found: false` with empty lists — never a 404 (no existence oracle).

/** The tab key prefix: `ticket:<ident>` (the ident verbatim; URLSearchParams escapes it in `view=`). */
export const TICKET_TAB_PREFIX = 'ticket:';

/** PRs listed per state at most (a payload guard; a real ticket rarely has more). */
export const TICKET_PRS_MAX = 100;

export interface TicketPrsTicket {
  key: string;
  /** From the freshest stored row; null when never read. */
  title: string | null;
  /** Browse URL — render through `safeExternalUrl`. */
  url: string | null;
  provider: TrackerProvider;
  status: { name: string; category: JiraStatusCategory | null } | null;
}

export interface TicketPrsResponse {
  workspaceId: number;
  /** Echo of the request's ident. */
  ident: string;
  /** false = unparseable, or not this workspace tracker's site: everything below is empty. */
  found: boolean;
  /** null when `found` is false or no stored row exists for it on this site. */
  ticket: TicketPrsTicket | null;
  /** Newest activity first (as /api/open-prs). */
  open: TimelinePr[];
  /** Newest merge first. */
  merged: TimelinePr[];
  /** Closed without merging, newest first. */
  closed: TimelinePr[];
  /** PRs on this ticket in repos outside this workspace — counted, not listed. */
  outsideWorkspace: number;
  /** A list hit TICKET_PRS_MAX. */
  truncated: boolean;
}
