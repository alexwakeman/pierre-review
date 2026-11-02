import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FeatureFacts, SprintSource } from '@pierre-review/shared';
import { db, schema } from './client.js';

// SETTINGS → FEATURES — the facts behind the defaults (shared features.ts `resolveFeatures`). Read on
// every GET /api/me, so each is ONE small indexed DB read: no tracker call, no GitHub call. Every
// query predicates on accountId.

/** At least one of the account's repositories has finished its 90-day backfill (docs/SYNC.md: a
 *  repo stays "never fully synced" until phase 2 ends, so `last_full_sync_at` is that moment). */
export async function hasCompletedBackfill(accountId: number): Promise<boolean> {
  const { repos, syncState } = schema;
  const rows = await db
    .select({ id: repos.id })
    .from(syncState)
    .innerJoin(repos, eq(repos.id, syncState.repoId))
    .where(and(eq(repos.accountId, accountId), isNotNull(syncState.lastFullSyncAt)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

/** Is this stored sprint-read source a real sprint (not the status fallback)? */
export function isSprintSource(source: SprintSource | null | undefined): boolean {
  if (source == null) return false;
  switch (source.kind) {
    case 'sprint':
    case 'cycle':
    case 'iteration':
      return true;
    case 'milestone':
      // Only a milestone with a due date makes a sprint.
      return source.dueOn != null;
    case 'status_fallback':
      return false;
  }
}

/** The trackers whose configuration names sprints or cycles (GitHub Issues is the automatic default
 *  in most workspaces, so its configuration alone says nothing). */
const SPRINT_TRACKERS = ['jira', 'linear', 'notion'] as const;

/**
 * Does any workspace of this account have a sprint source? True when:
 *  - the workspace's last sprint read found a sprint, a cycle, a GitHub Projects iteration (the
 *    current one, docs/TRACKERS.md § GitHub Projects iterations) or a milestone with a due date; or
 *  - the workspace has no successful read yet and the tracker worker's SPRINT-SOURCE PROBE (GitHub
 *    Issues workspaces only, tracker/sprint/probe.ts — never run by a view) found a current
 *    iteration or a dated milestone; or
 *  - the workspace has a Jira, Linear or Notion tracker configured and no read has said otherwise
 *    yet (the read runs once This Sprint is opened; until then, a configured tracker counts).
 *
 * ⚠ THE EXTENSION POINT for a further source: add it to `isSprintSource`, and the Features default
 * follows.
 */
export async function hasSprintSource(accountId: number): Promise<boolean> {
  const sr = schema.sprintReads;
  const reads = await db
    .select({ workspaceId: sr.workspaceId, source: sr.sourceJson, readAt: sr.readAt, probe: sr.probeSourceJson })
    .from(sr)
    .where(eq(sr.accountId, accountId))
    .execute();
  if (reads.some((r) => isSprintSource(r.source))) return true;
  // The probe's answer counts only until a read exists: a read's own source is the answer then.
  if (reads.some((r) => r.readAt == null && isSprintSource(r.probe))) return true;
  const readWorkspaces = new Set(reads.filter((r) => r.readAt != null && r.source != null).map((r) => r.workspaceId));
  const wt = schema.workspaceTrackers;
  const trackers = await db
    .select({ workspaceId: wt.workspaceId })
    .from(wt)
    .where(and(eq(wt.accountId, accountId), inArray(wt.provider, [...SPRINT_TRACKERS])))
    .execute();
  return trackers.some((t) => !readWorkspaces.has(t.workspaceId));
}

/** Everything `resolveFeatures` needs, for one account. */
export async function featureFacts(accountId: number, existingInstall: boolean): Promise<FeatureFacts> {
  // An existing install shows everything whatever the facts say: skip the reads.
  if (existingInstall) return { existingInstall, reportsReady: true, sprintSource: true };
  const [reportsReady, sprintSource] = await Promise.all([hasCompletedBackfill(accountId), hasSprintSource(accountId)]);
  return { existingInstall, reportsReady, sprintSource };
}
