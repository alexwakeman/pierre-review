import type { FastifyInstance } from 'fastify';
import type { AgentContext } from '../../review/agent-context.js';

// "IMPLEMENT STORY" — the docs routes, WORK PACKAGE 3 (see routes.ts): run the docs consideration, save the
// decisions. Paths: packages/shared `STORY_BUILD_API.{docs,docsDecisions}`. Contract-commit stub:
// registers nothing.
export function registerStoryBuildDocsRoutes(_app: FastifyInstance, _ctx: AgentContext): void {}
