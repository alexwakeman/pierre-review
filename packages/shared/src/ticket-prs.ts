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

// ── The story view's status picker — THE ONE TRACKER WRITE (Jira only) ───────────────────────────
//
//   GET  /api/ticket-status/transitions?workspace=<id>&ident=…  →  TicketTransitionsResponse
//   POST /api/ticket-status?workspace=<id>  { ident, transitionId }  →  TicketStatusChangeResponse
//
// docs/TRACKERS.md § The status change. The GET is made when the picker OPENS, never on mount: one
// Jira call (`/rest/api/2/issue/{key}/transitions`), plus a permission check only when Jira offers
// nothing. The POST makes the transition the reader picked, re-reads the ticket's status and writes
// it to every stored row of that ticket. Both refuse a ticket Limn holds no row for (not a proxy),
// a workspace whose tracker is not Jira, and an ident on another site. Every failure answers a
// sentence Limn wrote, never Jira's.

export interface TicketTransition {
  /** Jira's transition id — what the POST sends back. */
  id: string;
  /** The transition's own name ("Start progress"). */
  name: string;
  /** The status it leads to. */
  to: { name: string; category: JiraStatusCategory | null };
}

export interface TicketTransitionsResponse {
  workspaceId: number;
  ident: string;
  /** Only the transitions Jira allows from the current status, in Jira's order. Transitions that
   *  need fields only Jira's own form asks for are left out. */
  transitions: TicketTransition[];
  /** false = the saved Jira token may not change this issue (asked only when `transitions` is
   *  empty); null = not asked, or Jira did not say. */
  canTransition: boolean | null;
}

export interface TicketStatusChangeBody {
  ident: string;
  transitionId: string;
}

export interface TicketStatusChangeResponse {
  workspaceId: number;
  ident: string;
  /** The status Jira reports after the change; null when the re-read failed (the change was made). */
  status: { name: string; category: JiraStatusCategory | null } | null;
}

/** The one-line refusal when the saved token may not change an issue. */
export const TICKET_STATUS_NO_PERMISSION = 'Your Jira token cannot change this issue.';
