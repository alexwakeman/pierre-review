import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import {
  getAccountById,
  getLocalAccountCached,
  stampAccountActive,
  LOCAL_ACCOUNT_ID,
  type Account,
} from '../../auth/account.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Resolved per request by the onRequest hook below. In local mode this is
    // always the single synthesized account; in cloud mode it's the session's
    // account (or null when unauthenticated).
    account: Account | null;
  }
}

// Attaches `request.account` to every request. Registered once on the root app
// (so it covers all routes, including static/health which simply ignore it).
//
// Local mode: always the synthesized local account (id 1).
// Cloud mode: resolved from the sealed session cookie (set up in registerCloudAuth,
//   Phase 1). Unauthenticated requests get `null`; the requireAuth preHandler
//   then 401s the data routes.
export function registerAccountContext(app: FastifyInstance): void {
  app.decorateRequest('account', null);
  app.addHook('onRequest', async (req) => {
    if (config.isCloud) {
      const accountId = readSessionAccountId(req);
      req.account = accountId != null ? await getAccountById(accountId) : null;
      // A request from a signed-in account on a real data route means that tenant
      // has a loaded frontend — stamp activity (throttled) so the scheduler keeps
      // syncing their repos. Skips static/landing assets and the health/auth probes.
      if (req.account && req.url.startsWith('/api/')) {
        stampAccountActive(req.account.id);
      }
    } else {
      req.account =
        getLocalAccountCached() ?? {
          id: LOCAL_ACCOUNT_ID,
          githubUserId: '',
          githubLogin: '',
          displayName: null,
          avatarUrl: null,
          isLocal: true,
          plan: 'free',
          stripeCustomerId: null,
          aiCreditAllowance: null,
          benchmarkOptIn: false,
          largePrCodeLocThreshold: null,
        };
    }
  });
}

// Reads {accountId} from the sealed session cookie. @fastify/secure-session is
// only registered in cloud mode (Phase 1); guarded so this is safe pre-registration.
function readSessionAccountId(req: FastifyRequest): number | null {
  const session = (req as unknown as { session?: { get(k: string): unknown } })
    .session;
  if (!session) return null;
  const raw = session.get('accountId');
  return typeof raw === 'number' ? raw : null;
}

// Cloud only: register the cookie + sealed-session plugins. MUST run before
// registerAccountContext so the session cookie is parsed by the time the
// account-context onRequest hook reads it. The session key is derived from
// SESSION_SECRET (sha256 → 32 bytes, the size secure-session needs).
export async function registerSession(app: FastifyInstance): Promise<void> {
  const cookie = await import('@fastify/cookie');
  const secureSession = await import('@fastify/secure-session');
  await app.register(cookie.default, { secret: config.sessionSecret });
  const key = createHash('sha256').update(config.sessionSecret).digest();
  await app.register(secureSession.default, {
    key,
    cookieName: 'pierre_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.appBaseUrl.startsWith('https://'),
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
  });
}

// Cloud only: 401 any unauthenticated /api data route. Skips /api/health,
// /api/auth/* (sign-in itself), /api/billing/webhook (Stripe posts
// unauthenticated — verified by signature instead) and all non-/api requests
// (the SPA + landing are served openly; the frontend gate handles the signed-out
// UI). MUST be registered AFTER registerAccountContext so req.account is already
// resolved. Also the cloud-only ENTITLEMENT gate: an authenticated free-plan
// account gets 402 on the Pro plugin's /api/pro/* routes (local accounts are
// always entitled — isLocal never reaches the cloud gate anyway).
export function registerAuthGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/')) return;
    if (path === '/api/health') return;
    if (path.startsWith('/api/auth/')) return;
    if (path === '/api/billing/webhook') return;
    // GitHub App webhook: GitHub posts unauthenticated — authenticity is the
    // X-Hub-Signature-256 HMAC, verified in the route (see api/routes/webhooks.ts).
    if (path === '/api/webhooks/github') return;
    // The pricing page's "Get Pro" is a plain browser navigation from the public
    // landing; the route itself bounces anonymous visitors to sign-in instead of
    // dead-ending them on a JSON 401.
    if (path === '/api/billing/checkout') return;
    if (!req.account) {
      await reply.code(401).send({
        error: 'Unauthorized',
        message: 'Sign in with GitHub to continue.',
      });
      return;
    }
    if (isProPath(path) && !req.account.isLocal && req.account.plan === 'free') {
      await reply.code(402).send({ error: 'pro required' });
    }
  });
}

// Which paths the free-plan 402 gate covers.
//
// `/api/pro/*` is the convention, but it is NOT the whole surface: when Claude Review moved
// into the plugin it deliberately KEPT its pre-plugin URLs so the core frontend client did
// not have to change — `/api/prs/:id/claude-review*`, `/api/claude-reviews/*`,
// `/api/claude-findings/*`, `/api/claude-review/budget` (its `/key` sibling is DELETED with the
// retired BYO Anthropic key). A prefix test on `/api/pro/`
// therefore missed the most expensive routes in the product.
//
// Today that is latent rather than exploitable, because agentic AI is off in cloud
// (PRO_ADVANCED_AI_ENABLED unset ⇒ the routes 404 via their own self-gate) — but "latent"
// here means "the day someone enables the paid agentic tier, every free account gets it",
// which is precisely the kind of gap that ships. Enumerated explicitly so adding a plugin
// route outside /api/pro/ is a visible decision.
function isProPath(path: string): boolean {
  if (path.startsWith('/api/pro/')) return true;
  if (path.startsWith('/api/claude-reviews')) return true;
  if (path.startsWith('/api/claude-findings/')) return true;
  if (path.startsWith('/api/claude-review/')) return true;
  // /api/prs/<id>/claude-review, …/status, …/stream, …/cancel
  if (/^\/api\/prs\/\d+\/claude-review/.test(path)) return true;
  return false;
}

// preHandler that rejects unauthenticated requests in cloud mode. A no-op in
// local mode (the account is always present). Kept for any route that wants an
// explicit per-route guard in addition to the global gate above.
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.isCloud) return;
  if (!req.account) {
    await reply
      .code(401)
      .send({ error: 'Unauthorized', message: 'Sign in with GitHub to continue.' });
  }
}

// The request's account id, for scoping queries. Always present in local mode;
// in cloud mode requireAuth has already guaranteed it on data routes.
export function accountIdOf(req: FastifyRequest): number {
  if (req.account) return req.account.id;
  if (!config.isCloud) return LOCAL_ACCOUNT_ID;
  throw new Error('no account on request (requireAuth missing?)');
}
