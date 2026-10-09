import { useEffect } from 'react';
import type { ConflictAiResolution, ConflictSession } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { conflictAiRunActive, peekConflictAiRun, useConflictAiRun } from './useConflictAiResolve.js';
import { useConflictResolverStore } from '../store/conflictResolver.js';
import { claudePrefillPlan, useConflictClaudeStore } from '../store/conflictClaude.js';
import { seedEditLines } from '../components/conflicts/useRegionEdit.js';

/**
 * Apply "Resolve with Claude"'s answer to the open resolver, ONCE per run.
 *
 * ⚠ ONLY AN ANSWER FOR THIS EXACT SESSION. The answer names the server session and the pins it was
 * computed against; a different session (the head moved, the session expired and was rebuilt) is
 * a different model, and its decisions — `'edited'` handles above all — would not resolve. Then the
 * resolver simply opens bare.
 *
 * ⚠ ONE GET AT MOST, AND ONLY HERE. The overlay is a click away from any board, so this is the
 * resolver's own fetch, not a card's. It is skipped when the run store already holds the answer,
 * and entirely when the agentic features are off (the route does not exist in cloud).
 */
export function useClaudePrefill(prId: number, session: ConflictSession | null, key: string | null): void {
  const aiEnabled = useAiCapabilities().enabled;
  const setActiveKey = useConflictClaudeStore((s) => s.setActiveKey);

  useEffect(() => {
    setActiveKey(key);
    return () => setActiveKey(null);
  }, [key, setActiveKey]);

  const sessionId = session?.status === 'ready' ? session.sessionId : null;
  const modelHash = session?.modelHash ?? null;
  // ⚠ SUBSCRIBED, not peeked: the resolver may already be open on this session when the run
  // succeeds (the reopen toast, a second tab), and `openConflictResolver` on the same PR remounts
  // nothing — so the run's phase/runId must re-run the effect. The runId guard stops a double apply.
  const run = useConflictAiRun(prId);
  const runPhase = run?.phase ?? null;
  const runId = run?.resolution?.runId ?? null;
  // The resolver store's own session must be a dependency too, or an answer that arrives before
  // the store is seeded is dropped for good.
  const seeded = useConflictResolverStore((s) => key != null && s.sessions[key] != null);

  useEffect(() => {
    if (!aiEnabled || key == null || sessionId == null) return;
    let cancelled = false;
    const apply = (res: ConflictAiResolution | null): void => {
      if (cancelled || res == null || res.status !== 'succeeded') return;
      if (res.sessionId !== sessionId || res.modelHash !== modelHash) return;
      const claude = useConflictClaudeStore.getState();
      if (claude.runs[key]?.runId === res.runId) return; // applied already
      const resolver = useConflictResolverStore.getState();
      const stored = resolver.sessions[key];
      if (stored == null) return; // not seeded yet — `seeded` re-runs the effect when it is
      const plan = claudePrefillPlan(res, stored.decisions);
      seedEditLines(sessionId, plan.editLines);
      if (plan.decide.length > 0) {
        resolver.decideRegions({
          key,
          decisions: plan.decide.map((d) => ({
            fileIndex: d.fileIndex,
            regionId: d.regionId,
            decision: d.decision,
            editId: d.editId,
          })),
        });
      }
      claude.record({
        key,
        runId: res.runId,
        marks: plan.marks,
        decidableTotal: res.decidableTotal,
        summary: res.summary,
      });
    };
    const heldRun = peekConflictAiRun(prId);
    // A run still going here: wait — the subscription re-runs this effect when it settles.
    if (conflictAiRunActive(heldRun)) return;
    const held = heldRun?.resolution ?? null;
    if (held != null && held.sessionId === sessionId) {
      apply(held);
    } else {
      void api
        .conflictAiResolution(prId)
        .then((r) => apply(r.resolution))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [aiEnabled, key, sessionId, modelHash, prId, runPhase, runId, seeded]);
}
