import type { FastifyInstance } from 'fastify';
import {
  STORY_BUILD_API,
  STORY_BUILD_PUSH_DRAFT_DEFAULT,
  type StoryBuildActionResponse,
  type StoryBuildChecksPreview,
  type StoryBuildDiffResponse,
  type StoryBuildPushResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { CHECK_MANIFEST_FILES } from '../checks/index.js';
import { checksPreviewFromFiles } from '../ai-fix/checks-preview.js';
import { getStoryBuildRepoPatch, getStoryBuildRepoRow, getStoryBuildRow, storyBuildRepoNames } from './persist.js';
import { isStoryBuildRepoPushing, pushAllRepos } from './push.js';
import { storyBuildDeps, storyBuildLane } from './seams.js';

// "IMPLEMENT STORY" — THE BUILD-SIDE ROUTES, WORK PACKAGE 2 (docs/STORY-BUILD.md § Routes; contracts in
// docs/API.md). Registered only through routes.ts (and so only when AI is on). Every `:id` read scopes the
// account; a wrong owner, an unknown id or a repository not in the build is 404. Tiers: api/plugins/
// rate-limit.ts (the pushes `github_write`, the checks preview `search` + `read`, retry `ai` + `ai_hourly`).
//
//   GET  …/repos/:repoId/checks   the "Run tests" picker at the repository's BASE commit (one GitHub read
//                                 of the manifest files, cached 10 min per (repo, base)); asked on a click
//   GET  …/repos/:repoId/diff     the stored patch (never part of `StoryBuild`)
//   POST …/repos/:repoId/retry    build ONE repository again, through the manager's lane
//   POST …/repos/:repoId/push     push one repository as a new PR (draft unless `draft: false`)
//   POST …/push                   push every unpushed ready repository, in plan order
//
// The pushes answer 200 with per-repository results (`StoryBuildPushResponse`): each succeeds or fails on
// its own, and a failure is a `code` + one sentence on its result (and on its row's `push_error`). The SPA
// refetches through `invalidateAfterPrWrite` + `['ticket-prs']` + `['sprint-graph']`.

const CHECKS_TTL_MS = 10 * 60_000;
const checksCache = new Map<string, { at: number; value: StoryBuildChecksPreview }>();

/** For tests. */
export function clearStoryBuildChecksCache(): void {
  checksCache.clear();
}

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

export function registerStoryBuildBuildRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // The picker at the repository's base: which checks the project declares, and whether this machine can
  // sandbox them. The run discovers again on its own worktree, so a stale list can only offer a name the
  // run then skips — never run something undeclared.
  app.get<{ Params: Params }>(STORY_BUILD_API.repoChecks, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    const repoId = parseId(req.params.repoId);
    if (id == null || repoId == null) return reply.code(404).send(NOT_FOUND);
    const fetchFiles = ctx.github.fetchRepoFiles;
    if (!fetchFiles) return reply.code(404).send(NOT_FOUND);
    const row = await getStoryBuildRepoRow(ctx, accountId, id, repoId);
    if (!row) return reply.code(404).send(NOT_FOUND);
    const fullName = (await storyBuildRepoNames(ctx, accountId, [repoId])).get(repoId);
    const [owner, name] = (fullName ?? '').split('/');
    if (!owner || !name) return reply.code(404).send(NOT_FOUND);
    const key = `${accountId}:${repoId}:${row.baseSha}`;
    const hit = checksCache.get(key);
    if (hit && Date.now() - hit.at < CHECKS_TTL_MS) return reply.send(hit.value);
    try {
      const files = await fetchFiles(accountId, { owner, name, ref: row.baseSha, paths: CHECK_MANIFEST_FILES });
      const value: StoryBuildChecksPreview = checksPreviewFromFiles(files);
      checksCache.set(key, { at: Date.now(), value });
      return reply.send(value);
    } catch (err) {
      ctx.log.warn({ err }, 'story build checks preview failed');
      return reply.code(502).send({ error: 'ChecksUnavailable', message: 'Could not read the project’s checks from GitHub.' });
    }
  });

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

  app.post<{ Params: Params }>(STORY_BUILD_API.repoRetry, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    const repoId = parseId(req.params.repoId);
    if (id == null || repoId == null) return reply.code(404).send(NOT_FOUND);
    const row = await getStoryBuildRepoRow(ctx, accountId, id, repoId);
    if (!row) return reply.code(404).send(NOT_FOUND);
    if (row.status === 'pushed') return reply.code(409).send({ error: 'NotReady', message: 'This repository is already pushed.' });
    if (!row.include) return reply.code(409).send({ error: 'NotReady', message: 'This repository is not part of the build.' });
    if (isStoryBuildRepoPushing(row.id)) return reply.code(409).send({ error: 'NotReady', message: 'This repository is being pushed.' });
    const lane = storyBuildLane();
    if (!lane) return reply.code(503).send({ error: 'NotReady', message: 'Building is not available in this version of Limn yet.' });
    const out = await lane.retryRepo(ctx, { accountId, buildId: id, repoId });
    if (!out.ok) return reply.code(out.status).send({ error: out.error, message: out.message });
    const resp: StoryBuildActionResponse = { buildId: id };
    return reply.code(202).send(resp);
  });

  app.post<{ Params: Params; Body: unknown }>(STORY_BUILD_API.repoPush, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    const repoId = parseId(req.params.repoId);
    if (id == null || repoId == null) return reply.code(404).send(NOT_FOUND);
    const draft = parseDraft(req.body);
    if (draft == null) return reply.code(400).send({ error: 'BadRequest', message: '`draft` must be true or false.' });
    if (!(await getStoryBuildRepoRow(ctx, accountId, id, repoId))) return reply.code(404).send(NOT_FOUND);
    const r = await storyBuildDeps().pushRepo(ctx, { accountId, buildId: id, repoId, draft });
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
    const results = await pushAllRepos(ctx, { accountId, buildId: id, draft, push: storyBuildDeps().pushRepo });
    if (results == null) return reply.code(404).send(NOT_FOUND);
    const resp: StoryBuildPushResponse = { results };
    return reply.send(resp);
  });
}
