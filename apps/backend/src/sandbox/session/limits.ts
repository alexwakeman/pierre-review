// A WORKSPACE SESSION'S LIMITS (docs/SANDBOX.md § Sessions). The defaults are spelled once in
// packages/shared; the environment overrides them, read AT CALL TIME. An unset, unparseable or
// non-positive value falls back to the default.
//
//   LIMN_SANDBOX_MAX_SESSIONS   sandboxes running at once on this machine (default 4)
//   LIMN_SANDBOX_MAX_BUILDS     build-mode turns running at once, story and fix alike (default 3)
//   LIMN_SANDBOX_IDLE_MINUTES   a session with no turn and no reader action is closed after this long (15):
//                               its sandbox stopped and removed, its stored changes kept (Resume)
//   LIMN_SANDBOX_TURN_MAX_MINUTES one agent turn running longer than this is stopped (120)
//   STORY_BUILD_PATCH_MAX_BYTES one repository's stored patch (the old flow's cap, 4 MB)
//   STORY_BUILD_MAX_TURNS       model turns per reader message (Claude's --max-turns)
//
// Builds at once (owner decision 3 of STORY-BUILD, widened 2026-11-12 from one to LIMN_SANDBOX_MAX_BUILDS).
import { SANDBOX_IDLE_MINUTES_DEFAULT, SANDBOX_MAX_BUILDS_DEFAULT, SANDBOX_MAX_OPEN_SESSIONS_DEFAULT, SANDBOX_TURN_MAX_MINUTES_DEFAULT } from '@pierre-review/shared';
import { storyBuildLimits } from '../../coding/story-build/limits.js';

export interface SessionLimits {
  maxOpen: number;
  maxBuilds: number;
  idleMs: number;
  turnMaxMs: number;
  patchMaxBytes: number;
  maxTurns: number;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function sessionLimits(env: NodeJS.ProcessEnv = process.env): SessionLimits {
  const story = storyBuildLimits(env);
  return {
    maxOpen: Math.floor(positiveInt(env, 'LIMN_SANDBOX_MAX_SESSIONS', SANDBOX_MAX_OPEN_SESSIONS_DEFAULT)),
    maxBuilds: Math.floor(positiveInt(env, 'LIMN_SANDBOX_MAX_BUILDS', SANDBOX_MAX_BUILDS_DEFAULT)),
    idleMs: positiveInt(env, 'LIMN_SANDBOX_IDLE_MINUTES', SANDBOX_IDLE_MINUTES_DEFAULT) * 60_000,
    turnMaxMs: positiveInt(env, 'LIMN_SANDBOX_TURN_MAX_MINUTES', SANDBOX_TURN_MAX_MINUTES_DEFAULT) * 60_000,
    patchMaxBytes: story.patchMaxBytes,
    maxTurns: story.buildMaxTurns,
  };
}
