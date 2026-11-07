import { and, eq, inArray } from 'drizzle-orm';
import type { OpenPointsFieldMode } from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import type { OpenPointsChoice } from './open-points.js';

// WHERE AN ISSUE TYPE'S OPEN POINTS ARE READ (`tracker_open_points_fields`, migration 0171;
// docs/TRACKERS.md § Open points). The ONE reader and writer of the table. No row = 'auto'.
// Every query predicates on accountId.

const key = (workspaceId: number, apiRoot: string, issueTypeId: string): string => `${workspaceId}|${apiRoot}|${issueTypeId}`;

export interface StoredOpenPointsChoice extends OpenPointsChoice {
  fieldName: string | null;
}

/** Every choice an account made for these workspaces, keyed `ws|apiRoot|issueTypeId`. */
export async function readOpenPointsSettings(
  ctx: TrackerContext,
  accountId: number,
  workspaceIds: readonly number[],
): Promise<Map<string, StoredOpenPointsChoice>> {
  const out = new Map<string, StoredOpenPointsChoice>();
  const t = ctx.schema.trackerOpenPointsFields;
  // A test context built from a schema subset may not carry the table: nothing chosen.
  if (t == null || workspaceIds.length === 0) return out;
  const rows = (await ctx.db
    .select({
      workspaceId: t.workspaceId,
      apiRoot: t.apiRoot,
      issueTypeId: t.issueTypeId,
      mode: t.mode,
      fieldId: t.fieldId,
      fieldName: t.fieldName,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), inArray(t.workspaceId, [...new Set(workspaceIds)])))
    .execute()) as Array<{ workspaceId: number; apiRoot: string; issueTypeId: string; mode: string; fieldId: string | null; fieldName: string | null }>;
  for (const r of rows) {
    const mode: OpenPointsFieldMode = r.mode === 'field' && r.fieldId != null ? 'field' : r.mode === 'none' ? 'none' : 'auto';
    out.set(key(r.workspaceId, r.apiRoot, r.issueTypeId), { mode, fieldId: mode === 'field' ? r.fieldId : null, fieldName: r.fieldName });
  }
  return out;
}

/** The choice for one ticket's issue type (null = 'auto'). */
export function openPointsChoiceFor(
  settings: Map<string, StoredOpenPointsChoice>,
  workspaceId: number,
  apiRoot: string,
  issueTypeId: string | null | undefined,
): StoredOpenPointsChoice | null {
  if (issueTypeId == null) return null;
  return settings.get(key(workspaceId, apiRoot, issueTypeId)) ?? null;
}

/** Write one type's choice. 'auto' deletes the row (the default needs none). */
export async function writeOpenPointsSetting(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  apiRoot: string,
  issueTypeId: string,
  mode: OpenPointsFieldMode,
  field: { id: string; name: string } | null,
  now: Date,
): Promise<void> {
  const t = ctx.schema.trackerOpenPointsFields;
  if (mode === 'auto') {
    await ctx.db
      .delete(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.apiRoot, apiRoot), eq(t.issueTypeId, issueTypeId)))
      .execute();
    return;
  }
  const values = {
    mode,
    fieldId: mode === 'field' ? (field?.id ?? null) : null,
    fieldName: mode === 'field' ? (field?.name ?? null) : null,
    updatedAt: now,
  };
  await ctx.db
    .insert(t)
    .values({ accountId, workspaceId, apiRoot, issueTypeId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId, t.apiRoot, t.issueTypeId], set: { ...values } })
    .execute();
}
