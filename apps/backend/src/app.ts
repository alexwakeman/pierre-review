import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { registerErrorHandler } from './api/plugins/error-handler.js';
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

  await app.register(cors, { origin: true });

  // Single-process production mode: serve the built SPA when the bundled assets
  // exist next to the compiled server (release/dist → release/public). In dev
  // there is no sibling `public/` dir, so this no-ops and Vite (:5173) serves the
  // UI by proxying /api back to this server — dev stays unchanged.
  const publicDir = resolve(import.meta.dirname, '../public');
  const serveSpa = existsSync(resolve(publicDir, 'index.html'));
  if (serveSpa) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
  }

  // The not-found handler doubles as the SPA fallback when serving the SPA.
  registerErrorHandler(app, serveSpa);

  await app.register(healthRoutes);
  await app.register(repoRoutes);
  await app.register(userRoutes);
  await app.register(timelineRoutes);
  await app.register(prRoutes);
  await app.register(threadRoutes);
  await app.register(meRoutes);
  await app.register(openPrsRoutes);
  await app.register(mergersRoutes);
  await app.register(claudeReviewRoutes);

  return app;
}
