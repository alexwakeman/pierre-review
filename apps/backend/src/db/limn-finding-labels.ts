// THE SEVERITY BADGE OF A LIMN FINDING (docs/ML-SEVERITY.md § Limn findings).
//
// A Limn finding comment is a bot comment (db/limn-bots.ts), so Bots Monitoring rolls up its
// severity like any other bot's. That severity is the REVIEW'S OWN — the lead line Limn posted
// ("**Warning**") — and NEVER the ML scorer's: a Limn finding is not an ML candidate
// (ml-labels.ts `listMlCandidates` + `countBotText` leave out `limn_posted_by_user_id IS NOT
// NULL`, in lockstep).
//
// This writer stores it in `ml_comment_labels` with its own backend (`LIMN_LABEL_BACKEND`), so
// every badge and rollup reads it unchanged:
//   severity      `LIMN_ML_SEVERITY[lead]` (blocker→critical, warning→major, nit→nit,
//                 question→minor), probability 1
//   categories    nit → ['nitpick'], else ['correctness_bug'] (a finding has no lens on GitHub)
//   vendor claim  NULL — Limn is not a vendor, so the inflation index OMITS and NAMES it
//   no severity   (a reminder without one) → no row
//
// ⚠ THE SCORER NEVER OVERWRITES THESE ROWS (`upsertMlLabels` guards its update on the backend),
// and a deep re-sync / `ml:enrich --reset` keeps them (`deleteMlLabelsForRepo` and the script
// skip the backend). The writer is idempotent and runs inside `persistPr`'s transaction (DB only),
// at the end of the boot reconcile, and after a deep re-sync's label delete.
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  LIMN_LABEL_BACKEND,
  LIMN_LABEL_MODEL_VERSION,
  LIMN_ML_SEVERITY,
  limnFindingPost,
  type MlCategory,
  type MlLabelTargetKind,
  type MlSeverity,
} from '@pierre-review/shared';
import { db, schema, type Executor } from './client.js';

const { mlCommentLabels, pullRequests, reviewComments, prComments } = schema;

const SEVERITY_ORD: Record<MlSeverity, number> = { nit: 0, minor: 1, major: 2, critical: 3 };

/** The label a Limn finding body carries, or null when it has none (reminder, not a finding). */
export function limnFindingLabel(
  body: string | null | undefined,
): { severity: MlSeverity; severityOrd: number; categories: MlCategory[] } | null {
  const post = limnFindingPost(body);
  if (post?.severity == null) return null;
  const severity = LIMN_ML_SEVERITY[post.severity];
  return {
    severity,
    severityOrd: SEVERITY_ORD[severity],
    categories: severity === 'nit' ? ['nitpick'] : ['correctness_bug'],
  };
}

export interface LimnLabelSyncResult {
  written: number;
  deleted: number;
}

/**
 * Make the stored Limn labels match the stored Limn finding comments, for the whole account or
 * for `prIds` only. Writes a row only when it differs (body, author or severity), and deletes a
 * Limn-backend row whose comment is no longer a Limn finding with a severity. Idempotent.
 */
export async function syncLimnFindingLabels(
  exec: Executor,
  accountId: number,
  opts: { prIds?: number[] } = {},
): Promise<LimnLabelSyncResult> {
  const prIds = opts.prIds;
  if (prIds && prIds.length === 0) return { written: 0, deleted: 0 };
  const prFilter = <T extends typeof reviewComments | typeof prComments>(t: T) =>
    prIds ? [inArray(t.prId, prIds)] : [];

  const rc = await exec
    .select({
      id: reviewComments.id,
      prId: reviewComments.prId,
      repoId: pullRequests.repoId,
      authorId: reviewComments.authorId,
      body: reviewComments.body,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        isNotNull(reviewComments.limnPostedByUserId),
        ...prFilter(reviewComments),
      ),
    )
    .execute();
  const pc = await exec
    .select({
      id: prComments.id,
      prId: prComments.prId,
      repoId: pullRequests.repoId,
      authorId: prComments.authorId,
      body: prComments.body,
      createdAt: prComments.createdAt,
    })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        isNotNull(prComments.limnPostedByUserId),
        ...prFilter(prComments),
      ),
    )
    .execute();

  // Every label on these targets that exists now: a Limn row to keep or drop, or (from before this
  // writer) a scorer row to replace.
  const existing = await exec
    .select({
      id: mlCommentLabels.id,
      targetKind: mlCommentLabels.targetKind,
      targetId: mlCommentLabels.targetId,
      authorUserId: mlCommentLabels.authorUserId,
      severity: mlCommentLabels.severity,
      backend: mlCommentLabels.backend,
      bodyHash: mlCommentLabels.bodyHash,
    })
    .from(mlCommentLabels)
    .where(
      and(
        eq(mlCommentLabels.accountId, accountId),
        ...(prIds ? [inArray(mlCommentLabels.prId, prIds)] : []),
        // Subqueries, not id lists: an account's Limn findings can outgrow SQLite's bound-variable cap.
        sql`(${mlCommentLabels.backend} = ${LIMN_LABEL_BACKEND}
          or (${mlCommentLabels.targetKind} = 'review_comment' and ${mlCommentLabels.targetId} in
            (select ${reviewComments.id} from ${reviewComments} where ${reviewComments.limnPostedByUserId} is not null))
          or (${mlCommentLabels.targetKind} = 'pr_comment' and ${mlCommentLabels.targetId} in
            (select ${prComments.id} from ${prComments} where ${prComments.limnPostedByUserId} is not null)))`,
      ),
    )
    .execute();
  const key = (kind: string, id: number) => `${kind}:${id}`;
  const existingByKey = new Map(existing.map((e) => [key(e.targetKind, e.targetId), e]));

  let written = 0;
  const keep = new Set<string>();
  const now = new Date();
  const write = async (
    kind: MlLabelTargetKind,
    r: { id: number; prId: number; repoId: number; authorId: number | null; body: string | null; createdAt: Date },
  ) => {
    if (r.authorId == null) return;
    const label = limnFindingLabel(r.body);
    if (!label) return;
    const k = key(kind, r.id);
    keep.add(k);
    const bodyHash = createHash('sha256').update(r.body ?? '').digest('hex');
    const prior = existingByKey.get(k);
    if (
      prior &&
      prior.backend === LIMN_LABEL_BACKEND &&
      prior.bodyHash === bodyHash &&
      prior.authorUserId === r.authorId &&
      prior.severity === label.severity
    )
      return;
    const values = {
      accountId,
      repoId: r.repoId,
      prId: r.prId,
      targetKind: kind,
      targetId: r.id,
      authorUserId: r.authorId,
      severity: label.severity,
      severityOrd: label.severityOrd,
      severityProb: 1,
      vendorSeverity: null,
      vendorSeverityConfidence: null,
      categories: label.categories,
      categoryProbs: Object.fromEntries(label.categories.map((c) => [c, 1])),
      isSummary: false,
      backend: LIMN_LABEL_BACKEND,
      modelVersion: LIMN_LABEL_MODEL_VERSION,
      bodyHash,
      targetCreatedAt: r.createdAt,
      updatedAt: now,
    };
    // ⚠ Same conflict target as the scorer's upsert (`mcl_account_target`), and NO backend guard:
    // a Limn finding's label is always Limn's.
    const { accountId: _a, targetKind: _k, targetId: _t, ...set } = values;
    written += (
      await exec
        .insert(mlCommentLabels)
        .values(values)
        .onConflictDoUpdate({
          target: [mlCommentLabels.accountId, mlCommentLabels.targetKind, mlCommentLabels.targetId],
          set,
        })
        .returning({ id: mlCommentLabels.id })
        .execute()
    ).length;
  };
  for (const r of rc) await write('review_comment', r);
  for (const r of pc) await write('pr_comment', r);

  // A Limn row whose comment is no longer a Limn finding with a severity (marker edited away, or
  // a reminder) is removed; a scorer row on a Limn finding is removed too — never ML-graded.
  // (Every `existing` row is one or the other, by its query.)
  const stale = existing.filter((e) => !keep.has(key(e.targetKind, e.targetId))).map((e) => e.id);
  let deleted = 0;
  for (let i = 0; i < stale.length; i += 500) {
    deleted += (
      await exec
        .delete(mlCommentLabels)
        .where(inArray(mlCommentLabels.id, stale.slice(i, i + 500)))
        .returning({ id: mlCommentLabels.id })
        .execute()
    ).length;
  }
  return { written, deleted };
}

/** Run the writer outside any transaction (deep re-sync, scripts). */
export function syncLimnFindingLabelsNow(accountId: number, prIds?: number[]): Promise<LimnLabelSyncResult> {
  return syncLimnFindingLabels(db, accountId, prIds ? { prIds } : {});
}
