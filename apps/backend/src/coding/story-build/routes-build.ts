import type { FastifyInstance } from 'fastify';
import {
  STORY_BUILD_API,
  STORY_BUILD_PUSH_DRAFT_DEFAULT,
  type StoryBuildDiffResponse,
  type StoryBuildPushResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { getStoryBuildRepoPatch, getStoryBuildRepoRow, getStoryBuildRow } from './persist.js';
import { pushAllRepos, pushRepo } from './push.js';
import type { PushRepoFn } from './seams.js';

// "IMPLEMENT STORY" — THE PATCH ROUTES (docs/STORY-BUILD.md § Push; contracts in docs/API.md). A workspace
// session stores each repository's work as a patch on its `story_build_repos` row; these routes read it
// and push it from the HOST. Registered only from sandbox/session/routes.ts (so only when AI is on).
// Every `:id` read scopes the account; a wrong owner, an unknown id or a repository not in the build is
// 404. Tiers: api/plugins/rate-limit.ts (the pushes `github_write`, the diff `read`).
//
//   GET  …/repos/:repoId/diff     the stored patch (never part of `StoryBuild`)
//   POST …/repos/:repoId/push     push one repository as a new PR (draft unless `draft: false`)
//   POST …/push                   push every unpushed ready repository, in build order
//
// The pushes answer 200 with per-repository results (`StoryBuildPushResponse`): each succeeds or fails on
// its own, and a failure is a `code` + one sentence on its result (and on its row's `push_error`). The SPA
// refetches through `invalidateAfterPrWrite` + `['ticket-prs']` + `['sprint-graph']`.

const parseId = (raw: string | undefined): number | null => {
  if (raw == null || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** `draft` from a push body: absent ⇒ the default (draft); anything but a boolean ⇒ refused (null). */
export function parseDraft(body: unknown): boolean | null {
  if (body == null) return STORY_BUILD_PUSH_DRAFT_DEFAULT;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const v = (body as { draft?: unknown }).draft;
  if (v === undefined) return STORY_BUILD_PUSH_DRAFT_DEFAULT;
  return typeof v === 'boolean' ? v : null;
}

type Params = { id: string; repoId: string };
const NOT_FOUND = { error: 'NotFound', message: 'Not found.' } as const;

/** `push` is for tests (a fake push); the real one by default. */
export function registerStoryBuildBuildRoutes(app: FastifyInstance, ctx: AgentContext, push: PushRepoFn = pushRepo): void {
  app.get<{ Params: Params }>(STORY_BUILD_API.repoDiff, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    const repoId = parseId(req.params.repoId);
    if (id == null || repoId == null) return reply.code(404).send(NOT_FOUND);
    const got = await getStoryBuildRepoPatch(ctx, accountId, id, repoId);
    if (!got) return reply.code(404).send(NOT_FOUND);
    const resp: StoryBuildDiffResponse = { repoId, baseSha: got.baseSha, patch: got.patch, filesChanged: got.filesChanged };
    return reply.send(resp);
  });

  app.post<{ Params: Params; Body: unknown }>(STORY_BUILD_API.repoPush, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    const repoId = parseId(req.params.repoId);
    if (id == null || repoId == null) return reply.code(404).send(NOT_FOUND);
    const draft = parseDraft(req.body);
    if (draft == null) return reply.code(400).send({ error: 'BadRequest', message: '`draft` must be true or false.' });
    if (!(await getStoryBuildRepoRow(ctx, accountId, id, repoId))) return reply.code(404).send(NOT_FOUND);
    const r = await push(ctx, { accountId, buildId: id, repoId, draft });
    if (r.code === 'NotFound') return reply.code(404).send(NOT_FOUND);
    const resp: StoryBuildPushResponse = { results: [r] };
    return reply.send(resp);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(STORY_BUILD_API.pushAll, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    if (id == null) return reply.code(404).send(NOT_FOUND);
    const draft = parseDraft(req.body);
    if (draft == null) return reply.code(400).send({ error: 'BadRequest', message: '`draft` must be true or false.' });
    if (!(await getStoryBuildRow(ctx, accountId, id))) return reply.code(404).send(NOT_FOUND);
    const results = await pushAllRepos(ctx, { accountId, buildId: id, draft, push });
    if (results == null) return reply.code(404).send(NOT_FOUND);
    const resp: StoryBuildPushResponse = { results };
    return reply.send(resp);
  });
}
