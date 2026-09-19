// Chronology's working hours and wait budgets, per workspace — the ONE reader and writer of
// `workspaces.flow_settings` (migration 0065 / pg 0052).
//
// The column holds OVERRIDES ONLY. Every reader resolves them against the product defaults with
// `resolveFlowSettings` from packages/shared, so the engine, the route and the Settings form can
// never disagree about what a missing field means.
import { and, eq } from 'drizzle-orm';
import {
  resolveFlowSettings,
  type FlowSettings,
  type ResolvedFlowSettings,
} from '@pierre-review/shared';
import { config } from '../config.js';
import { db, schema } from './client.js';

const { workspaces } = schema;

/** The settings in force for a workspace. A workspace that is not this account's gets the defaults. */
export async function getResolvedFlowSettings(
  accountId: number,
  workspaceId: number,
): Promise<ResolvedFlowSettings> {
  const row = (
    await db
      .select({ flowSettings: workspaces.flowSettings })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return resolveFlowSettings(row?.flowSettings ?? null, config.defaultWorkTimezone);
}

/**
 * Replace a workspace's overrides. The body is the WHOLE override set — a field left out goes
 * back to its default — and an empty object stores NULL, so "Reset to defaults" is `{}`.
 * Callers validate with `validateFlowSettings` first. Returns false when the workspace is not
 * this account's (the route 404s).
 */
export async function setWorkspaceFlowSettings(
  accountId: number,
  workspaceId: number,
  settings: FlowSettings,
): Promise<boolean> {
  const stored = compactFlowSettings(settings);
  const rows = await db
    .update(workspaces)
    .set({ flowSettings: stored })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return rows.length > 0;
}

/** Drop empty branches so "nothing overridden" is stored as NULL, not as `{budgets:{}}`. */
export function compactFlowSettings(s: FlowSettings): FlowSettings | null {
  const out: FlowSettings = {};
  if (s.timeZone !== undefined) out.timeZone = s.timeZone;
  if (s.days !== undefined) out.days = [...new Set(s.days)].sort((a, b) => a - b);
  if (s.startMinute !== undefined && s.endMinute !== undefined) {
    out.startMinute = s.startMinute;
    out.endMinute = s.endMinute;
  }
  if (s.budgets) {
    const budgets: NonNullable<FlowSettings['budgets']> = {};
    for (const [k, v] of Object.entries(s.budgets) as [keyof typeof budgets, { good?: number; ok?: number } | undefined][]) {
      if (!v) continue;
      const b: { good?: number; ok?: number } = {};
      if (v.good !== undefined) b.good = v.good;
      if (v.ok !== undefined) b.ok = v.ok;
      if (Object.keys(b).length > 0) budgets[k] = b;
    }
    if (Object.keys(budgets).length > 0) out.budgets = budgets;
  }
  return Object.keys(out).length > 0 ? out : null;
}
