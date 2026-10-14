// The Open PRs cards wait for their TICKETS before the first paint (OpenPrsCards.tsx).
//
// Where the workspace has a tracker, the cards are grouped into ticket stacks and every card in the
// list carries a ticket row. Both come from a SECOND answer (`POST /api/ticket-links`) that lands a
// moment after the PRs, and painting the PRs first made the whole page redraw into stacks under the
// reader's eyes. So the first paint waits for both — but never for ever: a failed or slow ticket
// answer falls back to the plain list.
//
// This is the pure half: what the cards may paint right now, and the latch (only the FIRST paint
// waits; a background refetch keeps the last pair on screen, for at most TICKET_WAIT_MS). The hook
// (hooks/useOpenPrsTicketGate.ts) only wires them to React.

/** How long a paint waits for the ticket answer: the first before showing the plain list, a refetch
 *  before painting the new PRs with the tickets already on screen. */
export const TICKET_WAIT_MS = 6000;

/**
 * - `wait`: show the loading placeholder.
 * - `ready`: paint — with tickets where the tracker runs, without where it does not.
 * - `fallback`: paint the plain list; the ticket answer failed or is too slow.
 */
export type TicketGate = 'wait' | 'ready' | 'fallback';

export function ticketGate(input: {
  /** The workspace's tracker settings have answered (or failed). */
  trackerKnown: boolean;
  /** This workspace has a tracker (`useTrackerOn`). */
  ticketsOn: boolean;
  /** Cards to paint. No cards ⇒ no ticket request is made, so nothing to wait for. */
  prCount: number;
  /** The ticket answer for THIS set of PRs is here. */
  ticketsAnswered: boolean;
  /** The ticket request failed. */
  ticketsFailed: boolean;
  /** `TICKET_WAIT_MS` has passed while waiting. */
  timedOut: boolean;
}): TicketGate {
  const { trackerKnown, ticketsOn, prCount, ticketsAnswered, ticketsFailed, timedOut } = input;
  if (prCount === 0) return 'ready';
  if (!trackerKnown) return timedOut ? 'fallback' : 'wait';
  if (!ticketsOn || ticketsAnswered) return 'ready';
  if (ticketsFailed || timedOut) return 'fallback';
  return 'wait';
}

// ── The latch (hooks/useOpenPrsTicketGate.ts), pure so it can be tested ─────────────────────────────

/** What is painted: the PRs and the ticket answer taken together, for one workspace. */
export interface TicketSnapshot<P, T> {
  ws: number | null;
  prs: P[];
  ticketData: T | undefined;
  /** The FIRST paint for this workspace fell back to the plain list. */
  fellBack: boolean;
}

/**
 * The next snapshot. `prior` is the one on screen for THIS workspace (null = none yet). A snapshot is
 * taken only once the PR query has really ANSWERED (`answered`): a query not started yet also reads as
 * "no PRs", so `livePrs.length` can never mean "answered". An answered EMPTY list IS snapshotted — the
 * last open PR closing, or a filter with nothing in it, must show the empty state, never the old cards.
 */
export function nextTicketSnapshot<P, T>(
  prior: TicketSnapshot<P, T> | null,
  input: { ws: number | null; answered: boolean; gate: TicketGate; livePrs: P[]; ticketsOn: boolean; ticketData: T | undefined },
): TicketSnapshot<P, T> | null {
  const { ws, answered, gate, livePrs, ticketsOn, ticketData } = input;
  if (!answered) return prior;
  if (gate === 'ready') return { ws, prs: livePrs, ticketData: ticketsOn ? ticketData : undefined, fellBack: prior?.fellBack ?? false };
  if (gate === 'fallback') {
    return {
      ws,
      prs: livePrs,
      // Keep a ticket answer already on screen (a refetch failed or was slow) rather than drop the rows.
      ticketData: prior?.ticketData ?? (ticketsOn ? ticketData : undefined),
      // Only a FIRST paint that fell back holds the list; a later one keeps what is shown.
      fellBack: prior?.fellBack ?? true,
    };
  }
  return prior;
}

/** The snapshot's PRs, less any the answered live list no longer has (merged, closed, filtered out):
 *  a PR that is gone never lingers while the new ticket answer is on its way. */
export function paintedPrs<P extends { id: number }>(snap: TicketSnapshot<P, unknown> | null, livePrs: P[], answered: boolean): P[] {
  if (snap == null) return livePrs;
  if (!answered) return snap.prs;
  const live = new Set(livePrs.map((p) => p.id));
  const kept = snap.prs.filter((p) => live.has(p.id));
  return kept.length === snap.prs.length ? snap.prs : kept;
}

/** The wait timer's key: a new PR set (a refetch, a filter) waits — and times out — afresh. */
export function ticketWaitKey(ws: number | null, prIds: readonly number[]): string {
  return `${ws ?? 'none'}|${[...prIds].sort((a, b) => a - b).join(',')}`;
}
