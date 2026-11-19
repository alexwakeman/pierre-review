// AI FIX'S OWN REVIEW LOOP (docs/CLAUDE-REVIEW.md § AI Fix → The review loop; migration 0207). After each
// fix turn — manual, auto, or dependency automation's — Ensemble reviews the fix's OWN work with a full
// review cycle, as Implement story's review loop does: review round k of a LOCAL commit in Ensemble's clone
// cache (never pushed) → anything open and k ≤ N ⇒ one more fix turn seeded with REVIEW.md (the same
// F / AC / M refs and answers file as Build) → round k + 1; at most N fix turns and N + 1 reviews. A Claude +
// Codex pair is ONE pass. NOTHING is pushed until the loop ends; then the existing push rules decide (Push,
// Push when done, Push automatically, the Dependencies policy), and the closing review is imported as the
// PR's AI review at the PUSHED head (not posted).
//
// Ids on this wire are FIX-LOCAL (`ai_fix_loop_*` tables), never a claude_reviews id.
import type { AiProviderId, ClaudeFindingSeverity } from './types.js';
import type { StoryBuildLoopAcResponse, StoryBuildLoopResponse } from './story-build-loop.js';
import type { AiFixLoopStop } from './auto-fix-queue.js';

/** Settings → AI → AI Fix → Review rounds (the FIX profile's `rounds`): N fix turns, N + 1 reviews. */
export const AI_FIX_LOOP_ROUNDS_DEFAULT = 5;
export const AI_FIX_LOOP_ROUNDS_MIN = 1;
export const AI_FIX_LOOP_ROUNDS_MAX = 6;

/** reviewing / fixing: working (no Push, reader messages wait); done / stopped: ended (`stop` says why). */
export type AiFixLoopState = 'reviewing' | 'fixing' | 'done' | 'stopped';

export type AiFixLoopRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** One finding of a round's review, with the fix agent's answer (if it answered it). */
export interface AiFixLoopFinding {
  id: number;
  round: number;
  severity: ClaudeFindingSeverity;
  path: string;
  line: number | null;
  title: string;
  body: string;
  /** Who raised it (a pair: 'both' when the two made the same point). */
  raisedBy: AiProviderId | 'both' | null;
  response: { action: StoryBuildLoopResponse; text: string | null; round: number } | null;
}

/** A criterion ('AC3') or missing item ('M1') the round's story check left open, with the answer. */
export interface AiFixLoopCriterion {
  ref: string;
  status: 'not_met' | 'partly_met' | 'unclear' | 'missing';
  text: string;
  explanation: string | null;
  response: { action: StoryBuildLoopAcResponse; text: string | null } | null;
}

export interface AiFixLoopRound {
  /** 1-based for the whole fix (a reader's follow-up runs the loop again; the numbers go on). */
  round: number;
  /** The round's place in ITS loop run (1..rounds + 1), for "round 2 of 5". */
  step: number;
  /** The closing review: no fix turn follows it. */
  closing: boolean;
  /** The local commit reviewed (never pushed). */
  headSha: string | null;
  review: AiFixLoopRunStatus | null;
  providers: AiProviderId[];
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | null;
  summary: string | null;
  /** The story check of the round (only when the PR's ticket criteria are in the fix); null when none ran. */
  storyCheck: AiFixLoopRunStatus | null;
  /** What was open after this review (findings include carried 'not checked' ones). */
  open: { findings: number; criteria: number };
  /** The strip: what the review found, and what the fix turn after it did. */
  counts: { found: number; fixed: number; answered: number; pushedBack: number; cannotMeet: number };
  findings: AiFixLoopFinding[];
  criteria: AiFixLoopCriterion[];
  /** The fix turn after this review. */
  fix: 'none' | 'running' | 'done' | 'stopped' | 'failed';
}

/** `AiFix.loop`: null when the fix never ran its loop (an older row; a fix with nothing to push). */
export interface AiFixLoop {
  state: AiFixLoopState;
  /** The current (or last) round, 1-based for the whole fix. */
  round: number;
  /** The first round of the CURRENT loop run (a follow-up starts a new run). */
  firstRound: number;
  /** N (Settings → AI → AI Fix → Review rounds, read when the run started). */
  rounds: number;
  stop: AiFixLoopStop | null;
  /** One plain line for the stop (the shared `AI_FIX_LOOP_STOP_LINE`); null while it runs. */
  stopLine: string | null;
  /** The loop works in this process now (the footer shows its progress, never Push). */
  running: boolean;
  /** Newest LAST. */
  history: AiFixLoopRound[];
  /** The criteria the agent says cannot be done, as of the latest answers (still NOT MET). */
  cannotMeet: Array<{ ref: string; text: string; reason: string }>;
  /** The PR's AI review the closing review became after the push (claude_reviews id); null before. */
  importedReviewId: number | null;
}

/** Is the loop working now? */
export function aiFixLoopRunning(loop: Pick<AiFixLoop, 'state'> | null | undefined): boolean {
  return loop != null && (loop.state === 'reviewing' || loop.state === 'fixing');
}

/** "Reviewing, round 2 of 5." / "Fixing, round 2 of 5." / "Reviewing, the closing round." Pure. */
export function aiFixLoopProgressLine(loop: Pick<AiFixLoop, 'state' | 'round' | 'firstRound' | 'rounds'>): string | null {
  const step = loop.round - loop.firstRound + 1;
  if (loop.state === 'reviewing') return step > loop.rounds ? 'Reviewing, the closing round.' : `Reviewing, round ${step} of ${loop.rounds}.`;
  if (loop.state === 'fixing') return `Fixing, round ${Math.min(step, loop.rounds)} of ${loop.rounds}.`;
  return null;
}
