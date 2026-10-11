// Reports → This sprint — which story issues a workspace raises. The ONE reader and writer of
// `workspaces.sprint_checks` (migration 0102 / pg 0089). OVERRIDES ONLY: NULL (or the default
// `{off:[], issueTypes:[]}`, stored as NULL) = all three issues on, every issue type. Applied
// server-side by `sprintIssuesFor` through the shared `applyStoryIssueChecks`, so flagCount, the
// order and Copy all agree with what is on screen.
//
// ⚠ THE COLUMN OUTLIVED ITS FIRST SHAPE — an earlier cut stored chip ids in `off` and an OBJECT of
// per-chip type lists in `issueTypes`. A STORED value is read tolerantly (unknown ids dropped, a
// non-array `issueTypes` read as []); only a POSTED value is strict. No migration: same JSON column.
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_CHECKS_DEFAULT,
  STORY_ISSUE_CHECK_TYPES_MAX,
  STORY_ISSUE_CHECK_TYPE_MAX_CHARS,
  isStoryIssueId,
  type SprintChecks,
  type StoryIssueId,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { workspaces } = schema;

const badTypeName = (t: string): boolean => t === '' || t.length > STORY_ISSUE_CHECK_TYPE_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(t);

/** A stored or posted value as clean `SprintChecks`, or null when a POSTED one is malformed
 *  (`strict`). A stored value never reads as null: anything unreadable in it falls back to the
 *  default for that half. */
export function parseSprintChecks(raw: unknown, strict: boolean): SprintChecks | null {
  if (raw == null) return { off: [], issueTypes: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return strict ? null : { off: [], issueTypes: [] };
  const r = raw as { off?: unknown; issueTypes?: unknown };
  const offIn = r.off ?? [];
  const typesIn = r.issueTypes ?? [];
  if (strict && (!Array.isArray(offIn) || !Array.isArray(typesIn))) return null;

  const off: StoryIssueId[] = [];
  for (const id of Array.isArray(offIn) ? offIn : []) {
    if (isStoryIssueId(id)) {
      if (!off.includes(id)) off.push(id);
    } else if (strict) return null;
  }

  const list = Array.isArray(typesIn) ? typesIn : [];
  if (strict && list.length > STORY_ISSUE_CHECK_TYPES_MAX) return null;
  const issueTypes: string[] = [];
  for (const n of list) {
    const t = typeof n === 'string' ? n.trim() : '';
    if (typeof n !== 'string' || badTypeName(t)) {
      if (strict) return null;
      continue;
    }
    if (!issueTypes.some((x) => x.toLowerCase() === t.toLowerCase())) issueTypes.push(t);
  }
  return { off, issueTypes: issueTypes.slice(0, STORY_ISSUE_CHECK_TYPES_MAX) };
}

const isDefault = (c: SprintChecks): boolean => c.off.length === 0 && c.issueTypes.length === 0;

/** The workspace's checks (defaults for a workspace that is not this account's). */
export async function getSprintChecks(accountId: number, workspaceId: number): Promise<SprintChecks> {
  const row = (
    await db
      .select({ sprintChecks: workspaces.sprintChecks })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return parseSprintChecks(row?.sprintChecks ?? null, false) ?? { ...SPRINT_CHECKS_DEFAULT };
}

/** Replace the workspace's checks (already validated). False when the workspace is not this account's. */
export async function setSprintChecks(accountId: number, workspaceId: number, checks: SprintChecks): Promise<boolean> {
  const rows = await db
    .update(workspaces)
    .set({ sprintChecks: isDefault(checks) ? null : checks })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return rows.length > 0;
}
