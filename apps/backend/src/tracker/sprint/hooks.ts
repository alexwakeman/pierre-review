// The one seam between the tracker's sprint read (core, both modes) and the story labelling it
// starts afterwards (agentic, LOCAL ONLY — review/sprint-labels/, registered through
// `registerAgenticRoutes`). Unset — cloud, or AI disabled — a read labels nothing.

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
    /* labelling is best effort; the next read tries again */
  }
}
