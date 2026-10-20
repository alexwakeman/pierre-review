import type { SprintRefreshTicketChecks } from '@pierre-review/shared';

// The seams between the tracker's sprint read (core, both modes) and the BRIEF PASS it starts afterwards
// (agentic, LOCAL ONLY — review/sprint-briefs/, registered through `registerAgenticRoutes`).
//
//   • `afterSprintRead` — set by the brief pass: a stored read hands the workspace to it. Unset (cloud,
//     AI disabled) → a read briefs nothing.
//   • `expandGhostsAfterBriefs` — set by the tracker (`startSprintRead`): the pass briefed new ghosts,
//     so look up the tickets THEY point at (the next hop of the chain). Part of the read's pipeline —
//     no view ever reaches either seam.

type AfterSprintRead = (accountId: number, workspaceId: number) => void;
let hook: AfterSprintRead | null = null;

export function setAfterSprintRead(fn: AfterSprintRead | null): void {
  hook = fn;
}

/** Called after a successful sprint read is stored. Never throws. */
export function afterSprintRead(accountId: number, workspaceId: number): void {
  try {
    hook?.(accountId, workspaceId);
  } catch {
    /* the brief pass is best effort; the next read tries again */
  }
}

type GhostExpander = (accountId: number, workspaceId: number) => Promise<number>;
let expander: GhostExpander | null = null;

export function setSprintGhostExpander(fn: GhostExpander | null): void {
  expander = fn;
}

/** Look up the ghost chain's next hop; the rows stored (0 when unset or nothing new). Never throws. */
export async function expandGhostsAfterBriefs(accountId: number, workspaceId: number): Promise<number> {
  try {
    return (await expander?.(accountId, workspaceId)) ?? 0;
  } catch {
    return 0;
  }
}

// `startSprintTicketChecks` — set by the ticket review (review/ticket-review/sprint-checks.ts, agentic,
// LOCAL ONLY): a MANUAL refresh (POST /api/sprint-stories/refresh) may start up to
// SPRINT_REFRESH_TICKET_CHECKS ticket checks. Unset (cloud, AI disabled) → null, and the refresh
// response carries no `ticketChecks`.
type SprintTicketChecks = (accountId: number, workspaceId: number) => Promise<SprintRefreshTicketChecks>;
let checks: SprintTicketChecks | null = null;

export function setSprintTicketChecks(fn: SprintTicketChecks | null): void {
  checks = fn;
}

/** Start the refresh's ticket checks; null when no agentic seam is registered. Never throws. */
export async function startSprintTicketChecks(accountId: number, workspaceId: number): Promise<SprintRefreshTicketChecks | null> {
  if (checks == null) return null;
  try {
    return await checks(accountId, workspaceId);
  } catch {
    return { started: 0, skipped: null };
  }
}
