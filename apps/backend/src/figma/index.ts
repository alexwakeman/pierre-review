import type { FastifyInstance } from 'fastify';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema } from '../db/client.js';
import { registerFigmaRoutes } from './routes.js';

// FIGMA (docs/IMPLEMENT-UI-PLAN.md § 3). Registered from app.ts. ⚠ The ONE figma module that imports the
// database client; every other one takes it as an argument.
export function registerFigma(app: FastifyInstance): void {
  registerFigmaRoutes(app, {
    db,
    schema: schema as unknown as Record<string, unknown> as Parameters<typeof registerFigmaRoutes>[1]['schema'],
    accountIdOf,
    log: app.log,
  });
}
