// The AI Fix tab's per-PR progress stream (`GET /api/pro/prs/:id/ai-fix/stream`, AiFixStreamEvent). Fed by
// the fix session (sandbox/session/fix.ts) — its phases map to the old progress words, so the AiFixBanner
// and the Open PRs "Fixing…" pill need no change. In-process pub/sub, keyed by PR id; the route checks
// ownership before it subscribes.
import type { AiFixStreamEvent } from '@pierre-review/shared';

const subs = new Map<number, Set<(e: AiFixStreamEvent) => void>>();

export function subscribeFixStream(prId: number, cb: (e: AiFixStreamEvent) => void): () => void {
  let set = subs.get(prId);
  if (!set) {
    set = new Set();
    subs.set(prId, set);
  }
  set.add(cb);
  return () => {
    const s = subs.get(prId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subs.delete(prId);
  };
}

export function emitFixStream(prId: number, e: AiFixStreamEvent): void {
  const set = subs.get(prId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(e);
    } catch {
      /* a broken subscriber must not break the run */
    }
  }
}
