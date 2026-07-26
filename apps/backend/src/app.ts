import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config, intFromEnv } from './config.js';
import { registerErrorHandler } from './api/plugins/error-handler.js';
import {
  registerAccountContext,
  registerAuthGate,
  registerSession,
} from './api/plugins/auth.js';
import {
  corsOriginDelegate,
  registerCrossOriginGuard,
  registerHostGuard,
  registerSecurityHeaders,
} from './api/plugins/security.js';
import { registerRateLimit } from './api/plugins/rate-limit.js';
import { authRoutes } from './api/routes/auth.js';
import { healthRoutes } from './api/routes/health.js';
import { repoRoutes } from './api/routes/repos.js';
import { teamRoutes } from './api/routes/teams.js';
import { userRoutes } from './api/routes/users.js';
import { timelineRoutes } from './api/routes/timeline.js';
import { prRoutes } from './api/routes/prs.js';
import { threadRoutes } from './api/routes/threads.js';
import { meRoutes } from './api/routes/me.js';
import { openPrsRoutes } from './api/routes/open-prs.js';
import { feedRoutes } from './api/routes/feed.js';
import { mergersRoutes } from './api/routes/mergers.js';
import { insightsRoutes } from './api/routes/insights.js';
import { activityRoutes } from './api/routes/activity.js';
import { mentionsRoutes } from './api/routes/mentions.js';
import { searchRoutes } from './api/routes/search.js';
import { billingRoutes } from './api/routes/billing.js';
import { botTriageRoutes } from './api/routes/bot-triage.js';
import { webhookRoutes } from './api/routes/webhooks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // In production (the installed CLI) the per-request "incoming request" /
    // "request completed" lines are pure noise in the user's terminal — silence
    // them while keeping startup + error logs. Dev keeps them for debugging.
    //
    // Via `logController` rather than the top-level `disableRequestLogging`, which
    // Fastify 5.10 deprecated (FSTDEP023) and removes in 6 — the top-level form logs
    // a warning on every boot, which for a CLI users run in their own terminal is
    // exactly the noise this option exists to suppress.
    logController: new LogController({
      disableRequestLogging: process.env.NODE_ENV === 'production',
    }),
    // CLOUD ONLY. Railway terminates TLS and forwards, so without this every
    // request's `req.ip` is the proxy's and `req.protocol` is http — which would
    // collapse the rate limiter's IP fallback into a single shared bucket. It is
    // deliberately NOT enabled locally: there is no proxy there, so trusting
    // X-Forwarded-For would let any client choose its own rate-limit key.
    trustProxy: config.isCloud,
    // Cap request bodies. Fastify's default is already 1 MiB; pinning it here makes
    // it an explicit, reviewable decision rather than a framework default, and
    // 256 KiB is well above the largest legitimate body (a review draft, a settings
    // object, a webhook delivery) while shrinking the memory a flood can pin.
    bodyLimit: intFromEnv('BODY_LIMIT_BYTES', 256 * 1024),
    // Refuse a request whose headers never finish arriving (slowloris) and one whose
    // body stalls mid-stream. Fastify/Node default both to effectively unbounded.
    requestTimeout: intFromEnv('REQUEST_TIMEOUT_MS', 60_000),
    // A route param is an id or a short slug; 200 chars is generous. The default is
    // 100 but applies per-param, and a long param is a cheap way to stress a router.
    // Under `routerOptions` because the top-level `maxParamLength` is deprecated in
    // Fastify 5 (FSTDEP022) and removed in 6 — setting it at the top level logs a
    // warning on every boot.
    routerOptions: { maxParamLength: 200 },
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Redaction is load-bearing, not cosmetic. An `err` from a failed HTTP call can
      // carry the outgoing request headers — including `Authorization: token gho_…`
      // for GitHub and `x-api-key: sk-ant-…` for Anthropic — and pino serializes error
      // objects deeply. Every path below is a place a credential has been observed to
      // hide in a serialized error or request. `censor` keeps the shape so a redacted
      // log line is still diagnosable.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-hub-signature-256"]',
          'req.headers["stripe-signature"]',
          'res.headers["set-cookie"]',
          'err.config.headers',
          'err.request.headers',
          'err.response.headers',
          'err.headers',
          'headers.authorization',
          'headers.cookie',
          '*.access_token',
          '*.accessToken',
          '*.accessTokenEnc',
          '*.client_secret',
          '*.clientSecret',
          '*.apiKey',
          '*.api_key',
          '*.token',
          '*.password',
          '*.secret',
        ],
        censor: '[redacted]',
      },
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    },
  });

  // Security response headers (CSP per surface, nosniff, frame-deny, referrer,
  // permissions) plus — cloud only — HSTS and the www → apex canonical 301.
  // Registered FIRST so the headers ride on every response, including that redirect,
  // the 404/error bodies and the static assets. See api/plugins/security.ts.
  registerSecurityHeaders(app);

  // LOCAL only: reject a request whose Host header isn't loopback. The server binds
  // 127.0.0.1, so nothing on the network can reach it — but a DNS-rebinding attack
  // makes an attacker-controlled hostname resolve there, at which point their page
  // becomes same-origin and every origin check above stops helping. A rebound request
  // still carries the attacker's Host, so this catches it. Stands down if the operator
  // has deliberately bound a non-loopback HOST.
  registerHostGuard(app);

  // CORS: an allowlist in BOTH modes now. Cloud = the deployment's own origin, with
  // credentials so the session cookie rides along. Local = any LOOPBACK origin on any
  // port (dev 5173/5174, the demo stack 5273, the packaged CLI on its own port) —
  // previously this was `origin: true`, which reflected ANY origin. Combined with
  // local mode having no auth at all (every request resolves to the single local
  // account), that let any page the developer happened to have open read their whole
  // synced GitHub dataset with a cross-origin fetch. See security.ts.
  await app.register(cors, {
    origin: corsOriginDelegate,
    credentials: config.isCloud,
  });

  // Reject state-changing /api calls that arrive from a foreign origin. NOT redundant
  // with CORS: CORS only decides whether the attacker's page may READ the response —
  // a simple cross-origin POST is still delivered and still executes. Belt to
  // SameSite=Lax's braces in cloud; in local mode it is the only thing standing
  // between a drive-by page and an authenticated write.
  registerCrossOriginGuard(app);

  // Cloud only: parse the sealed session cookie BEFORE the account-context hook
  // reads it.
  if (config.isCloud) await registerSession(app);

  // Attach `request.account` to every request (local account in local mode; the
  // session's account in cloud mode). Must run after CORS/session and before the
  // route registrations so every handler can read `request.account` / accountIdOf().
  registerAccountContext(app);

  // Rate limiting. AFTER registerAccountContext so buckets key on the account id (the
  // thing that actually spends money) rather than an IP. Caps the AI-generation,
  // GitHub-write, sync and search routes — each of which already has a per-run cost
  // ceiling, but none of which was bounded in FREQUENCY until now. See
  // api/plugins/rate-limit.ts.
  registerRateLimit(app);

  // Cloud only: 401 unauthenticated /api data routes (after account context).
  if (config.isCloud) registerAuthGate(app);

  // Single-process production mode: serve the built SPA (under /app) and, in
  // cloud mode, the landing page (at /) when the bundled assets exist next to the
  // compiled server (release/dist → release/public + release/public-landing). In
  // dev there is no sibling public dir, so this no-ops and Vite serves the UI by
  // proxying /api back to this server — dev stays unchanged.
  const publicDir = resolve(import.meta.dirname, '../public');
  const publicLandingDir = resolve(import.meta.dirname, '../public-landing');
  const serveSpa = existsSync(resolve(publicDir, 'index.html'));
  const serveLanding =
    config.isCloud && existsSync(resolve(publicLandingDir, 'index.html'));
  if (serveSpa) {
    // SPA built with base '/app/', so its assets live under /app/.
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/app/',
      wildcard: false,
    });
  }
  if (serveLanding) {
    // Landing built with base '/', served at the origin root (assets at /assets).
    await app.register(fastifyStatic, {
      root: publicLandingDir,
      prefix: '/',
      wildcard: false,
      decorateReply: !serveSpa,
    });
  }

  // The single not-found handler routes /app → SPA, / → landing (cloud) or → /app
  // (local), and unknown /api → JSON 404.
  registerErrorHandler(app, {
    serveSpa,
    serveLanding,
    publicDir,
    publicLandingDir,
  });

  // OAuth sign-in routes (cloud only; ungated by the auth gate above).
  if (config.isCloud) await app.register(authRoutes);

  await app.register(healthRoutes);
  await app.register(repoRoutes);
  // Teams (CORE, always registered): group repos into named teams; account-scoped, no AI.
  await app.register(teamRoutes);
  await app.register(userRoutes);
  await app.register(timelineRoutes);
  await app.register(prRoutes);
  await app.register(threadRoutes);
  await app.register(meRoutes);
  await app.register(openPrsRoutes);
  await app.register(feedRoutes);
  await app.register(mergersRoutes);
  await app.register(insightsRoutes);
  await app.register(activityRoutes);
  await app.register(mentionsRoutes);
  await app.register(searchRoutes);
  // Bot-triage platform (CORE, always registered): detection/override, ROI analytics,
  // cross-bot dedup, confirm-gated bot-thread resolve. Account-scoped; no AI.
  await app.register(botTriageRoutes);
  // Stripe billing seam (checkout redirect + webhook). Registered in both modes;
  // inert until the STRIPE_* env vars are set (webhook 501s unconfigured).
  await app.register(billingRoutes);
  // GitHub App webhook receiver (real-time sync Phase 1). Registered in both modes;
  // inert until GITHUB_APP_WEBHOOK_SECRET is set (501s unconfigured). Additive on top of
  // the periodic poll — see docs/REALTIME-SYNC.md.
  await app.register(webhookRoutes);
  // Claude Review moved into the @pierre/pro plugin (its routes register there, gated on the
  // `claudeReview` capability). The SDK-run / diff-prep / GitHub-post infra + the tables stay
  // in core behind the ctx.review seam; nothing to register here.

  return app;
}
