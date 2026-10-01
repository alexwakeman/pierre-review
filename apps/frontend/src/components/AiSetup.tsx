import type { ReactNode } from 'react';
import {
  AI_AUTH_LINE,
  AI_CLOUD_NOTE,
  AI_SETUP_LABEL,
  useAiCapabilities,
  useAiRuntimeInstall,
  useAiRuntimePoll,
} from '../hooks/useAiCapabilities.js';

/**
 * What sits in place of a Run button for an agentic AI surface (Claude Review, the review chat,
 * AI Fix). In order: nothing when AI is off; the one-time runtime download when the SDKs are not
 * installed yet; ONE plain line when no Claude credential was detected; otherwise the children
 * (the real button).
 *
 * `auth` lets a surface pass a fresher answer than `/api/me` (the Claude Review route reports its
 * own); either one saying `'none'` wins.
 */
export function AiRunGate({
  children,
  auth,
}: {
  children: ReactNode;
  auth?: 'ok' | 'none';
}): JSX.Element | null {
  const ai = useAiCapabilities();
  if (!ai.enabled) return null;
  if (ai.runtime !== 'ready') return <AiRuntimeSetup />;
  if (ai.auth === 'none' || auth === 'none') return <AiAuthLine />;
  return <>{children}</>;
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

/** The hosted app's one line where an agentic tab used to be. Renders nothing locally. */
export function AiCloudNote({ className = '' }: { className?: string }): JSX.Element | null {
  const ai = useAiCapabilities();
  if (ai.enabled || !ai.cloud) return null;
  return (
    <span className={`text-xs text-gray-600 dark:text-gray-300 ${className}`}>{AI_CLOUD_NOTE}</span>
  );
}
