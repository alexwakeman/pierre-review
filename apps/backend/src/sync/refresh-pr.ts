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
import { isLimited } from '../github/rate-budget.js';
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
  lastWalkAt: number; // ms epoch of the last full walk ATTEMPT from this route; 0 = never
  // Whether that attempt ingested GitHub successfully. Load-bearing for honesty: a 304
  // only proves GitHub didn't move SINCE THE STORED ETAG — it says nothing about whether
  // the last walk actually landed. While false, every non-walking tick must keep
  // reporting {synced:false}, or a failed walk would be laundered into "current" by the
  // very next 304.
  lastWalkOk: boolean;
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

  // While the account's token is rate-limited (github/rate-budget.ts — the sync's budget
  // gate or a limited error observed elsewhere), skip BOTH the probe and the walk: the
  // probe would fail non-304 and a walk would burn the budget a paused repo sync is
  // waiting for. `synced` carries the LAST walk's honesty exactly like a non-walking tick
  // (lastWalkOk semantics preserved — probeState is not touched); a manual refresh
  // reports {synced:false}, which the client renders as a subtle stale note, never an
  // error. The limited state self-clears and the ~5s poll picks up the next real tick.
  if (isLimited(accountId)) {
    const lastOk = probeState.get(probeKey(accountId, prId))?.lastWalkOk ?? true;
    return {
      synced: wait ? false : lastOk,
      changed: false,
      updatedAt: before.toISOString(),
    };
  }

  try {
    const key = probeKey(accountId, prId);
    if (wait) {
      // Every manual walk is potentially-changed: the user asked for current state, and
      // the hydration bust below means only an invalidation repaints their checks. The
      // stored ETag is deliberately KEPT — it describes GitHub-side content, not our sync
      // state, so a 304 against it stays truthful after the walk. State bookkeeping
      // (floor clock + outcome) happens AFTER the walk, in walkAndReport.
      return await walkAndReport({
        target, prId, accountId, before, wait, log,
        forced: true,
        stateKey: key,
        nextEtag: probeState.get(key)?.etag ?? null,
      });
    }

    const state = probeState.get(key);
    const now = Date.now();
    const floorDue = !state || now - state.lastWalkAt >= WALK_FLOOR_MS;

    // Probe EVERY tick, not only when the floor is due: a 304 is free, and keeping the
    // stored ETag current is what lets the next tick 304 instead of re-paying for a walk
    // this tick already did. Three outcomes, and they are NOT the same thing:
    //   'unchanged' — a real 304: GitHub affirms nothing moved since the stored ETag.
    //   'changed'   — a real 200: GitHub has something newer than the stored ETag.
    //   'unknown'   — non-2xx or network failure: the probe PROVED NOTHING. Treating this
    //                 as 'changed' (as this code originally did) turned a revoked token /
    //                 SAML wall into a full GraphQL walk EVERY 5s tick with no floor —
    //                 ~24 failing GitHub calls/min per open pane. Unknown ticks retry at
    //                 the floor cadence instead.
    let probe: 'unchanged' | 'changed' | 'unknown' = 'unknown';
    let nextEtag = state?.etag ?? null;
    try {
      const res = await ghRestGetConditional(
        await getAccessToken(accountId),
        `/repos/${target.owner}/${target.name}/pulls/${target.number}`,
        nextEtag,
      );
      if (res.notModified) {
        probe = 'unchanged';
      } else if (res.status >= 200 && res.status < 300) {
        probe = 'changed';
        if (res.etag != null) nextEtag = res.etag;
      }
      // Any non-2xx (403 SAML wall, 404 revoked access, 5xx) stays 'unknown' — the
      // helper never throws on those, so this branch IS the failure path.
    } catch {
      // Network failure — 'unknown'.
    }

    // Walk when the floor is due, or immediately on a genuine probe-200 — but only if the
    // last walk didn't fail. Once a walk has failed, retries happen at the FLOOR cadence
    // regardless of what the probe says (a GraphQL outage with healthy REST would
    // otherwise walk every tick: the un-stored ETag keeps the probe 200ing).
    const walkNow = floorDue || (probe === 'changed' && (state?.lastWalkOk ?? true));
    if (!walkNow) {
      // Not walking this tick. `synced` must carry the LAST walk's honesty, not the
      // probe's: a 304 after a failed walk means "GitHub still has what we failed to
      // ingest", which is exactly NOT "the stored row reflects GitHub".
      const lastOk = state?.lastWalkOk ?? true;
      if (probe === 'unchanged' && lastOk) {
        return { synced: true, changed: false, updatedAt: before.toISOString() };
      }
      return { synced: lastOk, changed: false, updatedAt: before.toISOString() };
    }

    // A walk the 304ing probe couldn't justify — the floor forced it for the probe's
    // blind spots (checks, thread-resolves) — is potentially-changed even when updatedAt
    // holds still. A probe-200 walk lets the updatedAt comparison decide (REST payload
    // fields like mergeable_state churn ETags without real activity).
    return await walkAndReport({
      target, prId, accountId, before, wait, log,
      forced: probe !== 'changed',
      stateKey: key,
      nextEtag,
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
  stateKey: string;
  nextEtag: string | null; // the probe's fresh ETag (or the kept one on a manual walk)
}): Promise<PrRefreshResponse> {
  const { target, prId, accountId, before, wait, log, forced, stateKey, nextEtag } = args;
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
  // Bookkeeping AFTER the outcome is known. The floor clock stamps on every ATTEMPT
  // (success or failure — that is what caps the retry cadence), but the fresh ETag is
  // committed ONLY on success: storing it before a failed walk would consume the change
  // signal, and every later 304 would launder the un-ingested change into "current".
  const prev = probeState.get(stateKey);
  rememberProbeState(stateKey, {
    etag: synced ? nextEtag : (prev?.etag ?? null),
    lastWalkAt: Date.now(),
    lastWalkOk: synced,
  });
  const after = await getPrSyncTarget(prId, accountId);
  const afterAt = after?.updatedAt ?? before;
  const changed = synced && (forced || afterAt.getTime() !== before.getTime());
  return { synced, changed, updatedAt: afterAt.toISOString() };
}

// Test-only: reset the module's in-memory probe state between cases.
export function __resetPrRefreshState(): void {
  probeState.clear();
}
