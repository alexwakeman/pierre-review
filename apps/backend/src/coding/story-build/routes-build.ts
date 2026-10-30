import type { FastifyInstance } from 'fastify';
import type { AgentContext } from '../../review/agent-context.js';

// "IMPLEMENT STORY" — the build-side routes, WORK PACKAGE 2 (see routes.ts): checks preview, diff, retry,
// push one, push all. Paths: packages/shared `STORY_BUILD_API.{repoChecks,repoDiff,repoRetry,repoPush,pushAll}`.
// Contract-commit stub: registers nothing.
export function registerStoryBuildBuildRoutes(_app: FastifyInstance, _ctx: AgentContext): void {}
