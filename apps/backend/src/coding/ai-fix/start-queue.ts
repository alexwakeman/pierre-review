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
//   • ONE TICKET AT A TIME (ticket-line.ts). A fix whose ticket has a fix RUNNING of a PR it reads at its head
//     waits here too, even with a slot free: the pump SKIPS it (those behind it may start) and tries it again when
//     that fix leaves running (`releaseTicketLine` pumps). A DIRECT start of a PR whose ticket already has an entry
//     waiting goes in line behind it (`sameTicketWaiting`); the queue's own starts (`queuedPlaceOf`) keep their
//     place when they have to wait again. The order among waiting fixes is the same. A reader's "Start now"
//     (`startQueuedNow`) starts a press at once against what the siblings have now; auto fixes always wait.
//   • IN MEMORY. A restart drops the line: an auto fix is asked again by the auto fix queue's sweep within
//     a minute; a reader presses Start again (the AI Fix tab no longer says it waits).
// Positions are pushed to the PR's fix stream (`waiting`), so the AI Fix tab and the toast follow them.
import type { AiFixTrigger, AiFixWaiting } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { emitFixStream } from './stream.js';
import { ticketLineBlocker } from './ticket-line.js';

export const FIX_START_QUEUE_MAX = 50;

export interface QueuedStart {
  accountId: number;
  prId: number;
  trigger: AiFixTrigger;
  queuedAt: number;
  /** A reader's press: the start to run again (the manager's own input). An auto entry has none. */
  run?: () => Promise<{ status: string }>;
  /** A reader's press: the same start, past the per-ticket line ("Start now"). */
  runNow?: () => Promise<{ status: string }>;
  /** The PRs of its ticket this fix would READ at their head (ticket-line.ts). Absent ⇒ never ticket-blocked. */
  reads?: readonly number[];
  /** Every other PR of its ticket: a direct start of one of them goes in line behind this entry. */
  sameTicket?: readonly number[];
  /** A "Start now" start that lost the race for a slot: it waits for the slot only, never for the ticket. */
  skipLine?: boolean;
  /** The start route's words for its refusals (Start now answers with them). */
  meta?: { include: boolean; ciOnly: boolean };
}

/** `${accountId}:${prId}` → the place (queuedAt) of an entry whose start the queue runs NOW (pump, Start now). */
const runningFromQueue = new Map<string, number>();
const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;

/**
 * Is this start run BY THE QUEUE (the pump or Start now)? Its place (queuedAt) then, so a start that has to wait
 * again keeps it; null for a direct start (a press, the auto sweep).
 */
export function queuedPlaceOf(accountId: number, prId: number): number | null {
  return runningFromQueue.get(keyOf(accountId, prId)) ?? null;
}

/**
 * NO JUMPING THE LINE: does an entry of the same ticket already wait (either side's ticket list)? A DIRECT start then
 * goes in line behind it (presses first, oldest first) instead of racing for the ticket line. Pure read.
 */
export function sameTicketWaiting(accountId: number, prId: number, sameTicket: readonly number[]): boolean {
  const mine = new Set(sameTicket);
  return queue.some((e) => e.accountId === accountId && e.prId !== prId && (mine.has(e.prId) || (e.sameTicket ?? []).includes(prId)));
}

async function runFromQueue<T>(e: QueuedStart, fn: () => Promise<T>): Promise<T> {
  const k = keyOf(e.accountId, e.prId);
  runningFromQueue.set(k, e.queuedAt);
  try {
    return await fn();
  } finally {
    if (runningFromQueue.get(k) === e.queuedAt) runningFromQueue.delete(k);
  }
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

/** The running fix of the same ticket this entry waits for, or null (ticket-line.ts). */
function blockerOf(e: QueuedStart): { prId: number; number: number } | null {
  if (e.skipLine === true || e.reads == null || e.reads.length === 0) return null;
  return ticketLineBlocker(e.accountId, e.prId, e.reads);
}

function waitingOf(e: QueuedStart, position: number): AiFixWaiting {
  const b = blockerOf(e);
  return { position, queuedAt: new Date(e.queuedAt).toISOString(), trigger: e.trigger, blockedBy: b != null ? { prNumber: b.number } : null };
}

/** The PR's place in line (1 = next), or null. Account-checked. */
export function startWaitingFor(accountId: number, prId: number): AiFixWaiting | null {
  const list = sorted();
  const i = list.findIndex((e) => e.prId === prId && e.accountId === accountId);
  if (i < 0) return null;
  return waitingOf(list[i]!, i + 1);
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
      waiting: waitingOf(e, i + 1),
    });
  }
}

/**
 * Put a start in line. A reader's press replaces the PR's waiting auto entry (keeping its place); a
 * second entry of the same kind replaces the first's `run` (the newest press wins). An entry the queue itself
 * ran that has to wait again passes its `queuedAt` and KEEPS ITS PLACE. Returns the place, or null when the
 * line is full.
 */
export function enqueueStart(e: Omit<QueuedStart, 'queuedAt'> & { queuedAt?: number | null }, nowMs: number = Date.now()): AiFixWaiting | null {
  const placeAt = e.queuedAt ?? nowMs;
  const at = queue.findIndex((x) => x.prId === e.prId && x.accountId === e.accountId);
  if (at >= 0) {
    const prev = queue[at]!;
    // An auto entry never replaces a reader's.
    if (prev.trigger === 'manual' && e.trigger === 'auto') return startWaitingFor(e.accountId, e.prId);
    queue[at] = { ...e, queuedAt: Math.min(prev.queuedAt, placeAt) };
  } else {
    if (queue.length >= FIX_START_QUEUE_MAX) return null;
    queue.push({ ...e, queuedAt: placeAt });
  }
  announce();
  // A slot may already be free (a race lost by a hair): try now.
  pumpStartQueue();
  return startWaitingFor(e.accountId, e.prId);
}

/**
 * "START NOW" (a reader's press waiting behind a fix of the same ticket): run it at once against what the
 * siblings have now. Only a press: an auto fix always waits (`{refused: 'auto'}`). null when nothing waits for
 * this PR; otherwise the start's own answer (it may still wait for a free sandbox — then for the slot only, and
 * in its old place) and the start route's words.
 */
export async function startQueuedNow(
  accountId: number,
  prId: number,
): Promise<{ status: string; meta: QueuedStart['meta'] | null } | { refused: 'auto'; blockedBy: number | null } | null> {
  const at = queue.findIndex((x) => x.prId === prId && x.accountId === accountId);
  const e = at >= 0 ? queue[at]! : null;
  if (e == null) return null;
  if (e.trigger !== 'manual' || e.runNow == null) return { refused: 'auto', blockedBy: blockerOf(e)?.number ?? null };
  queue.splice(at, 1);
  announce();
  let out: { status: string };
  try {
    out = await runFromQueue(e, e.runNow);
  } catch {
    out = { status: 'failed' };
  }
  if (out.status !== 'queued' && out.status !== 'waiting') emitFixStream(prId, { type: 'done', status: 'idle', fixId: null });
  return { ...out, meta: e.meta ?? null };
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
      // Each entry is tried at most once per pass: a start that finds itself ticket-blocked after all (its
      // siblings changed meanwhile) goes back in line and must not be picked again in the same pass.
      const tried = new Set<QueuedStart>();
      const ready = (): QueuedStart | undefined => sorted().find((e) => !tried.has(e) && blockerOf(e) == null);
      for (let next = ready(); next != null && slotFree(); next = ready()) {
        tried.add(next);
        queue.splice(queue.indexOf(next), 1);
        let status = 'failed';
        try {
          const cur = next;
          if (cur.run) status = (await runFromQueue(cur, cur.run)).status;
          else if (pumpCtx) {
            const ctx = pumpCtx;
            const { evaluateAutoFix } = await import('./auto-fix-queue.js');
            const s = await runFromQueue(cur, () => evaluateAutoFix(ctx, { accountId: cur.accountId, prId: cur.prId, cause: 'sweep' }));
            // Back in line (a sandbox, or the same ticket's running fix): it waits — never "ended".
            status = s?.status === 'started' ? 'queued' : s?.reason === 'sandbox_busy' || s?.reason === 'ticket_fix_running' ? 'waiting' : 'ended';
          }
        } catch {
          status = 'failed';
        }
        // Lost the race for the slot: back to the FRONT (keeps its place), and wait for the next free slot.
        if (status === 'too_many' || status === 'build_busy') {
          queue.unshift(next);
          break;
        }
        // Re-queued by its own start (waiting again): the new entry is a new object; skip it this pass too.
        for (const e of queue) if (e.prId === next.prId && e.accountId === next.accountId) tried.add(e);
        // Started (its own events follow), or it waits again (the start put it back), or nothing to do now.
        if (status !== 'queued' && status !== 'waiting') emitFixStream(next.prId, { type: 'done', status: 'idle', fixId: null });
      }
      // Still waiting and no slot: an idle fix session may make room (its close frees a slot and pumps
      // again); otherwise look again shortly. A ticket-blocked entry waits for its sibling's fix instead (the
      // release pumps), so only an entry that could start counts here.
      if (queue.some((e) => blockerOf(e) == null) && !slotFree()) {
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
  runningFromQueue.clear();
}
