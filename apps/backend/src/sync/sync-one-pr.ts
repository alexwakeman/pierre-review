// Targeted single-PR sync — the shared core of Phase 0 real-time sync
// (see docs/REALTIME-SYNC.md).
//
// Instead of re-walking a repo's whole `since` window on a clock, `syncOnePr` fetches
// exactly ONE PR by number and runs it through the same idempotent persist path as the
// page walk (`persistPr`), so a webhook (cloud) or the adaptive scheduler (local) can
// refresh only what changed. Costs ~1 GraphQL point vs a multi-page walk.
//
// `enqueuePrSync` sits in front of it: a burst of change signals for the same PR — a push
// emits push + synchronize + check_run within seconds — coalesces into ONE syncOnePr
// fired after the burst settles (config.webhookDebounceMs). Nothing calls these yet;
// Phase 1 (webhooks) and Phase 2 (adaptive polling) wire them in.
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import {
  getGraphqlClientFor,
  graphqlChecksHint,
  graphqlTolerant,
  isSamlBlock,
  summarizeGraphqlErrors,
} from '../github/client.js';
import {
  PR_ACTIVITY_ONE_QUERY,
  type PrActivityOneResponse,
} from '../github/queries.js';
import { clearSamlBlock, recordSamlBlock } from './auth-notices.js';
import { ensureCommitFiles } from './commit-files.js';
import { createUserResolver, persistPr } from './upsert.js';
import type { Logger } from './sync-repo.js';

const { repos } = schema;

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// One in-flight targeted sync per (repoId, prNumber). Mirrors sync-manager's `running`
// set: reserved synchronously before any await so a concurrent trigger stands down.
// It holds the in-flight PROMISE (not just the key) so a caller that cannot accept the
// stand-down — see `waitForInFlight` on syncOnePr — can queue behind it.
const running = new Map<string, Promise<boolean>>();
const keyOf = (repoId: number, prNumber: number): string => `${repoId}:${prNumber}`;

// How many times a `waitForInFlight` caller will queue behind someone else's run before
// giving up. Bounded so a stream of writers on one hot PR can't spin here indefinitely.
const MAX_SERIALIZE_ATTEMPTS = 3;

/**
 * Is a targeted sync in flight for this PR right now? Read-only. The refresh route
 * (sync/refresh-pr.ts) samples this BEFORE a no-wait syncOnePr so it can report a
 * stand-down as "a sync is running" rather than as a failure — the poll's answer is
 * whatever freshness that run produces, not an error.
 */
export function isPrSyncInFlight(repoId: number, prNumber: number): boolean {
  return running.has(keyOf(repoId, prNumber));
}

interface RepoTarget {
  owner: string;
  name: string;
  accountId: number;
}

// Resolve a repo's coordinates + owning account from its local id. The id already
// encodes the account (repos PK), so the caller passes only repoId and isolation is
// structural — the token + every persisted row use THIS row's accountId.
async function getRepoTarget(repoId: number): Promise<RepoTarget | null> {
  const rows = await db
    .select({ owner: repos.owner, name: repos.name, accountId: repos.accountId })
    .from(repos)
    .where(eq(repos.id, repoId))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

/**
 * Sync a single PR by number into the DB, reusing the idempotent persist path. Returns
 * true when the PR was fetched + persisted, false on any no-op (already in flight, repo
 * or PR gone, no token). Never throws — failures are logged and swallowed so a bad
 * webhook/poll can't crash the caller; the periodic backstop sync reconciles anything
 * missed.
 *
 * `waitForInFlight` (used by the post-write resync — see sync/resync-after-write.ts):
 * a caller that just WROTE to this PR cannot accept the stand-down, because the run
 * already in flight may have read GitHub BEFORE that write, so its success proves
 * nothing about the new row. With the flag set the caller queues behind the running
 * sync and then does its OWN fetch.
 */
export async function syncOnePr(
  repoId: number,
  prNumber: number,
  log: Logger,
  opts?: { waitForInFlight?: boolean },
): Promise<boolean> {
  const key = keyOf(repoId, prNumber);
  for (let attempt = 0; attempt < MAX_SERIALIZE_ATTEMPTS; attempt++) {
    const inFlight = running.get(key);
    if (!inFlight) {
      // Reserved synchronously on this path (nothing is awaited above it), so a
      // concurrent enqueue/caller still sees the slot taken, exactly as before. The
      // `.finally` is attached AT CREATION, so it has already released the slot by the
      // time any `await inFlight` below resumes — a waiter can never see a stale slot.
      const run = runOnePrSync(repoId, prNumber, log).finally(() => {
        running.delete(key);
      });
      running.set(key, run);
      return run;
    }
    if (!opts?.waitForInFlight) return false;
    // runOnePrSync never rejects, so this needs no catch.
    await inFlight;
  }
  return false;
}

// The actual fetch + persist. Split out from `syncOnePr` so the in-flight bookkeeping
// (which now has to hand the promise to waiters) lives in exactly one place. Keeps its
// own try/catch, so it NEVER rejects.
async function runOnePrSync(
  repoId: number,
  prNumber: number,
  log: Logger,
): Promise<boolean> {
  try {
    const target = await getRepoTarget(repoId);
    if (!target) {
      log.warn(`syncOnePr: repo ${repoId} not found (deleted?) — skipping #${prNumber}`);
      return false;
    }
    const { owner, name, accountId } = target;

    let token: string;
    try {
      token = await getAccessToken(accountId);
    } catch (err) {
      log.error(
        `syncOnePr ${owner}/${name}#${prNumber}: no access token for account ${accountId}: ${errMsg(err)}`,
      );
      return false;
    }

    const client = getGraphqlClientFor(token);
    let samlBlocked = false;
    const resp = await graphqlTolerant<PrActivityOneResponse>(
      client,
      PR_ACTIVITY_ONE_QUERY,
      { owner, name, number: prNumber },
      (errors) => {
        if (isSamlBlock(errors)) samlBlocked = true;
        log.warn(
          `syncOnePr ${owner}/${name}#${prNumber}: partial GraphQL — continuing without forbidden fields${graphqlChecksHint(errors)}. ${summarizeGraphqlErrors(errors)}`,
        );
      },
    );

    const pr = resp.repository?.pullRequest ?? null;
    if (!pr) {
      // A SAML wall forbids the whole `repository` node → flag the owner's org for the
      // "Reconnect GitHub" banner (mirrors sync-repo). Otherwise the PR is simply gone /
      // inaccessible (deleted, wrong number, lost access) — nothing to persist.
      if (samlBlocked) recordSamlBlock(accountId, owner);
      log.warn(
        `syncOnePr ${owner}/${name}#${prNumber}: no PR data returned — skipping`,
      );
      return false;
    }
    // Read cleanly → the token IS authorized for this owner's org; self-dismiss any
    // prior SAML flag (guarded so a partial SAML error can't erroneously clear it).
    if (!samlBlocked) clearSamlBlock(accountId, owner);

    // Gather the commit SHAs whose changed files the thread-state heuristic needs —
    // commits that landed AFTER an unresolved thread's last comment (identical to the
    // per-PR logic in sync-repo). persistPr only reads the SHAs its own commits need.
    const shas: string[] = [];
    const unresolved = pr.reviewThreads.nodes.filter(
      (t) => !t.isResolved && t.comments.nodes.length > 0,
    );
    if (unresolved.length > 0) {
      const threshold = Math.min(
        ...unresolved.map((t) => Date.parse(t.comments.nodes.at(-1)!.createdAt)),
      );
      for (const c of pr.commits.nodes) {
        if (Date.parse(c.commit.committedDate) > threshold) shas.push(c.commit.oid);
      }
    }

    const commitFilesBySha = await ensureCommitFiles(
      owner,
      name,
      shas,
      token,
      config.commitFileConcurrency,
    );

    const resolver = createUserResolver();
    await persistPr(pr, repoId, resolver, commitFilesBySha, accountId);
    log.info(
      `syncOnePr ${owner}/${name}#${prNumber} done (cost ${resp.rateLimit?.cost ?? 0}, ${resp.rateLimit?.remaining ?? '?'} remaining)`,
    );
    return true;
  } catch (err) {
    log.error(`syncOnePr repo ${repoId} #${prNumber} failed: ${errMsg(err)}`);
    return false;
  }
}

// Pending debounce timers, one per (repoId, prNumber). A fresh signal for a key resets
// its timer, so a burst collapses to a single trailing run.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced, coalescing trigger for a targeted sync. Multiple calls for the same PR
 * within `config.webhookDebounceMs` collapse into ONE `syncOnePr` fired after the burst
 * settles. If a sync is already in flight for the PR when the timer fires, it re-arms
 * (rather than dropping the just-arrived change) so the newer state is still picked up.
 * Fire-and-forget: `syncOnePr` swallows its own errors.
 */
export function enqueuePrSync(
  repoId: number,
  prNumber: number,
  log: Logger,
): void {
  const key = keyOf(repoId, prNumber);

  const arm = (): void => {
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(key);
      // A sync is mid-flight for this PR — re-arm so the change that arrived during it
      // isn't lost, instead of firing a syncOnePr that would just no-op on the guard.
      if (running.has(key)) {
        arm();
        return;
      }
      void syncOnePr(repoId, prNumber, log);
    }, config.webhookDebounceMs);
    // Don't keep the process alive solely for a pending targeted sync (e.g. at shutdown).
    // Guarded because faked/mocked timers may not expose unref.
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(key, timer);
  };

  arm();
}

// Test-only: reset the module's in-memory state between cases.
export function __resetTargetedSyncState(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  running.clear();
}
