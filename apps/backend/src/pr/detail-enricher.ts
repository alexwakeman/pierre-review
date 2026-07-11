import type { TicketRef } from '@pierre-review/shared';

// PR-detail enrichment seam. Core `getPrDetail` builds the base PrDetail; the private @pierre/pro
// plugin registers an enricher here (bind.ts wires registerPrDetailEnricher into the ProContext)
// that computes Jira/Linear ticket links COMPUTE-ON-READ from the PR title + head branch against
// the account's configured provider/base URL. Mirrors review/events.ts: a single nullable
// provider, null ⇒ inert ⇒ PrDetail.tickets stays null (no ticket UI, free tier). accountId
// scopes every read the enricher does.
export interface PrEnrichInput {
  accountId: number;
  prId: number;
  repoId: number;
  repoFullName: string;
  title: string;
  headRefName: string | null;
}

export interface PrTicketEnrichment {
  // Whether a ticket provider (Jira/Linear) is configured for this account. When true and
  // `tickets` is empty, core renders a muted "No ticket found"; when false core renders nothing
  // (PrDetail.tickets → null).
  configured: boolean;
  tickets: TicketRef[];
}

export type PrDetailEnricher = (
  input: PrEnrichInput,
) => Promise<PrTicketEnrichment | null> | PrTicketEnrichment | null;

// Process-local singleton, registered once at boot inside the plugin's register(). Inert in OSS.
let enricher: PrDetailEnricher | null = null;

export function registerPrDetailEnricher(e: PrDetailEnricher): void {
  enricher = e;
}

export function getPrDetailEnricher(): PrDetailEnricher | null {
  return enricher;
}

// Resolve the tri-state PrDetail.tickets value via the registered enricher (if any), so
// getPrDetail calls exactly one helper. null = feature off / no provider configured; [] = a
// provider is configured but no ticket key was found; [..] = detected tickets. Never throws.
export async function resolvePrTickets(
  input: PrEnrichInput,
): Promise<TicketRef[] | null> {
  const e = enricher;
  if (!e) return null;
  try {
    const res = await e(input);
    if (!res || !res.configured) return null;
    return res.tickets;
  } catch {
    return null; // enrichment is best-effort; never fail the PR-detail read
  }
}
