// Client-driven per-PR freshness — the body of POST /api/prs/:id/refresh (the SPA's ~5s
// PrDetail poll + its manual Refresh button). See docs/REALTIME-SYNC.md § "Live PR-detail
// refresh".
//
// The POLL variant is PROBE-GATED so an idle open pane costs ~nothing: a conditional REST
// GET of the PR (If-None-Match) answers "did updated_at move?" and a 304 is free — GitHub
// doesn't count it against the REST quota. Only a 200, or the forced-walk floor below,
// pays for the real work (syncOnePr, ~1 GraphQL pt). The floor exists because the probe is
// BLIND to exactly what a live pane most wants: CI-finish and thread-resolve never bump
// updated_at (the same blindness sync/adaptive.ts documents with its 1800s repo floor —
// this one is 30s because a human is looking at THIS PR right now).
//
// The MANUAL variant (wait: true) is the resyncPrAfterWrite composition: unconditional
// hydration bust, then queue behind any in-flight sync (waitForInFlight) and fetch — the
// click's answer must be a read of GitHub AFTER now.
//
// NOTHING here throws, mirroring resync-after-write: a refresh failure must never become
// a 5xx — the stored PR is still perfectly renderable; the route reports {synced:false}
// and the client renders a subtle stale note, never an error.
import type { FastifyBaseLogger } from 'fastify';
import type { PrRefreshResponse } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { ghRestGetConditional } from '../github/client.js';
import { invalidatePrHydration } from './hydrate-detail.js';
import {
  asSyncLogger,
  getPrSyncTarget,
  type PrSyncTarget,
} from './resync-after-write.js';
import { isPrSyncInFlight, syncOnePr } from './sync-one-pr.js';

// Per-(accountId, prId) probe memory: the last ETag GitHub handed us + when this route
// last paid for a full walk. In-memory per process (like adaptive.ts's cadence map) — a
// restart just costs each polled PR one extra walk.
interface ProbeState {
  etag: string | null;
  lastWalkAt: number; // ms epoch of the last full walk from this route; 0 = never
}

// Bounded with the HYDRATE_CACHE_MAX FIFO pattern: a browse over many PRs must not grow
// this without limit, and an evicted entry only costs that PR one extra probe-200 + walk.
const PROBE_STATE_MAX = 500;
const probeState = new Map<string, ProbeState>();
const probeKey = (accountId: number, prId: number): string => `${accountId}:${prId}`;

function rememberProbeState(key: string, next: ProbeState): void {
  if (!probeState.has(key) && probeState.size >= PROBE_STATE_MAX) {
    // Oldest-inserted first (Map preserves insertion order) — a plain FIFO trim, exactly
    // like the hydrate cache's.
    const oldest = probeState.keys().next().value;
    if (oldest !== undefined) probeState.delete(oldest);
  }
  probeState.set(key, next);
}

// The forced-full-walk floor: how stale checks/thread-resolves may go while the probe
// keeps 304ing. Half a minute keeps a green CI tick honest without paying the ~2 pts
// (walk + the client's re-hydration) more than ~120×/hour per open pane.
const WALK_FLOOR_MS = 30_000;

/**
 * Refresh ONE PR from GitHub on the client's behalf. Returns null when the PR isn't the
 * caller's (route 404s); otherwise ALWAYS a PrRefreshResponse — sync failures are
 * reported as {synced:false}, never thrown.
 */
export async function refreshPrFromGitHub(args: {
  prId: number;
  accountId: number;
  wait: boolean;
  log: FastifyBaseLogger;
}): Promise<PrRefreshResponse | null> {
  const { prId, accountId, wait, log } = args;
  // Account-scoped resolve — the same structural isolation as the post-write resync this
  // route descends from. Foreign/unknown id → null → 404 upstream.
  const target = await getPrSyncTarget(prId, accountId);
  if (!target) return null;
  const before = target.updatedAt;

  try {
    if (wait) {
      // A manual walk IS a full walk — reset the poll's floor clock (keeping the stored
      // ETag) so the next tick inside the window doesn't floor-walk again for nothing.
      const key = probeKey(accountId, prId);
      rememberProbeState(key, {
        etag: probeState.get(key)?.etag ?? null,
        lastWalkAt: Date.now(),
      });
      // Every manual walk is potentially-changed: the user asked for current state, and
      // the hydration bust below means only an invalidation repaints their checks.
      return await walkAndReport({ target, prId, accountId, before, wait, log, forced: true });
    }

    const key = probeKey(accountId, prId);
    const state = probeState.get(key);
    const now = Date.now();
    const floorDue = !state || now - state.lastWalkAt >= WALK_FLOOR_MS;

    // Probe EVERY tick, not only when the floor isn't due: a 304 is free, and keeping the
    // stored ETag current is what lets the next tick 304 instead of re-paying for a walk
    // this tick already did.
    let probeChanged = true; // no stored ETag / probe failure ⇒ must walk
    let nextEtag = state?.etag ?? null;
    try {
      const probe = await ghRestGetConditional(
        await getAccessToken(accountId),
        `/repos/${target.owner}/${target.name}/pulls/${target.number}`,
        nextEtag,
      );
      probeChanged = !probe.notModified;
      if (probe.etag != null) nextEtag = probe.etag;
    } catch {
      // Network failure — fall through to a walk rather than silently skipping (the same
      // contract ghRestGetConditional applies to a non-2xx).
    }

    if (!probeChanged && state && now - state.lastWalkAt < WALK_FLOOR_MS) {
      // Nothing changed and the floor isn't due: the stored row IS current, at zero
      // GitHub cost (the 304 is unbilled).
      rememberProbeState(key, { etag: nextEtag, lastWalkAt: state.lastWalkAt });
      return { synced: true, changed: false, updatedAt: before.toISOString() };
    }

    rememberProbeState(key, { etag: nextEtag, lastWalkAt: now });
    // A walk the 304ing probe couldn't justify — the floor forced it for the probe's
    // blind spots (checks, thread-resolves) — is potentially-changed even when updatedAt
    // holds still. A probe-200 walk lets the updatedAt comparison decide (REST payload
    // fields like mergeable_state churn ETags without real activity).
    return await walkAndReport({
      target,
      prId,
      accountId,
      before,
      wait,
      log,
      forced: !probeChanged,
    });
  } catch (err) {
    log.warn({ err }, `refreshPr: PR ${prId} failed`);
    return { synced: false, changed: false, updatedAt: before.toISOString() };
  }
}

async function walkAndReport(args: {
  target: PrSyncTarget;
  prId: number;
  accountId: number;
  before: Date;
  wait: boolean;
  log: FastifyBaseLogger;
  forced: boolean; // treat the walk itself as potentially-changed (floor / manual)
}): Promise<PrRefreshResponse> {
  const { target, prId, accountId, before, wait, log, forced } = args;
  // Order load-bearing (the resync-after-write rule): bust the 60s hydration cache
  // BEFORE the walk, so even if the sync fails the client's follow-up GET /api/prs/:id
  // can't be served the pre-walk snapshot — in lean mode checkRuns render ONLY from that
  // overlay.
  invalidatePrHydration(accountId, target.owner, target.name, target.number);
  // Sampled BEFORE the call: the no-wait poll treats a stand-down as "a sync literally
  // just ran — that freshness is the answer", not as a failure. (The entry can only be
  // RELEASED between the sample and the call, in which case syncOnePr runs for real.)
  const inFlightAtStart = isPrSyncInFlight(target.repoId, target.number);
  const synced =
    (await syncOnePr(target.repoId, target.number, asSyncLogger(log), wait ? { waitForInFlight: true } : undefined)) ||
    (!wait && inFlightAtStart);
  const after = await getPrSyncTarget(prId, accountId);
  const afterAt = after?.updatedAt ?? before;
  const changed = synced && (forced || afterAt.getTime() !== before.getTime());
  return { synced, changed, updatedAt: afterAt.toISOString() };
}

// Test-only: reset the module's in-memory probe state between cases.
export function __resetPrRefreshState(): void {
  probeState.clear();
}
