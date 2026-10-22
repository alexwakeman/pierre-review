// The synthesis PAYLOAD HASH (§8.2) — the $0-on-unchanged gate and the free GET's staleness
// probe, in ONE exported function so the two writers-of-truth (the POST's cache check and the
// GET's `stale` flag) cannot drift the way two hand-copied formulas do (the addressed-check
// lesson: both callers import the one function, neither re-spells it).
//
// WHAT IT FOLDS — and only this:
//   - SYNTHESIS_SCHEMA_VERSION + SYNTHESIS_PROMPT_VERSION: a bump is SELF-EXECUTING — every
//     stored row flips `stale` at once and regenerates on the next click (the
//     PERIOD_METRICS_SCHEMA_VERSION discipline).
//   - the scope key: the population's identity.
//   - analyzed/total counts: the coverage line is part of the output, so a total that moved with
//     an unchanged capped set still reads stale (the "Summarised X of Y" must not lie).
//   - the SORTED item ids + each item's created-at: the set, order-independent.
//
// WHAT IT MUST NEVER FOLD (§8.2):
//   - anything `Date.now()`-derived (no day-quantised windowKey here, unlike the themes hash — a
//     dormant scope must stay a cache hit forever);
//   - anything GitHub-hydrated or model-produced — the free GET recomputes this hash from
//     `getSynthesisInput` alone (plain DB reads) at zero external cost;
//   - item BODIES: bodies are re-upserted on every sync walk while ids + GitHub creation times
//     are stable, so folding text would flip rows stale on cosmetic re-syncs.
import { createHash } from 'node:crypto';
import type { SynthesisInput } from '@pierre-review/shared';

/** Bump when the stored output STRUCTURE changes shape. Self-invalidating via the hash. */
export const SYNTHESIS_SCHEMA_VERSION = 1;

/** Bump when the prompt materially changes (same rows should be re-grouped). Self-invalidating. */
// 1 → 2: the clusters prompt no longer asks for remainderIds (the server recomputes them; echoing
// them doubled the id traffic and, at the 250-item input cap, overran the output budget so the
// JSON truncated mid-stream — every large-scope Summarise 502'd "unparseable").
// 2 → 3: the ordering prompt forbids second person, and parseOrderingOutput now GATES on it.
// The bump is what makes that reach existing accounts: a stored phrase is keyed on this hash, so
// without it every already-narrated brief would keep serving "Items awaiting YOUR review or
// reply" over workspace-wide work until its counts happened to change.
export const SYNTHESIS_PROMPT_VERSION = 3;

export function synthesisPayloadHash(scopeKey: string, input: SynthesisInput): string {
  const sig = [
    `sv:${SYNTHESIS_SCHEMA_VERSION}`,
    `pv:${SYNTHESIS_PROMPT_VERSION}`,
    scopeKey,
    `n:${input.analyzedCount}/${input.totalCount}`,
    ...input.items.map((i) => `${i.id}@${i.createdAt}`).sort(),
  ].join('|');
  return createHash('sha256').update(sig).digest('hex');
}
