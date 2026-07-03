import { ApiError } from './client.js';

export interface SseOptions<E> {
  method?: string;
  /** JSON-serializable body; sent as application/json when present. */
  body?: unknown;
  /** Aborts the underlying fetch — close the stream by aborting this. */
  signal?: AbortSignal;
  /** Called once per parsed `data:` event with the decoded JSON payload. */
  onEvent: (event: E) => void;
}

// Consume a Server-Sent-Events response over `fetch` (rather than `EventSource`)
// so we can POST, carry the session cookie, and abort cleanly — EventSource does
// none of those. The server emits `data: <json>\n\n` frames (plus `: heartbeat`
// comment lines, which we ignore). Resolves when the stream ends; rejects on a
// non-OK response or a network error (an abort throws AbortError, which callers
// treat as a normal close).
export async function sseStream<E>(url: string, opts: SseOptions<E>): Promise<void> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      Accept: 'text/event-stream',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (!res.body) throw new ApiError(res.status, 'stream has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const flush = (block: string): void => {
    // A block is one SSE frame; join its `data:` lines, ignore comments/other fields.
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    try {
      opts.onEvent(JSON.parse(dataLines.join('\n')) as E);
    } catch {
      /* skip a malformed frame rather than tearing down the stream */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalize CRLF so frame-splitting on \n\n is robust.
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        flush(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim()) flush(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
