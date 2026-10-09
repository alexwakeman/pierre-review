// The WRITE half of `workspace_setting_events` (migration 0096 / pg 0083), with NO database import
// of its own: the caller hands in the executor and schema it already holds. That is what lets the
// context-injected writers (the auto-review switch takes an `AgentContext`, the tracker a
// `TrackerContext`) record a change without importing `db/client.js` — an import-time DB open in a
// module a test loads before setting DATABASE_URL is how test rows once leaked into the real dev
// database. Core callers go through `recordWorkspaceSettingEvent` (./workspace-setting-events.ts).
//
// ⚠ NEVER FATAL: the setting is already stored when this runs. A missing table (an executor whose
// schema predates 0096) is a silent no-op, and an insert error is logged and swallowed.
import type { WorkspaceSettingEventKind } from '@pierre-review/shared';

/** Summaries are short sentences; anything longer is cut, never stored whole. */
const SUMMARY_MAX = 200;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function writeSettingEvent(
  exec: { db: any; schema: Record<string, any> },
  accountId: number,
  workspaceId: number,
  kind: WorkspaceSettingEventKind,
  summary: string,
  at: Date = new Date(),
): Promise<void> {
  const table = exec.schema.workspaceSettingEvents;
  if (table == null) return;
  try {
    await exec.db
      .insert(table)
      .values({
        accountId,
        workspaceId,
        kind,
        summary: summary.slice(0, SUMMARY_MAX),
        // Whole seconds: SQLite stores this column in seconds.
        occurredAt: new Date(Math.floor(at.getTime() / 1000) * 1000),
      })
      .execute();
  } catch (err) {
    console.warn('[workspace-setting-events] could not record a setting change', err);
  }
}

/** "switched on" / "switched off" — the one spelling every on/off summary uses. */
export function onOff(on: boolean): string {
  return on ? 'switched on' : 'switched off';
}
