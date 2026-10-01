// The server → SPA "something on a PR changed" signal — one timestamp per (account, repo).
//
// WHY IT EXISTS. The SPA learns about a finished repo WALK through the `['repos']` poll
// (SyncStatus reads `lastIncrementalSyncAt` / `lastFullSyncAt` and cascades one invalidation
// over every screen). Everything that changes a PR OUTSIDE a walk was invisible to that path:
// a webhook's targeted sync, the post-write settle ladder (sync/pr-settle.ts), the unsettled-PR
// backstop and the trunk-moved recheck (sync/unsettled-prs.ts), the Pending liveness sweep, and
// the local stamps a write route makes. Targeted syncs deliberately never advance `sync_state`,
// so the SPA had no way to know. This is that way: `GET /api/repos` carries
// `Repo.lastPrChangeAt`, and the SPA's existing 30s poll cascades when it moves.
//
// ⚠ NEVER A `sync_state` CURSOR. `last_incremental_sync_at` is the WALK cursor — `planSync`
// derives the next walk's `since` from it — so bumping it for a targeted change would make the
// next walk skip every PR updated between the real walk and the bump. This signal lives in
// memory and nothing reads it but the listing.
//
// ⚠ DIFF-GATED BY ITS CALLERS. A bump costs the SPA a cascade of refetches (three of them on the
// `search` rate-limit tier), so it must mean "a board-visible column actually moved", never
// "a row was written". Every caller compares before it calls: persistPr against its `prev` row,
// the liveness applies against `movedOnBoard`, a local stamp only after it wrote something.
//
// In-memory per process, on the refresh-pr.ts / auth-notices.ts pattern: a restart loses the
// values, which reads on the SPA as "no change signal yet" — the next real change repopulates it,
// and the walk-completion path is unaffected. Cloud runs one Fastify process, so the writer and
// the listing share the map.

// Bounded like refresh-pr's PROBE_STATE_MAX: one entry per (account, repo) that ever changed.
// An evicted entry only costs its repo one missed cascade, which the next walk's own
// `sync_state` stamp (or the next change) repairs.
const SIGNAL_MAX = 5_000;
const lastChange = new Map<string, number>();
const keyOf = (accountId: number, repoId: number): string => `${accountId}:${repoId}`;

// ── Listeners: server-side caches that must not outlive a change ─────────────────────────────
//
// A server cache over the same fold the SPA re-reads (db/daily-brief.ts's roll-up counts) would
// otherwise keep answering with the pre-change population for its whole TTL after the SPA was told
// to refetch. ⚠ THIS MODULE IMPORTS NOTHING — every writer imports IT, so an import from here into
// a cache module would drag that module (and its query layer) into every writer and risk a cycle.
// The cache registers itself instead, at its own module load, so a process that never loaded the
// cache has no cache to clear either.
type PrChangeListener = (accountId: number, repoId: number) => void;
const listeners = new Set<PrChangeListener>();

/**
 * Call `listener` synchronously every time `notePrChanged` raises the signal. Returns the
 * unsubscribe. A listener that throws is contained: the signal (and every other listener) still
 * lands, because the signal is advisory and must never fail the write that raised it.
 */
export function onPrChanged(listener: PrChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record that a board-visible fact about one of this repo's pull requests just changed.
 * EXPORTED for every writer that is not a walk — including a later merge-queue stamp.
 *
 * Strictly increasing per key (a second change inside the same millisecond still moves the
 * value), so the SPA's "did it move?" comparison can never swallow a real change.
 */
export function notePrChanged(accountId: number, repoId: number): void {
  const key = keyOf(accountId, repoId);
  const prev = lastChange.get(key);
  const next = prev != null ? Math.max(Date.now(), prev + 1) : Date.now();
  // Delete-then-set keeps Map insertion order = recency, so the FIFO trim below evicts the
  // repo that changed LONGEST ago rather than the one that changed first.
  if (prev != null) lastChange.delete(key);
  else if (lastChange.size >= SIGNAL_MAX) {
    const oldest = lastChange.keys().next().value;
    if (oldest !== undefined) lastChange.delete(oldest);
  }
  lastChange.set(key, next);
  for (const l of listeners) {
    try {
      l(accountId, repoId);
    } catch {
      /* contained — see onPrChanged */
    }
  }
}

/** The repo's last recorded PR change, or null when none has been seen by this process. */
export function lastPrChangeAt(accountId: number, repoId: number): Date | null {
  const ms = lastChange.get(keyOf(accountId, repoId));
  return ms != null ? new Date(ms) : null;
}

/**
 * Decorate a repo listing with `lastPrChangeAt` (ISO), for THIS account only — the key carries
 * the accountId, so another tenant's repo id can never read a value it did not earn. A repo
 * with no recorded change gets NO key at all (the field is optional on the wire), never null.
 */
export function withPrChangeSignal<T extends { id: number }>(
  accountId: number,
  rows: T[],
): Array<T & { lastPrChangeAt?: string }> {
  return rows.map((r) => {
    const at = lastPrChangeAt(accountId, r.id);
    return at ? { ...r, lastPrChangeAt: at.toISOString() } : r;
  });
}

/** Test-only: clear the in-memory signal. Listeners are NOT dropped: they are module-load
 *  registrations (a cache's own), and a reset that dropped them would silently disarm the cache
 *  for every later test in the file. */
export function __resetPrChangeSignal(): void {
  lastChange.clear();
}
