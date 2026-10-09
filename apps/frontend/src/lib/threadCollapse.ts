// ── THE THREADS TAB'S OPEN/CLOSED RULE, AND WHAT A RESOLVE DOES TO IT ───────────────────────
//
// A resolved thread shows as one line until the reader opens it; every other state stays open.
// Resolving used to leave the thread wide open: the refetch had not landed yet, and the thread
// you just resolved is usually the SELECTED one, which was forced open for ever. Now a successful
// resolve (from ANY surface — the Threads tab, the Claude Review tab, a Pending card; they share
// `RESOLVE_THREAD_MUTATION_KEY`) collapses it at once:
//   - the thread counts as resolved locally until the refetch agrees (`overrides`),
//   - it leaves the reader's opened set,
//   - and if it is the selected thread, selection stops forcing it open (`released`) — once. The
//     reader can still open it again by clicking, and a NEW selection forces it open as before.
// Unresolving re-opens it (it is no longer resolved, and every unresolved thread is open).

export interface ThreadCollapseState {
  /** Resolved threads the reader has opened. */
  expanded: ReadonlySet<number>;
  /** Local resolved/unresolved verdicts awaiting the refetch, by thread id. */
  overrides: ReadonlyMap<number, boolean>;
  /** Threads whose forced-open-by-selection was released by a resolve. */
  released: ReadonlySet<number>;
}

export const EMPTY_THREAD_COLLAPSE: ThreadCollapseState = {
  expanded: new Set(),
  overrides: new Map(),
  released: new Set(),
};

/** The effective resolved state: a local verdict beats the server's until the server agrees. */
export function effectiveResolved(
  serverResolved: boolean,
  threadId: number,
  overrides: ReadonlyMap<number, boolean>,
): boolean {
  return overrides.get(threadId) ?? serverResolved;
}

/** Selection forces a thread open unless a resolve released it. */
export function forcedOpen(selected: boolean, threadId: number, released: ReadonlySet<number>): boolean {
  return selected && !released.has(threadId);
}

/** Is this thread's card open? */
export function threadIsOpen(args: {
  resolved: boolean;
  selected: boolean;
  threadId: number;
  state: ThreadCollapseState;
}): boolean {
  const { resolved, selected, threadId, state } = args;
  return !resolved || forcedOpen(selected, threadId, state.released) || state.expanded.has(threadId);
}

/** Apply successful resolve/unresolve writes, in the order they were made. */
export function applyResolveEvents(
  state: ThreadCollapseState,
  events: readonly { threadId: number; resolved: boolean }[],
): ThreadCollapseState {
  if (events.length === 0) return state;
  const expanded = new Set(state.expanded);
  const overrides = new Map(state.overrides);
  const released = new Set(state.released);
  for (const e of events) {
    overrides.set(e.threadId, e.resolved);
    expanded.delete(e.threadId);
    if (e.resolved) released.add(e.threadId);
    else released.delete(e.threadId);
  }
  return { expanded, overrides, released };
}

/** Drop each local verdict the server now agrees with (or whose thread is gone), so a later
 *  change on GitHub is never masked by a stale one. Returns the SAME object when nothing moved. */
export function pruneOverrides(
  state: ThreadCollapseState,
  serverResolvedById: ReadonlyMap<number, boolean>,
): ThreadCollapseState {
  let next: Map<number, boolean> | null = null;
  for (const [id, resolved] of state.overrides) {
    const server = serverResolvedById.get(id);
    if (server === undefined || server === resolved) {
      next ??= new Map(state.overrides);
      next.delete(id);
    }
  }
  return next == null ? state : { ...state, overrides: next };
}

/** The reader clicked a resolved thread's line (or its Collapse control). */
export function toggleExpanded(state: ThreadCollapseState, threadId: number): ThreadCollapseState {
  const expanded = new Set(state.expanded);
  const released = new Set(state.released);
  if (expanded.has(threadId)) {
    expanded.delete(threadId);
    // Collapsing the selected thread by hand keeps it collapsed.
    released.add(threadId);
  } else {
    expanded.add(threadId);
  }
  return { ...state, expanded, released };
}
