import type { FastifyInstance } from 'fastify';
import {
  RELEASE_SUFFIX_MAX,
  validateReleaseSettings,
  type SetReleaseSettingsBody,
} from '@pierre-review/shared';
import { getReleaseSettingsResponse, setReleaseSettings } from '../../db/release-settings.js';
import { accountIdOf } from '../plugins/auth.js';

// RELEASES (docs/RELEASES.md; docs/API.md § Releases). CORE, always registered.
//
//   GET /api/workspaces/:id/release-settings   the workspace's release + hotfix suffixes (null = not
//                                              set; there is no default), `configured` (both set) and
//                                              `hasReleases` (the form warns before a change).
//   PUT /api/workspaces/:id/release-settings   the WHOLE setting: `{ releaseSuffix, hotfixSuffix }`,
//                                              null or "" clears one. 400 with the SAME sentence
//                                              shared `validateReleaseSettings` gives the Settings form.
//
// Both are DB only — the workspace-CRUD `read` tier (api/plugins/rate-limit.ts). 404 on a workspace
// that is not this account's, like every id-addressed workspace route.

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } },
} as const;

const suffixSchema = { type: ['string', 'null'], maxLength: RELEASE_SUFFIX_MAX * 4 } as const;

export async function releaseRoutes(app: FastifyInstance): Promise<void> {
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
