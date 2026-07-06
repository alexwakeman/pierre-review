import type { ConsolidatedFeedItem } from '@pierre-review/shared';

// The FYI / "My Turn" feed-enrichment seam. The Consolidated Feed itself is CORE (the plain
// chronological activity stream every tier sees), but the participation intelligence that
// flags each item `isMyTurn` — "this event is on a PR you're involved in, by someone else"
// — is a PAID capability. That logic lives ONLY in the private @pierre/pro plugin, which
// registers a provider here at boot (bind.ts wires `registerFyiProvider` into the
// ProContext). Mirrors review/events.ts' learnings-provider registry: a single nullable
// provider, null ⇒ inert ⇒ the feed renders plain (isMyTurn:false everywhere).
//
// The provider mutates the CORE ConsolidatedFeedItem shape in place — the FYI fields
// (isMyTurn / myTurnReasons / reasonTag) exist on the type with plain defaults, so an
// un-enriched item is a valid, plain feed row.
export interface FyiProvider {
  // Resolve participation over the items' PRs and flag each in place. Runs BEFORE the feed's
  // cap so uncapped-my-turn rows survive. accountId scopes every read.
  enrich(accountId: number, items: ConsolidatedFeedItem[]): Promise<void>;
  // How many FYI (My-Turn) feed items are NEW since `since` — the Welcome-back banner count
  // surfaced via /api/me. 0 when there's no provider (free tier) or no viewer identity.
  countNewSince(accountId: number, since: Date): Promise<number>;
}

// Process-local singleton, registered once at boot inside the plugin's register(). Inert in
// OSS (no plugin → never registered → the feed stays plain and the banner count stays 0).
let provider: FyiProvider | null = null;

export function registerFyiProvider(p: FyiProvider): void {
  provider = p;
}

export function getFyiProvider(): FyiProvider | null {
  return provider;
}
