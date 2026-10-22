import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema } from '../db/client.js';
import { registerSonarRoutes } from './routes.js';

// SONARCLOUD — CORE, FREE (docs/SONARCLOUD.md). Registered from app.ts unconditionally: the settings
// and the stored reads work in both modes; the post route registers locally only (routes.ts).
// ⚠ This is the ONE sonar module that imports the database client; every other one takes it as an
// argument, so a review-side test never opens the real database.
export function registerSonar(app: FastifyInstance): void {
  registerSonarRoutes(app, {
    db,
    schema: schema as unknown as Record<string, unknown> as Parameters<typeof registerSonarRoutes>[1]['schema'],
    accountIdOf,
    log: app.log,
  });
}
