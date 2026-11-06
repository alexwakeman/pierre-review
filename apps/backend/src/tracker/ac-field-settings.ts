import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { JiraAcFieldSettingsBody, JiraAcFieldSettingsResponse, JiraAcFieldTypeRow } from '@pierre-review/shared';
import { ownedWorkspaceId, type TrackerContext } from './context.js';
import { isJiraFieldId } from './jira/client.js';
import { markDue, parseCandidates, readAcFieldSettings, rederiveAcForIssueType, settingFor, writeAcFieldSetting } from './store.js';

// SETTINGS → TRACKERS: THE ACCEPTANCE-CRITERIA FIELD PER ISSUE TYPE (docs/TRACKERS.md § The criteria
// field). One row per (site, issue type) the workspace has stored Jira tickets for, built from those
// rows alone — never a Jira call. A choice is written with the SAME store writer the old per-ticket
// picker used (`writeAcFieldSetting`), every stored ticket of the type re-derives at once from its
// stored candidates, and they are marked due so the worker reads them again in its own time (no Jira call here).

const wsIdParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;

interface TicketFacts {
  apiRoot: string;
  issueTypeId: string | null;
  issueTypeName: string | null;
  acFieldId: string | null;
  acFieldName: string | null;
  candidatesJson: string | null;
}

/** The rows of the settings list, from the stored tickets and the saved choices. Pure. */
export function acFieldTypeRows(
  tickets: readonly TicketFacts[],
  chosenFor: (apiRoot: string, issueTypeId: string) => { fieldId: string; fieldName: string } | null,
): JiraAcFieldTypeRow[] {
  const byType = new Map<string, { apiRoot: string; id: string; name: string; count: number; inUse: Map<string, { name: string; n: number }>; fields: Map<string, { name: string; n: number }> }>();
  for (const t of tickets) {
    if (t.issueTypeId == null || t.candidatesJson == null) continue;
    const key = `${t.apiRoot}|${t.issueTypeId}`;
    let g = byType.get(key);
    if (!g) {
      g = { apiRoot: t.apiRoot, id: t.issueTypeId, name: t.issueTypeName ?? t.issueTypeId, count: 0, inUse: new Map(), fields: new Map() };
      byType.set(key, g);
    }
    g.count += 1;
    if (t.issueTypeName) g.name = t.issueTypeName;
    if (t.acFieldId != null) {
      const u = g.inUse.get(t.acFieldId) ?? { name: t.acFieldName ?? t.acFieldId, n: 0 };
      u.n += 1;
      g.inUse.set(t.acFieldId, u);
    }
    for (const c of parseCandidates(t.candidatesJson)) {
      const f = g.fields.get(c.id) ?? { name: c.name, n: 0 };
      f.n += 1;
      g.fields.set(c.id, f);
    }
  }
  const top = (m: Map<string, { name: string; n: number }>): Array<{ id: string; name: string; n: number }> =>
    [...m.entries()].map(([id, v]) => ({ id, name: v.name, n: v.n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...byType.values()]
    .map((g) => {
      const chosen = chosenFor(g.apiRoot, g.id);
      const inUse = top(g.inUse)[0];
      return {
        apiRoot: g.apiRoot,
        issueTypeId: g.id,
        issueTypeName: g.name,
        ticketCount: g.count,
        chosen: chosen ? { id: chosen.fieldId, name: chosen.fieldName } : null,
        inUse: inUse ? { id: inUse.id, name: inUse.name } : null,
        fields: top(g.fields).map((f) => ({ id: f.id, name: f.name, ticketCount: f.n })),
      };
    })
    .sort((a, b) => b.ticketCount - a.ticketCount || a.issueTypeName.localeCompare(b.issueTypeName));
}

async function readRows(ctx: TrackerContext, accountId: number, workspaceId: number): Promise<JiraAcFieldTypeRow[]> {
  const t = ctx.schema.trackerTickets;
  const tickets = (await ctx.db
    .select({
      apiRoot: t.apiRoot,
      issueTypeId: t.issueTypeId,
      issueTypeName: t.issueTypeName,
      acFieldId: t.acFieldId,
      acFieldName: t.acFieldName,
      candidatesJson: t.candidatesJson,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.provider, 'jira')))
    .execute()) as TicketFacts[];
  const settings = await readAcFieldSettings(ctx, accountId, [workspaceId]);
  return acFieldTypeRows(tickets, (apiRoot, issueTypeId) => {
    const id = settingFor(settings, workspaceId, apiRoot, issueTypeId);
    if (id == null) return null;
    return settings.get(`${workspaceId}|${apiRoot}|${issueTypeId}`) ?? null;
  });
}

export function registerAcFieldSettingsRoutes(app: FastifyInstance, ctx: TrackerContext): void {
  app.get<{ Params: { id: number } }>(
    '/api/workspaces/:id/tracker/ac-fields',
    { schema: { params: wsIdParam } },
    async (req, reply): Promise<JiraAcFieldSettingsResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (ws == null) return reply.code(404).send({ error: 'NotFound', message: `Workspace ${req.params.id} not found` });
      return { workspaceId: ws, types: await readRows(ctx, accountId, ws) };
    },
  );

  app.put<{ Params: { id: number }; Body: JiraAcFieldSettingsBody }>(
    '/api/workspaces/:id/tracker/ac-fields',
    {
      schema: {
        params: wsIdParam,
        body: {
          type: 'object',
          required: ['apiRoot', 'issueTypeId', 'fieldId'],
          additionalProperties: false,
          properties: {
            apiRoot: { type: 'string', minLength: 1, maxLength: 2048 },
            issueTypeId: { type: 'string', minLength: 1, maxLength: 64 },
            fieldId: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (req, reply): Promise<JiraAcFieldSettingsResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (ws == null) return reply.code(404).send({ error: 'NotFound', message: `Workspace ${req.params.id} not found` });
      const { apiRoot, issueTypeId, fieldId } = req.body;
      const row = (await readRows(ctx, accountId, ws)).find((r) => r.apiRoot === apiRoot && r.issueTypeId === issueTypeId);
      if (row == null) return reply.code(404).send({ error: 'UnknownIssueType', message: 'Limn has no tickets of this type in this workspace.' });
      let field: { id: string; name: string } | null = null;
      if (fieldId != null) {
        // Only a field this type's own tickets carry, as the per-ticket picker allowed.
        const f = isJiraFieldId(fieldId) ? row.fields.find((x) => x.id === fieldId) : undefined;
        if (f == null) return reply.code(400).send({ error: 'UnknownField', message: `No ${row.issueTypeName} ticket has the field ${fieldId}.` });
        field = { id: f.id, name: f.name };
      }
      await writeAcFieldSetting(ctx, accountId, ws, apiRoot, issueTypeId, field, new Date());
      const touched = await rederiveAcForIssueType(ctx, accountId, ws, apiRoot, issueTypeId, field?.id ?? null);
      // Due again: the worker reads them on its own cadence and budget, as after a per-ticket change.
      await markDue(ctx, accountId, touched);
      return { workspaceId: ws, types: await readRows(ctx, accountId, ws) };
    },
  );
}
