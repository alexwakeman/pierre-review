import { useQuery } from '@tanstack/react-query';
import type { ClaudeThreadJudgementsForPr } from '@pierre-review/shared';
import { CLAUDE_REVIEW_STATES_MAX_IDS } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';

// What the latest Claude review said about each review thread, for the THREAD CARDS.
//
// ONE request for every PR on screen: each ThreadCard asks for its PR's entry through an ordinary
// per-PR React Query, whose query function drops the PR id into a shared queue; everything queued
// in one tick is flushed as ONE `POST /api/claude-review/thread-judgements` (the useReactions
// mechanism). The Feed and Pending span many PRs, so a per-PR GET would be one request per card
// group — exactly the fetch-on-mount storm the board rules forbid.
//
// The key sits UNDER `['claude-review', prId]` on purpose: every place that invalidates a PR's
// review read (a run finishing, the PR's head moving) refreshes this too, with no second list of
// invalidations to keep in step.
//
// Gated on `me.ai.enabled` (no agentic routes register under LIMN_AI_DISABLED): off ⇒ no request, no marker.

export function claudeThreadJudgementsKey(prId: number): unknown[] {
  return ['claude-review', prId, 'thread-judgements'];
}

interface Waiter {
  resolve: (v: ClaudeThreadJudgementsForPr | null) => void;
  reject: (err: unknown) => void;
}

const pending = new Map<number, Waiter[]>();
let scheduled = false;

async function dispatch(entries: Array<[number, Waiter[]]>): Promise<void> {
  try {
    const res = await api.claudeThreadJudgements(entries.map(([id]) => id));
    const byPr = new Map(res.prs.map((p) => [p.prId, p]));
    for (const [id, waiters] of entries) {
      const hit = byPr.get(id) ?? null;
      for (const w of waiters) w.resolve(hit);
    }
  } catch (err) {
    for (const [, waiters] of entries) for (const w of waiters) w.reject(err);
  }
}

function flush(): void {
  scheduled = false;
  if (pending.size === 0) return;
  const entries = [...pending.entries()];
  pending.clear();
  for (let i = 0; i < entries.length; i += CLAUDE_REVIEW_STATES_MAX_IDS) {
    void dispatch(entries.slice(i, i + CLAUDE_REVIEW_STATES_MAX_IDS));
  }
}

/** Register one PR and get its entry when the batch lands (null = no judged run). Exported for tests. */
export function loadClaudeThreadJudgements(prId: number): Promise<ClaudeThreadJudgementsForPr | null> {
  return new Promise((resolve, reject) => {
    const waiters = pending.get(prId);
    if (waiters) {
      waiters.push({ resolve, reject });
      return;
    }
    pending.set(prId, [{ resolve, reject }]);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });
}

/**
 * This PR's judgements, or `undefined` while unknown / off / failed. A thread card treats
 * `undefined` and `null` alike: it keeps its own pills.
 */
export function useClaudeThreadJudgements(
  prId: number | null,
): ClaudeThreadJudgementsForPr | null | undefined {
  const enabled = useAiCapabilities().enabled && prId != null;
  const q = useQuery<ClaudeThreadJudgementsForPr | null>({
    queryKey: claudeThreadJudgementsKey(prId ?? -1),
    queryFn: () => loadClaudeThreadJudgements(prId as number),
    enabled,
    // DB-only and refreshed by the review's own invalidations (see the key), so a remount inside
    // the window is served from cache.
    staleTime: 60_000,
    // A failed batch must not become a retry per card; the card just keeps its own pills.
    retry: false,
  });
  return enabled ? q.data : undefined;
}
