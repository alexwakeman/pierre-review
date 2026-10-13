import { and, eq } from 'drizzle-orm';
import { type SprintAssessmentCurrency, type SprintAssessMode, type SprintRepoRef, type SprintStage } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { sprintAssessFingerprint, sprintTicketTextHash, type SprintAssessmentRow, type SprintTicketDbRow } from './sprint-store.js';
import type { AcceptedRepoDetail } from './sprint-ticket-repos.js';
import { sprintLayoutFor, sprintStageOf } from './sprint-status-layout.js';

// REPORTS → THIS SPRINT — small shared folds of the sprint surface: the assessment's currency, one
// ticket's stage, the workspace's repos. The page itself is the GRAPH (db/sprint-graph.ts); the
// ticket list this file used to build (GET /api/sprint-stories) is gone with the chips, findings,
// checks and the write-back (2026-10-12).

/** Pure currency: a SUCCEEDED run is current while today's text hash and today's accepted repos'
 *  synced default-branch shas give its stored fingerprint. A ticket gone from the store is stale. */
export function sprintAssessmentCurrencyFrom(
  row: Pick<SprintAssessmentRow, 'status' | 'fingerprint'>,
  ticket: Pick<SprintTicketDbRow, 'title' | 'description' | 'acceptanceCriteria'> | null,
  accepted: ReadonlyArray<Pick<AcceptedRepoDetail, 'repoId' | 'syncedSha'>>,
  /** The mode TODAY's stage asks for (`sprintAssessModeOf`) — a stage change makes the run stale. */
  mode: SprintAssessMode,
): SprintAssessmentCurrency {
  if (row.status !== 'succeeded') return null;
  if (ticket == null) return 'stale';
  const now = sprintAssessFingerprint(
    sprintTicketTextHash(ticket),
    accepted.map((a) => ({ repoId: a.repoId, sha: a.syncedSha })),
    mode,
  );
  return now === row.fingerprint ? 'current' : 'stale';
}

/** One stored ticket's stage under the workspace's status layout — the list's own rule
 *  (`sprintStageOf`), for a caller holding one row ("Check against code" picks its mode from it). */
export async function sprintTicketStage(
  accountId: number,
  workspaceId: number,
  row: Pick<SprintTicketDbRow, 'statusName' | 'statusCategory'>,
): Promise<SprintStage> {
  const layout = await sprintLayoutFor(accountId, workspaceId);
  const status = row.statusName != null ? { name: row.statusName, category: row.statusCategory ?? null } : null;
  return sprintStageOf(layout ?? { order: [] }, status);
}

/** The workspace's repos (owner/name), sorted — the repo picker's choices. */
export async function workspaceRepoRefs(accountId: number, workspaceId: number): Promise<SprintRepoRef[]> {
  const { repos: r, workspaceRepos: wr } = schema;
  const rows = await db
    .select({ id: r.id, owner: r.owner, name: r.name })
    .from(r)
    .innerJoin(wr, and(eq(wr.repoId, r.id), eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .where(eq(r.accountId, accountId))
    .execute();
  return rows
    .map((x) => ({ repoId: x.id, fullName: `${x.owner}/${x.name}` }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
