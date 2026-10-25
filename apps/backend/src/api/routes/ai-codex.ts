import type { FastifyInstance } from 'fastify';
import type { CodexLoginBody, CodexLoginResponse, CodexLogoutResponse } from '@pierre-review/shared';
import { config } from '../../config.js';
import { codexSignedInCached } from '../../ai/codex/app-server.js';
import { cancelCodexLogin, codexLoginState, codexLogout, startCodexLogin } from '../../ai/codex/login.js';

// THE CODEX SIGN-IN, for Limn's OWN Codex home (`~/.limn/codex`; docs/CODEX-PLAN.md § 6). The work is
// ai/codex/login.ts's; these routes only relay it. Registered only when `config.aiEnabled` (which is
// false in cloud and under LIMN_AI_DISABLED), and each refuses again on its own if ever reached
// without it. Nothing here is written to the database; the sign-in lives in Codex's own auth.json.
//
// The SPA (Phase 4) POSTs to start, opens what `login` names (the browser flow's URL, or the device
// flow's page + code), and polls the GET until `done` or `failed`. A second POST joins the running
// sign-in. Rate tier: `sync` for the POSTs (rate-limit.ts).
export async function aiCodexRoutes(app: FastifyInstance): Promise<void> {
  const notHere = { error: 'NotFound', message: 'Not available here.' };
  const respond = (): CodexLoginResponse => {
    const a = codexSignedInCached();
    return { login: codexLoginState(), signedIn: !!a?.signedIn, plan: a?.plan ?? null };
  };

  app.get('/api/ai/codex/login', async (_req, reply) => {
    if (!config.aiEnabled) return reply.code(404).send(notHere);
    return respond();
  });

  app.post('/api/ai/codex/login', async (req, reply) => {
    if (!config.aiEnabled) return reply.code(404).send(notHere);
    const body = (req.body ?? {}) as CodexLoginBody;
    const method = body.method ?? 'browser';
    if (method !== 'browser' && method !== 'device') {
      return reply.code(400).send({ error: 'BadRequest', message: 'method must be browser or device.' });
    }
    await startCodexLogin(method);
    return respond();
  });

  app.post('/api/ai/codex/login/cancel', async (_req, reply) => {
    if (!config.aiEnabled) return reply.code(404).send(notHere);
    await cancelCodexLogin();
    return respond();
  });

  app.post('/api/ai/codex/logout', async (_req, reply) => {
    if (!config.aiEnabled) return reply.code(404).send(notHere);
    const message = await codexLogout();
    const out: CodexLogoutResponse = { ok: message == null, message };
    return out;
  });
}
