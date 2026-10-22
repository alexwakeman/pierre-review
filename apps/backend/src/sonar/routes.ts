import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  SONAR_KEY_PATTERN,
  type SonarConnectionCheck,
  type SonarPostResponse,
  type SonarPrResponse,
  type WorkspaceSonarSettings,
  type WorkspaceSonarUpdate,
} from '@pierre-review/shared';
import type { JiraTransport } from '../tracker/jira/fetch.js';
import type { AgentContext } from '../review/agent-context.js';
import { sonarClient, sonarErrorMessage, SonarError } from './client.js';
import {
  readSonarAccessForPr,
  readWorkspaceSonar,
  readWorkspaceSonarToken,
  sonarConfigured,
  writeWorkspaceSonar,
  type SonarDb,
} from './settings.js';
import { ensureSonarSnapshot, type EnsureSonarOpts } from './snapshot.js';
import { readSonarSnapshot } from './store.js';
import { postSonarSnapshot, defaultSonarPostDeps, type SonarPostDeps } from './post.js';

// SONARCLOUD'S HTTP SURFACE (CORE, free; docs/SONARCLOUD.md § Routes). Rate-limit tiers are spelled
// out by exact path in api/plugins/rate-limit.ts `tierFor`.
//
//   GET  /api/workspaces/:id/sonar         the settings (404 if not yours). Never the token.
//   PUT  /api/workspaces/:id/sonar         a partial patch (organization, token, project keys).
//   POST /api/workspaces/:id/sonar/check   "Test connection" with the SAVED token.
//   GET  /api/prs/:id/sonar?head=<sha>     the STORED snapshot — never calls SonarCloud.
//   POST /api/prs/:id/sonar/refresh        { headSha? } read SonarCloud for that head NOW.
//   POST /api/prs/:id/sonar/post           { headSha } ONE GitHub review, once per (PR, head).
//                                          LOCAL ONLY (it posts through the `gh` session, like
//                                          every other Claude Review post).
//
// ⚠ Every id arrives in a PATH (→ 404 when not the account's); a workspace's repos are the only
// repos a project-key override may name. SonarCloud failures are a 502 with a sentence WE wrote.

export interface SonarRouteCtx extends SonarDb {
  accountIdOf: (req: FastifyRequest) => number;
  log: AgentContext['log'];
  transport?: JiraTransport;
  postDeps?: SonarPostDeps;
  /** Test seam: is SonarCloud's analysed sha GitHub's test merge commit of the head? */
  isMergeOfHead?: EnsureSonarOpts['isMergeOfHead'];
}

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

// ⚠ EVERY KEY LISTED: `additionalProperties: false` + ajv's removeAdditional strips an unlisted key
// SILENTLY and the PUT would still answer 200 ("saved" with nothing stored).
const putBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    organization: { type: ['string', 'null'], maxLength: 400 },
    token: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S+$' },
    clearToken: { type: 'boolean' },
    projectKeys: {
      type: 'object',
      maxProperties: 500,
      patternProperties: { '^[0-9]+$': { type: ['string', 'null'], maxLength: 400 } },
      additionalProperties: false,
    },
  },
} as const;

const headBody = {
  type: 'object',
  additionalProperties: false,
  properties: { headSha: { type: 'string', pattern: '^[0-9a-f]{7,64}$' } },
} as const;

const notFound = (reply: FastifyReply, what: string): FastifyReply =>
  reply.code(404).send({ error: 'NotFound', message: `${what} not found` });

async function ownedWorkspace(c: SonarDb, accountId: number, id: number): Promise<number | null> {
  const w = c.schema.workspaces;
  const rows = (await c.db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.id, id), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

async function ownedPrHead(c: SonarDb, accountId: number, id: number): Promise<{ headSha: string | null } | null> {
  const p = c.schema.pullRequests;
  const rows = (await c.db
    .select({ headSha: p.headSha })
    .from(p)
    .where(and(eq(p.id, id), eq(p.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ headSha: string | null }>;
  return rows[0] ?? null;
}

/** Most repos the connection check asks SonarCloud about (one call each). */
export const CHECK_PROJECTS_MAX = 20;

export function registerSonarRoutes(app: FastifyInstance, ctx: SonarRouteCtx): void {
  const keyRe = new RegExp(SONAR_KEY_PATTERN);

  app.get<{ Params: { id: number } }>(
    '/api/workspaces/:id/sonar',
    { schema: { params: idParam } },
    async (req, reply): Promise<WorkspaceSonarSettings | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspace(ctx, accountId, req.params.id);
      if (ws == null) return notFound(reply, `Workspace ${req.params.id}`);
      return readWorkspaceSonar(ctx, accountId, ws);
    },
  );

  app.put<{ Params: { id: number }; Body: WorkspaceSonarUpdate }>(
    '/api/workspaces/:id/sonar',
    { schema: { params: idParam, body: putBody } },
    async (req, reply): Promise<WorkspaceSonarSettings | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspace(ctx, accountId, req.params.id);
      if (ws == null) return notFound(reply, `Workspace ${req.params.id}`);
      const res = await writeWorkspaceSonar(ctx, accountId, ws, req.body ?? {});
      if (!res.ok) return reply.code(400).send({ error: 'InvalidSonarSettings', message: res.message });
      return res.settings;
    },
  );

  app.post<{ Params: { id: number } }>(
    '/api/workspaces/:id/sonar/check',
    { schema: { params: idParam } },
    async (req, reply): Promise<SonarConnectionCheck | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspace(ctx, accountId, req.params.id);
      if (ws == null) return notFound(reply, `Workspace ${req.params.id}`);
      const [{ organization, token }, settings] = await Promise.all([
        readWorkspaceSonarToken(ctx, accountId, ws),
        readWorkspaceSonar(ctx, accountId, ws),
      ]);
      const answer = (ok: boolean, message: string, projects: SonarConnectionCheck['projects'] = []) => ({
        workspaceId: ws,
        ok,
        message,
        projects,
      });
      if (organization == null) return answer(false, 'Save an organization key first.');
      if (token.state === 'none') return answer(false, 'Save a token first.');
      if (token.state === 'unreadable') return answer(false, 'The saved token cannot be read on this server. Save it again.');
      const client = sonarClient(token.token, ctx.transport);
      try {
        const orgs = (await client.get('api/organizations/search', { organizations: organization })) as {
          organizations?: unknown[];
        };
        if (!Array.isArray(orgs?.organizations) || orgs.organizations.length === 0) {
          return answer(false, `SonarCloud has no organization “${organization}” this token can see.`);
        }
      } catch (err) {
        ctx.log.warn({ accountId, workspaceId: ws, code: err instanceof SonarError ? err.code : 'unknown' }, 'sonar check failed');
        return answer(false, sonarErrorMessage(err));
      }
      const repos = settings.repos.slice(0, CHECK_PROJECTS_MAX);
      const projects: SonarConnectionCheck['projects'] = [];
      for (const r of repos) {
        if (!keyRe.test(r.projectKey)) {
          projects.push({ repoId: r.repoId, projectKey: r.projectKey, found: false });
          continue;
        }
        try {
          await client.get('api/components/show', { component: r.projectKey, organization });
          projects.push({ repoId: r.repoId, projectKey: r.projectKey, found: true });
        } catch (err) {
          projects.push({
            repoId: r.repoId,
            projectKey: r.projectKey,
            found: err instanceof SonarError && err.code === 'not_found' ? false : null,
          });
        }
      }
      for (const r of settings.repos.slice(CHECK_PROJECTS_MAX)) {
        projects.push({ repoId: r.repoId, projectKey: r.projectKey, found: null });
      }
      const found = projects.filter((p) => p.found === true).length;
      return answer(true, `Connected. ${found} of ${settings.repos.length} ${settings.repos.length === 1 ? 'repo has' : 'repos have'} a SonarCloud project.`, projects);
    },
  );

  app.get<{ Params: { id: number }; Querystring: { head?: string } }>(
    '/api/prs/:id/sonar',
    {
      schema: {
        params: idParam,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { head: { type: 'string', pattern: '^[0-9a-f]{7,64}$' } },
        },
      },
    },
    async (req, reply): Promise<SonarPrResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const pr = await ownedPrHead(ctx, accountId, req.params.id);
      if (!pr) return notFound(reply, `PR ${req.params.id}`);
      const access = await readSonarAccessForPr(ctx, accountId, req.params.id);
      const head = req.query.head ?? pr.headSha;
      const snapshot = head ? await readSonarSnapshot(ctx, accountId, req.params.id, head) : null;
      return { prId: req.params.id, configured: sonarConfigured(access), snapshot };
    },
  );

  app.post<{ Params: { id: number }; Body: { headSha?: string } }>(
    '/api/prs/:id/sonar/refresh',
    { schema: { params: idParam, body: headBody } },
    async (req, reply): Promise<SonarPrResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const pr = await ownedPrHead(ctx, accountId, req.params.id);
      if (!pr) return notFound(reply, `PR ${req.params.id}`);
      const head = req.body?.headSha ?? pr.headSha;
      if (!head) return reply.code(409).send({ error: 'NoHead', message: 'This PR has no head commit yet.' });
      const access = await readSonarAccessForPr(ctx, accountId, req.params.id);
      if (!sonarConfigured(access)) {
        return reply.code(409).send({ error: 'SonarNotConfigured', message: 'Set up SonarCloud for this workspace in Settings.' });
      }
      const snapshot = await ensureSonarSnapshot(ctx, accountId, req.params.id, head, {
        force: true,
        transport: ctx.transport,
        isMergeOfHead: ctx.isMergeOfHead,
        log: { warn: (m) => ctx.log.warn(m) },
      });
      return { prId: req.params.id, configured: true, snapshot };
    },
  );

  // Posting rides the reader's `gh` session (review/post-review.ts).
  app.post<{ Params: { id: number }; Body: { headSha: string } }>(
    '/api/prs/:id/sonar/post',
    {
      schema: {
        params: idParam,
        body: { ...headBody, required: ['headSha'] },
      },
    },
    async (req, reply): Promise<SonarPostResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const pr = await ownedPrHead(ctx, accountId, req.params.id);
      if (!pr) return notFound(reply, `PR ${req.params.id}`);
      let out;
      try {
        out = await postSonarSnapshot(
          ctx,
          { accountId, prId: req.params.id, headSha: req.body.headSha, trigger: 'manual' },
          ctx.postDeps ?? defaultSonarPostDeps,
        );
      } catch (err) {
        ctx.log.warn(`sonar post pr ${req.params.id}: ${err instanceof Error ? err.message : String(err)}`);
        return reply.code(502).send({ error: 'GithubError', message: 'GitHub could not be reached. Nothing was posted.' });
      }
      switch (out.kind) {
        case 'not_found':
          return notFound(reply, 'SonarCloud snapshot');
        case 'nothing_to_post':
          return reply.code(409).send({ error: 'NothingToPost', message: 'Nothing new to post on this commit: every issue is already on GitHub, or there are none.' });
        case 'already_posted':
          return reply.code(409).send({ error: 'AlreadyPosted', message: 'These SonarCloud findings were already posted for this commit.' });
        case 'head_moved':
          return reply.code(409).send({ error: 'HeadMoved', message: 'The PR has new commits. Refresh SonarCloud first.' });
        case 'not_open':
          return reply.code(409).send({ error: 'NotOpen', message: 'The PR is no longer open.' });
        case 'done':
          return { snapshot: out.snapshot, visible: out.visible };
      }
    },
  );
}
