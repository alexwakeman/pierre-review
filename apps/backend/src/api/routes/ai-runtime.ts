import type { FastifyInstance } from 'fastify';
import type { AiRuntimeInstallEvent } from '@pierre-review/shared';
import { config } from '../../config.js';
import { getAiRuntimeStatus, installAiRuntime } from '../../ai/runtime.js';

// POST /api/ai/runtime/install — "Set up AI": download the pinned AI runtime (the Agent SDK and its
// three peers, ~110 MB) into `<dataDir>/ai-runtime`, streaming npm's progress as SSE.
// ai/runtime.ts owns the work; this route only relays it.
//
// LOCAL ONLY, STRUCTURALLY: registered only when `config.aiEnabled` (which is false in cloud and
// under LIMN_AI_DISABLED), and it refuses again on its own if ever reached in cloud.
//
// ⚠ IT IS A POST, SO THE DISCONNECT SIGNAL IS THE REPLY SOCKET (`reply.raw`), never
// `req.raw.on('close')` — a POST's request `close` fires as soon as the body is read (CLAUDE.md,
// Conventions). And a disconnect only UNSUBSCRIBES: the download is single-flight and keeps going,
// so a reload re-POSTs and joins the same run instead of starting a second one.
export async function aiRuntimeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/ai/runtime/install', async (_req, reply) => {
    if (config.isCloud || !config.aiEnabled) {
      return reply.code(404).send({ error: 'NotFound', message: 'Not available here.' });
    }
    const before = getAiRuntimeStatus();

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
    if (before.runtime === 'ready') {
      send({ type: 'done', runtime: 'ready' });
      finish();
      return;
    }

    const result = await installAiRuntime((p) => {
      if (p.phase === 'done' || p.phase === 'failed') return; // the terminal event is sent below
      send({ type: 'progress', phase: p.phase, message: p.message });
    });
    if (result.ok) send({ type: 'done', runtime: 'ready' });
    else send({ type: 'error', message: result.message });
    finish();
  });
}
