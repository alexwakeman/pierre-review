import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  RELEASE_NOTES_SECTION_MAX,
  RELEASE_OLDER_TAGS_MAX,
  RELEASE_SUFFIX_MAX,
  validateReleaseSettings,
  type CreateReleaseBody,
  type ReleaseOlderTagsBody,
  type ReleaseOlderTagsResponse,
  type ReleasePreviewBody,
  type ReleasesRefreshResponse,
  type ReleasesResponse,
  type SetReleaseReposBody,
  type SetReleaseSettingsBody,
} from '@pierre-review/shared';
import { getReleaseRepos, setReleaseRepos } from '../../db/release-repos.js';
import { markTagCatchUp, scheduleTagSync } from '../../sync/tags-step.js';
import { raiseOlderTagsWanted } from '../../releases/older-tags.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { ReleaseRequestError, createRelease, getReleaseDetail, previewRelease } from '../../releases/create.js';
import { getReleases } from '../../db/release-check.js';
import { refreshReleases } from '../../releases/refresh.js';
import { getReleaseSettingsResponse, setReleaseSettings } from '../../db/release-settings.js';
import { accountIdOf } from '../plugins/auth.js';

// RELEASES (docs/RELEASES.md; docs/API.md § Releases). CORE, always registered.
//
//   GET /api/workspaces/:id/release-settings   the workspace's release + hotfix suffixes (null = not
//                                              set; there is no default), `configured` (both set) and
//                                              `hasReleases` (the form warns before a change).
//   PUT /api/workspaces/:id/release-settings   the WHOLE setting: `{ releaseSuffix, hotfixSuffix }`,
//                                              null or "" clears one; a suffix without the fixed
//                                              leading hyphen gets one. 400 with the SAME sentence
//                                              shared `validateReleaseSettings` gives the Settings form.
//   PUT /api/workspaces/:id/release-repos      the WHOLE set of repos ticked "Released from this
//                                              workspace": `{ repoIds }` (members only, else 400).
//                                              DB only; newly ticked repos are marked for the tag
//                                              sync's catch-up (the settle sweep reads GitHub, not this
//                                              route). Answers the settings.
//   GET /api/releases?workspace=<id>           This Sprint → Releases: the release check (shared
//                                              `foldReleaseCheck` over db/release-check.ts's stored
//                                              inputs) with each repo's scan progress, the newest
//                                              release, whether both suffixes are set. DB + memory
//                                              only, NEVER a GitHub or tracker call; tier `read`. The
//                                              tab polls it every ~3 s while a repo is checking.
//   POST /api/releases/refresh?workspace=<id>  Refresh (a reader's press): the tickets the check holds by
//                                              their own state read again from the tracker
//                                              (releases/refresh.ts), then the check. Tier `search`.
//   POST /api/releases/older-tags?workspace=<id>  "Show 50 more": `{repoId, wanted}` → the older band of
//                                              one RELEASABLE repo lists up to `wanted` tags (raised, never
//                                              lowered; in memory — releases/older-tags.ts). 404 for a repo
//                                              not released from the workspace. When it grows, the scan
//                                              starts in the background (more history and tickets may be
//                                              read: GitHub + tracker quota) — tier `sync`.
//   POST /api/releases/preview?workspace=<id>  "Create release…" opening: `{repoIds}` → the snapshot,
//                                              the notes (a model summary per story when AI is on — a
//                                              reader's click, never refused by the spend gate) and the
//                                              comment preview. No GitHub or tracker call; tier `ai`.
//   POST /api/releases?workspace=<id>          Confirm: `{repoIds, snapshot, sections?}` → re-reads the
//                                              tickets and the tags, then the writes (releases/create.ts).
//                                              Tracker reads + GitHub writes: tier `search` + `github_write`.
//   GET  /api/releases/:id                     one stored release (its notes and per-step results).
//
// The settings routes are DB only — the `read` tier (api/plugins/rate-limit.ts). 404
// on a workspace that is not this account's, like every id-addressed workspace route.

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } },
} as const;

const suffixSchema = { type: ['string', 'null'], maxLength: RELEASE_SUFFIX_MAX * 4 } as const;

const repoIdsSchema = { type: 'array', minItems: 1, maxItems: 200, items: { type: 'integer' } } as const;
const snapshotSchema = {
  type: 'object',
  required: ['repos', 'tickets'],
  additionalProperties: false,
  properties: {
    repos: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['repoId', 'tagName', 'sha'],
        additionalProperties: false,
        properties: {
          repoId: { type: 'integer' },
          tagName: { type: 'string', minLength: 1, maxLength: 300 },
          sha: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
    tickets: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        required: ['ident', 'key'],
        additionalProperties: false,
        properties: { ident: { type: 'string', minLength: 1, maxLength: 600 }, key: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  },
} as const;

export async function releaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/releases', async (req): Promise<ReleasesResponse> => {
    const q = req.query as { workspace?: string };
    return getReleases(accountIdOf(req), q.workspace);
  });

  const refusal = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ReleaseRequestError) {
      reply.status(err.status);
      return { error: err.code, message: err.message };
    }
    throw err;
  };

  app.post('/api/releases/refresh', async (req): Promise<ReleasesRefreshResponse> => {
    const q = req.query as { workspace?: string };
    return refreshReleases(accountIdOf(req), q.workspace);
  });

  app.post(
    '/api/releases/older-tags',
    {
      schema: {
        body: {
          type: 'object',
          required: ['repoId', 'wanted'],
          additionalProperties: false,
          properties: { repoId: { type: 'integer' }, wanted: { type: 'integer', minimum: 1, maximum: RELEASE_OLDER_TAGS_MAX } },
        },
      },
    },
    async (req, reply): Promise<ReleaseOlderTagsResponse | { error: string; message: string }> => {
      const accountId = accountIdOf(req);
      const q = req.query as { workspace?: string };
      const body = req.body as ReleaseOlderTagsBody;
      const { workspaceId } = await resolveWorkspaceScope(accountId, q.workspace);
      if (!(await getReleaseRepos(accountId, workspaceId)).has(body.repoId)) {
        reply.status(404);
        return { error: 'NotFound', message: `Repository ${body.repoId} is not released from this workspace` };
      }
      const r = raiseOlderTagsWanted(accountId, workspaceId, body.repoId, body.wanted);
      // More older tags: the scan reads on (history just far enough, then their tickets in a batch).
      if (r.grew && !scheduleTagSync(accountId, body.repoId, req.log, { rescan: true })) markTagCatchUp(body.repoId);
      return { workspaceId, repoId: body.repoId, wanted: r.wanted };
    },
  );

  app.post(
    '/api/releases/preview',
    {
      schema: {
        body: { type: 'object', required: ['repoIds'], additionalProperties: false, properties: { repoIds: repoIdsSchema } },
      },
    },
    async (req, reply) => {
      const q = req.query as { workspace?: string };
      try {
        return await previewRelease(accountIdOf(req), q.workspace, req.body as ReleasePreviewBody);
      } catch (err) {
        return refusal(reply, err);
      }
    },
  );

  app.post(
    '/api/releases',
    {
      schema: {
        body: {
          type: 'object',
          required: ['repoIds', 'snapshot'],
          additionalProperties: false,
          properties: {
            repoIds: repoIdsSchema,
            snapshot: snapshotSchema,
            sections: {
              type: 'array',
              maxItems: 200,
              items: {
                type: 'object',
                required: ['repoId', 'markdown'],
                additionalProperties: false,
                properties: { repoId: { type: 'integer' }, markdown: { type: 'string', maxLength: RELEASE_NOTES_SECTION_MAX } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query as { workspace?: string };
      try {
        return await createRelease(accountIdOf(req), q.workspace, req.body as CreateReleaseBody);
      } catch (err) {
        return refusal(reply, err);
      }
    },
  );

  app.get('/api/releases/:id', { schema: { params: idParamSchema } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const detail = await getReleaseDetail(accountIdOf(req), id);
    if (detail == null) {
      reply.status(404);
      return { error: 'NotFound', message: `Release ${id} not found` };
    }
    return detail;
  });

  app.put(
    '/api/workspaces/:id/release-repos',
    {
      schema: {
        params: idParamSchema,
        body: {
          type: 'object',
          required: ['repoIds'],
          additionalProperties: false,
          properties: {
            repoIds: { type: 'array', maxItems: 500, items: { type: 'integer' } },
            bases: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['repoId', 'basis'],
                additionalProperties: false,
                properties: { repoId: { type: 'integer' }, basis: { type: 'string', enum: ['auto', 'tags', 'prs'] } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: number };
      const body = req.body as SetReleaseReposBody;
      const before = await getReleaseRepos(accountId, id);
      const out = await setReleaseRepos(accountId, id, body.repoIds, new Date(), body.bases ?? []);
      if (out == null) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      if (!out.ok) {
        reply.status(400);
        return { error: 'NotAMember', message: 'Only repositories of this workspace can be released from it.' };
      }
      for (const repoId of body.repoIds) if (!before.has(repoId)) markTagCatchUp(repoId);
      // A changed "Release from" reads the history again for that repo (DB only until the scan runs).
      for (const b of body.bases ?? []) if (before.has(b.repoId) && before.get(b.repoId)!.basis !== b.basis) markTagCatchUp(b.repoId);
      const res = await getReleaseSettingsResponse(accountId, id);
      if (!res) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      return res;
    },
  );

  app.get('/api/workspaces/:id/release-settings', { schema: { params: idParamSchema } }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const res = await getReleaseSettingsResponse(accountId, id);
    if (!res) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    return res;
  });

  app.put(
    '/api/workspaces/:id/release-settings',
    {
      schema: {
        params: idParamSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['releaseSuffix', 'hotfixSuffix'],
          properties: { releaseSuffix: suffixSchema, hotfixSuffix: suffixSchema },
        },
      },
    },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: number };
      const body = req.body as SetReleaseSettingsBody;
      const problem = validateReleaseSettings(body);
      if (problem) {
        reply.status(400);
        return { error: 'InvalidReleaseSettings', message: problem };
      }
      if (!(await setReleaseSettings(accountId, id, body))) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const res = await getReleaseSettingsResponse(accountId, id);
      if (!res) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      return res;
    },
  );
}
