// STORY CHAT routes (docs/STORY-CHAT.md; docs/API.md § Story chat). Registered ONLY through
// `registerAgenticRoutes`, so nothing answers when AI is off. The workspace resolves the `?workspace=`
// way (`resolveWorkspaceScope`); a chat id resolves only within (account, workspace, ticket).
//
//   GET    /api/story-chats?workspace=&ident=   the story's saved chats + the live agent       → read
//   GET    /api/story-chats/:id                 one chat's turns + the live agent               → read
//   POST   /api/story-chats/prepare             start / keep alive the story's agent (no model
//                                               call; git fetches of the PR heads)             → sync
//   POST   /api/story-chats/ask                 one question (a model run)                     → ai + ai_hourly
//   POST   /api/story-chats/:id/stop            stop the running answer                        → read
//   POST   /api/story-chats/close               close the story's live agent now               → read
//   DELETE /api/story-chats/:id                 delete a saved chat                            → read
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  STORY_CHAT_MAX_QUESTION,
  type StoryChatAskResponse,
  type StoryChatDetailResponse,
  type StoryChatListResponse,
  type StoryChatLive,
} from '@pierre-review/shared';
import { resolveWorkspaceScope } from '../db/queries.js';
import type { AgentContext } from '../review/agent-context.js';
import * as live from './live.js';
import * as store from './store.js';

const IDENT_MAX = 200;

function identOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.length <= IDENT_MAX ? v.trim() : null;
}
function intOf(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}
function bad(reply: FastifyReply, message: string): { error: string; message: string } {
  reply.status(400);
  return { error: 'bad_request', message };
}

export function registerStoryChatRoutes(app: FastifyInstance, ctx: AgentContext): void {
  void live.sweepAtBoot().catch((err) => app.log.warn({ err }, 'story chat: boot sweep failed'));
  app.addHook('onClose', async () => {
    await live.closeAll();
  });

  app.get('/api/story-chats', async (req, reply): Promise<StoryChatListResponse | { error: string; message: string }> => {
    const q = req.query as { workspace?: string; ident?: string };
    const ident = identOf(q.ident);
    if (!ident) return bad(reply, 'Send the ticket ident.');
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, intOf(q.workspace));
    return {
      workspaceId: scope.workspaceId,
      ident,
      chats: await store.listChats(accountId, scope.workspaceId, ident),
      live: live.liveOf(accountId, scope.workspaceId, ident),
    };
  });

  app.get('/api/story-chats/:id', async (req, reply): Promise<StoryChatDetailResponse | { error: string }> => {
    const id = intOf((req.params as { id: string }).id);
    const accountId = ctx.accountIdOf(req);
    const chat = id == null ? null : await store.chatById(accountId, id);
    if (!chat) {
      reply.status(404);
      return { error: 'not_found' };
    }
    return {
      chat,
      turns: await store.listTurns(accountId, chat.id),
      live: live.liveOf(accountId, chat.workspaceId, chat.ident),
    };
  });

  app.post('/api/story-chats/prepare', async (req, reply): Promise<{ live: StoryChatLive } | { error: string; message: string }> => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; ident?: unknown; chatId?: unknown };
    const ident = identOf(body.ident);
    if (!ident || intOf(body.workspaceId) == null) return bad(reply, 'Send a workspaceId and the ticket ident.');
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, intOf(body.workspaceId));
    const chatId = body.chatId == null ? null : intOf(body.chatId);
    if (chatId != null && !(await store.findChat(accountId, scope.workspaceId, ident, chatId))) {
      reply.status(404);
      return { error: 'not_found', message: 'No such chat for this story.' };
    }
    // Preparing runs in the background: the SPA polls the live state.
    void live.prepare(ctx, accountId, scope.workspaceId, ident, chatId).catch((err) => app.log.warn({ err }, 'story chat: prepare failed'));
    return { live: live.liveOf(accountId, scope.workspaceId, ident) };
  });

  app.post('/api/story-chats/ask', async (req, reply): Promise<StoryChatAskResponse | { error: string; message: string }> => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; ident?: unknown; chatId?: unknown; question?: unknown };
    const ident = identOf(body.ident);
    const question = typeof body.question === 'string' ? body.question.replace(/\u0000/g, '').trim() : '';
    if (!ident || intOf(body.workspaceId) == null || question === '' || question.length > STORY_CHAT_MAX_QUESTION) {
      return bad(reply, `Send a workspaceId, the ticket ident and a question of at most ${STORY_CHAT_MAX_QUESTION} characters.`);
    }
    const auth = ctx.llm.detectAuth('story_chat');
    if (auth.status !== 'ok') {
      reply.status(503);
      return { error: 'no_credential', message: auth.message ?? 'No AI sign-in found.' };
    }
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, intOf(body.workspaceId));
    const chatId = body.chatId == null ? null : intOf(body.chatId);
    if (chatId != null && !(await store.findChat(accountId, scope.workspaceId, ident, chatId))) {
      reply.status(404);
      return { error: 'not_found', message: 'No such chat for this story.' };
    }
    try {
      return await live.ask(ctx, accountId, scope.workspaceId, ident, chatId, question);
    } catch (err) {
      reply.status(err instanceof live.StoryChatBusyError ? 409 : 500);
      return { error: err instanceof live.StoryChatBusyError ? 'busy' : 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/story-chats/:id/stop', async (req, reply): Promise<{ stopped: boolean } | { error: string }> => {
    const id = intOf((req.params as { id: string }).id);
    const accountId = ctx.accountIdOf(req);
    if (id == null || !(await store.chatById(accountId, id))) {
      reply.status(404);
      return { error: 'not_found' };
    }
    return { stopped: await live.stop(accountId, id) };
  });

  app.post('/api/story-chats/close', async (req, reply): Promise<{ closed: true } | { error: string; message: string }> => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; ident?: unknown };
    const ident = identOf(body.ident);
    if (!ident || intOf(body.workspaceId) == null) return bad(reply, 'Send a workspaceId and the ticket ident.');
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, intOf(body.workspaceId));
    await live.closeFor(accountId, scope.workspaceId, ident);
    return { closed: true };
  });

  app.delete('/api/story-chats/:id', async (req, reply): Promise<{ deleted: true } | { error: string }> => {
    const id = intOf((req.params as { id: string }).id);
    const accountId = ctx.accountIdOf(req);
    const chat = id == null ? null : await store.chatById(accountId, id);
    if (!chat) {
      reply.status(404);
      return { error: 'not_found' };
    }
    const l = live.liveForChat(accountId, chat.id);
    if (l) await live.close(l);
    await store.deleteChat(accountId, chat.id);
    return { deleted: true };
  });
}
