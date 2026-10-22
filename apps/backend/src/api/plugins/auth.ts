import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getLocalAccountCached, LOCAL_ACCOUNT_ID, type Account } from '../../auth/account.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Resolved per request by the onRequest hook below: always the single local account.
    account: Account | null;
  }
}

// Attaches `request.account` to every request. Registered once on the root app (so it covers all
// routes, including static/health which simply ignore it). Limn runs on the reader's own machine
// with their `gh` login, so every request is the synthesized local account (id 1).
export function registerAccountContext(app: FastifyInstance): void {
  app.decorateRequest('account', null);
  app.addHook('onRequest', async (req) => {
    req.account =
      getLocalAccountCached() ?? {
        id: LOCAL_ACCOUNT_ID,
        githubUserId: '',
        githubLogin: '',
        displayName: null,
        avatarUrl: null,
        isLocal: true,
        largePrCodeLocThreshold: null,
        blastRadiusConfig: null,
      };
  });
}

// The request's account id, for scoping queries.
export function accountIdOf(req: FastifyRequest): number {
  return req.account?.id ?? LOCAL_ACCOUNT_ID;
}
