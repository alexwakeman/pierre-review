import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_PROVIDER_LABEL,
  sprintReplaceBaseText,
  sprintReplaceBaseTruncated,
  sprintReplaceTarget,
  type SprintReplaceTarget,
  type SprintWriteErrorBody,
  type SprintWriteMode,
  type SprintWriteRecord,
  type TrackerProvider,
} from '@pierre-review/shared';
import { db, schema } from '../../db/client.js';
import {
  kickSprintRead,
  markSprintTicketDue,
  readSprintTicket,
  trackerWriteRecordOf,
  type TrackerWriteRow,
} from '../../db/sprint-store.js';
import { prepareTrackerCall } from '../calls.js';
import { rereadSprintTicketNow } from '../sprint/read.js';
import type { FetchedTicket, TrackerCall } from '../types.js';
import { githubAccessFor, type TrackerContext } from '../context.js';
import { readWorkspaceTrackerAccess } from '../settings.js';
import { markDue } from '../store.js';
import { trackerWriteMessage } from './messages.js';
import { WRITERS, classifyWriteError, type TrackerWriter } from './providers.js';

// THE SPRINT WRITE-BACK (Reports → This sprint): write the text a person CONFIRMED to ONE ticket, on
// ONE press. No bulk, no automatic setting, no agent tool reaches this function.
//
// ⚠ CLAIM BEFORE THE WRITE, NEVER RETRY. The `tracker_writes` row is inserted `status:'writing'`
// against its unique `(account_id, request_id)` BEFORE the tracker is called; a second POST carrying
// the same requestId (a double click, a replayed request) is answered with the first record and
// writes nothing. A failure is recorded and shown, never retried; a write cut off after it was sent
// is `maybe_written` for ever (and a restart mid-write sweeps `writing` → `maybe_written`), because
// the tracker may well have stored it and a retry would post it twice.
//
// The replace TARGET is the server's (`sprintReplaceTarget` over the STORED row's criteria field) —
// the client's copy is only compared, so a dialog that showed one field can never write another.

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// One write per (account, ticket) at a time, claimed synchronously (no await between check and add).
const inFlight = new Set<string>();

export function __resetTrackerWriteLocks(): void {
  inFlight.clear();
}

type Refusal = { ok: false; status: number; body: SprintWriteErrorBody };
const refuse = (status: number, error: SprintWriteErrorBody['error'], message: string): Refusal => ({
  ok: false,
  status,
  body: { error, message },
});

const recordOf = (r: TrackerWriteRow): SprintWriteRecord => trackerWriteRecordOf(r, trackerWriteMessage);

const sameTarget = (a: SprintReplaceTarget | undefined, b: SprintReplaceTarget): boolean => {
  if (a == null || a.kind !== b.kind) return false;
  if (a.kind === 'ac_field' && b.kind === 'ac_field') return a.fieldId === b.fieldId && a.fieldName === b.fieldName;
  return true;
};

async function readByRequestId(accountId: number, requestId: string): Promise<TrackerWriteRow | null> {
  const t = schema.trackerWrites;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.requestId, requestId)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

async function readById(accountId: number, id: number): Promise<TrackerWriteRow | null> {
  const t = schema.trackerWrites;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.id, id)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

async function ownAssessmentId(accountId: number, workspaceId: number, ident: string, id: number): Promise<number | null> {
  const t = schema.sprintAssessments;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.ident, ident)))
    .limit(1)
    .execute();
  return rows[0]?.id ?? null;
}

export async function performTrackerWrite(
  ctx: TrackerContext,
  a: {
    accountId: number;
    workspaceId: number;
    ident: string;
    mode: SprintWriteMode;
    text: string;
    requestId: string;
    target?: SprintReplaceTarget;
    /** For 'replace': the `replaceBase.hash` the dialog was built on. */
    baseHash?: string;
    assessmentId?: number | null;
    writers?: Record<TrackerProvider, TrackerWriter>;
    /** Test seam: the live single-ticket read before a replace. */
    fetchTicket?: (call: TrackerCall, key: string) => Promise<FetchedTicket>;
  },
): Promise<{ ok: true; record: SprintWriteRecord } | Refusal> {
  // A repeated requestId is the first press answering again — before any other check, so a replay
  // after the ticket left the list still reads its own outcome rather than a refusal.
  const prior = await readByRequestId(a.accountId, a.requestId);
  if (prior != null) {
    if (prior.ident !== a.ident || prior.workspaceId !== a.workspaceId) {
      return refuse(400, 'bad_request', 'That request id was already used for another ticket.');
    }
    return { ok: true, record: recordOf(prior) };
  }

  // 1. The ticket must be on this workspace's current sprint list, under the workspace's tracker.
  const ticket = await readSprintTicket(a.accountId, a.workspaceId, a.ident);
  if (ticket == null || ticket.inSprint !== true) {
    return refuse(404, 'no_ticket', 'This ticket is not on this workspace’s sprint list.');
  }
  const access = await readWorkspaceTrackerAccess(ctx, a.accountId, a.workspaceId);
  const prepared = prepareTrackerCall(access, {
    cloud: ctx.host.isCloud,
    github: githubAccessFor(ctx, a.accountId),
  });
  if (!prepared.ok) return refuse(prepared.status === 503 ? 503 : 400, 'no_tracker', prepared.message);
  const call = prepared.call;
  if (call.provider !== ticket.provider || (call.provider !== 'github' && call.apiRoot !== ticket.apiRoot)) {
    return refuse(404, 'no_ticket', 'This ticket is not on this workspace’s sprint list.');
  }
  const provider = call.provider;

  // 2. The replace target is the server's; the dialog's copy must match it.
  let target: SprintReplaceTarget | null = null;
  if (a.mode === 'replace') {
    target = sprintReplaceTarget(
      provider,
      ticket.acFieldId != null ? { id: ticket.acFieldId, name: ticket.acFieldName ?? ticket.acFieldId } : null,
    );
    if (!sameTarget(a.target, target)) {
      return refuse(409, 'target_changed', 'Where this ticket keeps its criteria has changed. Open the dialog again.');
    }
    // 2b. ⚠ Replace overwrites the WHOLE field, so the base the dialog was built on must be the
    //     ticket's text NOW. The page carries a capped copy of a list read up to 20 minutes old:
    //     a text longer than the page shows cannot be replaced here at all, and the ticket is read
    //     live before the write — anything edited in the tracker since then refuses, writes nothing,
    //     and the fresh text is stored for the next dialog.
    const storedBase = sprintReplaceBaseText(ticket, target);
    if (sprintReplaceBaseTruncated(storedBase, target)) {
      return refuse(409, 'too_long', 'This ticket’s text is too long to replace here. Add it as a comment instead.');
    }
    const changed = (): Refusal =>
      refuse(409, 'ticket_changed', 'This ticket changed since you opened it. Open the dialog again.');
    if (a.baseHash == null || a.baseHash !== sha256(storedBase)) return changed();
    let live: Awaited<ReturnType<typeof rereadSprintTicketNow>>;
    try {
      live = await rereadSprintTicketNow(ctx, {
        accountId: a.accountId,
        workspaceId: a.workspaceId,
        rowId: ticket.id,
        issueKey: ticket.issueKey,
        call,
        ...(a.fetchTicket != null ? { fetch: a.fetchTicket } : {}),
      });
    } catch (err) {
      ctx.log.warn({ accountId: a.accountId, provider, code: classifyWriteError(err).code }, 'sprint write-back: live re-read failed');
      return refuse(
        502,
        'read_failed',
        `Could not read this ticket from ${SPRINT_PROVIDER_LABEL[provider]} to check it first. Nothing was written. Try again.`,
      );
    }
    const liveTarget = sprintReplaceTarget(
      provider,
      live.acFieldId != null ? { id: live.acFieldId, name: live.acFieldName ?? live.acFieldId } : null,
    );
    if (!sameTarget(liveTarget, target)) {
      return refuse(409, 'target_changed', 'Where this ticket keeps its criteria has changed. Open the dialog again.');
    }
    const liveBase = sprintReplaceBaseText(live, target);
    if (sprintReplaceBaseTruncated(liveBase, target)) {
      return refuse(409, 'too_long', 'This ticket’s text is too long to replace here. Add it as a comment instead.');
    }
    if (sha256(liveBase) !== a.baseHash) return changed();
  }

  // 2c. The assessment id is history only, and it arrives in the body: keep it only when it is this
  //     account's assessment of THIS ticket in THIS workspace, else store nothing.
  const assessmentId = a.assessmentId != null ? await ownAssessmentId(a.accountId, a.workspaceId, a.ident, a.assessmentId) : null;

  // 3. One write per ticket at a time.
  const lockKey = `${a.accountId}:${a.ident}`;
  if (inFlight.has(lockKey)) return refuse(409, 'busy', 'Another update to this ticket is in progress.');
  inFlight.add(lockKey);
  try {
    // 4. CLAIM. The unique (account_id, request_id) makes the insert the claim.
    const t = schema.trackerWrites;
    const claimed = await db
      .insert(t)
      .values({
        accountId: a.accountId,
        workspaceId: a.workspaceId,
        ident: a.ident,
        provider,
        requestId: a.requestId,
        mode: a.mode,
        targetJson: target,
        text: a.text,
        textHash: sha256(a.text),
        status: 'writing',
        assessmentId,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [t.accountId, t.requestId] })
      .returning({ id: t.id })
      .execute();
    const id = claimed[0]?.id;
    if (id == null) {
      const existing = await readByRequestId(a.accountId, a.requestId);
      if (existing == null) throw new Error('tracker_writes: claim lost and no row found');
      return { ok: true, record: recordOf(existing) };
    }

    // 5. THE WRITE — once. Whatever happens is recorded; nothing here loops or retries.
    const writer = (a.writers ?? WRITERS)[provider];
    let status: 'written' | 'failed' | 'maybe_written';
    let errorCode: string | null = null;
    let url: string | null = null;
    try {
      const out =
        a.mode === 'comment'
          ? await writer.comment(call, ticket.issueKey, a.text)
          : await writer.replace(call, ticket.issueKey, target!, a.text, { fieldType: null });
      status = 'written';
      url = out.url ?? ticket.url ?? null;
    } catch (err) {
      const c = classifyWriteError(err);
      status = c.status;
      errorCode = c.code;
      ctx.log.warn({ accountId: a.accountId, provider, code: c.code }, 'sprint write-back failed');
    }

    // 6. Settle the claimed row — compare-and-set from 'writing', so a startup sweep that already
    //    called it `maybe_written` is never overwritten.
    await db
      .update(t)
      .set({ status, errorCode, url, completedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.accountId, a.accountId), eq(t.status, 'writing')))
      .execute();

    // 7. After a write, read the ticket again so its text and labels refresh.
    if (status === 'written') {
      try {
        await markSprintTicketDue(a.accountId, a.workspaceId, a.ident);
        const tt = ctx.schema.trackerTickets;
        const rows = (await ctx.db
          .select({ id: tt.id })
          .from(tt)
          .where(
            and(
              eq(tt.accountId, a.accountId),
              eq(tt.provider, ticket.provider),
              eq(tt.apiRoot, ticket.apiRoot),
              eq(tt.issueKey, ticket.issueKey),
            ),
          )
          .execute()) as Array<{ id: number }>;
        await markDue(ctx, a.accountId, rows.map((r) => r.id));
      } catch (err) {
        ctx.log.warn({ accountId: a.accountId, err: String(err) }, 'sprint write-back: re-read mark failed');
      }
      kickSprintRead(a.accountId, a.workspaceId);
    }

    const row = await readById(a.accountId, id);
    if (row == null) throw new Error('tracker_writes: settled row vanished');
    return { ok: true, record: recordOf(row) };
  } finally {
    inFlight.delete(lockKey);
  }
}

/** Boot sweep: a write still `writing` was cut off by a restart — it may have landed. */
export async function reconcileTrackerWritesOnStartup(): Promise<number> {
  const t = schema.trackerWrites;
  const rows = await db
    .update(t)
    .set({ status: 'maybe_written', errorCode: 'interrupted', completedAt: new Date() })
    .where(eq(t.status, 'writing'))
    .returning({ id: t.id })
    .execute();
  return rows.length;
}
