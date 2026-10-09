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
// `addable`: the workspace has a READING tracker, so a ticket can be added by hand — true even while
// `tickets` is null because the PR's GitHub Issues links are not read yet.
export async function resolvePrTickets(
  input: PrEnrichInput,
): Promise<{ tickets: TicketRef[] | null; addable: boolean }> {
  try {
    // Lazy: tracker/runtime.ts opens the database client at import time (see tracker/ticket-source.ts).
    const [{ prTicketView }, { trackerContext }] = await Promise.all([
      import('../tracker/enricher.js'),
      import('../tracker/runtime.js'),
    ]);
    return await prTicketView(trackerContext(), input);
  } catch {
    return { tickets: null, addable: false }; // enrichment is best-effort; never fail the PR-detail read
  }
}
