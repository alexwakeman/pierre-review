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
