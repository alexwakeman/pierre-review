// AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions). Every AI Fix run is a sandboxed
// session (Claude Code or Codex) on its `ai_fixes` row: the whole workspace is mirrored, the PR's
// repository is checked out at the PR's head sha, and only that repository is pushed (to the PR's own
// branch, compare-and-set on the head).
//
//   POST /api/pro/prs/:id/ai-fix                  start: boot, then the fix at once (build mode)
//   POST /api/pro/prs/:id/ai-fix/plan             Plan first: boot, one "make a plan" chat turn, then wait
//   POST /api/pro/ai-fixes/:fixId/message         one more turn in the SAME session (chat or build)
//   POST /api/pro/ai-fixes/:fixId/plan/approve    Start fix (Plan first only)
//   POST /api/pro/prs/:id/ai-fix/cancel           Stop (a manual session stays; an unattended one ends)
//   POST /api/pro/ai-fixes/:fixId/discard         close the session; nothing is pushed
//   POST /api/pro/ai-fixes/:fixId/resume          boot a closed session again with its stored patch
//   POST /api/pro/ai-fixes/:fixId/network/allow   an Allow click
//   GET  /api/pro/ai-fixes/:fixId/session/stream  SSE: SandboxSessionStreamEvent frames
//   POST /api/pro/ai-fixes/:fixId/push            UNCHANGED (ends the session after the push)
//
// THE ROW'S STATUS is DERIVED from the session phase by `aiFixStatusForPhase` — never written apart — so
// every older reader of `ai_fixes.status` (the banner, the Open PRs pill, the auto-fix caps, dependency
// automation's poll, `pushFix`) keeps working.
import type { SandboxSessionPhase } from './sandbox-session.js';
import type { AiFixStatus } from './types.js';

/** Every AI Fix session path (the backend's registration, the client and the rate-limit tiers). */
export const AI_FIX_SESSION_API = {
  message: '/api/pro/ai-fixes/:fixId/message',
  /** Kept for an older SPA bundle: the same as `message`. */
  planMessage: '/api/pro/ai-fixes/:fixId/plan/message',
  /** Start fix (Plan first). */
  planApprove: '/api/pro/ai-fixes/:fixId/plan/approve',
  discard: '/api/pro/ai-fixes/:fixId/discard',
  /** Kept for an older SPA bundle: the same as `discard`. */
  planDiscard: '/api/pro/ai-fixes/:fixId/plan/discard',
  resume: '/api/pro/ai-fixes/:fixId/resume',
  networkAllow: '/api/pro/ai-fixes/:fixId/network/allow',
  sessionStream: '/api/pro/ai-fixes/:fixId/session/stream',
} as const;

export type AiFixSessionApiRoute = keyof typeof AI_FIX_SESSION_API;

export function aiFixSessionPath(route: AiFixSessionApiRoute, fixId: number): string {
  return AI_FIX_SESSION_API[route].replace(':fixId', String(fixId));
}

/**
 * THE ONE MAP from a fix session's phase to `ai_fixes.status`:
 *   booting, building      → running   (the banner, the "Fixing…" pill and dependency automation's poll)
 *   ready, chatting        → planned   (Plan first, before Start fix)
 *   built                  → succeeded (with or without a patch: "The agent made no changes")
 *   pushed                 → succeeded (with `pushed_at`)
 *   discarded              → succeeded when it was pushed, else cancelled (a person's cancel wins)
 *   failed                 → failed
 */
export function aiFixStatusForPhase(phase: SandboxSessionPhase, o: { pushed: boolean }): AiFixStatus {
  switch (phase) {
    case 'booting':
    case 'building':
    case 'planning':
    case 'revising':
      return 'running';
    case 'ready':
    case 'chatting':
    case 'plan_ready':
      return 'planned';
    case 'built':
    case 'pushed':
      return 'succeeded';
    case 'discarded':
      return o.pushed ? 'succeeded' : 'cancelled';
    case 'failed':
      return 'failed';
  }
}

/** A repository the session edited that AI Fix does not push (only the PR's repository is pushed). */
export interface AiFixLeftOutRepo {
  repoId: number;
  fullName: string;
  files: string[];
}
