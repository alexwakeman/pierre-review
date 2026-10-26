// THE PER-RUN CHOICE of a MANUAL run with a model picker (docs/CODEX-PLAN.md § 6, revised 2026-10-26):
// Claude Review (run + follow-up) and AI Fix (+ Plan first). The request names `{ provider, model }`;
// this validates the pair and answers the provider the run goes to and the Claude model of the same
// depth (what every run entry point takes — each provider resolves the depth to its own model).
//
// The DEFAULT provider (Settings → AI, `activeProviderId()`) still decides every AUTOMATIC run and
// every surface without a picker; it is only the fallback here, when the request names no provider.
//
// Pure apart from the default and the pre-flight it is handed, so the routes and tests share it.
import {
  aiModelName,
  aiPickerModelProvider,
  aiPickerRequestModel,
  aiProviderName,
  type AiPickerModel,
  type AiProviderId,
  type AiRunKind,
  type ClaudeReviewModel,
} from '@pierre-review/shared';
import { activeProviderId } from './provider-setting.js';

export type ManualRunChoice =
  | { ok: true; provider: AiProviderId; model: ClaudeReviewModel }
  | { ok: false; error: 'UnknownProvider' | 'ModelNotOffered' | 'ModelNotOnProvider' | 'NoClaudeAuth'; message: string };

export interface ManualRunChoiceOptions {
  /** The model when the request names none (the surface's usual depth). */
  defaultModel: ClaudeReviewModel;
  /** The pre-flight for a named provider and kind (review/auth.ts `detectProviderAuth`). */
  detect(provider: AiProviderId, kind: AiRunKind): { status: 'ok' | 'none'; message?: string };
  /** The default provider (Settings → AI). Defaults to `activeProviderId()`. */
  defaultProvider?: () => AiProviderId;
}

/**
 * Validate a manual run's `{ provider, model }` for an agent kind:
 *   • an unknown provider, or a model no picker offers ⇒ 400 (`UnknownProvider`, `ModelNotOffered`);
 *   • a model of the OTHER provider ⇒ 400 `ModelNotOnProvider` ("GPT-6 Astra runs on Codex, not Claude.");
 *   • the provider not signed in, or unable to run this kind ⇒ 400 `NoClaudeAuth` (historical name)
 *     with the pre-flight's own sentence.
 * No provider ⇒ the model's own provider when it names one of Codex's, else the default provider.
 */
export function resolveManualRunChoice(
  raw: { provider?: unknown; model?: unknown },
  kind: AiRunKind,
  opts: ManualRunChoiceOptions,
): ManualRunChoice {
  let named: AiProviderId | null = null;
  if (raw.provider != null) {
    if (raw.provider !== 'claude' && raw.provider !== 'codex') {
      return { ok: false, error: 'UnknownProvider', message: 'Pick Claude or Codex.' };
    }
    named = raw.provider;
  }
  let model: AiPickerModel | null = null;
  let modelProvider: AiProviderId | null = null;
  if (raw.model != null) {
    modelProvider = aiPickerModelProvider(raw.model);
    if (modelProvider == null) return { ok: false, error: 'ModelNotOffered', message: 'That model is no longer offered.' };
    model = raw.model as AiPickerModel;
  }
  const provider: AiProviderId = named ?? (modelProvider === 'codex' ? 'codex' : (opts.defaultProvider ?? activeProviderId)());
  // A Claude model with NO provider named is a DEPTH (an older SPA, the Open PRs table's default
  // start): the default provider runs it at that depth, as before the per-run choice. Only a NAMED
  // provider must own its model.
  if (model != null && named != null && modelProvider !== provider) {
    return {
      ok: false,
      error: 'ModelNotOnProvider',
      message: `${aiModelName(model)} runs on ${aiProviderName(modelProvider)}, not ${aiProviderName(provider)}.`,
    };
  }
  const pre = opts.detect(provider, kind);
  if (pre.status !== 'ok') {
    return { ok: false, error: 'NoClaudeAuth', message: pre.message ?? `${aiProviderName(provider)} is not signed in.` };
  }
  return { ok: true, provider, model: model != null ? aiPickerRequestModel(model) : opts.defaultModel };
}

/**
 * A FOLLOW-UP on a stored run (the review chat on its review, another plan pass or the build of a
 * plan): the stored run's provider when it is signed in and can run the kind, else the default.
 */
export function followUpProvider(
  stored: AiProviderId,
  kind: AiRunKind,
  detect: ManualRunChoiceOptions['detect'],
  defaultProvider: () => AiProviderId = activeProviderId,
): AiProviderId {
  return detect(stored, kind).status === 'ok' ? stored : defaultProvider();
}

/** A context's pre-flight, structurally (review/agent-context.ts `AgentContext['llm']`; no import: that
 *  module opens the database at import time). */
export interface PreflightSource {
  llm: {
    detectAuth(kind?: AiRunKind): { status: 'ok' | 'none'; message?: string };
    detectProviderAuth?(provider: AiProviderId, kind: AiRunKind): { status: 'ok' | 'none'; message?: string };
  };
}

/**
 * The per-provider pre-flight of a context: `ctx.llm.detectProviderAuth`, or — a test's fake context
 * with only `detectAuth` — that one answer for either provider.
 */
export function preflightFor(ctx: Partial<PreflightSource>): ManualRunChoiceOptions['detect'] {
  const llm = ctx.llm;
  // A context with no pre-flight at all (a narrow test fake) has no opinion: the run itself is the check.
  if (!llm) return () => ({ status: 'ok' });
  const named = llm.detectProviderAuth?.bind(llm);
  return named ?? ((_provider, kind) => llm.detectAuth(kind));
}

/**
 * A PICKER SURFACE's pre-flight (its GET's `auth`): ready when ANY provider can run the kind — the
 * default's answer when it is ready, else 'ok' when the other one is, else the default's sentence.
 */
export function anyProviderPreflight(
  detect: ManualRunChoiceOptions['detect'],
  kind: AiRunKind,
  byDefault: { status: 'ok' | 'none'; message?: string },
): { status: 'ok' | 'none'; message?: string } {
  if (byDefault.status === 'ok') return byDefault;
  const other = (['claude', 'codex'] as const).some((p) => detect(p, kind).status === 'ok');
  return other ? { status: 'ok' } : byDefault;
}
