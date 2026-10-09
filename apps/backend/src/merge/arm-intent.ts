// ── ARMING "MERGE WHEN READY" — the ONE arm path (CORE, free, both modes) ──────────────────────
//
// Three callers arm an intent, and every one of them goes through `armIntentLive`:
//   • the per-PR route `POST /api/prs/:id/auto-merge` (MergeWhenReadyControl, a click);
//   • Pending → Dependencies' "Merge or arm all" (`POST /api/dependencies/merge-all`, a click);
//   • the dependency auto-merge setting's sweep (merge/dependency-policy.ts, `armedByPolicy`).
//
// The consent rules live here once: the head pin is the LIVE head (never the synced one, which
// may already be superseded), the base ref is checked against the synced one the reader saw and
// pinned as GitHub's own answer, and a PR already in GitHub's merge queue is never armed (landing
// is already arranged). The caller checks write permission and that the PR is open.
import { config } from '../config.js';
import type { ArmedMergeRequest, MergeMethod } from '@pierre-review/shared';
import { armAutoMerge, getSyncedBaseRef } from '../db/queries.js';
import { stampPrMergeQueueStateNonFatal, type MergeQueueStampLog } from '../db/pr-merge-queue-stamp.js';
import {
  fetchMergeQueueState,
  fetchPrHeadInfo,
  fetchRepoMergeConfig,
  type MergeQueueState,
} from '../github/mutations.js';

/** An intent that never becomes mergeable dies rather than lingering. */
export const AUTO_MERGE_TTL_MS = 72 * 60 * 60 * 1000;

export type ArmIntentResult =
  | { ok: true; armed: ArmedMergeRequest }
  | {
      ok: false;
      code: 'StaleBase' | 'AlreadyQueued' | 'HeadUnchanged';
      message: string;
    };

export interface ArmIntentArgs {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  number: number;
  token: string;
  mergeMethod: MergeMethod;
  updateStrategy: 'rebase' | 'merge' | 'none';
  /** The dependency setting armed it, not a person. */
  armedByPolicy?: boolean;
  /** Refuse (`HeadUnchanged`) when the LIVE head is still this SHA — the sweep's guard against
   *  re-arming a head whose intent already ended (expired, failed, lost access). */
  refuseIfHead?: string | null;
  /** A queue probe the caller already made (null = it asked and could not read one). */
  queue?: MergeQueueState | null;
  log: MergeQueueStampLog;
}

export async function armIntentLive(a: ArmIntentArgs): Promise<ArmIntentResult> {
  const info = await fetchPrHeadInfo(a.token, a.owner, a.name, a.number);
  if (a.refuseIfHead != null && a.refuseIfHead === info.headSha) {
    return { ok: false, code: 'HeadUnchanged', message: 'This head was already tried.' };
  }
  // The head pin is blind to a RETARGET, so the watcher guards the base too — against the base
  // the reader was shown, which is only a valid consent record if GitHub agrees right now.
  const syncedBaseRef = await getSyncedBaseRef(a.accountId, a.prId);
  if (syncedBaseRef !== info.baseRef) {
    return {
      ok: false,
      code: 'StaleBase',
      message: `This PR now targets ${info.baseRef}; Limn last saw ${syncedBaseRef ?? 'no base branch'}. Sync the repository, then arm auto-merge again.`,
    };
  }
  // Best-effort: an older GHES or a token that can't run the query arms a direct-merge intent.
  const queue =
    a.queue !== undefined
      ? a.queue
      : await fetchMergeQueueState(a.token, a.owner, a.name, a.number).catch(() => null);
  // An answer is an answer whichever way this goes — stamp it (non-fatal).
  if (queue) {
    await stampPrMergeQueueStateNonFatal(a.prId, a.accountId, queue.inQueue, queue.state, a.log);
  }
  if (queue?.inQueue) {
    return {
      ok: false,
      code: 'AlreadyQueued',
      message: 'This PR is already in the merge queue — it will land on its own.',
    };
  }
  const armed = await armAutoMerge(a.accountId, a.prId, {
    mergeMethod: a.mergeMethod,
    updateStrategy: a.updateStrategy,
    viaMergeQueue: queue?.enabled === true,
    expectedHeadOid: info.headSha,
    // GitHub's own answer, pinned — the synced column belongs to the sync and may change.
    expectedBaseRef: info.baseRef,
    expiresAt: new Date(Date.now() + AUTO_MERGE_TTL_MS),
    ...(a.armedByPolicy ? { armedByPolicy: true } : {}),
  });
  return { ok: true, armed };
}

/** The repo's first enabled merge method (GitHub order) — the merge control's own default —
 *  or null when the repo enables none. */
export async function defaultMergeMethod(
  token: string,
  owner: string,
  name: string,
): Promise<MergeMethod | null> {
  const cfg = await fetchRepoMergeConfig(token, owner, name);
  if (cfg.allowMergeCommit) return 'merge';
  if (cfg.allowSquashMerge) return 'squash';
  if (cfg.allowRebaseMerge) return 'rebase';
  return null;
}

/** The update strategy MergeWhenReadyControl stores for a click: a clone-based rebase where it
 *  can run (local), GitHub's native merge-in otherwise. */
export function clickUpdateStrategy(): 'rebase' | 'merge' {
  return config.isCloud ? 'merge' : 'rebase';
}
