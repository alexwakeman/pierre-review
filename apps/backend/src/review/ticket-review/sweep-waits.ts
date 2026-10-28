import type { TicketReviewWait } from '@pierre-review/shared';

// WHY A STALE TICKET IS WAITING — written by the auto sweeper (sweep.ts rule 7), read by the states
// route (routes.ts) so the story view can say it. Its own module: the route must not load the sweeper
// (and through it the run manager). In memory, keyed `${accountId}:${ident}`: a restart forgets it,
// and the next tick says it again.
const waits = new Map<string, TicketReviewWait>();

const keyOf = (accountId: number, ident: string): string => `${accountId}:${ident}`;

export function setTicketSweepWait(accountId: number, ident: string, why: TicketReviewWait | null): void {
  if (why == null) waits.delete(keyOf(accountId, ident));
  else waits.set(keyOf(accountId, ident), why);
}

/** Why the sweeper is holding this ticket back right now; null when it is not. */
export function ticketSweepWait(accountId: number, ident: string): TicketReviewWait | null {
  return waits.get(keyOf(accountId, ident)) ?? null;
}

export function _resetTicketSweepWaitsForTest(): void {
  waits.clear();
}
