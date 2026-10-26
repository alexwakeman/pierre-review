import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TICKET_STATUS_NO_PERMISSION,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketIdent,
  trackerTicketRow,
  type JiraStatusCategory,
  type TicketStatusChangeBody,
  type TicketStatusChangeResponse,
  type TicketTransition,
  type TicketTransitionsResponse,
} from '@pierre-review/shared';
import { resolveRequestWorkspaceId, type TrackerContext } from './context.js';
import { maybeAdapterFor } from './registry.js';
import { readWorkspaceTrackerAccess } from './settings.js';
import { prepareTrackerCall } from './calls.js';
import { isTicketKey, jiraAuthHeader, jiraErrorMessage, statusOf, type JiraCall } from './jira/client.js';
import { JiraFetchError, jiraGetJson, jiraPostJson, type JiraTransport } from './jira/fetch.js';

// ── THE ONE TRACKER WRITE — a Jira status transition the reader picks (docs/TRACKERS.md § The status
// change). CORE and FREE, Jira only.
//
//   GET  /api/ticket-status/transitions?workspace=<id>&ident=…  the transitions Jira allows from the
//        current status. Fetched when the story view's picker OPENS, never on mount: one Jira call,
//        plus a permission check ONLY when Jira offers nothing (to tell "may not" from "nowhere to go").
//   POST /api/ticket-status?workspace=<id>  { ident, transitionId }  makes that transition, then
//        SETTLES: re-reads the ticket's status and writes it to every stored row of the ticket
//        (`tracker_tickets` on that site, `sprint_tickets`, `sprint_ref_tickets` — this account only).
//        A failed re-read marks the PR rows due, so the worker reads them at its next pass.
//
// ⚠ STILL NOT A TRACKER PROXY: the ident must name THIS workspace's Jira site, and Limn must already
// hold a row for the ticket in this account (a PR's ticket, or this workspace's sprint / referenced
// ticket). Any other key is refused BEFORE Jira is called.
// ⚠ Every failure answers a sentence Limn wrote, never Jira's body; the log carries the CODE only.
// ⚠ Nothing here runs on its own: no worker, no automation, no retry. Only the reader's pick writes.

const TRANSITION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRANSITIONS_MAX = 50;
const MSG_NOT_HELD = 'Limn holds no such ticket in this workspace.';
const MSG_NOT_JIRA = 'Changing the status works with Jira only.';
const MSG_REFUSED = 'Jira refused this change.';

const STATUS_CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

// ---- the Jira calls (REST v2: Cloud AND Server / Data Center, like ./jira/client.ts) ----

/**
 * Jira's `GET …/transitions?expand=transitions.fields` → the transitions this token may make now.
 * Left out: `isAvailable: false` (Cloud names a transition whose conditions fail), and any transition
 * with a REQUIRED field that has no default — Limn fills no fields, so Jira would refuse it.
 */
export function toTransitions(raw: unknown): TicketTransition[] {
  const list = asRecord(raw)?.transitions;
  if (!Array.isArray(list)) return [];
  const out: TicketTransition[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const t = asRecord(x);
    if (t == null) continue;
    const id = typeof t.id === 'string' ? t.id : typeof t.id === 'number' ? String(t.id) : '';
    if (!TRANSITION_ID_RE.test(id) || seen.has(id)) continue;
    if (t.isAvailable === false) continue;
    const fields = asRecord(t.fields);
    if (
      fields != null &&
      Object.values(fields).some((f) => asRecord(f)?.required === true && asRecord(f)?.hasDefaultValue !== true)
    ) {
      continue;
    }
    const to = statusOf(t.to);
    if (to == null) continue;
    const name = typeof t.name === 'string' && t.name.trim() !== '' ? t.name.trim().slice(0, 100) : to.name;
    seen.add(id);
    out.push({ id, name, to: { name: to.name, category: to.category } });
    if (out.length >= TRANSITIONS_MAX) break;
  }
  return out;
}

const auth = (call: JiraCall): Record<string, string> => ({ authorization: jiraAuthHeader(call.credentials) });
const issueUrl = (call: JiraCall, key: string): string => `${call.apiRoot}/rest/api/2/issue/${encodeURIComponent(key)}`;

export async function fetchJiraTransitions(call: JiraCall, key: string): Promise<TicketTransition[]> {
  const raw = await jiraGetJson(`${issueUrl(call, key)}/transitions?expand=transitions.fields`, auth(call), call.policy, call.transport);
  return toTransitions(raw);
}

/** Whether the token holds TRANSITION_ISSUES on this issue; null when Jira did not say. */
export async function fetchJiraCanTransition(call: JiraCall, key: string): Promise<boolean | null> {
  const raw = await jiraGetJson(
    `${call.apiRoot}/rest/api/2/mypermissions?issueKey=${encodeURIComponent(key)}&permissions=TRANSITION_ISSUES`,
    auth(call),
    call.policy,
    call.transport,
  );
  const p = asRecord(asRecord(asRecord(raw)?.permissions)?.TRANSITION_ISSUES)?.havePermission;
  return typeof p === 'boolean' ? p : null;
}

export async function postJiraTransition(call: JiraCall, key: string, transitionId: string): Promise<void> {
  await jiraPostJson(`${issueUrl(call, key)}/transitions`, auth(call), { transition: { id: transitionId } }, call.policy, call.transport);
}

export async function fetchJiraStatus(call: JiraCall, key: string): Promise<ReturnType<typeof statusOf>> {
  const raw = await jiraGetJson(`${issueUrl(call, key)}?fields=status`, auth(call), call.policy, call.transport);
  return statusOf(asRecord(asRecord(raw)?.fields)?.status);
}

/** The sentence for a failed status call. 403 → the token may not change it; a POST's 400 → refused. */
export function statusChangeErrorMessage(err: unknown): string {
  if (err instanceof JiraFetchError) {
    if (err.code === 'forbidden') return TICKET_STATUS_NO_PERMISSION;
    if (err.code === 'http' && err.status === 400) return MSG_REFUSED;
  }
  return jiraErrorMessage(err);
}

// ---- the gate ----

type Gate =
  | { ok: false; status: number; error: string; message: string }
  | { ok: true; call: JiraCall; key: string; apiRoot: string; ident: string };

/**
 * ⚠ THE NOT-A-PROXY GATE: the workspace's tracker is Jira with a usable token, the ident names its
 * site, and Limn already holds a row for the ticket in this account.
 */
export async function statusGate(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  rawIdent: string,
  transport: JiraTransport | undefined,
): Promise<Gate> {
  const access = await readWorkspaceTrackerAccess(ctx, accountId, workspaceId);
  if (access.issue.provider !== 'jira') return { ok: false, status: 400, error: 'NotJira', message: MSG_NOT_JIRA };
  const parsed = parseTicketIdent(rawIdent);
  const notHeld = { ok: false as const, status: 404, error: 'TicketNotFound', message: MSG_NOT_HELD };
  if (!isTrackerIdent(parsed)) return notHeld;
  const row = trackerTicketRow(parsed);
  const siteRoot = maybeAdapterFor('jira')?.siteRoot(access.issue.baseUrl) ?? null;
  if (row.provider !== 'jira' || siteRoot == null || row.apiRoot !== siteRoot || !isTicketKey(row.issueKey)) return notHeld;
  const ident = trackerTicketIdent('jira', row.apiRoot, row.issueKey);
  if (!(await holdsTicket(ctx, accountId, workspaceId, row.apiRoot, row.issueKey, ident))) return notHeld;
  const prepared = prepareTrackerCall(access, { transport });
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error, message: prepared.message };
  return { ok: true, call: prepared.call, key: row.issueKey, apiRoot: row.apiRoot, ident };
}

async function holdsTicket(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  apiRoot: string,
  key: string,
  ident: string,
): Promise<boolean> {
  const t = ctx.schema.trackerTickets;
  const pr = (await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.provider, 'jira'), eq(t.apiRoot, apiRoot), eq(t.issueKey, key)))
    .limit(1)
    .execute()) as unknown[];
  if (pr.length > 0) return true;
  for (const table of [ctx.schema.sprintTickets, ctx.schema.sprintRefTickets]) {
    if (table == null) continue;
    const rows = (await ctx.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.accountId, accountId), eq(table.workspaceId, workspaceId), eq(table.ident, ident)))
      .limit(1)
      .execute()) as unknown[];
    if (rows.length > 0) return true;
  }
  return false;
}

// ---- the settle ----

/**
 * Write the status Jira reported to every stored row of the ticket in this account. Only the status
 * columns move: a status change is not a story change (`changed_at` stays), and the status id is
 * written only when Jira sent one (a column is cleared only on a positive statement).
 */
export async function writeTicketStatus(
  ctx: TrackerContext,
  accountId: number,
  apiRoot: string,
  key: string,
  ident: string,
  status: { name: string; category: JiraStatusCategory | null; id?: string | null },
): Promise<void> {
  // sprint_ref_tickets has no status id column.
  const refSet = { statusName: status.name, statusCategory: status.category };
  const set = { ...refSet, ...(status.id != null ? { statusId: status.id } : {}) };
  const t = ctx.schema.trackerTickets;
  await ctx.db
    .update(t)
    .set(set)
    .where(and(eq(t.accountId, accountId), eq(t.provider, 'jira'), eq(t.apiRoot, apiRoot), eq(t.issueKey, key)))
    .execute();
  const s = ctx.schema.sprintTickets;
  if (s != null) {
    await ctx.db.update(s).set(set).where(and(eq(s.accountId, accountId), eq(s.ident, ident))).execute();
  }
  const r = ctx.schema.sprintRefTickets;
  if (r != null) {
    await ctx.db.update(r).set(refSet).where(and(eq(r.accountId, accountId), eq(r.ident, ident))).execute();
  }
}

/** The re-read failed after a made change: the worker reads the PR rows at its next pass. */
async function markTicketDue(ctx: TrackerContext, accountId: number, apiRoot: string, key: string): Promise<void> {
  const t = ctx.schema.trackerTickets;
  await ctx.db
    .update(t)
    .set({ nextCheckAt: new Date(0) })
    .where(and(eq(t.accountId, accountId), eq(t.provider, 'jira'), eq(t.apiRoot, apiRoot), eq(t.issueKey, key)))
    .execute();
}

// ---- the routes ----

function failed(
  ctx: TrackerContext,
  reply: FastifyReply,
  err: unknown,
  where: { accountId: number; workspaceId: number; route: string },
): FastifyReply {
  const code = err instanceof JiraFetchError ? err.code : 'unknown';
  const status = err instanceof JiraFetchError ? err.status : null;
  ctx.log.warn({ ...where, code, status }, 'jira status change failed');
  return reply.code(502).send({ error: 'JiraError', code, message: statusChangeErrorMessage(err) });
}

export function registerTicketStatusRoutes(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  app.get<{ Querystring: { workspace?: string; ident?: string } }>(
    '/api/ticket-status/transitions',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['ident'],
          properties: {
            workspace: { type: 'string', maxLength: 20 },
            ident: { type: 'string', minLength: 1, maxLength: 600 },
          },
        },
      },
    },
    async (req, reply): Promise<TicketTransitionsResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const gate = await statusGate(ctx, accountId, workspaceId, req.query.ident ?? '', opts.transport);
      if (!gate.ok) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
      try {
        const transitions = await fetchJiraTransitions(gate.call, gate.key);
        let canTransition: boolean | null = null;
        if (transitions.length === 0) {
          // Jira lists nothing both when the workflow has nowhere to go and when the token may not
          // transition; one more call tells them apart. Its failure is "not known", never an error.
          canTransition = await fetchJiraCanTransition(gate.call, gate.key).catch(() => null);
        }
        return { workspaceId, ident: gate.ident, transitions, canTransition };
      } catch (err) {
        return failed(ctx, reply, err, { accountId, workspaceId, route: 'transitions' });
      }
    },
  );

  app.post<{ Querystring: { workspace?: string }; Body: TicketStatusChangeBody }>(
    '/api/ticket-status',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { workspace: { type: 'string', maxLength: 20 } },
        },
        body: {
          type: 'object',
          required: ['ident', 'transitionId'],
          additionalProperties: false,
          properties: {
            ident: { type: 'string', minLength: 1, maxLength: 600 },
            transitionId: { type: 'string', pattern: TRANSITION_ID_RE.source },
          },
        },
      },
    },
    async (req, reply): Promise<TicketStatusChangeResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const gate = await statusGate(ctx, accountId, workspaceId, req.body.ident, opts.transport);
      if (!gate.ok) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
      try {
        await postJiraTransition(gate.call, gate.key, req.body.transitionId);
      } catch (err) {
        return failed(ctx, reply, err, { accountId, workspaceId, route: 'transition' });
      }
      ctx.log.info({ accountId, workspaceId, route: 'transition' }, 'jira status changed');
      // SETTLE: read back what Jira now says, and store it. The change is made either way.
      let status: Awaited<ReturnType<typeof fetchJiraStatus>> = null;
      try {
        status = await fetchJiraStatus(gate.call, gate.key);
      } catch (err) {
        const code = err instanceof JiraFetchError ? err.code : 'unknown';
        ctx.log.warn({ accountId, workspaceId, route: 'transition-settle', code }, 'jira status re-read failed');
      }
      if (status != null) await writeTicketStatus(ctx, accountId, gate.apiRoot, gate.key, gate.ident, status);
      else await markTicketDue(ctx, accountId, gate.apiRoot, gate.key);
      return {
        workspaceId,
        ident: gate.ident,
        status: status == null ? null : { name: status.name, category: status.category },
      };
    },
  );
}
