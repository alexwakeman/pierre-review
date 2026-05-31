import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
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

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    },
  });

  await app.register(cors, { origin: true });

  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(repoRoutes);
  await app.register(userRoutes);
  await app.register(timelineRoutes);
  await app.register(prRoutes);
  await app.register(threadRoutes);
  await app.register(meRoutes);
  await app.register(openPrsRoutes);
  await app.register(mergersRoutes);

  return app;
}
