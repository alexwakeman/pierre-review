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
import { userRoutes } from './api/routes/users.js';
import { timelineRoutes } from './api/routes/timeline.js';
import { prRoutes } from './api/routes/prs.js';
import { threadRoutes } from './api/routes/threads.js';
import { meRoutes } from './api/routes/me.js';
import { openPrsRoutes } from './api/routes/open-prs.js';
import { mergersRoutes } from './api/routes/mergers.js';
import { claudeReviewRoutes } from './api/routes/claude-review.js';

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
  await app.register(userRoutes);
  await app.register(timelineRoutes);
  await app.register(prRoutes);
  await app.register(threadRoutes);
  await app.register(meRoutes);
  await app.register(openPrsRoutes);
  await app.register(mergersRoutes);
  // Claude Review is local-only + opt-in. Only register its routes when enabled,
  // so the clone-manager / gh-CLI dependency is unreachable in cloud mode.
  if (config.claudeReviewEnabled) await app.register(claudeReviewRoutes);

  return app;
}
