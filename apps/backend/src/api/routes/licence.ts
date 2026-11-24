import type { FastifyInstance } from 'fastify';
import type { LicenceKeyRequest, LicenceStatusResponse } from '@pierre-review/shared';
import { accountIdOf } from '../plugins/auth.js';
import {
  getLicenceStatus,
  removeLicenceKey,
  saveLicenceKey,
  snoozeLicenceReminder,
  startLicenceEvaluation,
} from '../../licence/status.js';

// THE COMMERCIAL LICENCE (docs/LICENSING.md; docs/API.md § Licence). DB only: the key is checked
// OFFLINE against public keys built into the app, and the colleague count reads synced rows. No
// GitHub call, no model, nothing sent anywhere.
//
//   GET    /api/licence             → LicenceStatusResponse
//   PUT    /api/licence             { key } → the new status; 400 with `problem` when the key fails
//   DELETE /api/licence             → the new status
//   POST   /api/licence/evaluating  start the one 30-day evaluation → the new status
//   POST   /api/licence/later       "Remind me later" (7 days) → the new status
const keyBody = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 4096 } },
} as const;

export async function licenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/licence', async (req): Promise<LicenceStatusResponse> => getLicenceStatus(accountIdOf(req)));

  app.put<{ Body: LicenceKeyRequest }>('/api/licence', { schema: { body: keyBody } }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const saved = await saveLicenceKey(accountId, req.body.key);
    if (!saved.ok) return reply.status(400).send({ error: 'licence_key_rejected', problem: saved.problem });
    return getLicenceStatus(accountId);
  });

  app.delete('/api/licence', async (req): Promise<LicenceStatusResponse> => {
    const accountId = accountIdOf(req);
    await removeLicenceKey(accountId);
    return getLicenceStatus(accountId);
  });

  app.post('/api/licence/evaluating', async (req): Promise<LicenceStatusResponse> => {
    const accountId = accountIdOf(req);
    await startLicenceEvaluation(accountId);
    return getLicenceStatus(accountId);
  });

  app.post('/api/licence/later', async (req): Promise<LicenceStatusResponse> => {
    const accountId = accountIdOf(req);
    await snoozeLicenceReminder(accountId);
    return getLicenceStatus(accountId);
  });
}
