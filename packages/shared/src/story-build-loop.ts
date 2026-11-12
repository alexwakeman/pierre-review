// IMPLEMENT STORY: THE REVIEW LOOP (docs/STORY-BUILD.md § The review loop; migration 0186).
// "After the build: review and fix, then open the pull request": the host pushes the branch, reviews it
// with Limn's own machinery (the code review of each target — Claude + Codex when the workspace's AI
// review setting says so — and ONE story check across every target), the build agent fixes, answers or
// pushes back on every point, each fix is pushed as a NEW commit, and Limn reviews again — for at most
// `rounds` rounds. Then the pull request opens, ready for review. The review stays IN LIMN: no GitHub
// comment, no GitHub review, no tracker write.
//
// A TARGET is one branch that becomes one pull request: a repository row of a one-patch build, or a
// planned PR of a plan-first build. Ids on this wire are BUILD-LOCAL (story_build_* tables), never a
// claude_reviews or pull_requests id.
import type { AiProviderId, ClaudeFinding, ClaudeFollowUpItem, ClaudeReview, TicketReview } from './types.js';
import { aiProviderName } from './ai-run-label.js';

export const STORY_BUILD_LOOP_ROUNDS_DEFAULT = 3;
export const STORY_BUILD_LOOP_ROUNDS_MIN = 1;
export const STORY_BUILD_LOOP_ROUNDS_MAX = 6;

/** A rounds number as stored: an integer in MIN..MAX; anything else ⇒ the default. */
export function clampLoopRounds(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) return STORY_BUILD_LOOP_ROUNDS_DEFAULT;
  return Math.min(STORY_BUILD_LOOP_ROUNDS_MAX, Math.max(STORY_BUILD_LOOP_ROUNDS_MIN, n));
}

export type StoryBuildLoopState = 'waiting' | 'pushing' | 'reviewing' | 'fixing' | 'opening' | 'paused' | 'done' | 'stopped' | 'failed';
export type StoryBuildLoopPause =
  | 'budget'
  | 'session_closed'
  | 'interrupted'
  | 'fix_stopped'
  | 'fix_failed'
  | 'push_failed'
  | 'branch_exists'
  | 'review_failed'
  | 'build_busy';
/** What the build agent did with a finding. */
export type StoryBuildLoopResponse = 'fixed' | 'answered' | 'pushed_back' | 'not_reported';
/** What the build agent did with a criterion ('AC3') or a missing item ('M1'). */
export type StoryBuildLoopAcResponse = 'fixed' | 'not_applicable' | 'answered' | 'pushed_back' | 'not_reported';
export type StoryBuildLoopTargetKind = 'repo' | 'pr';

/** The states in which the loop is working by itself (the tab polls; Push and messages wait). */
export const STORY_BUILD_LOOP_RUNNING_STATES: readonly StoryBuildLoopState[] = ['waiting', 'pushing', 'reviewing', 'fixing', 'opening'];

export function isStoryBuildLoopRunning(state: StoryBuildLoopState | null | undefined): boolean {
  return state != null && STORY_BUILD_LOOP_RUNNING_STATES.includes(state);
}

export interface StoryBuildLoopTarget {
  kind: StoryBuildLoopTargetKind;
  /** story_build_repos.id or story_build_prs.id. */
  id: number;
  repoId: number;
  fullName: string;
  /** A planned PR's key and title ('PR2' · …); null for a repository target. */
  key: string | null;
  title: string | null;
  /** The branch the loop pushed (no PR until the end); null before the first push. */
  branch: string | null;
  pushedSha: string | null;
  pushedAt: string | null;
  ended: 'pr_opened' | 'manual_push' | 'stopped' | null;
  prNumber: number | null;
  prUrl: string | null;
  pushError: string | null;
  pushErrorCode: string | null;
}

/** One finding as the build tab shows it: the ClaudeFinding wire + the build agent's response. */
export interface StoryBuildLoopFinding extends ClaudeFinding {
  targetKind: StoryBuildLoopTargetKind;
  targetId: number;
  round: number;
  /** The provider that raised it (a pair: 'both' when the two made the same point). */
  raisedBy: AiProviderId | 'both' | null;
  response: { action: StoryBuildLoopResponse; text: string | null; round: number } | null;
}

export interface StoryBuildLoopTargetReview {
  targetKind: StoryBuildLoopTargetKind;
  targetId: number;
  headSha: string;
  baseSha: string;
  /** The runs (halves), as the PR review's wire with build-local ids and `prId: 0`. */
  runs: ClaudeReview[];
  /** The pair's one verdict (or the one run's). null while none succeeded. */
  verdict: ClaudeReview['verdict'];
  summary: string | null;
  /** Consolidated (merged-away duplicates left out), praise last. */
  findings: StoryBuildLoopFinding[];
  /** What this round said about the earlier round's findings (and the agent's answers on them). */
  followUp: ClaudeFollowUpItem[];
}

export interface StoryBuildLoopClaimVerdict {
  ref: string;
  verdict: 'accepted' | 'rejected';
  why: string;
}

export interface StoryBuildLoopRound {
  /** 1..N+1 */
  round: number;
  /** The closing review: no fix follows it. */
  closing: boolean;
  reviews: StoryBuildLoopTargetReview[];
  /** The round's story check, as the ticket review's wire (members' `prId` = the target id). */
  storyCheck: TicketReview | null;
  claimVerdicts: StoryBuildLoopClaimVerdict[];
  /** The build agent's answers on criteria AFTER this review. */
  acResponses: Array<{ ref: string; response: StoryBuildLoopAcResponse; text: string | null }>;
  /** What was open after this review. */
  open: { findings: number; followUps: number; criteria: number };
  /** The fix pass after this review; null when none ran (nothing open, or the closing review). */
  fix: {
    state: 'none' | 'running' | 'done' | 'stopped' | 'failed';
    pushed: Array<{ targetKind: StoryBuildLoopTargetKind; targetId: number; sha: string | null; error: string | null }>;
  } | null;
}

export interface StoryBuildLoop {
  /** = StoryBuild.autoPush (the switch). */
  on: boolean;
  /** N: review + fix rounds before the PR opens. */
  rounds: number;
  /** The switch and N can change (the loop has not started). */
  editable: boolean;
  state: StoryBuildLoopState | null;
  round: number;
  pause: StoryBuildLoopPause | null;
  /** The one plain line the tab shows while paused (or stopped / failed); null otherwise. */
  pauseLine: string | null;
  canContinue: boolean;
  error: string | null;
  targets: StoryBuildLoopTarget[];
  /** Newest LAST. */
  history: StoryBuildLoopRound[];
  /** "What happens next", one line; null when nothing will. */
  next: string | null;
}

/** The pause words (the server sends `pauseLine`, built from these plus the stored detail). */
export const STORY_BUILD_LOOP_PAUSE_LINE: Record<StoryBuildLoopPause, string> = {
  budget: 'Paused: the AI spend limit is reached. Press Continue to go on.',
  session_closed: 'Paused: the session closed. Press Continue to start it again and go on.',
  interrupted: 'Paused: Limn restarted during the review loop. Press Continue to go on.',
  fix_stopped: 'Paused: the fix was stopped. Press Continue to go on.',
  fix_failed: 'Paused: the agent could not finish the fixes. Press Continue to try again.',
  push_failed: 'Paused: a push did not work. Press Continue to try again.',
  branch_exists: 'Paused: the branch already exists on GitHub. Pick another name, then press Continue.',
  review_failed: 'Paused: the review did not finish. Press Continue to try again.',
  build_busy: 'Paused: another session is building. Press Continue when it is done.',
};

const providersWords = (providers: readonly AiProviderId[]): string =>
  providers.length === 0 ? 'Limn' : providers.map((p) => aiProviderName(p)).join(' and ');
/** "Claude reviews" / "Claude and Codex review" (one reviewer, or Limn, takes the -s). */
const reviewVerb = (providers: readonly AiProviderId[]): string => (providers.length >= 2 ? 'review' : 'reviews');

/**
 * THE "WHAT HAPPENS NEXT" LINE (pure; the server sends it as `next`). `providers` = who reviews the code
 * next (the workspace's AI review setting). `open` = what is open after the latest review.
 */
export function loopNextLine(
  loop: Pick<StoryBuildLoop, 'on' | 'state' | 'round' | 'rounds' | 'pause' | 'targets'>,
  providers: readonly AiProviderId[],
  open: { findings: number; criteria: number } | null,
): string | null {
  if (!loop.on) return null;
  const many = loop.targets.filter((t) => t.ended == null).length > 1;
  const prs = many ? 'the pull requests' : 'the pull request';
  switch (loop.state) {
    case null:
      return `After the build, Limn pushes the branch and ${providersWords(providers)} ${reviewVerb(providers)} it (up to ${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}).`;
    case 'waiting':
      return 'Next: Limn pushes the branch.';
    case 'pushing':
      return loop.round === 0 ? 'Next: Limn pushes the branch, then reviews it.' : `Next: ${providersWords(providers)} ${reviewVerb(providers)} round ${loop.round + 1}.`;
    case 'reviewing':
      return loop.round > loop.rounds ? `Next: Limn opens ${prs}.` : `Next: the agent answers what round ${loop.round} finds.`;
    case 'fixing': {
      if (open == null) return 'Next: Limn pushes the fixes and reviews again.';
      const parts: string[] = [];
      if (open.findings > 0) parts.push(`${open.findings} ${open.findings === 1 ? 'finding' : 'findings'}`);
      if (open.criteria > 0) parts.push(`${open.criteria} ${open.criteria === 1 ? 'criterion' : 'criteria'}`);
      return parts.length > 0 ? `Next: the agent answers ${parts.join(' and ')}.` : 'Next: Limn pushes the fixes and reviews again.';
    }
    case 'opening':
      return `Next: Limn opens ${prs}.`;
    case 'paused':
      return loop.pause ? STORY_BUILD_LOOP_PAUSE_LINE[loop.pause] : null;
    case 'done':
    case 'stopped':
    case 'failed':
      return null;
  }
}

/** `POST …/loop/settings`. Either field may be left out. */
export interface StoryBuildLoopSettingsBody {
  on?: boolean;
  rounds?: number;
}

/** `POST …/loop/continue`: the reader's press (never refused by the spend limit). `branch` renames one
 *  target's branch first (the recovery from a branch that already exists). */
export interface StoryBuildLoopContinueBody {
  branch?: { kind: StoryBuildLoopTargetKind; id: number; name: string };
}

/** The loop routes answer the loop as it is now. */
export interface StoryBuildLoopRouteResponse {
  loop: StoryBuildLoop;
}
