import type { MeResponse } from '@pierre-review/shared';

/**
 * THE ONE GATE for the agentic AI surfaces — Claude Review (run, follow-up, ticket check, auto
 * review, the review chat), review memory and AI Fix. It reads the TOP-LEVEL `me.ai` block, never
 * `me.pro`: these features are FREE and run on the reader's own Claude, and `entitledProCapabilities`
 * zeroes `pro` for a free cloud account (the `mlSeverity` argument).
 *
 * ⚠ VISIBILITY IS `enabled` ALONE. Locally the tabs and buttons ALWAYS render; a missing runtime or
 * credential changes what sits in place of the Run button (`AiRunGate`), never whether the surface
 * exists — hiding it until a credential is detected would hide it from exactly the people who have
 * not set one up yet, and the detection is a heuristic anyway (the run is the real check).
 *
 * `enabled: false` covers two cases the SPA tells apart with `cloud`: the hosted app (show one "runs
 * on your machine" line where the tab used to be) and a local `LIMN_AI_DISABLED=true` (show nothing).
 * An older server with no `ai` block reads as disabled.
 */
export interface AiCapabilities {
  enabled: boolean;
  /** Hosted deployment — agentic AI never runs there; show `AI_CLOUD_NOTE` instead. */
  cloud: boolean;
  runtime: MeResponse['ai']['runtime'];
  runtimeMessage: string | null;
  auth: MeResponse['ai']['auth'];
  authMessage: string | null;
  /** Enabled, runtime installed, and a credential detected — a Run button may show. */
  ready: boolean;
}

export const AI_CLOUD_NOTE = 'Review and fix run on your machine: npx limn-review';
export const AI_AUTH_LINE = 'Sign in to Claude Code or set ANTHROPIC_API_KEY';
export const AI_SETUP_LABEL = 'Set up AI (one-time ~110 MB download)';

export function aiCapabilitiesOf(me: MeResponse | undefined): AiCapabilities {
  const ai = me?.ai;
  const enabled = ai?.enabled === true;
  const runtime = ai?.runtime ?? 'absent';
  const auth = ai?.auth ?? 'none';
  return {
    enabled,
    cloud: me?.deploymentMode === 'cloud',
    runtime,
    runtimeMessage: ai?.runtimeMessage ?? null,
    auth,
    authMessage: ai?.authMessage ?? null,
    ready: enabled && runtime === 'ready' && auth === 'ok',
  };
}

