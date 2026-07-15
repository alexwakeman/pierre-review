import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { registerErrorHandler } from './api/plugins/error-handler.js';
import {
  registerAccountContext,
  registerAuthGate,
  registerSession,
} from './api/plugins/auth.js';
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
import { billingRoutes } from './api/routes/billing.js';
import { botTriageRoutes } from './api/routes/bot-triage.js';
import { webhookRoutes } from './api/routes/webhooks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // In production (the installed CLI) the per-request "incoming request" /
    // "request completed" lines are pure noise in the user's terminal — silence
    // them while keeping startup + error logs. Dev keeps them for debugging.
    disableRequestLogging: process.env.NODE_ENV === 'production',
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    },
  });

  // Cloud only: canonicalise the host and pin HTTPS. Local mode runs on
  // http://127.0.0.1, where HSTS would wrongly pin localhost to HTTPS and a www
  // redirect is meaningless — so both are cloud-gated. Registered first so it runs
  // before everything else (the redirect short-circuits before CORS/routing).
  if (config.isCloud) {
    let canonicalHost = '';
    try {
      // hostname (not host) so a configured port never enters the comparison.
      canonicalHost = new URL(config.appBaseUrl).hostname.toLowerCase();
    } catch {
      canonicalHost = '';
    }

    app.addHook('onRequest', async (req, reply) => {
      // HSTS: keep browsers on HTTPS for this domain. Honored only over HTTPS
      // (Railway terminates TLS); ignored on plain HTTP. `includeSubDomains` also
      // covers www. No `preload` — it's hard to undo. HSTS_MAX_AGE=0 disables it.
      if (config.hstsMaxAge > 0) {
        reply.header(
          'Strict-Transport-Security',
          `max-age=${config.hstsMaxAge}; includeSubDomains`,
        );
      }

      // Canonical host: 301 www.<apex> → <apex> so the OAuth round-trip and the
      // session cookie stay on a single origin (and crawlers see one canonical
      // URL). The HSTS header set above still rides on the redirect response.
      if (canonicalHost) {
        // Strip any :port from the Host header before comparing hostnames.
        const host = (req.headers.host ?? '').toLowerCase().split(':')[0] ?? '';
        if (
          host !== canonicalHost &&
          host.replace(/^www\./, '') === canonicalHost
        ) {
          return reply.redirect(`${config.appBaseUrl}${req.url}`, 301);
        }
      }
    });
  }

  // CORS: in cloud mode lock to the app's own origin and allow credentials so the
  // session cookie rides along; local mode reflects any origin (dev convenience).
  await app.register(cors, {
    origin: config.isCloud ? [config.appBaseUrl] : true,
    credentials: config.isCloud,
  });

  // Cloud only: parse the sealed session cookie BEFORE the account-context hook
  // reads it.
  if (config.isCloud) await registerSession(app);

  // Attach `request.account` to every request (local account in local mode; the
  // session's account in cloud mode). Must run after CORS/session and before the
  // route registrations so every handler can read `request.account` / accountIdOf().
  registerAccountContext(app);

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
  // Bot-triage platform (CORE, always registered): detection/override, ROI analytics,
  // cross-bot dedup, mute / auto-triage rules. Account-scoped; no AI.
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
