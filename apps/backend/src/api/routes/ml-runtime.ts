import type { FastifyInstance } from 'fastify';
import type { MlInstallEvent } from '@pierre-review/shared';
import { config } from '../../config.js';
import { getMlStatus, installMl } from '../../ml/runtime.js';

// POST /api/ml/install — "Set up" for local bot-comment scoring: the pinned model runtime
// (onnxruntime-node + the tokenizer) and the severity model, downloaded into the data directory,
// progress streamed as SSE. ml/runtime.ts owns the work; this route only relays it.
//
// Registered only when `config.mlLocalEnabled` (false under LIMN_ML_DISABLED), and it refuses again
// on its own if ever reached with it switched off.
//
// ⚠ A POST: the disconnect signal is the REPLY socket, never `req.raw.on('close')`. A disconnect
// only unsubscribes — the download is single-flight, so a reload re-POSTs and joins it.
export async function mlRuntimeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/ml/install', async (_req, reply) => {
    if (!config.mlLocalEnabled) {
      return reply.code(404).send({ error: 'NotFound', message: 'Not available here.' });
    }
    const before = getMlStatus();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    const send = (e: MlInstallEvent): void => {
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

    if (before.state === 'ready') {
      send({ type: 'done' });
      finish();
      return;
    }
    const result = await installMl((p) => {
      if (p.phase === 'done' || p.phase === 'failed') return; // the terminal event is sent below
      send({ type: 'progress', phase: p.phase, message: p.message });
    });
    if (result.ok) send({ type: 'done' });
    else send({ type: 'error', message: result.message });
    finish();
  });
}
