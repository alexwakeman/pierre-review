import type { FastifyInstance } from 'fastify';
import type { AiRuntimeInstallBody, AiRuntimeInstallEvent, AiRuntimeRemoveBody, AiRuntimeRemoveResponse } from '@pierre-review/shared';
import { config } from '../../config.js';
import { getAiRuntimeStatus, getCodexRuntimeStatus, installAiRuntime, removeAiRuntime } from '../../ai/runtime.js';

// POST /api/ai/runtime/install — "Set up AI": download the pinned AI runtime (the Agent SDK and its
// three peers, ~110 MB) into `<dataDir>/ai-runtime`, streaming npm's progress as SSE.
// ai/runtime.ts owns the work; this route only relays it.
//
// Registered only when `config.aiEnabled` (false under LIMN_AI_DISABLED), and it refuses again on
// its own if ever reached with AI switched off.
//
// ⚠ IT IS A POST, SO THE DISCONNECT SIGNAL IS THE REPLY SOCKET (`reply.raw`), never
// `req.raw.on('close')` — a POST's request `close` fires as soon as the body is read (CLAUDE.md,
// Conventions). And a disconnect only UNSUBSCRIBES: the download is single-flight and keeps going,
// so a reload re-POSTs and joins the same run instead of starting a second one.
export async function aiRuntimeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/ai/runtime/install', async (req, reply) => {
    if (!config.aiEnabled) {
      return reply.code(404).send({ error: 'NotFound', message: 'Not available here.' });
    }
    // Optional body `{ provider }` names the ONE agent to download and records it as picked (Settings →
    // AI); absent ⇒ Claude. The shared packages come with either. Anything else in the body is ignored;
    // an unknown provider is refused before a byte is downloaded.
    const body = (req.body ?? {}) as AiRuntimeInstallBody;
    const provider = body.provider ?? 'claude';
    if (provider !== 'claude' && provider !== 'codex') {
      return reply.code(400).send({ error: 'BadRequest', message: 'provider must be claude or codex.' });
    }
    // Ready AND picked (a provider the reader did not pick reads 'absent', so a press picks it).
    const alreadyReady = (provider === 'codex' ? getCodexRuntimeStatus() : getAiRuntimeStatus()).runtime === 'ready';

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    const send = (e: AiRuntimeInstallEvent): void => {
      if (open && !raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const hb = setInterval(() => {
      if (open && !raw.writableEnded) raw.write(': hb\n\n');
    }, 15_000);
    const finish = (): void => {
      if (!open) return;
      open = false;
      clearInterval(hb);
      if (!raw.writableEnded) raw.end();
    };
    raw.on('close', () => {
      open = false;
      clearInterval(hb);
    });

    // Already there (a second tab, or the workspace's own SDK in dev): say so and stop.
    if (alreadyReady) {
      send({ type: 'done', runtime: 'ready' });
      finish();
      return;
    }

    const result = await installAiRuntime(
      (p) => {
        if (p.phase === 'done' || p.phase === 'failed') return; // the terminal event is sent below
        send({ type: 'progress', phase: p.phase, message: p.message });
      },
      { providers: [provider], skipIfReady: true },
    );
    if (result.ok) send({ type: 'done', runtime: 'ready' });
    else send({ type: 'error', message: result.message });
    finish();
  });

  // POST /api/ai/runtime/remove {provider} — Settings → AI's Remove: the agent is no longer picked (every
  // gate then reads it as not downloaded) and its own files are deleted (ai/runtime.ts `remove`). Local
  // disk only: no model, no GitHub. Refused (409) while a download runs.
  app.post('/api/ai/runtime/remove', async (req, reply) => {
    if (!config.aiEnabled) {
      return reply.code(404).send({ error: 'NotFound', message: 'Not available here.' });
    }
    const provider = ((req.body ?? {}) as Partial<AiRuntimeRemoveBody>).provider;
    if (provider !== 'claude' && provider !== 'codex') {
      return reply.code(400).send({ error: 'BadRequest', message: 'provider must be claude or codex.' });
    }
    const result = removeAiRuntime(provider);
    if (!result.ok) return reply.code(409).send({ error: 'Conflict', message: result.message });
    const status = provider === 'codex' ? getCodexRuntimeStatus() : getAiRuntimeStatus();
    const body: AiRuntimeRemoveResponse = { provider, runtime: status.runtime };
    return body;
  });
}
