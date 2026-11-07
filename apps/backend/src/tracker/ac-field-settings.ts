import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type {
  JiraAcFieldSettingsBody,
  JiraAcFieldSettingsResponse,
  JiraAcFieldTypeRow,
  JiraOpenPointsFieldBody,
  JiraOpenPointsFieldChoice,
} from '@pierre-review/shared';
import { ownedWorkspaceId, type TrackerContext } from './context.js';
import { isJiraFieldId } from './jira/client.js';
import { markDue, parseCandidates, readAcFieldSettings, rederiveAcForIssueType, settingFor, writeAcFieldSetting } from './store.js';
import { deriveOpenPoints, type OpenPointsChoice } from './open-points.js';
import { openPointsChoiceFor, readOpenPointsSettings, writeOpenPointsSetting } from './open-points-settings.js';

// SETTINGS → TRACKERS: THE ACCEPTANCE-CRITERIA FIELD PER ISSUE TYPE (docs/TRACKERS.md § The criteria
// field). One row per (site, issue type) the workspace has stored Jira tickets for, built from those
// rows alone — never a Jira call. A choice is written with the SAME store writer the old per-ticket
// picker used (`writeAcFieldSetting`), every stored ticket of the type re-derives at once from its
// stored candidates, and they are marked due so the worker reads them again in its own time (no Jira call here).
//
// The same rows carry each type's OPEN-POINTS field (docs/TRACKERS.md § Open points): 'auto' / a field
// / 'none' (the description only), written by `PUT …/tracker/open-points-fields`. Open points are
// derived on read, so that write re-derives nothing and marks nothing due.

const wsIdParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;

interface TicketFacts {
  apiRoot: string;
  issueTypeId: string | null;
  issueTypeName: string | null;
  acFieldId: string | null;
  acFieldName: string | null;
  candidatesJson: string | null;
  description?: string | null;
}

/** The rows of the settings list, from the stored tickets and the saved choices. Pure. */
export function acFieldTypeRows(
  tickets: readonly TicketFacts[],
  chosenFor: (apiRoot: string, issueTypeId: string) => { fieldId: string; fieldName: string } | null,
  // The open-points choice per type (null = 'auto'). Absent = rows without `openPoints`.
  openPointsFor?: (apiRoot: string, issueTypeId: string) => (OpenPointsChoice & { fieldName: string | null }) | null,
): JiraAcFieldTypeRow[] {
  const byType = new Map<
    string,
    {
      apiRoot: string;
      id: string;
      name: string;
      count: number;
      inUse: Map<string, { name: string; n: number }>;
      fields: Map<string, { name: string; n: number }>;
      opInUse: Map<string, { name: string; n: number }>;
    }
  >();
  for (const t of tickets) {
    if (t.issueTypeId == null || t.candidatesJson == null) continue;
    const key = `${t.apiRoot}|${t.issueTypeId}`;
    let g = byType.get(key);
    if (!g) {
      g = { apiRoot: t.apiRoot, id: t.issueTypeId, name: t.issueTypeName ?? t.issueTypeId, count: 0, inUse: new Map(), fields: new Map(), opInUse: new Map() };
      byType.set(key, g);
    }
    g.count += 1;
    if (t.issueTypeName) g.name = t.issueTypeName;
    if (t.acFieldId != null) {
      const u = g.inUse.get(t.acFieldId) ?? { name: t.acFieldName ?? t.acFieldId, n: 0 };
      u.n += 1;
      g.inUse.set(t.acFieldId, u);
    }
    const candidates = parseCandidates(t.candidatesJson);
    for (const c of candidates) {
      const f = g.fields.get(c.id) ?? { name: c.name, n: 0 };
      f.n += 1;
      g.fields.set(c.id, f);
    }
    if (openPointsFor) {
      const op = deriveOpenPoints(candidates, t.description ?? null, openPointsFor(t.apiRoot, t.issueTypeId)).field;
      if (op != null) {
        const u = g.opInUse.get(op.id) ?? { name: op.name, n: 0 };
        u.n += 1;
        g.opInUse.set(op.id, u);
      }
    }
  }
  const top = (m: Map<string, { name: string; n: number }>): Array<{ id: string; name: string; n: number }> =>
    [...m.entries()].map(([id, v]) => ({ id, name: v.name, n: v.n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...byType.values()]
    .map((g) => {
      const chosen = chosenFor(g.apiRoot, g.id);
      const inUse = top(g.inUse)[0];
      let openPoints: JiraOpenPointsFieldChoice | undefined;
      if (openPointsFor) {
        const c = openPointsFor(g.apiRoot, g.id);
        const opInUse = top(g.opInUse)[0];
        openPoints = {
          mode: c?.mode ?? 'auto',
          chosen: c?.mode === 'field' && c.fieldId != null ? { id: c.fieldId, name: c.fieldName ?? c.fieldId } : null,
          inUse: opInUse ? { id: opInUse.id, name: opInUse.name } : null,
        };
      }
      return {
        apiRoot: g.apiRoot,
        issueTypeId: g.id,
        issueTypeName: g.name,
        ticketCount: g.count,
        chosen: chosen ? { id: chosen.fieldId, name: chosen.fieldName } : null,
        inUse: inUse ? { id: inUse.id, name: inUse.name } : null,
        fields: top(g.fields).map((f) => ({ id: f.id, name: f.name, ticketCount: f.n })),
        ...(openPoints ? { openPoints } : {}),
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
      description: t.description,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.provider, 'jira')))
    .execute()) as TicketFacts[];
  const settings = await readAcFieldSettings(ctx, accountId, [workspaceId]);
  const opSettings = await readOpenPointsSettings(ctx, accountId, [workspaceId]);
  return acFieldTypeRows(
    tickets,
    (apiRoot, issueTypeId) => {
      const id = settingFor(settings, workspaceId, apiRoot, issueTypeId);
      if (id == null) return null;
      return settings.get(`${workspaceId}|${apiRoot}|${issueTypeId}`) ?? null;
    },
    (apiRoot, issueTypeId) => openPointsChoiceFor(opSettings, workspaceId, apiRoot, issueTypeId),
  );
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

  // The OPEN-POINTS field for one issue type. Open points are derived on read (open-points.ts), so
  // nothing is re-derived or marked due: the next review reads the ticket again anyway.
  app.put<{ Params: { id: number }; Body: JiraOpenPointsFieldBody }>(
    '/api/workspaces/:id/tracker/open-points-fields',
    {
      schema: {
        params: wsIdParam,
        body: {
          type: 'object',
          required: ['apiRoot', 'issueTypeId', 'mode'],
          additionalProperties: false,
          properties: {
            apiRoot: { type: 'string', minLength: 1, maxLength: 2048 },
            issueTypeId: { type: 'string', minLength: 1, maxLength: 64 },
            mode: { type: 'string', enum: ['auto', 'field', 'none'] },
            fieldId: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (req, reply): Promise<JiraAcFieldSettingsResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (ws == null) return reply.code(404).send({ error: 'NotFound', message: `Workspace ${req.params.id} not found` });
      const { apiRoot, issueTypeId, mode, fieldId } = req.body;
      const row = (await readRows(ctx, accountId, ws)).find((r) => r.apiRoot === apiRoot && r.issueTypeId === issueTypeId);
      if (row == null) return reply.code(404).send({ error: 'UnknownIssueType', message: 'Limn has no tickets of this type in this workspace.' });
      let field: { id: string; name: string } | null = null;
      if (mode === 'field') {
        const f = fieldId != null && isJiraFieldId(fieldId) ? row.fields.find((x) => x.id === fieldId) : undefined;
        if (f == null) return reply.code(400).send({ error: 'UnknownField', message: `No ${row.issueTypeName} ticket has the field ${fieldId ?? '(none)'}.` });
        field = { id: f.id, name: f.name };
      }
      await writeOpenPointsSetting(ctx, accountId, ws, apiRoot, issueTypeId, mode, field, new Date());
      return { workspaceId: ws, types: await readRows(ctx, accountId, ws) };
    },
  );
}
