import type { ReactNode } from 'react';
import {
  AI_AUTH_LINE,
  AI_SETUP_LABEL,
  useAiCapabilities,
  useAiRuntimeInstall,
  useAiRuntimePoll,
} from '../hooks/useAiCapabilities.js';
import { AiBudgetMeter, OverBudgetConfirm } from './AiBudget.js';

/**
 * What sits in place of a Run button for an agentic AI surface (Claude Review, the review chat,
 * AI Fix). In order: nothing when AI is off; the one-time runtime download when the SDKs are not
 * installed yet; ONE plain line when no Claude credential was detected; otherwise the children
 * (the real button).
 *
 * `auth` lets a surface pass a fresher answer than `/api/me` (the Claude Review route reports its
 * own); either one saying `'none'` wins.
 *
 * THE CLAUDE SPEND BUDGET rides here, so every AI surface gets it: the compact meter after the
 * button while the budget is on, and — over budget — the button takes two presses (the run is the
 * reader's choice, never refused). `meter={false}` drops the meter where a surface has no room.
 */
export function AiRunGate({
  children,
  auth,
  meter = true,
}: {
  children: ReactNode;
  auth?: 'ok' | 'none';
  meter?: boolean;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  if (!ai.enabled) return null;
  if (ai.runtime !== 'ready') return <AiRuntimeSetup />;
  if (ai.auth === 'none' || auth === 'none') return <AiAuthLine />;
  // A gate with nothing inside (a surface that only wants the setup/auth line) gets no budget UI.
  if (children == null) return null;
  return (
    <>
      <OverBudgetConfirm>{children}</OverBudgetConfirm>
      {meter && <AiBudgetMeter />}
    </>
  );
}

export function AiAuthLine(): JSX.Element {
  return <span className="text-xs text-gray-600 dark:text-gray-300">{AI_AUTH_LINE}</span>;
}

/** The "Set up AI" button, its progress line, and a failure with Retry. */
export function AiRuntimeSetup(): JSX.Element | null {
  const ai = useAiCapabilities();
  const { state, start } = useAiRuntimeInstall();
  // Started somewhere else (another tab, `limn ai install`): watch it finish.
  const serverInstalling = ai.runtime === 'installing' && state.phase !== 'running';
  useAiRuntimePoll(serverInstalling);
  if (!ai.enabled || ai.runtime === 'ready') return null;

  if (state.phase === 'running' || ai.runtime === 'installing') {
    return (
      <span className="text-xs text-gray-600 dark:text-gray-300" role="status">
        Setting up AI…{state.message != null ? ` ${state.message}` : ''}
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
      {failure != null && <span className="text-xs text-red-600 dark:text-red-400">{failure}</span>}
      <button
        type="button"
        onClick={start}
        className="rounded border border-gray-300 px-2 py-1 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
      >
        {failure != null ? 'Retry' : AI_SETUP_LABEL}
      </button>
    </span>
  );
}

