// Reports → This sprint — the workspace's STATUS LAYOUT override. The ONE reader and writer of
// `workspaces.sprint_statuses` (migration 0103 / pg 0090; shared `SprintStatusSettings`). OVERRIDES
// ONLY: NULL (or the default `{order: null, deliveredFrom: null}`, stored as NULL) = the automatic
// order (`sprint_reads.status_order_json`) and the automatic "code delivered from"
// (db/sprint-status-layout.ts). Status NAMES, matched case-insensitively by the fold.
//
// A STORED value is read tolerantly (bad names dropped, a malformed half read as automatic); only a
// POSTED value is strict (shared `SprintStatusesUpdate`).
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_STATUS_NAME_MAX,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_STATUS_SETTINGS_DEFAULT,
  type SprintStatusSettings,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { workspaces } = schema;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const badName = (n: string): boolean => n === '' || n.length > SPRINT_STATUS_NAME_MAX || CONTROL.test(n);

/** A stored or posted value as clean settings, or null when a POSTED one is malformed (`strict`):
 *  a non-object, a non-array non-null `order`, a non-string name, an empty / over-long / control-
 *  character name, more than SPRINT_STATUS_ORDER_MAX names, a duplicate name (case-insensitive), or a
 *  `deliveredFrom` that is not a valid name or null. A stored value never reads as null. */
export function parseSprintStatusSettings(raw: unknown, strict: boolean): SprintStatusSettings | null {
  const fallback = (): SprintStatusSettings | null => (strict ? null : { ...SPRINT_STATUS_SETTINGS_DEFAULT });
  if (raw == null) return strict ? null : { ...SPRINT_STATUS_SETTINGS_DEFAULT };
  if (typeof raw !== 'object' || Array.isArray(raw)) return fallback();
  const r = raw as { order?: unknown; deliveredFrom?: unknown };

  let order: string[] | null = null;
  if (r.order != null) {
    if (!Array.isArray(r.order)) {
      if (strict) return null;
    } else {
      if (strict && r.order.length > SPRINT_STATUS_ORDER_MAX) return null;
      const out: string[] = [];
      const seen = new Set<string>();
      for (const n of r.order) {
        const t = typeof n === 'string' ? n.trim() : '';
        if (typeof n !== 'string' || badName(t)) {
          if (strict) return null;
          continue;
        }
        const k = t.toLowerCase();
        if (seen.has(k)) {
          if (strict) return null;
          continue;
        }
        seen.add(k);
        out.push(t);
      }
      order = out.length > 0 ? out.slice(0, SPRINT_STATUS_ORDER_MAX) : null;
    }
  }

  let deliveredFrom: string | null = null;
  if (r.deliveredFrom != null) {
    const t = typeof r.deliveredFrom === 'string' ? r.deliveredFrom.trim() : '';
    if (typeof r.deliveredFrom !== 'string' || badName(t)) {
      if (strict) return null;
    } else deliveredFrom = t;
  }
  return { order, deliveredFrom };
}

const isDefault = (s: SprintStatusSettings): boolean => (s.order == null || s.order.length === 0) && s.deliveredFrom == null;

/** The workspace's override (the default for a workspace that is not this account's). */
export async function getSprintStatusSettings(accountId: number, workspaceId: number): Promise<SprintStatusSettings> {
  const row = (
    await db
      .select({ sprintStatuses: workspaces.sprintStatuses })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return parseSprintStatusSettings(row?.sprintStatuses ?? null, false) ?? { ...SPRINT_STATUS_SETTINGS_DEFAULT };
}

/** Replace the override (already validated; the default is stored as NULL). False when the workspace
 *  is not this account's. */
export async function setSprintStatusSettings(
  accountId: number,
  workspaceId: number,
  settings: SprintStatusSettings,
): Promise<boolean> {
  const rows = await db
    .update(workspaces)
    .set({ sprintStatuses: isDefault(settings) ? null : { order: settings.order, deliveredFrom: settings.deliveredFrom } })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return rows.length > 0;
}
