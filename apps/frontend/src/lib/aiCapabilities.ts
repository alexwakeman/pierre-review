import {
  aiProviderName,
  aiSignInLine,
  type AiKindStatus,
  type AiProviderId,
  type AiProviderName,
  type AiRunKind,
  type MeResponse,
} from '@pierre-review/shared';

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
  /** The ACTIVE provider (`MeResponse.ai.provider`); absent from an older server ⇒ Claude. */
  provider: AiProviderId;
  /** Its name for copy: 'Claude' | 'Codex' — the one source for "the AI that will run now". */
  providerName: AiProviderName;
}

/** Claude's sign-in line (the default provider). Per provider: `aiSignInLine` (shared). */
export const AI_AUTH_LINE = aiSignInLine('claude');
export const AI_SETUP_LABEL = 'Set up AI (one-time ~110 MB download)';
/** The setup button for the ACTIVE provider. Codex's native program is ~360 MB unpacked per platform
 *  (docs/PACKAGING.md § The Codex CLI), on top of Claude's SDKs — never Claude's ~110 MB figure. */
export const AI_SETUP_LABEL_CODEX = 'Set up AI (one-time download; Codex takes ~360 MB)';
export function aiSetupLabel(provider: AiProviderId | null | undefined): string {
  return provider === 'codex' ? AI_SETUP_LABEL_CODEX : AI_SETUP_LABEL;
}

export function aiCapabilitiesOf(me: MeResponse | undefined): AiCapabilities {
  const ai = me?.ai;
  const enabled = ai?.enabled === true;
  const runtime = ai?.runtime ?? 'absent';
  const auth = ai?.auth ?? 'none';
  const provider: AiProviderId = ai?.provider === 'codex' ? 'codex' : 'claude';
  return {
    enabled,
    runtime,
    runtimeMessage: ai?.runtimeMessage ?? null,
    auth,
    authMessage: ai?.authMessage ?? null,
    kinds: ai?.kinds ?? {},
    ready: enabled && runtime === 'ready' && auth === 'ok',
    provider,
    providerName: aiProviderName(provider),
  };
}

/** `ready` for ONE run kind: enabled, runtime installed, and that kind's pre-flight says 'ok'. */
export function aiReadyFor(ai: AiCapabilities, kind: AiRunKind): boolean {
  return ai.enabled && ai.runtime === 'ready' && aiAuthFor(ai, kind).auth === 'ok';
}

/**
 * Can THIS provider run this kind right now — its own download ready and its own pre-flight 'ok'
 * (`me.ai.providers.*`), whichever provider is the default? The per-run model picker lists a provider
 * only when this says yes. An older server without `providers.claude.runtime` reads the top-level
 * `runtime` for Claude while Claude is the default.
 */
export function aiProviderReadyFor(me: MeResponse | undefined, provider: AiProviderId, kind: AiRunKind): boolean {
  const ai = me?.ai;
  if (ai?.enabled !== true) return false;
  if (provider === 'codex') {
    const c = ai.providers?.codex;
    return c != null && c.runtime === 'ready' && (c.kinds?.[kind]?.auth ?? c.auth) === 'ok';
  }
  const c = ai.providers?.claude;
  if (c == null) return ai.provider !== 'codex' && ai.runtime === 'ready' && ai.auth === 'ok';
  const runtime = c.runtime ?? (ai.provider !== 'codex' ? ai.runtime : 'absent');
  return runtime === 'ready' && c.auth === 'ok';
}

/**
 * THE PROVIDERS A MODEL PICKER OFFERS for a kind: every provider that can run it now, the DEFAULT
 * (`me.ai.provider`, Settings → AI) first. Empty ⇒ none can (the gate shows the default's line).
 */
export function aiRunnableProviders(me: MeResponse | undefined, kind: AiRunKind): AiProviderId[] {
  const first: AiProviderId = me?.ai?.provider === 'codex' ? 'codex' : 'claude';
  const order: AiProviderId[] = first === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  return order.filter((p) => aiProviderReadyFor(me, p, kind));
}

/**
 * The pre-flight for ONE run kind: its own entry when the server sent one, else the top-level
 * answer. The sentence is the kind's own, else the top-level one.
 */
export function aiAuthFor(ai: AiCapabilities, kind: AiRunKind | undefined): { auth: 'ok' | 'none'; message: string | null } {
  const k = kind != null ? ai.kinds[kind] : undefined;
  return k ? { auth: k.auth, message: k.message ?? ai.authMessage } : { auth: ai.auth, message: ai.authMessage };
}

