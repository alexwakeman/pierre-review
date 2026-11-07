import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import type {
  TrackerCopyBody,
  TrackerCopySource,
  TrackerCopySourcesResponse,
  WorkspaceTrackerSettings,
} from '@pierre-review/shared';
import { ownedWorkspaceId, type TrackerContext } from './context.js';
import {
  copyStoredTracker,
  isIssueConfigured,
  issueOf,
  readStoredTrackerRow,
  readWorkspaceTracker,
  readWorkspaceTrackerRow,
  type WorkspaceTrackerRow,
} from './settings.js';
import { markDue, rederiveAcForIssueType } from './store.js';
import { readOpenPointsSettings, writeOpenPointsSetting } from './open-points-settings.js';
import { kickTrackerSync } from './worker.js';
import { writeSettingEvent } from '../db/setting-event-write.js';

// "COPY FROM ANOTHER WORKSPACE" (docs/TRACKERS.md § Copying a tracker). A team that runs several
// workspaces on ONE Jira (or Linear, Notion, GitHub Issues) sets it up once and copies it.
//
//   GET  /api/workspaces/:id/tracker/copy-sources   the account's OTHER workspaces whose STORED tracker
//                                                   is set up (`isIssueConfigured`). DB only.
//   POST /api/workspaces/:id/tracker/copy           { fromWorkspaceId, replace? } — copies the whole
//                                                   setup server-side into :id; answers :id's tracker.
//
// What travels: the `workspace_trackers` row column for column (provider, base URL, project keys,
// where to look, email, Notion mapping, and the TOKEN IN ITS STORED FORM — sealed stays sealed, so it
// is never opened here and never reaches the client), and the per-issue-type field choices
// (`pro_jira_ac_fields` and the open-points choices, `tracker_open_points_fields`), which REPLACE
// this workspace's. ⚠ A new per-workspace tracker setting joins
// `copyFieldChoices` below, or a copy silently leaves it behind.
//
// ⚠ BOTH IDS ARE THE ACCOUNT'S: `:id` and `fromWorkspaceId` each go through `ownedWorkspaceId` → 404.
// ⚠ ONE TRACKER PER WORKSPACE: replacing a set-up tracker needs `replace: true` (409 without it).
// ⚠ NO TRACKER CALL HERE. The copy kicks the ticket worker, as a save does, so the route sits on the
// `search` tier with the PUT (api/plugins/rate-limit.ts).

const wsIdParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;

const TRACKER_NAME: Record<string, string> = { jira: 'Jira', github: 'GitHub Issues', linear: 'Linear', notion: 'Notion' };

const notFound = (reply: FastifyReply, id: number): FastifyReply =>
  reply.code(404).send({ error: 'NotFound', message: `Workspace ${id} not found` });

/** A stored row → a copy source, or null when it is not set up (no live provider, or nowhere to link). */
export function copySourceOf(workspaceId: number, name: string, row: WorkspaceTrackerRow): TrackerCopySource | null {
  const issue = issueOf(row);
  if (!isIssueConfigured(issue)) return null;
  return {
    workspaceId,
    name,
    provider: issue.provider,
    baseUrl: issue.baseUrl,
    hasToken: row.authToken != null && row.authToken !== '',
  };
}

/** The account's other workspaces with a STORED tracker set up, by name. ⚠ The automatic GitHub
 *  Issues default is not a set-up tracker: it is per workspace, derived from that workspace's repos. */
export async function trackerCopySources(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
): Promise<TrackerCopySource[]> {
  const w = ctx.schema.workspaces;
  const t = ctx.schema.workspaceTrackers;
  const rows = (await ctx.db
    .select({
      workspaceId: w.id,
      name: w.name,
      provider: t.provider,
      baseUrl: t.baseUrl,
      projectKeys: t.projectKeys,
      matchScope: t.matchScope,
      authEmail: t.authEmail,
      authToken: t.authToken,
      notionConfig: t.notionConfig,
    })
    .from(w)
    .innerJoin(t, and(eq(t.workspaceId, w.id), eq(t.accountId, w.accountId)))
    .where(and(eq(w.accountId, accountId), ne(w.id, workspaceId)))
    .execute()) as Array<WorkspaceTrackerRow & { workspaceId: number; name: string | null }>;
  return rows
    .map((r) => copySourceOf(r.workspaceId, r.name ?? `Workspace ${r.workspaceId}`, r))
    .filter((s): s is TrackerCopySource => s != null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.workspaceId - b.workspaceId);
}

/** Replace `to`'s per-issue-type field choices with `from`'s, then re-derive every stored ticket whose
 *  choice moved (no tracker call) and mark them due. */
async function copyFieldChoices(ctx: TrackerContext, accountId: number, from: number, to: number): Promise<void> {
  const t = ctx.schema.jiraAcFields;
  if (t == null) return;
  type Choice = { apiRoot: string; issueTypeId: string; fieldId: string; fieldName: string };
  const read = async (ws: number): Promise<Choice[]> =>
    (await ctx.db
      .select({ apiRoot: t.apiRoot, issueTypeId: t.issueTypeId, fieldId: t.fieldId, fieldName: t.fieldName })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, ws)))
      .execute()) as Choice[];
  const [source, before] = [await read(from), await read(to)];
  const now = new Date();
  await ctx.db.delete(t).where(and(eq(t.accountId, accountId), eq(t.workspaceId, to))).execute();
  if (source.length > 0) {
    await ctx.db
      .insert(t)
      .values(source.map((c) => ({ accountId, workspaceId: to, ...c, updatedAt: now })))
      .execute();
  }
  // Every (site, type) whose choice may have moved: the ones copied in and the ones dropped.
  const key = (c: Pick<Choice, 'apiRoot' | 'issueTypeId'>): string => `${c.apiRoot}\u0000${c.issueTypeId}`;
  const after = new Map(source.map((c) => [key(c), c]));
  const was = new Map(before.map((c) => [key(c), c]));
  const touched: number[] = [];
  for (const k of new Set([...after.keys(), ...was.keys()])) {
    const next = after.get(k);
    const prev = was.get(k);
    const c = next ?? prev;
    if (c == null || next?.fieldId === prev?.fieldId) continue;
    touched.push(...(await rederiveAcForIssueType(ctx, accountId, to, c.apiRoot, c.issueTypeId, next?.fieldId ?? null)));
  }
  await markDue(ctx, accountId, touched);
  await copyOpenPointsChoices(ctx, accountId, from, to, now);
}

/** Replace `to`'s open-points choices per issue type with `from`'s (docs/TRACKERS.md § Open points),
 *  through that table's own reader and writer. Open points are derived on read, so nothing re-derives. */
async function copyOpenPointsChoices(ctx: TrackerContext, accountId: number, from: number, to: number, now: Date): Promise<void> {
  const settings = await readOpenPointsSettings(ctx, accountId, [from, to]);
  const split = (ws: number) =>
    [...settings.entries()]
      .filter(([k]) => k.startsWith(`${ws}|`))
      .map(([k, v]) => {
        // The key is `ws|apiRoot|issueTypeId`; an apiRoot may itself hold '|', the type id never does.
        const rest = k.slice(String(ws).length + 1);
        const cut = rest.lastIndexOf('|');
        return { apiRoot: rest.slice(0, cut), issueTypeId: rest.slice(cut + 1), choice: v };
      });
  const source = split(from);
  const kept = new Set(source.map((c) => `${c.apiRoot}|${c.issueTypeId}`));
  for (const c of split(to)) {
    if (!kept.has(`${c.apiRoot}|${c.issueTypeId}`)) {
      await writeOpenPointsSetting(ctx, accountId, to, c.apiRoot, c.issueTypeId, 'auto', null, now);
    }
  }
  for (const c of source) {
    const { mode, fieldId, fieldName } = c.choice;
    const field = fieldId != null ? { id: fieldId, name: fieldName ?? fieldId } : null;
    await writeOpenPointsSetting(ctx, accountId, to, c.apiRoot, c.issueTypeId, mode, field, now);
  }
}

export function registerTrackerCopyRoutes(app: FastifyInstance, ctx: TrackerContext): void {
  app.get<{ Params: { id: number } }>(
    '/api/workspaces/:id/tracker/copy-sources',
    { schema: { params: wsIdParam } },
    async (req, reply): Promise<TrackerCopySourcesResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (ws == null) return notFound(reply, req.params.id);
      return { workspaceId: ws, sources: await trackerCopySources(ctx, accountId, ws) };
    },
  );

  app.post<{ Params: { id: number }; Body: TrackerCopyBody }>(
    '/api/workspaces/:id/tracker/copy',
    {
      schema: {
        params: wsIdParam,
        body: {
          type: 'object',
          required: ['fromWorkspaceId'],
          additionalProperties: false,
          properties: {
            fromWorkspaceId: { type: 'integer', minimum: 1 },
            replace: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply): Promise<WorkspaceTrackerSettings | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const to = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (to == null) return notFound(reply, req.params.id);
      // ⚠ A BODY id: the same ownership test as the path id, so another account's workspace is a 404.
      const from = await ownedWorkspaceId(ctx, accountId, req.body.fromWorkspaceId);
      if (from == null) return notFound(reply, req.body.fromWorkspaceId);
      if (from === to) {
        return reply.code(400).send({ error: 'SameWorkspace', message: 'Pick a different workspace to copy from.' });
      }
      const source = await readStoredTrackerRow(ctx, accountId, from);
      if (source == null || !isIssueConfigured(issueOf(source))) {
        return reply.code(400).send({ error: 'NoTracker', message: 'That workspace has no issue tracker set up.' });
      }
      const before = await readWorkspaceTrackerRow(ctx, accountId, to);
      if (isIssueConfigured(issueOf(before)) && req.body.replace !== true) {
        return reply.code(409).send({
          error: 'TrackerExists',
          message: 'This workspace already has an issue tracker. Confirm to replace it.',
        });
      }
      await copyStoredTracker(ctx, accountId, source, to);
      await copyFieldChoices(ctx, accountId, from, to);
      const saved = await readWorkspaceTracker(ctx, accountId, to);
      const was = issueOf(before);
      if (was.provider !== saved.issue.provider || was.baseUrl !== saved.issue.baseUrl) {
        const name = saved.issue.provider == null ? 'an issue tracker' : TRACKER_NAME[saved.issue.provider];
        await writeSettingEvent(ctx, accountId, to, 'tracker', `Issue tracker set to ${name}`);
      }
      void kickTrackerSync(ctx, accountId);
      return saved;
    },
  );
}
