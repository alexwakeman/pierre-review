// Replays a recorded (or simulated) server-sent-event stream as a fetch Response, so the SPA's
// `sseStream` (api/sse.ts) reads it exactly as it reads the real server: `data: <json>\n\n` frames
// on a `text/event-stream` body, one frame per tick, closed after the last one.

import type { RecordedStreamFrame } from './recording.js';

export interface StreamOptions {
  signal?: AbortSignal | null;
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
}

export function encodeFrame(frame: RecordedStreamFrame): string {
  const event = frame.event && frame.event !== 'message' ? `event: ${frame.event}\n` : '';
  return `${event}data: ${JSON.stringify(frame.data)}\n\n`;
}

export function sseResponse(frames: readonly RecordedStreamFrame[], opts: StreamOptions = {}): Response {
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const encoder = new TextEncoder();
  let i = 0;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const fail = (): void => {
        if (closed) return;
        closed = true;
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (opts.signal?.aborted) {
        fail();
        return;
      }
      opts.signal?.addEventListener('abort', fail, { once: true });
      const next = (): void => {
        if (closed) return;
        const frame = frames[i];
        if (!frame) {
          close();
          return;
        }
        schedule(() => {
          if (closed) return;
          controller.enqueue(encoder.encode(encodeFrame(frame)));
          i += 1;
          next();
        }, Math.max(0, frame.delayMs));
      };
      next();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}
