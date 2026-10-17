import type { JiraStatusCategory, TimelinePr, TrackerProvider } from './types.js';
import type { SprintBrief, SprintBriefState } from './sprint-graph.js';

// THE STORY VIEW (the ticket tab) — one ticket's story and pull requests, in isolation (docs/FRONTEND.md § The story view;
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

// ── The story view's ticket text and brief ───────────────────────────────────────────────────────
//
//   GET /api/ticket-story?workspace=<id>&ident=<trackerTicketIdent>  →  TicketStoryResponse
//
// DB-only (`read` tier), CORE and FREE. ONE ticket's stored SPRINT text (this workspace's
// `sprint_tickets` row, in the sprint or not, else its `sprint_ref_tickets` row) on the tracker's
// CURRENT site, and its CURRENT sprint brief (Claude's summary + itemised criteria; text hash +
// SPRINT_BRIEF_VERSION). It is how a ticket with NO pull request still gets its header facts, its
// story and its summary. Workspace resolution as above; an ident Limn holds no sprint text for answers
// `found: false` with nulls — never a 404.

export interface TicketStoryTicket {
  key: string;
  title: string | null;
  url: string | null;
  provider: TrackerProvider;
  status: { name: string; category: JiraStatusCategory | null } | null;
  issueType: string | null;
  assignee: { name: string; avatarUrl: string | null } | null;
  epic: { key: string; title: string | null } | null;
  /** In this workspace's current sprint. */
  inSprint: boolean;
}

export interface TicketStoryResponse {
  workspaceId: number;
  ident: string;
  found: boolean;
  ticket: TicketStoryTicket | null;
  /** 'current' = `brief` is today's; 'pending' = the brief pass will read this text after the next
   *  sprint read; 'off' = agentic AI does not run here; 'none' = nothing will summarise it (not found,
   *  or it left the sprint). */
  briefState: SprintBriefState | 'none';
  /** The CURRENT brief only; null otherwise. */
  brief: SprintBrief | null;
  /** The ticket's text as the sprint read stored it ('' when empty); null when not found. */
  story: { description: string; acceptanceCriteria: string } | null;
}
