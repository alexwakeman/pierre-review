import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  spliceAcSection,
  TICKET_UPDATE_FIELD_MAX,
  TICKET_UPDATE_FIELD_NOT_EDITABLE,
  TICKET_UPDATE_FIELD_ONE_LINE,
  type TicketUpdateBody,
  type TicketUpdateCurrent,
  type TicketUpdateResponse,
} from '@pierre-review/shared';
import { resolveRequestWorkspaceId, type TrackerContext } from './context.js';
import { auth, issueUrl, markTicketDue, statusChangeErrorMessage, statusGate } from './status-change.js';
import { JiraFetchError, jiraGetJson, jiraPutJson, type JiraTransport } from './jira/fetch.js';
import { criteriaFieldFormat, JIRA_TEXTFIELD_MAX, markdownToJiraWiki, plainOneLine, spliceWikiAcSection } from './jira/text.js';
import { storedTicketText } from './ac-location.js';
import { readWorkspaceTrackerAccess } from './settings.js';

// ── A TRACKER WRITE — the ticket update the reader presses (docs/TRACKERS.md § The ticket update).
// CORE and FREE, Jira only, behind the status change's NOT-A-PROXY gate (`statusGate`: this
// workspace's Jira site, a ticket Limn already holds a row for in this account).
//
//   GET  /api/ticket-update/current?workspace=<id>&ident=<ident>
//        DB only: the ticket as Limn holds it (markdown) and where its criteria live
//        (./ac-location.ts) — what the plan panel's review compares the draft with.
//   POST /api/ticket-update?workspace=<id>  { ident, description, acceptanceCriteria }
//        ONE `PUT /rest/api/2/issue/<key>` with the fields the reader sent (null = leave it):
//          - the description as markdown → wiki markup (Limn shows it as markdown, `jiraWikiToMarkdown`);
//          - the criteria where the ticket keeps them (./ac-location.ts):
//              a custom field  → its FORMAT read from `GET …/editmeta` at press time: a rich-text
//                                field gets wiki markup, a one-line `textfield` plain text (≤ 255
//                                characters, else `CriteriaTooLong`), anything else, or a field not
//                                on the edit screen, `CriteriaFieldNotEditable` — before the PUT;
//              the description → SPLICED into its criteria section: of the description the reader
//                                sent (shared `spliceAcSection`, markdown); with no description sent,
//                                of the LIVE wiki text (one GET, `spliceWikiAcSection`: only the criteria
//                                block changes — Limn's stored markdown copy is lossy and is never
//                                written back);
//              nowhere         → appended to the description under "Acceptance criteria" (same two ways).
//        Then the stored PR rows are marked due: the worker reads the ticket again, and the build's
//        Approve reads it live (`readSessionTicket`).
//
// REST v2 takes wiki strings for rich-text fields on Cloud and Server alike, so Limn never writes ADF
// (only a move to REST v3 would need it).
// ⚠ Nothing here runs on its own: no worker, no automation, no retry. Only the reader's press writes.
// ⚠ Every failure answers a sentence Limn wrote, never Jira's body; the log carries the CODE only.

const TICKET_UPDATE_DESCRIPTION_NOT_TEXT = 'Limn cannot edit this ticket’s description. Copy the criteria into the ticket instead.';
const MSG_NOT_JIRA = 'Updating the ticket from Limn works with Jira only. Copy the draft into the ticket instead.';

function jiraFailed(
  ctx: TrackerContext,
  reply: FastifyReply,
  err: unknown,
  where: { accountId: number; workspaceId: number; step: string },
): FastifyReply {
  const code = err instanceof JiraFetchError ? err.code : 'unknown';
  const status = err instanceof JiraFetchError ? err.status : null;
  ctx.log.warn({ ...where, route: 'ticket-update', code, status }, 'jira ticket update failed');
  return reply.code(502).send({ error: 'JiraError', code, message: statusChangeErrorMessage(err) });
}

export function registerTicketUpdateRoutes(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  app.get<{ Querystring: { workspace?: string; ident: string } }>(
    '/api/ticket-update/current',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['ident'],
          properties: { workspace: { type: 'string', maxLength: 20 }, ident: { type: 'string', minLength: 1, maxLength: 600 } },
        },
      },
    },
    async (req, reply): Promise<TicketUpdateCurrent | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const stored = await storedTicketText(ctx, accountId, workspaceId, req.query.ident);
      if (stored == null) {
        return reply.code(404).send({ error: 'TicketNotFound', message: 'Limn holds no copy of this ticket.' });
      }
      const access = await readWorkspaceTrackerAccess(ctx, accountId, workspaceId);
      return {
        workspaceId,
        ident: req.query.ident,
        jira: access.issue.provider === 'jira' && stored.provider === 'jira',
        description: stored.description,
        acceptanceCriteria: stored.acceptanceCriteria,
        acLocation: stored.acLocation,
        readAt: stored.readAt,
      };
    },
  );

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
      let newDescription = description;
      // A criteria-only press in the description: the LIVE wiki text with only its criteria replaced.
      let wikiDescription: string | null = null;
      let criteriaField: string | null = null;
      let criteriaWritten: TicketUpdateResponse['criteriaWritten'] = null;
      if (acceptanceCriteria != null) {
        const stored = await storedTicketText(ctx, accountId, workspaceId, gate.ident);
        const loc = stored?.acLocation ?? { kind: 'none' as const };
        if (loc.kind === 'field') {
          if (!/^customfield_\d{1,12}$/.test(loc.fieldId)) {
            return reply.code(400).send({ error: 'CriteriaFieldNotEditable', message: TICKET_UPDATE_FIELD_NOT_EDITABLE });
          }
          let meta: unknown;
          try {
            meta = await jiraGetJson(`${issueUrl(gate.call, gate.key)}/editmeta`, auth(gate.call), gate.call.policy, gate.call.transport);
          } catch (err) {
            return jiraFailed(ctx, reply, err, { accountId, workspaceId, step: 'editmeta' });
          }
          const metaFields = (meta as { fields?: Record<string, { schema?: unknown } | undefined> } | null)?.fields;
          const format = criteriaFieldFormat(metaFields?.[loc.fieldId]?.schema);
          if (format == null) {
            return reply.code(400).send({ error: 'CriteriaFieldNotEditable', message: TICKET_UPDATE_FIELD_NOT_EDITABLE });
          }
          if (format === 'plain') {
            const line = plainOneLine(acceptanceCriteria);
            if (line.length > JIRA_TEXTFIELD_MAX) {
              return reply.code(400).send({ error: 'CriteriaTooLong', message: TICKET_UPDATE_FIELD_ONE_LINE });
            }
            fields[loc.fieldId] = line;
          } else {
            fields[loc.fieldId] = markdownToJiraWiki(acceptanceCriteria);
          }
          criteriaField = loc.fieldName ?? loc.fieldId;
          criteriaWritten = 'field';
        } else if (description != null) {
          // The criteria live in the description and the reader sent a description too: splice them
          // into its section of the reader's text (the whole description is written from it).
          newDescription = spliceAcSection(description, acceptanceCriteria, loc.kind === 'description' ? loc.heading : null);
          if (newDescription.length > TICKET_UPDATE_FIELD_MAX * 2) {
            return reply.code(400).send({ error: 'TooLong', message: 'The description is too long to write.' });
          }
          criteriaWritten = 'description';
        } else {
          // CRITERIA ONLY, in the description: Limn's stored copy is lossy markdown (no colours, panels
          // or images), so the description is never rebuilt from it. ONE live read of the wiki text,
          // and ONLY its criteria block is replaced (`spliceWikiAcSection`); every other byte is kept.
          let live: unknown;
          try {
            live = await jiraGetJson(`${issueUrl(gate.call, gate.key)}?fields=description`, auth(gate.call), gate.call.policy, gate.call.transport);
          } catch (err) {
            return jiraFailed(ctx, reply, err, { accountId, workspaceId, step: 'read' });
          }
          const raw = (live as { fields?: { description?: unknown } } | null)?.fields?.description;
          if (raw != null && typeof raw !== 'string') {
            return reply.code(400).send({ error: 'CriteriaFieldNotEditable', message: TICKET_UPDATE_DESCRIPTION_NOT_TEXT });
          }
          const wiki = spliceWikiAcSection(raw ?? '', markdownToJiraWiki(acceptanceCriteria), loc.kind === 'description' ? loc.heading : null);
          if (wiki.length > TICKET_UPDATE_FIELD_MAX * 2) {
            return reply.code(400).send({ error: 'TooLong', message: 'The description is too long to write.' });
          }
          wikiDescription = wiki;
          criteriaWritten = 'description';
        }
      }
      if (wikiDescription != null) fields.description = wikiDescription;
      else if (newDescription != null) fields.description = markdownToJiraWiki(newDescription);
      try {
        await jiraPutJson(issueUrl(gate.call, gate.key), auth(gate.call), { fields }, gate.call.policy, gate.call.transport);
      } catch (err) {
        return jiraFailed(ctx, reply, err, { accountId, workspaceId, step: 'put' });
      }
      ctx.log.info({ accountId, workspaceId, route: 'ticket-update' }, 'jira ticket updated');
      // SETTLE: the stored rows hold the old text; the worker reads the ticket again at its next pass.
      await markTicketDue(ctx, accountId, gate.apiRoot, gate.key);
      return {
        workspaceId,
        ident: gate.ident,
        updated: { description: newDescription != null || wikiDescription != null, acceptanceCriteria: acceptanceCriteria != null },
        criteriaField,
        criteriaWritten,
      };
    },
  );
}
