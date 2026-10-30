import { and, eq, notInArray } from 'drizzle-orm';
import type { StoryBuildProgress } from '@pierre-review/shared';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import type { AgentContext } from '../../review/agent-context.js';
import { pumpReviewLane, registerReviewSlotPeer, reviewLaneWaiting, reviewSlotFree } from '../../review/claude-review/manager.js';
import { BUILD_DOCS_TEXT } from './docs.js';
import { getStoryBuildRow, updateStoryBuild } from './persist.js';
import { storyBuildDeps } from './seams.js';

// THE DOCS CONSIDERATION'S QUEUE (WP3; docs/STORY-BUILD.md § Docs consideration). Every run is a CLICK
// (`POST …/docs`) or the session manager's own start after a plan (`wantDocs`) — never on view.
//
//   CLAIM   per SESSION: at most one docs run queued-or-running, claimed SYNCHRONOUSLY (before any await)
//           so two clicks cannot both start one; `docs_status = 'running'` is written next.
//   LANE    one FIFO, at most LANE_MAX waiting (more ⇒ 'busy', the route's 409 Busy).
//   SLOTS   a READ-ONLY pass, so it shares the ONE review concurrency as a registered PEER (like the story
//           docs check): it starts only when a slot is free and no PR-review CLICK is waiting.
//   NEVER STUCK  a run that throws, times out or ends without writing an outcome is stored `failed`; a
//           restart fails every `running` row (`reconcileStoryBuildDocsOnStartup`).
//   PROGRESS  `onStoryBuildDocsProgress` — the session manager (WP1) subscribes once and forwards each
//           event to the session's SSE emitter; the phase is also on the row (the SPA's 2 s poll).

const LANE_MAX = 10;
/** Wall-clock cap on one docs run (a wedged read must not hold the claim and a review slot). */
export const STORY_BUILD_DOCS_TIMEOUT_MS = 10 * 60_000;

interface Job {
  ctx: AgentContext;
  accountId: number;
  buildId: number;
  force: boolean;
  controller: AbortController;
}

const claimed = new Map<number, Job>();
const lane: Job[] = [];
const running = new Set<number>();
/** A docs run's event: a step, or its end (refetch the session: the outcome is on the row). */
export type StoryBuildDocsEvent = { kind: 'progress'; progress: StoryBuildProgress } | { kind: 'done' };
const listeners = new Set<(buildId: number, e: StoryBuildDocsEvent) => void>();

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

/** Subscribe to every docs run's progress (the session manager forwards it to its SSE). Returns the
 *  unsubscribe. */
export function onStoryBuildDocsProgress(fn: (buildId: number, e: StoryBuildDocsEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(buildId: number, e: StoryBuildDocsEvent): void {
  for (const fn of listeners) {
    try {
      fn(buildId, e);
    } catch {
      /* a listener never breaks the run */
    }
  }
}

/** Is a docs run of this session queued or running in this process? */
export function storyBuildDocsHeld(buildId: number): boolean {
  return claimed.has(buildId);
}

export type StartBuildDocsResult = { outcome: 'started' } | { outcome: 'already_running' } | { outcome: 'busy' };

/**
 * Queue a docs run for a session in `plan_ready` (the CALLER checks the session's state, the library and
 * the budget — routes-docs.ts, or the manager after a plan). Claims synchronously; writes `running`.
 */
export async function startStoryBuildDocs(
  ctx: AgentContext,
  a: { accountId: number; buildId: number; force: boolean },
): Promise<StartBuildDocsResult> {
  if (claimed.has(a.buildId)) return { outcome: 'already_running' };
  if (lane.length >= LANE_MAX) return { outcome: 'busy' };
  const job: Job = { ctx, accountId: a.accountId, buildId: a.buildId, force: a.force, controller: new AbortController() };
  claimed.set(a.buildId, job); // reserve synchronously, before any await
  try {
    const ok = await updateStoryBuild(ctx, a.accountId, a.buildId, { docsStatus: 'running', docsError: null, wantDocs: true });
    if (!ok) {
      claimed.delete(a.buildId);
      return { outcome: 'already_running' };
    }
  } catch (err) {
    claimed.delete(a.buildId);
    throw err;
  }
  emit(a.buildId, { kind: 'progress', progress: { phase: 'docs_shortlisting' } });
  lane.push(job);
  pump();
  return { outcome: 'started' };
}

/** Stop this session's docs run (Cancel / Discard / Accept): a queued one never starts, a running one is
 *  aborted. Its row reads `failed` "Stopped." Returns whether there was one. */
export function abortStoryBuildDocs(buildId: number): boolean {
  const job = claimed.get(buildId);
  if (job == null) return false;
  job.controller.abort();
  const at = lane.indexOf(job);
  if (at >= 0) {
    lane.splice(at, 1);
    claimed.delete(buildId);
    void markFailed(job, BUILD_DOCS_TEXT.stopped);
  }
  return true;
}

function pump(): void {
  while (lane.length > 0 && reviewSlotFree() && !reviewLaneWaiting().manual) launch(lane.shift()!);
}

async function markFailed(job: Job, sentence: string): Promise<void> {
  const row = await getStoryBuildRow(job.ctx, job.accountId, job.buildId).catch(() => null);
  if (row == null || row.docsStatus !== 'running') return;
  await updateStoryBuild(job.ctx, job.accountId, job.buildId, { docsStatus: 'failed', docsError: sentence }).catch(() => {});
}

function launch(job: Job): void {
  const { ctx, buildId, accountId, controller } = job;
  running.add(buildId);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, STORY_BUILD_DOCS_TIMEOUT_MS);
  void storyBuildDeps()
    .runBuildDocs(ctx, { accountId, buildId, force: job.force, onProgress: (p) => emit(buildId, { kind: 'progress', progress: p }), signal: controller.signal })
    .catch((err) => {
      ctx.log.warn(`story build ${buildId} docs failed: ${err instanceof Error ? err.message : String(err)}`);
      return markFailed(job, err instanceof AiRuntimeMissingError ? err.message : 'Weighing the docs failed. Run it again.');
    })
    // An implementation that ended without storing an outcome is never left `running`.
    .then(() => markFailed(job, BUILD_DOCS_TEXT.stopped))
    .then(async () => {
      if (!timedOut) return;
      const row = await getStoryBuildRow(ctx, accountId, buildId).catch(() => null);
      if (row?.docsStatus === 'failed') await updateStoryBuild(ctx, accountId, buildId, { docsError: BUILD_DOCS_TEXT.tooLong }).catch(() => {});
    })
    .finally(() => {
      clearTimeout(timer);
      running.delete(buildId);
      claimed.delete(buildId);
      emit(buildId, { kind: 'done' });
      pump();
      pumpReviewLane();
    });
}

/** Boot: every docs run a restart cut off reads `failed` (never stuck on "running"). */
export async function reconcileStoryBuildDocsOnStartup(ctx: Pick<AgentContext, 'db' | 'schema' | 'log'>): Promise<number> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const b = (ctx.schema as any).storyBuilds;
  // Only rows no run of THIS process holds (none at boot; a test may register the routes mid-run).
  const held = [...claimed.keys()];
  const rows = (await ctx.db
    .update(b)
    .set({ docsStatus: 'failed', docsError: BUILD_DOCS_TEXT.restarted })
    .where(held.length > 0 ? and(eq(b.docsStatus, 'running'), notInArray(b.id, held)) : eq(b.docsStatus, 'running'))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  if (rows.length > 0) ctx.log.info(`reconciled ${rows.length} story build docs run(s) -> failed`);
  return rows.length;
}

/** Test seam: wait until nothing is queued or running. */
export async function _storyBuildDocsIdleForTest(timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((lane.length > 0 || running.size > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}
