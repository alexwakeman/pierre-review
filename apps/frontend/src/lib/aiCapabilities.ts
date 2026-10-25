import type { AiKindStatus, AiRunKind, MeResponse } from '@pierre-review/shared';

/**
 * THE ONE GATE for the agentic AI surfaces — Claude Review (run, follow-up, ticket check, auto
 * review, the review chat), review memory and AI Fix. It reads the TOP-LEVEL `me.ai` block: these
 * features run on the reader's own Claude.
 *
 * ⚠ VISIBILITY IS `enabled` ALONE. Locally the tabs and buttons ALWAYS render; a missing runtime or
 * credential changes what sits in place of the Run button (`AiRunGate`), never whether the surface
 * exists — hiding it until a credential is detected would hide it from exactly the people who have
 * not set one up yet, and the detection is a heuristic anyway (the run is the real check).
 *
 * `enabled: false` is `LIMN_AI_DISABLED=true` (show nothing). An older server with no `ai` block
 * reads as disabled.
 */
export interface AiCapabilities {
  enabled: boolean;
  runtime: MeResponse['ai']['runtime'];
  runtimeMessage: string | null;
  auth: MeResponse['ai']['auth'];
  authMessage: string | null;
  /**
   * The same pre-flight PER RUN KIND (`MeResponse.ai.kinds`): under Codex a kind it can run is 'ok'
   * while `auth` above stays 'none'. Absent (an older server) ⇒ every kind reads `auth`.
   */
  kinds: Partial<Record<AiRunKind, AiKindStatus>>;
  /** Enabled, runtime installed, and a credential detected — a Run button may show. */
  ready: boolean;
}

export const AI_AUTH_LINE = 'Sign in to Claude Code or set ANTHROPIC_API_KEY';
export const AI_SETUP_LABEL = 'Set up AI (one-time ~110 MB download)';

export function aiCapabilitiesOf(me: MeResponse | undefined): AiCapabilities {
  const ai = me?.ai;
  const enabled = ai?.enabled === true;
  const runtime = ai?.runtime ?? 'absent';
  const auth = ai?.auth ?? 'none';
  return {
    enabled,
    runtime,
    runtimeMessage: ai?.runtimeMessage ?? null,
    auth,
    authMessage: ai?.authMessage ?? null,
    kinds: ai?.kinds ?? {},
    ready: enabled && runtime === 'ready' && auth === 'ok',
  };
}

/** `ready` for ONE run kind: enabled, runtime installed, and that kind's pre-flight says 'ok'. */
export function aiReadyFor(ai: AiCapabilities, kind: AiRunKind): boolean {
  return ai.enabled && ai.runtime === 'ready' && aiAuthFor(ai, kind).auth === 'ok';
}

/**
 * The pre-flight for ONE run kind: its own entry when the server sent one, else the top-level
 * answer. The sentence is the kind's own, else the top-level one.
 */
export function aiAuthFor(ai: AiCapabilities, kind: AiRunKind | undefined): { auth: 'ok' | 'none'; message: string | null } {
  const k = kind != null ? ai.kinds[kind] : undefined;
  return k ? { auth: k.auth, message: k.message ?? ai.authMessage } : { auth: ai.auth, message: ai.authMessage };
}

