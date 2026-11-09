// WHO IS WRITING: THE READER, OR LIMN ON THE READER'S BEHALF (docs/CLAUDE-REVIEW.md § Limn's actions
// are bots). Every exported GitHub WRITE (github/mutations.ts, review/post-review.ts, the git push in
// coding/git.ts, the team-claim status) takes a REQUIRED `origin: WriteOrigin` as its LAST parameter:
//
//   'reader'          the person pressed a plain button with their own words or decision (Approve,
//                     Merge now, a typed reply, a reaction). Nothing is recorded.
//   LimnWriteOrigin   Limn wrote: a run nobody pressed, the Dependencies policy, or a button that posts
//                     Limn's words / lands Limn's work. The write is recorded in the provenance ledger
//                     (`limn_actions`, db/limn-actions.ts) — claimed BEFORE the call, settled with
//                     GitHub's ids AFTER it — so sync stores what it produced under the `limn:` bot.
//
// The parameter is required so the compiler asks every new call site the question; the guard test
// (`write-origin.test.ts`) fails when a write function does not take it or does not record.
//
// ⚠ The ledger is imported LAZILY: this module sits in the github layer, which many tests import with
// no database. A ledger failure never fails or blocks the GitHub write (it is logged to stderr only).
import type { LimnActionKind, LimnActionOrigin } from '@pierre-review/shared';
import type { LimnActionIds } from '../db/limn-actions.js';
import { assertScratchWriteAllowed } from '../scratch-guard.js';

export interface LimnWriteOrigin {
  limn: LimnActionOrigin;
  accountId: number;
  repoId: number;
  /** The local PR id; null when the PR is not stored yet (a PR Limn is opening). */
  prId: number | null;
  /** The person whose account Limn writes as. */
  onBehalfUserId: number | null;
  /** The Limn run that caused the write (claude_reviews, ai_fixes, story_builds, …). */
  source?: { table: string; id: number } | null;
  /** The writer's own idempotency key for the ledger row (else a fresh one per write). */
  claimKey?: string;
}

export type WriteOrigin = 'reader' | LimnWriteOrigin;

export function isLimnOrigin(o: WriteOrigin): o is LimnWriteOrigin {
  return o !== 'reader';
}

/** A Limn origin with one field changed (a second write of the same run). */
export function limnOriginWith(o: LimnWriteOrigin, patch: Partial<LimnWriteOrigin>): LimnWriteOrigin {
  return { ...o, ...patch };
}

/** What a write's result says about the ledger row: GitHub's ids ('done'), or that it did not happen. */
export type LimnWriteResult = LimnActionIds & { failed?: string };

const warn = (what: string, err: unknown): void => {
  // eslint-disable-next-line no-console
  console.warn(`[limn-actions] ${what}: ${err instanceof Error ? err.message : String(err)}`);
};

/**
 * Run ONE GitHub write. For 'reader' it is just `run()`. For Limn: claim a ledger row, run, then
 * settle it 'done' with the ids `idsOf` reads from the result (or 'failed' when it says so or the
 * call throws; the throw is re-raised unchanged).
 */
export async function limnWrite<T>(
  origin: WriteOrigin,
  kind: LimnActionKind,
  target: { prNumber?: number | null },
  run: () => Promise<T>,
  idsOf: (result: T) => LimnWriteResult,
): Promise<T> {
  // A scratch backend without `--github write` writes nothing (scratch-guard.ts); before the ledger.
  assertScratchWriteAllowed(`a GitHub write (${kind})`);
  if (!isLimnOrigin(origin)) return run();
  let rowId: number | null = null;
  let ledger: typeof import('../db/limn-actions.js') | null = null;
  try {
    ledger = await import('../db/limn-actions.js');
    rowId = await ledger.claimLimnAction({
      accountId: origin.accountId,
      repoId: origin.repoId,
      prId: origin.prId,
      prNumber: target.prNumber ?? null,
      kind,
      origin: origin.limn,
      onBehalfUserId: origin.onBehalfUserId,
      source: origin.source ?? null,
      ...(origin.claimKey ? { claimKey: origin.claimKey } : {}),
    });
  } catch (err) {
    warn(`claim ${kind}`, err);
  }
  let result: T;
  try {
    result = await run();
  } catch (err) {
    if (ledger && rowId != null) {
      await ledger
        .settleLimnAction(rowId, 'failed', { detail: err instanceof Error ? err.message : String(err) })
        .catch((e) => warn(`settle ${kind}`, e));
    }
    throw err;
  }
  if (ledger && rowId != null) {
    try {
      const ids = idsOf(result);
      const { failed, ...rest } = ids;
      if (failed != null) await ledger.settleLimnAction(rowId, 'failed', { ...rest, detail: failed });
      else await ledger.settleLimnAction(rowId, 'done', rest);
    } catch (err) {
      warn(`settle ${kind}`, err);
    }
  }
  return result;
}

/** Record a Limn write that has already happened (a read-back adopted a review GitHub published
 *  despite an error). A no-op for 'reader'. Never throws. */
export async function recordLimnWrite(
  origin: WriteOrigin,
  kind: LimnActionKind,
  ids: LimnActionIds,
): Promise<void> {
  if (!isLimnOrigin(origin)) return;
  try {
    const ledger = await import('../db/limn-actions.js');
    await ledger.recordLimnAction(
      {
        accountId: origin.accountId,
        repoId: origin.repoId,
        prId: origin.prId,
        prNumber: ids.prNumber ?? null,
        kind,
        origin: origin.limn,
        onBehalfUserId: origin.onBehalfUserId,
        source: origin.source ?? null,
        ...(origin.claimKey ? { claimKey: origin.claimKey } : {}),
      },
      ids,
    );
  } catch (err) {
    warn(`record ${kind}`, err);
  }
}

/** Record the commits Limn pushed (one 'push' row per sha). A no-op for 'reader'. Never throws. */
export async function recordLimnPush(origin: WriteOrigin, shas: readonly string[]): Promise<void> {
  if (!isLimnOrigin(origin) || shas.length === 0) return;
  try {
    const ledger = await import('../db/limn-actions.js');
    await ledger.recordLimnPushedCommits(
      {
        accountId: origin.accountId,
        repoId: origin.repoId,
        prId: origin.prId,
        origin: origin.limn,
        onBehalfUserId: origin.onBehalfUserId,
        source: origin.source ?? null,
      },
      shas,
    );
  } catch (err) {
    warn('record push', err);
  }
}
