// WORKSPACE SETTINGS HISTORY — the ONE reader and writer of `workspace_setting_events`
// (migration 0096 / pg 0083). docs/BOTTLENECKS.md § Over time.
//
// Append-only. Each setting's ONE writer calls `recordWorkspaceSettingEvent` after a write that
// actually CHANGED the stored value (a Save that changes nothing records nothing), with a short
// plain-English summary that Chronology's "Over time" charts show as an event marker.
//
// ⚠ NEVER FATAL. Recording history must not fail the settings write it describes: the setting is
// already stored when this runs, so an error here is logged and swallowed.
//
// ⚠ GOING FORWARD ONLY. Nothing is backfilled; `firstSettingEventMs` is what the page quotes as
// "Settings history starts on …".
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { WorkspaceSettingEventKind } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { onOff, writeSettingEvent } from './setting-event-write.js';

export { onOff };

const { workspaceSettingEvents } = schema;

export async function recordWorkspaceSettingEvent(
  accountId: number,
  workspaceId: number,
  kind: WorkspaceSettingEventKind,
  summary: string,
  at: Date = new Date(),
): Promise<void> {
  await writeSettingEvent({ db, schema }, accountId, workspaceId, kind, summary, at);
}

export interface WorkspaceSettingEventRow {
  id: number;
  kind: WorkspaceSettingEventKind;
  summary: string;
  occurredAtMs: number;
}

/** A workspace's setting changes in `[fromMs, toMs)`, oldest first. Account-scoped. */
export async function listWorkspaceSettingEvents(
  accountId: number,
  workspaceId: number,
  fromMs: number,
  toMs: number,
): Promise<WorkspaceSettingEventRow[]> {
  const rows = await db
    .select({
      id: workspaceSettingEvents.id,
      kind: workspaceSettingEvents.kind,
      summary: workspaceSettingEvents.summary,
      occurredAt: workspaceSettingEvents.occurredAt,
    })
    .from(workspaceSettingEvents)
    .where(
      and(
        eq(workspaceSettingEvents.accountId, accountId),
        eq(workspaceSettingEvents.workspaceId, workspaceId),
        gte(workspaceSettingEvents.occurredAt, new Date(fromMs)),
        lt(workspaceSettingEvents.occurredAt, new Date(toMs)),
      ),
    )
    .orderBy(asc(workspaceSettingEvents.occurredAt), asc(workspaceSettingEvents.id))
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as WorkspaceSettingEventKind,
    summary: r.summary,
    occurredAtMs: r.occurredAt.getTime(),
  }));
}

/** When this workspace's settings history starts — its first row — or null when it has none. */
export async function firstSettingEventMs(
  accountId: number,
  workspaceId: number,
): Promise<number | null> {
  const rows = await db
    .select({ at: workspaceSettingEvents.occurredAt })
    .from(workspaceSettingEvents)
    .where(
      and(
        eq(workspaceSettingEvents.accountId, accountId),
        eq(workspaceSettingEvents.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(workspaceSettingEvents.occurredAt))
    .limit(1)
    .execute();
  return rows[0]?.at.getTime() ?? null;
}
