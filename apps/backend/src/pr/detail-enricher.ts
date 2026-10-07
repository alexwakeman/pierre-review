import type { TicketRef } from '@pierre-review/shared';

// PrDetail.tickets — the PR's tracker tickets, compute-on-read from the PR title + head branch
// against its WORKSPACE's tracker. Until apiVersion 23 this was a plugin seam
// (`registerPrDetailEnricher`, inert in OSS); the tracker is CORE now (tracker/enricher.ts), so
// `getPrDetail` answers it in every install, plugin or not.
export interface PrEnrichInput {
  accountId: number;
  prId: number;
  repoId: number;
  repoFullName: string;
  title: string;
  headRefName: string | null;
}

// The tri-state PrDetail.tickets value: null = no tracker for this PR's workspace; [] = a tracker
// is configured but no ticket key was found; [..] = detected tickets. Never throws.
export async function resolvePrTickets(input: PrEnrichInput): Promise<TicketRef[] | null> {
  try {
    // Lazy: tracker/runtime.ts opens the database client at import time (see tracker/ticket-source.ts).
    const [{ prTicketRefs }, { trackerContext }] = await Promise.all([
      import('../tracker/enricher.js'),
      import('../tracker/runtime.js'),
    ]);
    return await prTicketRefs(trackerContext(), input);
  } catch {
    return null; // enrichment is best-effort; never fail the PR-detail read
  }
}
