import { and, eq } from 'drizzle-orm';
import { type SprintReadState } from '@pierre-review/shared';
import { db, schema } from './client.js';

// REPORTS → THIS SPRINT — the SHARED STORE HALF (foundation module; the tracker sprint read, the
// graph and the story view import it, none of them owns it). The demand gate
// (`sprint_reads.viewed_at`), the "read me again now" marks and the one-ticket read. Schema + rationale: db/schema.sqlite.ts § REPORTS → THIS SPRINT.
//
// Every query predicates on accountId (and workspaceId where the table has one). Portable Drizzle
// only (`.execute()` terminals, `onConflictDoUpdate`), no transactions needed: each write is one
// statement.

export type SprintReadRow = typeof schema.sprintReads.$inferSelect;
export type SprintTicketDbRow = typeof schema.sprintTickets.$inferSelect;

const EPOCH = new Date(0);

// ── the demand gate + due marks ─────────────────────────────────────────────────────────────────

/**
 * GET /api/sprint-graph served this workspace: stamp `viewed_at`. A workspace with no row gets one
 * that is DUE NOW (`next_read_at` = epoch 0), so its first read happens on the next tick (or the
 * kick below). Returns the row as stored.
 */
export async function noteSprintViewed(accountId: number, workspaceId: number, now: Date = new Date()): Promise<SprintReadRow> {
  const t = schema.sprintReads;
  await db
    .insert(t)
    .values({ accountId, workspaceId, nextReadAt: EPOCH, viewedAt: now })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: { viewedAt: now } })
    .execute();
  const row = await readSprintRead(accountId, workspaceId);
  if (row == null) throw new Error('sprint_reads: upsert returned no row');
  return row;
}

export async function readSprintRead(accountId: number, workspaceId: number): Promise<SprintReadRow | null> {
  const t = schema.sprintReads;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

/** Ask for the workspace's list to be read on the next tick (a Refresh press). No-op without a row. */
export async function markSprintReadDue(accountId: number, workspaceId: number): Promise<void> {
  const t = schema.sprintReads;
  await db
    .update(t)
    .set({ nextReadAt: EPOCH })
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
}

/**
 * The workspace moved to another tracker or site since its stored read: forget that read (it is not
 * this list) and make a new one due now. The row is re-stamped with the NEW site, so a failure of
 * the new tracker's read is shown as its own sentence rather than reset again on every view.
 */
export async function resetSprintReadForSite(
  accountId: number,
  workspaceId: number,
  site: { provider: string; apiRoot: string },
): Promise<SprintReadRow | null> {
  const t = schema.sprintReads;
  await db
    .update(t)
    .set({
      provider: site.provider,
      apiRoot: site.apiRoot,
      sourceJson: null,
      statusOrderJson: null,
      readAt: null,
      checkedAt: null,
      errorCode: null,
      truncated: false,
      nextReadAt: EPOCH,
      // Another tracker: its sprint, its dates, its story attempts.
      sprintStartsAt: null,
      sprintEndsAt: null,
      storyAttemptAt: null,
      storyAttemptHash: null,
      storyAttemptError: null,
    })
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
  return readSprintRead(accountId, workspaceId);
}

/** The read state for the wire. `errorMessage` is the provider-named sentence for `error_code`. */
export function sprintReadStateOf(row: SprintReadRow | null, errorMessage: (code: string) => string): SprintReadState {
  return {
    readAt: row?.readAt != null ? row.readAt.toISOString() : null,
    checkedAt: row?.checkedAt != null ? row.checkedAt.toISOString() : null,
    error: row?.errorCode != null ? errorMessage(row.errorCode) : null,
    truncated: row?.truncated === true,
  };
}

// ── the kick seam (set by the tracker sprint read, B1; absent → the next tick reads it) ─────────

type SprintReadKicker = (accountId: number, workspaceId: number) => void;
let kicker: SprintReadKicker | null = null;

/** The tracker's sprint read registers its fire-and-forget kick here at boot. */
export function setSprintReadKicker(fn: SprintReadKicker | null): void {
  kicker = fn;
}

/** Fire-and-forget: read this workspace's sprint list soon. Never throws. */
export function kickSprintRead(accountId: number, workspaceId: number): void {
  try {
    kicker?.(accountId, workspaceId);
  } catch {
    /* a kick is best effort; the tick reads it anyway */
  }
}

/** One stored sprint ticket of this workspace (in the list or not), or null. */
export async function readSprintTicket(accountId: number, workspaceId: number, ident: string): Promise<SprintTicketDbRow | null> {
  const t = schema.sprintTickets;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.ident, ident)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}
