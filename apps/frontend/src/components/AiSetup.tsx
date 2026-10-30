import type { ReactNode } from 'react';
import { aiSignInLine, type AiProviderId, type AiRunKind } from '@pierre-review/shared';
import {
  AI_SETUP_LABEL_BOTH,
  aiSetupLabel,
  aiAuthFor,
  useAiCapabilities,
  useAiRuntimeInstall,
  useAiRuntimePoll,
} from '../hooks/useAiCapabilities.js';
import { AiBudgetMeter, OverBudgetConfirm } from './AiBudget.js';
import { useMe } from '../hooks/useTriage.js';
import { aiGateReadyFor } from '../lib/aiCapabilities.js';

/**
 * What sits in place of a Run button for an agentic AI surface (Claude Review, the review chat,
 * AI Fix). In order: nothing when AI is off; the one-time download's progress (Limn starts it by
 * itself on the first boot) or its Retry while the runtime is not ready; ONE plain line when the active provider has no credential; otherwise the children
 * (the real button).
 *
 * `auth` lets a surface pass a fresher answer than `/api/me` (the Claude Review route reports its
 * own); either one saying `'none'` wins.
 *
 * `kind` names what the button runs (an agent kind, or 'complete' for a one-shot feature), so the gate
 * reads `/api/me`'s answer FOR THAT KIND (`ai.kinds`): a provider may run some kinds and not others
 * (Codex, while its agents are being ported). Without it, the top-level answer ("any agent").
 *
 * THE AI SPEND BUDGET rides here, so every AI surface gets it: the compact meter after the
 * button while the budget is on, and — over budget — the button takes two presses (the run is the
 * reader's choice, never refused). `meter={false}` drops the meter where a surface has no room.
 *
 * A PER-RUN PICKER SURFACE (`anyProvider`, with its `kind`): the run may go to ANY provider that can
 * run the kind (the menu lists them, lib/modelPick.ts), so the gate is ready when ANY of them is —
 * the default's setup or sign-in line shows only when none is. `provider` is the provider the run
 * goes to (the menu's pick), whose budget the meter and the over-budget confirm read; absent ⇒ the
 * default's.
 *
 * A FOLLOW-UP SURFACE (`followUp`, with its `kind` and `provider`): a run on a stored run (the review
 * chat, another plan pass, the build of a plan) goes to `provider` (`useFollowUpProvider`) and to no
 * other, so the gate is ready only when THAT provider can run the kind (`aiGateReadyFor`).
 */
export function AiRunGate({
  children,
  auth,
  kind,
  meter = true,
  anyProvider = false,
  followUp = false,
  provider,
}: {
  children: ReactNode;
  auth?: 'ok' | 'none';
  kind?: AiRunKind;
  meter?: boolean;
  anyProvider?: boolean;
  followUp?: boolean;
  provider?: AiProviderId | null;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const me = useMe().data;
  if (!ai.enabled) return null;
  const ready = aiGateReadyFor(me, { kind, anyProvider, followUp, provider });
  if (ready !== true) {
    // A follow-up pinned to the OTHER provider that cannot run: that provider's own line.
    if (ready === false && provider != null && provider !== ai.provider) return <AiAuthLine provider={provider} />;
    if (ai.runtime !== 'ready') return <AiRuntimeSetup />;
    // ⚠ `ready === false`: the provider the follow-up runs on cannot run it — the line, never the button.
    if (ready === false || aiAuthFor(ai, kind).auth === 'none' || auth === 'none') return <AiAuthLine kind={kind} />;
  }
  // A gate with nothing inside (a surface that only wants the setup/auth line) gets no budget UI.
  if (children == null) return null;
  return (
    <>
      <OverBudgetConfirm provider={provider}>{children}</OverBudgetConfirm>
      {meter && <AiBudgetMeter provider={provider} />}
    </>
  );
}

export function AiAuthLine({ kind, provider }: { kind?: AiRunKind; provider?: AiProviderId | null } = {}): JSX.Element {
  // The server's own sentence when it sent one (e.g. "Codex cannot run … yet" under
  // LIMN_AI_PROVIDER=codex — the kind's own when the gate named one), else the ACTIVE provider's
  // sign-in line. A NAMED provider other than the active one gets its own sign-in line.
  const ai = useAiCapabilities();
  const line =
    provider != null && provider !== ai.provider ? aiSignInLine(provider) : (aiAuthFor(ai, kind).message ?? aiSignInLine(ai.provider));
  return <span className="text-meta text-ui-mute">{line}</span>;
}

/**
 * What stands where "Set up AI" used to: Limn downloads Claude and Codex by itself on the first boot
 * (`ai.autoInstall`), so this is the download's progress line, then — only if it failed — the reason
 * and Retry. The Set up button shows only where the automatic download is off (LIMN_AI_AUTO_INSTALL=false).
 */
export function AiRuntimeSetup(): JSX.Element | null {
  const ai = useAiCapabilities();
  const { state, start } = useAiRuntimeInstall();
  // Poll while the SERVER is downloading (the automatic one, another tab's, `limn ai install`): its
  // step shows, and the line turns into Run on its own.
  useAiRuntimePoll(ai.runtime === 'installing');
  if (!ai.enabled || ai.runtime === 'ready') return null;

  if (state.phase === 'running' || ai.runtime === 'installing') {
    const step = state.message ?? (ai.runtime === 'installing' ? ai.runtimeMessage : null);
    return (
      <span className="text-meta text-ui-mute" role="status">
        Setting up AI…{step != null ? ` ${step}` : ''}
      </span>
    );
  }

  const failure =
    state.phase === 'failed'
      ? (state.message ?? 'The download failed.')
      : ai.runtime === 'failed'
        ? (ai.runtimeMessage ?? 'The download failed.')
        : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {failure != null && <span className="text-meta text-ui-danger">{failure}</span>}
      <button
        type="button"
        onClick={() => start()}
        className="hit bg-ui-raise rounded-ui px-2 py-1 text-meta hover:bg-ui-hover"
      >
        {failure != null ? 'Retry' : ai.autoInstall ? AI_SETUP_LABEL_BOTH : aiSetupLabel(ai.provider)}
      </button>
    </span>
  );
}
