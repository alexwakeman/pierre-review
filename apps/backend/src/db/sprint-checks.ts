// Reports → This sprint — which chips a workspace raises. The ONE reader and writer of
// `workspaces.sprint_checks` (migration 0102 / pg 0089). OVERRIDES ONLY: NULL (or `{off:[],
// issueTypes:{}}`, stored as NULL) = every check on for every issue type. Applied server-side by
// `sprintChipsFor` through the shared `sprintCheckApplies`, so flagCount, the order and Copy all
// agree with what is on screen.
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_CHECKS_DEFAULT,
  SPRINT_CHECK_ISSUE_TYPES_MAX,
  SPRINT_CHECK_ISSUE_TYPE_MAX_CHARS,
  SPRINT_CHIPS,
  type SprintChecks,
  type SprintChipId,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { workspaces } = schema;

const isChipId = (v: unknown): v is SprintChipId => typeof v === 'string' && Object.hasOwn(SPRINT_CHIPS, v);

/** A stored or posted value as clean `SprintChecks`, or null when it is malformed. Unknown chip ids
 *  are dropped from a STORED value (a chip renamed later) but refused in a POSTED one (`strict`). */
export function parseSprintChecks(raw: unknown, strict: boolean): SprintChecks | null {
  if (raw == null) return { off: [], issueTypes: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { off?: unknown; issueTypes?: unknown };
  const offIn = r.off ?? [];
  const typesIn = r.issueTypes ?? {};
  if (!Array.isArray(offIn) || typeof typesIn !== 'object' || typesIn == null || Array.isArray(typesIn)) return null;
  const off: SprintChipId[] = [];
  for (const id of offIn) {
    if (isChipId(id)) {
      if (!off.includes(id)) off.push(id);
    } else if (strict) return null;
  }
  const issueTypes: Partial<Record<SprintChipId, string[]>> = {};
  for (const [id, list] of Object.entries(typesIn as Record<string, unknown>)) {
    if (!isChipId(id)) {
      if (strict) return null;
      continue;
    }
    if (!Array.isArray(list) || list.length > SPRINT_CHECK_ISSUE_TYPES_MAX) return null;
    const names: string[] = [];
    for (const n of list) {
      if (typeof n !== 'string') return null;
      const t = n.trim();
      if (t === '' || t.length > SPRINT_CHECK_ISSUE_TYPE_MAX_CHARS || /[\u0000-\u001f]/.test(t)) return null;
      if (!names.some((x) => x.toLowerCase() === t.toLowerCase())) names.push(t);
    }
    if (names.length > 0) issueTypes[id] = names;
  }
  return { off, issueTypes };
}

const isDefault = (c: SprintChecks): boolean => c.off.length === 0 && Object.keys(c.issueTypes).length === 0;

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
