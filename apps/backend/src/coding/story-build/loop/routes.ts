// THE REVIEW LOOP'S ROUTES (docs/API.md; docs/STORY-BUILD.md § The review loop). Registered by
// routes-build.ts (so only when AI is on). Every `:id` read scopes the account (another account's build ⇒ 404).
// Tiers: api/plugins/rate-limit.ts (Continue may start reviews, a fix turn and pushes; the rest are DB only).
//
//   GET  …/loop            the loop as it is now (StoryBuildLoopRouteResponse)
//   POST …/loop/settings   {on?, rounds?} — the switch and the rounds, until the loop starts (409 LoopStarted)
//   POST …/loop/continue   {branch?: {kind, id, name}} — the reader's press: one new attempt of the paused step
//   POST …/loop/stop       stop at the next checkpoint (the work and the branches stay)
import type { FastifyInstance } from 'fastify';
import {
  STORY_BUILD_API,
  STORY_BUILD_BRANCH_MAX,
  STORY_BUILD_LOOP_ROUNDS_MAX,
  STORY_BUILD_LOOP_ROUNDS_MIN,
  type StoryBuildLoopRouteResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { getStoryBuildRow } from '../persist.js';
import { continueLoop, setLoopSettings, stopLoop, storyLoopWire } from './driver.js';

const NOT_FOUND = { error: 'NotFound', message: 'Not found.' } as const;

const parseId = (raw: string | undefined): number | null => {
  if (raw == null || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const isObj = (b: unknown): b is Record<string, unknown> => b != null && typeof b === 'object' && !Array.isArray(b);

/** The settings body: `on` a boolean, `rounds` an integer MIN..MAX; at least one. null ⇒ refused. */
export function parseLoopSettings(body: unknown): { on?: boolean; rounds?: number } | null {
  if (!isObj(body)) return null;
  const out: { on?: boolean; rounds?: number } = {};
  if (body.on !== undefined) {
    if (typeof body.on !== 'boolean') return null;
    out.on = body.on;
  }
  if (body.rounds !== undefined) {
    const r = body.rounds;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < STORY_BUILD_LOOP_ROUNDS_MIN || r > STORY_BUILD_LOOP_ROUNDS_MAX) return null;
    out.rounds = r;
  }
  return out.on === undefined && out.rounds === undefined ? null : out;
}

/** The continue body: nothing, or `branch: {kind, id, name}`. undefined ⇒ refused. */
export function parseContinue(body: unknown): { branch?: { kind: 'repo' | 'pr'; id: number; name: string } } | undefined {
  if (body == null) return {};
  if (!isObj(body)) return undefined;
  if (body.branch === undefined) return {};
  const b = body.branch;
  if (!isObj(b)) return undefined;
  const kind = b.kind;
  const id = b.id;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if ((kind !== 'repo' && kind !== 'pr') || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
  if (name.length === 0 || name.length > STORY_BUILD_BRANCH_MAX) return undefined;
  return { branch: { kind, id, name } };
}

export function registerStoryBuildLoopRoutes(app: FastifyInstance, ctx: AgentContext): void {
  const answer = async (accountId: number, id: number): Promise<StoryBuildLoopRouteResponse | null> => {
    const row = await getStoryBuildRow(ctx, accountId, id);
    if (!row) return null;
    const loop = await storyLoopWire(ctx, accountId, { ...row, autoPush: row.autoPush || row.loopState != null });
    return loop ? { loop } : null;
  };

  app.get<{ Params: { id: string } }>(STORY_BUILD_API.loop, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id == null) return reply.code(404).send(NOT_FOUND);
    const got = await answer(ctx.accountIdOf(req), id);
    if (!got) return reply.code(404).send(NOT_FOUND);
    return reply.send(got);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(STORY_BUILD_API.loopSettings, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    if (id == null) return reply.code(404).send(NOT_FOUND);
    const body = parseLoopSettings(req.body);
    if (!body) {
      return reply.code(400).send({ error: 'BadRequest', message: `Send \`on\` (true or false) and/or \`rounds\` (${STORY_BUILD_LOOP_ROUNDS_MIN} to ${STORY_BUILD_LOOP_ROUNDS_MAX}).` });
    }
    const r = await setLoopSettings(ctx, accountId, id, body);
    if (r.status === 'not_found') return reply.code(404).send(NOT_FOUND);
    if (r.status === 'started') return reply.code(409).send({ error: 'LoopStarted', message: 'The review loop has started. Stop it to change this.' });
    const got = await answer(accountId, id);
    return got ? reply.send(got) : reply.code(404).send(NOT_FOUND);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(STORY_BUILD_API.loopContinue, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    if (id == null) return reply.code(404).send(NOT_FOUND);
    const body = parseContinue(req.body);
    if (body === undefined) return reply.code(400).send({ error: 'BadRequest', message: `\`branch\` must be {kind, id, name} with a name of 1 to ${STORY_BUILD_BRANCH_MAX} characters.` });
    const r = await continueLoop(ctx, accountId, id, body);
    if (r.status === 'not_found') return reply.code(404).send(NOT_FOUND);
    if (r.status === 'not_paused') return reply.code(409).send({ error: 'NotReady', message: r.message });
    if (r.status === 'refused') return reply.code(400).send({ error: 'BadRequest', message: r.message });
    const got = await answer(accountId, id);
    reply.code(202);
    return got ? reply.send(got) : reply.code(404).send(NOT_FOUND);
  });

  app.post<{ Params: { id: string } }>(STORY_BUILD_API.loopStop, async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const id = parseId(req.params.id);
    if (id == null) return reply.code(404).send(NOT_FOUND);
    const r = await stopLoop(ctx, accountId, id);
    if (r === 'not_found') return reply.code(404).send(NOT_FOUND);
    if (r === 'not_running') return reply.code(409).send({ error: 'NotReady', message: 'The review loop is not running.' });
    if (r === 'busy') return reply.code(409).send({ error: 'NotReady', message: 'Wait for the push to finish, then press Stop.' });
    const got = await answer(accountId, id);
    return got ? reply.send(got) : reply.code(404).send(NOT_FOUND);
  });
}
