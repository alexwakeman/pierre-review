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

/** The same labelling, asked for by a VIEW: `GET /api/sprint-stories` calls this when a listed ticket's
 *  label is still pending (no current label — new text, or a rubric bump). Deduped per (account,
 *  workspace) to once a minute, so a page that refetches does not keep re-queuing; the run itself
 *  skips current labels and a busy slot. Never throws. */
export const SPRINT_LABEL_VIEW_MIN_INTERVAL_MS = 60_000;
const lastViewAsk = new Map<string, number>();

export function sprintViewedWithPendingLabels(accountId: number, workspaceId: number, nowMs = Date.now()): boolean {
  if (hook == null) return false;
  const k = `${accountId}:${workspaceId}`;
  const last = lastViewAsk.get(k);
  if (last != null && nowMs - last < SPRINT_LABEL_VIEW_MIN_INTERVAL_MS) return false;
  lastViewAsk.set(k, nowMs);
  afterSprintRead(accountId, workspaceId);
  return true;
}

/** Test seam: forget the view dedupe. */
export function resetSprintViewDedupe(): void {
  lastViewAsk.clear();
}
