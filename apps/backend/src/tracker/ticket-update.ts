import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TICKET_UPDATE_FIELD_MAX,
  TICKET_UPDATE_NO_CRITERIA_FIELD,
  type TicketUpdateBody,
  type TicketUpdateResponse,
} from '@pierre-review/shared';
import { resolveRequestWorkspaceId, type TrackerContext } from './context.js';
import { auth, issueUrl, markTicketDue, statusChangeErrorMessage, statusGate } from './status-change.js';
import { JiraFetchError, jiraPutJson, type JiraTransport } from './jira/fetch.js';
import { markdownToJiraWiki } from './jira/text.js';

// ── A TRACKER WRITE — the ticket update the reader presses (docs/TRACKERS.md § The ticket update).
// CORE and FREE, Jira only, behind the status change's NOT-A-PROXY gate (`statusGate`: this
// workspace's Jira site, a ticket Limn already holds a row for in this account).
//
//   POST /api/ticket-update?workspace=<id>  { ident, description, acceptanceCriteria }
//        `PUT /rest/api/2/issue/<key>` with the fields the reader sent (null = leave it): the
//        description as markdown → wiki markup (Limn shows it as markdown, `jiraWikiToMarkdown`);
//        the criteria VERBATIM into the custom field Limn read them from (`ac_field_id` on a stored
//        row — Limn shows that field's own text). No such field ⇒ `NoCriteriaField`, before Jira is
//        called. Then the stored PR rows are marked due: the worker reads the ticket again, and the
//        build's Approve reads it live (`readSessionTicket`).
//
// ⚠ Nothing here runs on its own: no worker, no automation, no retry. Only the reader's press writes.
// ⚠ Every failure answers a sentence Limn wrote, never Jira's body; the log carries the CODE only.

const MSG_NOT_JIRA = 'Updating the ticket from Limn works with Jira only. Copy the draft into the ticket instead.';
const CUSTOM_FIELD_RE = /^customfield_\d{1,12}$/;

/** The custom field the ticket's criteria were read from, from any stored row of it in this account. */
async function criteriaFieldOf(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  apiRoot: string,
  key: string,
  ident: string,
): Promise<{ id: string; name: string | null } | null> {
  const t = ctx.schema.trackerTickets;
  const rows = (await ctx.db
    .select({ id: t.acFieldId, name: t.acFieldName })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.provider, 'jira'), eq(t.apiRoot, apiRoot), eq(t.issueKey, key), isNotNull(t.acFieldId)))
    .limit(1)
    .execute()) as Array<{ id: string | null; name: string | null }>;
  const s = ctx.schema.sprintTickets;
  if (rows.length === 0 && s != null && s.acFieldId != null) {
    rows.push(
      ...((await ctx.db
        .select({ id: s.acFieldId, name: s.acFieldName })
        .from(s)
        .where(and(eq(s.accountId, accountId), eq(s.workspaceId, workspaceId), eq(s.ident, ident), isNotNull(s.acFieldId)))
        .limit(1)
        .execute()) as Array<{ id: string | null; name: string | null }>),
    );
  }
  const r = rows[0];
  return r?.id != null && CUSTOM_FIELD_RE.test(r.id) ? { id: r.id, name: r.name } : null;
}

export function registerTicketUpdateRoutes(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  // A type UNION, never anyOf: under anyOf, Fastify's coercion turns a null into "" (the first branch).
  const field = { type: ['string', 'null'], maxLength: TICKET_UPDATE_FIELD_MAX };
  app.post<{ Querystring: { workspace?: string }; Body: TicketUpdateBody }>(
    '/api/ticket-update',
    {
      schema: {
        querystring: { type: 'object', properties: { workspace: { type: 'string', maxLength: 20 } } },
        body: {
          type: 'object',
          required: ['ident', 'description', 'acceptanceCriteria'],
          additionalProperties: false,
          properties: {
            ident: { type: 'string', minLength: 1, maxLength: 600 },
            description: field,
            acceptanceCriteria: field,
          },
        },
      },
    },
    async (req, reply): Promise<TicketUpdateResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const { description, acceptanceCriteria } = req.body;
      if (description == null && acceptanceCriteria == null) {
        return reply.code(400).send({ error: 'NothingToUpdate', message: 'There is nothing to update.' });
      }
      const gate = await statusGate(ctx, accountId, workspaceId, req.body.ident, opts.transport, MSG_NOT_JIRA);
      if (!gate.ok) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
      const fields: Record<string, string> = {};
      if (description != null) fields.description = markdownToJiraWiki(description);
      let criteriaField: { id: string; name: string | null } | null = null;
      if (acceptanceCriteria != null) {
        criteriaField = await criteriaFieldOf(ctx, accountId, workspaceId, gate.apiRoot, gate.key, gate.ident);
        if (criteriaField == null) return reply.code(400).send({ error: 'NoCriteriaField', message: TICKET_UPDATE_NO_CRITERIA_FIELD });
        fields[criteriaField.id] = acceptanceCriteria;
      }
      try {
        await jiraPutJson(issueUrl(gate.call, gate.key), auth(gate.call), { fields }, gate.call.policy, gate.call.transport);
      } catch (err) {
        const code = err instanceof JiraFetchError ? err.code : 'unknown';
        const status = err instanceof JiraFetchError ? err.status : null;
        ctx.log.warn({ accountId, workspaceId, route: 'ticket-update', code, status }, 'jira ticket update failed');
        return reply.code(502).send({ error: 'JiraError', code, message: statusChangeErrorMessage(err) });
      }
      ctx.log.info({ accountId, workspaceId, route: 'ticket-update' }, 'jira ticket updated');
      // SETTLE: the stored rows hold the old text; the worker reads the ticket again at its next pass.
      await markTicketDue(ctx, accountId, gate.apiRoot, gate.key);
      return {
        workspaceId,
        ident: gate.ident,
        updated: { description: description != null, acceptanceCriteria: acceptanceCriteria != null },
        criteriaField: criteriaField == null ? null : (criteriaField.name ?? criteriaField.id),
      };
    },
  );
}
