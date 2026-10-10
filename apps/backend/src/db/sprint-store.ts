import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  SPRINT_ASSESS_FORMAT_VERSION,
  SPRINT_ASSESS_MODEL,
  STORY_ISSUE_IDS,
  isStoryIssueId,
  type SprintAssessmentBody,
  type SprintAssessmentIssue,
  type SprintAssessmentErrorCode,
  type SprintAssessmentPhase,
  type SprintAssessmentRecord,
  type SprintAssessmentStatus,
  type SprintReadState,
  type SprintWriteErrorCode,
  type SprintWriteMode,
  type SprintWriteRecord,
  type SprintWriteStatus,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

// REPORTS → THIS SPRINT — the SHARED STORE HALF (foundation module; the tracker sprint read, the
// assessment and the write-back all import it, none of them owns it). Row → wire mappers, the
// demand gate (`sprint_reads.viewed_at`), the "read me again now" marks, the two currency hashes and
// the latest-per-ticket reads. Schema + rationale: db/schema.sqlite.ts § REPORTS → THIS SPRINT.
//
// Every query predicates on accountId (and workspaceId where the table has one). Portable Drizzle
// only (`.execute()` terminals, `onConflictDoUpdate`), no transactions needed: each write is one
// statement.

export type SprintReadRow = typeof schema.sprintReads.$inferSelect;
export type SprintTicketDbRow = typeof schema.sprintTickets.$inferSelect;
export type SprintAssessmentRow = typeof schema.sprintAssessments.$inferSelect;
export type TrackerWriteRow = typeof schema.trackerWrites.$inferSelect;

const EPOCH = new Date(0);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── currency ─────────────────────────────────────────────────────────────────────────────────────

/** sha256(title | description | acceptance criteria) of a sprint ticket — the SAME fold as
 *  tracker/peers.ts `storyHash` and ticket-review `ticketHash`, so one ticket text has one hash. */
export function sprintTicketTextHash(t: { title: string | null; description: string | null; acceptanceCriteria: string | null }): string {
  return sha256([t.title ?? '', t.description ?? '', t.acceptanceCriteria ?? ''].join('\u0000'));
}

/** The assessment's currency input: the body format (`SPRINT_ASSESS_FORMAT_VERSION`, so a run stored
 *  in an older shape reads 'stale'), the ticket text hash + sorted "repoId:defaultBranchHeadSha"
 *  (the SYNCED `repos.default_branch_head_sha`; null → ''). Pure and clock-free. */
export function sprintAssessFingerprint(textHash: string, repos: ReadonlyArray<{ repoId: number; sha: string | null }>): string {
  const parts = [...repos].sort((a, b) => a.repoId - b.repoId).map((r) => `${r.repoId}:${r.sha ?? ''}`);
  return sha256([`sprint-assess-v${SPRINT_ASSESS_FORMAT_VERSION}`, textHash, ...parts].join('\u0000'));
}

// ── the demand gate + due marks ─────────────────────────────────────────────────────────────────

/**
 * GET /api/sprint-stories served this workspace: stamp `viewed_at`. A workspace with no row gets one
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
      readAt: null,
      checkedAt: null,
      errorCode: null,
      truncated: false,
      nextReadAt: EPOCH,
    })
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
  return readSprintRead(accountId, workspaceId);
}

/** Ask for ONE ticket to be re-read alone at once (after a write-back). `next_check_at` = epoch 0. */
export async function markSprintTicketDue(accountId: number, workspaceId: number, ident: string): Promise<void> {
  const t = schema.sprintTickets;
  await db
    .update(t)
    .set({ nextCheckAt: EPOCH })
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.ident, ident)))
    .execute();
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

// ── row → wire ───────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);

/** A stored `body_json` as the CURRENT body shape, or null when it is another shape (an older
 *  format, or damaged). Re-checked defensively — a malformed issue entry is dropped, never thrown on. */
export function sprintAssessmentBodyFromStored(raw: unknown): SprintAssessmentBody | null {
  if (!isObj(raw) || typeof raw.summary !== 'string' || !Array.isArray(raw.issues) || !Array.isArray(raw.revisedCriteria)) {
    return null;
  }
  const issues: SprintAssessmentIssue[] = [];
  for (const it of raw.issues) {
    if (!isObj(it) || !isStoryIssueId(it.id) || typeof it.text !== 'string' || it.text.trim() === '') continue;
    if (issues.some((x) => x.id === it.id)) continue;
    const ref =
      isObj(it.ref) && typeof it.ref.repo === 'string' && typeof it.ref.path === 'string'
        ? { repo: it.ref.repo, path: it.ref.path }
        : null;
    issues.push({ id: it.id, text: it.text, ref });
  }
  issues.sort((a, b) => STORY_ISSUE_IDS.indexOf(a.id) - STORY_ISSUE_IDS.indexOf(b.id));
  return {
    summary: raw.summary,
    issues,
    revisedCriteria: raw.revisedCriteria.filter((c): c is string => typeof c === 'string' && c.trim() !== ''),
  };
}

export function sprintAssessmentRecordOf(r: SprintAssessmentRow): SprintAssessmentRecord {
  const live = r.status === 'queued' || r.status === 'running';
  const succeeded = r.status === 'succeeded';
  const body = succeeded ? sprintAssessmentBodyFromStored(r.bodyJson) : null;
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    ident: r.ident,
    model: r.model || SPRINT_ASSESS_MODEL,
    status: r.status as SprintAssessmentStatus,
    phase: live ? ((r.phase as SprintAssessmentPhase | null) ?? null) : null,
    repos: r.reposJson ?? [],
    body,
    outdated: succeeded && body == null,
    dropped: r.droppedJson ?? null,
    error: (r.error as SprintAssessmentErrorCode | null) ?? null,
    costUsd: r.costUsd ?? null,
    numTurns: r.numTurns ?? null,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt != null ? r.completedAt.toISOString() : null,
  };
}

/** `message` comes from the write-back's own sentence table (tracker/write), handed in so this
 *  module stays provider-free. */
export function trackerWriteRecordOf(r: TrackerWriteRow, message: (r: TrackerWriteRow) => string | null): SprintWriteRecord {
  return {
    id: r.id,
    ident: r.ident,
    mode: r.mode as SprintWriteMode,
    target: r.targetJson ?? null,
    status: r.status as SprintWriteStatus,
    error: (r.errorCode as SprintWriteErrorCode | null) ?? null,
    message: message(r),
    url: r.url ?? null,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt != null ? r.completedAt.toISOString() : null,
  };
}

// ── latest per ticket ────────────────────────────────────────────────────────────────────────────

/** The newest assessment (any status) per ident, this account + workspace only. */
export async function latestSprintAssessments(
  accountId: number,
  workspaceId: number,
  idents: readonly string[],
): Promise<Map<string, SprintAssessmentRow>> {
  const out = new Map<string, SprintAssessmentRow>();
  const list = [...new Set(idents)];
  if (list.length === 0) return out;
  const t = schema.sprintAssessments;
  for (let i = 0; i < list.length; i += 500) {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), inArray(t.ident, list.slice(i, i + 500))))
      .orderBy(desc(t.createdAt), desc(t.id))
      .execute();
    for (const r of rows) if (!out.has(r.ident)) out.set(r.ident, r);
  }
  return out;
}

/** The newest write-back (any status) per ident, this account + workspace only. */
export async function latestTrackerWrites(
  accountId: number,
  workspaceId: number,
  idents: readonly string[],
): Promise<Map<string, TrackerWriteRow>> {
  const out = new Map<string, TrackerWriteRow>();
  const list = [...new Set(idents)];
  if (list.length === 0) return out;
  const t = schema.trackerWrites;
  for (let i = 0; i < list.length; i += 500) {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), inArray(t.ident, list.slice(i, i + 500))))
      .orderBy(desc(t.createdAt), desc(t.id))
      .execute();
    for (const r of rows) if (!out.has(r.ident)) out.set(r.ident, r);
  }
  return out;
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
