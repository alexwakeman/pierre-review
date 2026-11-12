// THE BUILDS TOAST (docs/STORY-BUILD.md § The builds toast; docs/FRONTEND.md). One circle in the ONE toast
// cluster while any Implement / Fill gaps build of the workspace is RUNNING (a progress ring) or waits at a
// GATE (a count badge and the alert ring). `GET /api/story-builds/active?workspace=` answers one row per
// such build; this file is the ONE fold from a build's stored facts to that row (pure, tested).
//
// A GATE is a step where the build stops for the reader:
//   plan     the plan waits for "Approve and start"
//   push     the build is done and nothing pushes it (the review loop is off): Push
//   paused   the review loop paused or was stopped: Continue
//   failed   the session or the loop failed
//   ticket   Limn approved the plan itself and the pull request is open: the ticket changes wait for the
//            reader (Update ticket, or "No update")
// A build that is neither running nor at a gate is not listed.

import type { SandboxSessionPhase } from './sandbox-session.js';
import type { StoryBuildLoopState } from './story-build-loop.js';

export type StoryBuildGate = 'plan' | 'push' | 'paused' | 'failed' | 'ticket';

export interface StoryBuildActivity {
  id: number;
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  /** An agent or the review loop is working now (the circle's ring). */
  running: boolean;
  /** 0–100: how far along the build is (planning → build → review rounds → pull request). */
  progress: number;
  /** One plain line: what is happening, or what the reader needs to do. */
  step: string;
  gate: StoryBuildGate | null;
}

/** `GET /api/story-builds/active?workspace=`. Newest first. */
export interface StoryBuildActivityResponse {
  workspaceId: number;
  builds: StoryBuildActivity[];
}

export interface StoryBuildActivityFacts {
  phase: SandboxSessionPhase | null;
  /** The sandbox is running now. */
  live: boolean;
  /** The review loop is on ("After the build: review and fix, then open the pull request"). */
  loopOn: boolean;
  loopState: StoryBuildLoopState | null;
  loopRound: number;
  loopRounds: number;
  /** Limn approved the plan itself, and the plan carries a ticket update the reader has not closed. */
  ticketWaiting: boolean;
}

const RUNNING_PHASES: ReadonlySet<SandboxSessionPhase> = new Set(['booting', 'planning', 'revising', 'chatting', 'building']);
const LOOP_RUNNING: ReadonlySet<StoryBuildLoopState> = new Set(['pushing', 'reviewing', 'fixing', 'opening']);

const PHASE_STEP: Partial<Record<SandboxSessionPhase, { step: string; progress: number }>> = {
  booting: { step: 'Starting the sandbox', progress: 5 },
  planning: { step: 'Planning', progress: 15 },
  revising: { step: 'Revising the plan', progress: 20 },
  chatting: { step: 'Answering you', progress: 20 },
  plan_ready: { step: 'The plan is ready: approve it to start the build', progress: 25 },
  building: { step: 'Building', progress: 45 },
  built: { step: 'Built: ready to push', progress: 60 },
  pushed: { step: 'Pushed', progress: 100 },
  failed: { step: 'The build failed', progress: 0 },
};

/** The review loop's share of the bar: 60 → 97 over the rounds (+1 for the closing review), then 100. */
function loopProgress(state: StoryBuildLoopState, round: number, rounds: number): number {
  if (state === 'done') return 100;
  if (state === 'opening') return 97;
  const total = Math.max(1, rounds + 1);
  const at = Math.min(total, Math.max(0, round - 1) + (state === 'fixing' ? 0.5 : 0));
  return Math.round(62 + (35 * at) / total);
}

function loopStep(state: StoryBuildLoopState, round: number, rounds: number): string {
  switch (state) {
    case 'pushing':
      return round <= 0 ? 'Pushing the branch' : `Pushing round ${round}'s fixes`;
    case 'reviewing':
      return round > rounds ? 'Final review' : `Review round ${Math.max(1, round)} of ${rounds}`;
    case 'fixing':
      return `Fixing round ${Math.max(1, round)}'s findings`;
    case 'opening':
      return 'Opening the pull request';
    case 'paused':
      return 'The review loop paused: open the build to continue';
    case 'stopped':
      return 'The review loop stopped';
    case 'failed':
      return 'The review loop failed';
    case 'done':
      return 'Pull request open';
    default:
      return 'Waiting to review';
  }
}

/** The ONE fold: a build's row in the toast, or null when it is neither running nor at a gate. */
export function storyBuildActivityOf(f: StoryBuildActivityFacts): Omit<StoryBuildActivity, 'id' | 'ident' | 'ticketKey' | 'ticketTitle'> | null {
  if (f.phase == null || f.phase === 'discarded') return null;
  const loop = f.loopOn && f.loopState != null && f.loopState !== 'waiting' ? f.loopState : null;
  const phaseRunning = f.live && RUNNING_PHASES.has(f.phase);
  const loopRunning = loop != null && LOOP_RUNNING.has(loop);
  const running = phaseRunning || loopRunning;
  const base = PHASE_STEP[f.phase] ?? { step: 'Waiting for you', progress: 10 };
  let step = base.step;
  let progress = base.progress;
  // A fix turn is a build phase while the loop runs: the loop's words win.
  if (loop != null && (loopRunning || !phaseRunning)) {
    step = loopStep(loop, f.loopRound, f.loopRounds);
    progress = loopProgress(loop, f.loopRound, f.loopRounds);
  }
  let gate: StoryBuildGate | null = null;
  if (f.phase === 'failed' || loop === 'failed') gate = 'failed';
  else if (loop === 'paused' || loop === 'stopped') gate = 'paused';
  else if (!running && f.phase === 'plan_ready') gate = 'plan';
  else if (!running && f.phase === 'built' && !f.loopOn) gate = 'push';
  else if (!running && f.ticketWaiting && (loop === 'done' || f.phase === 'pushed')) {
    gate = 'ticket';
    step = 'Pull request open: check the ticket changes';
  }
  if (!running && gate == null) return null;
  return { running, progress: Math.max(0, Math.min(100, progress)), step, gate };
}

/** The toast's count: builds at a gate. */
export function storyBuildGateCount(builds: readonly Pick<StoryBuildActivity, 'gate'>[]): number {
  return builds.filter((b) => b.gate != null).length;
}

/** The ring's value when several builds run: the least advanced running one (it is what is left). */
export function storyBuildRingProgress(builds: readonly Pick<StoryBuildActivity, 'running' | 'progress'>[]): number | null {
  const run = builds.filter((b) => b.running);
  if (run.length === 0) return null;
  return Math.min(...run.map((b) => b.progress));
}
