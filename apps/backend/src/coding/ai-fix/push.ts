import { PRODUCT_NAME } from '@pierre-review/shared';
import type { AiFixPushResult } from '@pierre-review/shared';
import type { ApplyAndPushTarget } from '../../platform/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { getFixPrContext, getViewerCanPush } from './pr-context.js';
import { getFixById, markFixPushed } from './persist.js';
import { beginFixPush, endFixPush } from './push-guard.js';
import { fixRowHasWork, readMergeState } from '../../sandbox/session/fix-merge.js';

// PUSH A FINISHED FIX, AS-IS — the ONE path the Push button (routes.ts) and the AUTOMATIC push
// (auto-push.ts) share. Never a force push: onto the PR's own head branch (refused with HEAD_MOVED
// when that branch moved since the fix was generated) or onto a NEW branch with a PR opened against
// the base. No trunk step before it. `applyAndPush` settles the PR after the write.
//
// THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions): a push is refused while a turn of the fix's
// live session runs, the session refuses messages while the push runs (`beginFixPush`, taken in the
// first tick), and a push that lands ENDS the session (phase `pushed`). The patch is the PR repository's
// only, extracted by the host; edits in other repositories were never stored.
//
// A FIX WITH THE MERGE (docs/SANDBOX.md § AI Fix sessions, "The merge") pushes ONLY onto the PR's own branch
// and ONLY a merge Limn checked as valid: `ctx.coding.pushMerge` re-checks the sandbox's commits, rebuilds
// the merge commit (parents: the PR head, the base tip) and the fix on top under the reader's name, and
// pushes them as a fast-forward of the head the fix started from. An invalid or missing merge pushes nothing.

export type PushFixOutcome =
  | { ok: true; result: AiFixPushResult }
  | {
      ok: false;
      // not_found / not_pushable / no_write / head_unavailable / branch_required / HEAD_MOVED /
      // PUSH_DENIED / APPLY_FAILED / failed
      code:
        | 'not_found'
        | 'not_pushable'
        | 'no_write'
        | 'head_unavailable'
        | 'branch_required'
        | 'HEAD_MOVED'
        | 'PUSH_DENIED'
        | 'APPLY_FAILED'
        | 'failed';
      message: string;
    };

export async function pushFix(
  ctx: AgentContext,
  input: { accountId: number; fixId: number; target: 'existing' | 'new'; branch?: string },
): Promise<PushFixOutcome> {
  const { accountId, fixId } = input;
  // ⚠ The push slot in THIS tick, before any await: a message to the session cannot start meanwhile.
  if (!beginFixPush(fixId)) return { ok: false, code: 'not_pushable', message: 'This fix is being pushed.' };
  try {
    return await pushFixHeld(ctx, input);
  } finally {
    endFixPush(fixId);
  }
}

async function pushFixHeld(
  ctx: AgentContext,
  input: { accountId: number; fixId: number; target: 'existing' | 'new'; branch?: string },
): Promise<PushFixOutcome> {
  const { accountId, fixId } = input;
  const session = await import('../../sandbox/session/fix.js');
  if (session.fixTurnRunning(fixId)) return { ok: false, code: 'not_pushable', message: 'The agent is still working. Wait, or press Stop.' };
  const row = await getFixById(ctx, accountId, fixId);
  if (!row) return { ok: false, code: 'not_found', message: 'Fix not found.' };
  const merge = readMergeState(row.mergeJson ?? null);
  if (merge != null && merge.status !== 'valid')
    return { ok: false, code: 'not_pushable', message: `Nothing is pushed: ${merge.reason ?? 'the merge is not ready yet.'}` };
  if (row.status !== 'succeeded' || !fixRowHasWork(row) || !row.baseSha)
    return { ok: false, code: 'not_pushable', message: 'This fix has nothing to push.' };

  const pr = await getFixPrContext(ctx, accountId, row.prId);
  if (!pr) return { ok: false, code: 'not_found', message: 'Pull request not found.' };

  if (!(await getViewerCanPush(ctx, accountId, pr.repoId)))
    return { ok: false, code: 'no_write', message: 'You cannot push to this repository.' };

  const commitMessage = row.commitMessage ?? 'AI fix';

  if (merge != null) {
    if (merge.mergeSha == null || merge.resultSha == null) {
      return { ok: false, code: 'not_pushable', message: 'Nothing is pushed: Limn has not checked the merge.' };
    }
    if (input.target !== 'existing') {
      return { ok: false, code: 'not_pushable', message: "A fix with a merge pushes only to the pull request's own branch." };
    }
    try {
      const pushMerge = ctx.coding.pushMerge ?? (await import('../git-ops.js')).pushMergeResult;
      const by = row.provider === 'codex' ? 'Codex' : 'Claude';
      const result = await pushMerge({
        accountId,
        fixId,
        owner: pr.owner,
        name: pr.name,
        prNumber: pr.number,
        headSha: row.baseSha,
        baseRef: merge.baseRef,
        baseSha: merge.baseSha,
        bundle: Buffer.from(row.mergeBundle ?? '', 'base64'),
        conflictedFiles: merge.conflictedFiles,
        expectedMergeSha: merge.mergeSha,
        expectedResultSha: merge.resultSha,
        mergeMessage: `Merge ${merge.baseRef} into this pull request\n\nConflicts resolved with ${by} in ${PRODUCT_NAME} AI Fix.`,
        fixMessage: commitMessage,
      });
      await markFixPushed(ctx, fixId, { pushedBranch: result.pushedBranch });
      if (row.sessionPhase != null) await session.closeFixAfterPush(ctx, accountId, fixId).catch((err: unknown) => ctx.log.warn({ err }, 'ai-fix: closing the session after the push failed'));
      return { ok: true, result };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'HEAD_MOVED' || code === 'PUSH_DENIED' || code === 'APPLY_FAILED') return { ok: false, code, message };
      ctx.log.warn({ err }, 'ai-fix merge push failed');
      return { ok: false, code: 'failed', message };
    }
  }

  let target: ApplyAndPushTarget;
  if (input.target === 'existing') {
    const head = await ctx.github.fetchPrHeadInfo(accountId, pr.owner, pr.name, pr.number).catch(() => null);
    if (!head) return { ok: false, code: 'head_unavailable', message: 'Could not read the PR branch.' };
    target = { kind: 'existing', headRef: head.headRef };
  } else {
    const branch = (input.branch ?? '').trim();
    if (!branch) return { ok: false, code: 'branch_required', message: 'Name the new branch.' };
    // This body lands on GitHub, where it is read by people who have never seen this app — so it
    // names the PRODUCT, not the npm package. Nothing detects on this string.
    const prBody = `${row.summary ?? ''}\n\n---\nAutomated fix for #${pr.number}, generated by ${PRODUCT_NAME} AI Fix.`;
    target = {
      kind: 'new',
      branch,
      base: pr.baseRefName ?? pr.defaultBranch ?? 'main',
      title: commitMessage,
      body: prBody,
    };
  }

  try {
    const result = await ctx.coding.applyAndPush({
      accountId,
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      baseSha: row.baseSha,
      patch: row.patch ?? '',
      commitMessage,
      target,
    });
    await markFixPushed(ctx, fixId, {
      pushedBranch: result.pushedBranch,
      pushedPrNumber: result.prNumber,
      pushedPrUrl: result.prUrl,
    });
    // The session ends with the push (no follow-up after a push: a new fix starts from the next review).
    if (row.sessionPhase != null) await session.closeFixAfterPush(ctx, accountId, fixId).catch((err: unknown) => ctx.log.warn({ err }, 'ai-fix: closing the session after the push failed'));
    return { ok: true, result };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'HEAD_MOVED' || code === 'PUSH_DENIED' || code === 'APPLY_FAILED') return { ok: false, code, message };
    ctx.log.warn({ err }, 'ai-fix push failed');
    return { ok: false, code: 'failed', message };
  }
}
