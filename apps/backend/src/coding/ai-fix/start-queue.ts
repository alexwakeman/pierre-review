// THE FIX START QUEUE (docs/CLAUDE-REVIEW.md § AI Fix → The fix start queue, 2026-11-12). Up to
// LIMN_SANDBOX_MAX_BUILDS fixes build at once (default 3; sandbox/session/limits.ts). A fix that finds every
// slot taken — a reader's press or an auto fix — WAITS HERE instead of being refused, and starts the moment
// a slot frees (`onSessionSlotFreed`), with no further press.
//
//   • ONE ENTRY PER PR. A reader's press replaces a waiting auto fix of the same PR (and keeps its place).
//   • ORDER: people's presses first, then auto fixes; each oldest first.
//   • RE-VALIDATED AT ITS TURN. A reader's entry runs the SAME start again (`startRun`: the seed is built
//     then, from the stored review and the CI review at the PR's CURRENT head). An auto entry asks THE AUTO
//     FIX QUEUE again (`evaluateAutoFix`): a newer review, a new head, a fix pushed meanwhile — what still
//     needs fixing then is what starts, or nothing.
//   • ONE START AT A TIME (`pumping`): a start awaits its seed and GitHub before it reserves its slot, so
//     several at once would race for the same slots. A start that still finds no slot goes back to the FRONT.
//   • ROOM. A slot is a build slot AND an open sandbox. Auto fixes close their sandbox after their turn; a
//     reader's fix session stays open for follow-ups. When every sandbox is open and a fix waits, the
//     longest-idle FIX session (idle ≥ LIMN_SANDBOX_RECLAIM_IDLE_SECONDS, 60 s) is closed with its work kept
//     (Resume goes on) — never a story session; nothing idle yet ⇒ look again every START_QUEUE_RETRY_MS.
//   • IN MEMORY. A restart drops the line: an auto fix is asked again by the auto fix queue's sweep within
//     a minute; a reader presses Start again (the AI Fix tab no longer says it waits).
// Positions are pushed to the PR's fix stream (`waiting`), so the AI Fix tab and the toast follow them.
import type { AiFixTrigger, AiFixWaiting } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { emitFixStream } from './stream.js';

export const FIX_START_QUEUE_MAX = 50;

export interface QueuedStart {
  accountId: number;
  prId: number;
  trigger: AiFixTrigger;
  queuedAt: number;
  /** A reader's press: the start to run again (the manager's own input). An auto entry has none. */
  run?: () => Promise<{ status: string }>;
}

const queue: QueuedStart[] = [];
let pumping = false;
/** A pump was asked for while one ran (a slot freed meanwhile): run again when it ends, never drop it. */
let again = false;
let pumpCtx: AgentContext | null = null;
/** Is there a slot now (the session manager's own rule, registered by the AI Fix manager)? */
let slotFree: () => boolean = () => true;
/** Every sandbox open and a fix waiting: close the longest-idle FIX session, its work kept (manager.ts). */
let reclaim: () => Promise<boolean> = async () => false;
/** While something waits and nothing frees: look again (a session may become idle long enough). */
export const START_QUEUE_RETRY_MS = 30_000;
let retry: ReturnType<typeof setTimeout> | null = null;

export function bindStartQueue(o: { ctx?: AgentContext; slotFree?: () => boolean; reclaim?: () => Promise<boolean> }): void {
  if (o.ctx) pumpCtx = o.ctx;
  if (o.slotFree) slotFree = o.slotFree;
  if (o.reclaim) reclaim = o.reclaim;
}

const rank = (e: QueuedStart): number => (e.trigger === 'manual' ? 0 : 1);
function sorted(): QueuedStart[] {
  return [...queue].sort((a, b) => rank(a) - rank(b) || a.queuedAt - b.queuedAt);
}

/** The PR's place in line (1 = next), or null. Account-checked. */
export function startWaitingFor(accountId: number, prId: number): AiFixWaiting | null {
  const list = sorted();
  const i = list.findIndex((e) => e.prId === prId && e.accountId === accountId);
  if (i < 0) return null;
  const e = list[i]!;
  return { position: i + 1, queuedAt: new Date(e.queuedAt).toISOString(), trigger: e.trigger };
}

export function startQueueLength(): number {
  return queue.length;
}

/** Tell every waiting PR's stream where it stands now. */
function announce(): void {
  for (const [i, e] of sorted().entries()) {
    emitFixStream(e.prId, {
      type: 'progress',
      status: 'queued',
      fixId: null,
      progress: null,
      waiting: { position: i + 1, queuedAt: new Date(e.queuedAt).toISOString(), trigger: e.trigger },
    });
  }
}

/**
 * Put a start in line. A reader's press replaces the PR's waiting auto entry (keeping its place); a
 * second entry of the same kind replaces the first's `run` (the newest press wins). Returns the place,
 * or null when the line is full.
 */
export function enqueueStart(e: Omit<QueuedStart, 'queuedAt'>, nowMs: number = Date.now()): AiFixWaiting | null {
  const at = queue.findIndex((x) => x.prId === e.prId && x.accountId === e.accountId);
  if (at >= 0) {
    const prev = queue[at]!;
    // An auto entry never replaces a reader's.
    if (prev.trigger === 'manual' && e.trigger === 'auto') return startWaitingFor(e.accountId, e.prId);
    queue[at] = { ...e, queuedAt: prev.queuedAt };
  } else {
    if (queue.length >= FIX_START_QUEUE_MAX) return null;
    queue.push({ ...e, queuedAt: nowMs });
  }
  announce();
  // A slot may already be free (a race lost by a hair): try now.
  pumpStartQueue();
  return startWaitingFor(e.accountId, e.prId);
}

/** Drop a PR's waiting start (the reader's Cancel). True when there was one. */
export function cancelQueuedStart(accountId: number, prId: number): boolean {
  const at = queue.findIndex((x) => x.prId === prId && x.accountId === accountId);
  if (at < 0) return false;
  queue.splice(at, 1);
  emitFixStream(prId, { type: 'done', status: 'idle', fixId: null });
  announce();
  return true;
}

/**
 * Start what waits, one at a time, while a slot is free. Called whenever a slot frees, after every enqueue,
 * and by the auto fix queue's sweep (a missed signal). Never throws.
 */
export function pumpStartQueue(): void {
  if (queue.length === 0) return;
  if (pumping) {
    again = true;
    return;
  }
  pumping = true;
  again = false;
  void (async () => {
    try {
      while (queue.length > 0 && slotFree()) {
        const next = sorted()[0]!;
        queue.splice(queue.indexOf(next), 1);
        let status = 'failed';
        try {
          if (next.run) status = (await next.run()).status;
          else if (pumpCtx) {
            const { evaluateAutoFix } = await import('./auto-fix-queue.js');
            const s = await evaluateAutoFix(pumpCtx, { accountId: next.accountId, prId: next.prId, cause: 'sweep' });
            status = s?.status === 'started' ? 'queued' : s?.reason === 'sandbox_busy' ? 'waiting' : 'ended';
          }
        } catch {
          status = 'failed';
        }
        // Lost the race for the slot: back to the FRONT (keeps its place), and wait for the next free slot.
        if (status === 'too_many' || status === 'build_busy') {
          queue.unshift(next);
          break;
        }
        // Started (its own events follow), or it waits again (the start put it back), or nothing to do now.
        if (status !== 'queued' && status !== 'waiting') emitFixStream(next.prId, { type: 'done', status: 'idle', fixId: null });
      }
      // Still waiting and no slot: an idle fix session may make room (its close frees a slot and pumps
      // again); otherwise look again shortly.
      if (queue.length > 0 && !slotFree()) {
        const freed = await reclaim().catch(() => false);
        if (!freed && retry == null) {
          retry = setTimeout(() => {
            retry = null;
            pumpStartQueue();
          }, START_QUEUE_RETRY_MS);
          retry.unref?.();
        }
      }
    } finally {
      pumping = false;
      announce();
      if (again) {
        again = false;
        pumpStartQueue();
      }
    }
  })();
}

/** Test hook. */
export function _resetStartQueueForTest(): void {
  queue.length = 0;
  pumping = false;
  again = false;
  if (retry) clearTimeout(retry);
  retry = null;
  reclaim = async () => false;
}
