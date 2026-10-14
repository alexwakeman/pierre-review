import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TicketLinksResponse, TimelinePr } from '@pierre-review/shared';
import { useTicketLinks } from './useTicketLinks.js';
import { useTrackerState } from './useWorkspaceTracker.js';
import {
  TICKET_WAIT_MS,
  nextTicketSnapshot,
  paintedPrs,
  ticketGate,
  ticketWaitKey,
  type TicketSnapshot,
} from '../lib/openPrsTicketGate.js';

// The Open PRs cards' FIRST PAINT waits for the ticket answer (lib/openPrsTicketGate.ts), so the
// page never paints a plain list and then redraws into ticket stacks.
//
// What is painted is a SNAPSHOT — the PRs and the ticket answer that go with them, taken together.
// Only the first paint for a workspace shows the loader; after it, a background refetch (a new PR, a
// repo filter, a ticket re-read) keeps the last snapshot on screen until the new pair is complete —
// for at most TICKET_WAIT_MS, then the new PRs paint with the tickets already known. A PR the live
// list no longer has leaves at once, and an answered empty list paints the empty state.
//
// A slow or failed ticket answer on the first paint paints the plain list (`fallback`). When the
// tickets do arrive later, a grouped view stays a list until the reader asks (`heldList` +
// `release`): one jump the reader chose, never one that happens to them.

export interface OpenPrsTicketGate {
  /** Show the loading placeholder instead of the cards. */
  waiting: boolean;
  /** The PRs to paint — the snapshot's, which may lag the live list by one ticket answer. */
  prs: TimelinePr[];
  /** The ticket answer that goes with `prs`. */
  ticketData: TicketLinksResponse | undefined;
  /** THIS workspace has a tracker. */
  ticketsOn: boolean;
  /** The first paint fell back to the list; grouping waits for the reader's click. */
  heldList: boolean;
  release: () => void;
}

export function useOpenPrsTicketGate(
  livePrs: TimelinePr[],
  workspaceId: number | null,
  isLoading: boolean,
  /** The PR query has really answered (its data is here). A query not started yet reads as "no PRs"
   *  and not loading, so `isLoading` alone cannot say it. */
  answered: boolean = !isLoading,
): OpenPrsTicketGate {
  const { on: ticketsOn, known: trackerKnown } = useTrackerState(workspaceId);
  const prIds = useMemo(() => livePrs.map((p) => p.id), [livePrs]);
  const ticketQuery = useTicketLinks(prIds, ticketsOn);
  const waitKey = ticketWaitKey(workspaceId, prIds);
  const [timedOutFor, setTimedOutFor] = useState<string | null>(null);
  const [releasedFor, setReleasedFor] = useState<number | null | undefined>(undefined);
  const snap = useRef<TicketSnapshot<TimelinePr, TicketLinksResponse> | null>(null);

  const gate = ticketGate({
    trackerKnown,
    ticketsOn,
    prCount: livePrs.length,
    ticketsAnswered: ticketQuery.data != null,
    ticketsFailed: ticketQuery.isError,
    timedOut: timedOutFor === waitKey,
  });

  const prior = snap.current != null && snap.current.ws === workspaceId ? snap.current : null;
  snap.current = nextTicketSnapshot(prior, {
    ws: workspaceId,
    answered: answered && !isLoading,
    gate,
    livePrs,
    ticketsOn,
    ticketData: ticketQuery.data,
  }) ?? snap.current;

  const shown = snap.current != null && snap.current.ws === workspaceId ? snap.current : null;
  const waiting = !isLoading && gate === 'wait' && shown == null;

  // The wait is bounded for EVERY pending ticket answer — the first paint's and a refetch's alike.
  const pendingKey = answered && !isLoading && gate === 'wait' ? waitKey : null;
  useEffect(() => {
    if (pendingKey == null) return;
    const t = setTimeout(() => setTimedOutFor(pendingKey), TICKET_WAIT_MS);
    return () => clearTimeout(t);
  }, [pendingKey]);

  const release = useCallback(() => setReleasedFor(workspaceId), [workspaceId]);

  return {
    waiting,
    prs: paintedPrs(shown, livePrs, answered && !isLoading),
    ticketData: shown?.ticketData,
    ticketsOn,
    heldList: shown?.fellBack === true && releasedFor !== workspaceId,
    release,
  };
}
