import type { FastifyInstance } from 'fastify';
import type { AgentContext } from '../../review/agent-context.js';
import { registerStoryBuildBuildRoutes } from './routes-build.js';
import { registerStoryBuildDocsRoutes } from './routes-docs.js';

// "IMPLEMENT STORY" ROUTES (docs/STORY-BUILD.md § Routes; contracts in docs/API.md). Registered ONLY from
// review/agentic.ts `registerAgenticRoutes`, so nothing answers when AI is off (the paths 404). Every path
// is spelled once in packages/shared `STORY_BUILD_API`; every `:id` read scopes the account (a wrong owner
// is 404); each new path has a rate-limit tier (api/plugins/rate-limit.ts, rate-limit.test.ts).
//
// THREE FILES, ONE PER WORK PACKAGE, so the packages never edit the same lines:
//   routes.ts        WP1  GET list/one/stream · POST start · plan/message · accept · cancel · discard
//   routes-build.ts  WP2  GET …/repos/:repoId/{checks,diff} · POST …/repos/:repoId/{retry,push} · POST …/push
//   routes-docs.ts   WP3  POST …/docs · PUT …/docs/decisions
// The contract commit registers nothing yet: each WP adds its own handlers.

export function registerStoryBuildRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // WP1: the session routes go here.
  registerStoryBuildBuildRoutes(app, ctx);
  registerStoryBuildDocsRoutes(app, ctx);
}
