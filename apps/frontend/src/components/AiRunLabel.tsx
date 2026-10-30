import { aiRunLabel, type AiProviderId } from '@pierre-review/shared';

/**
 * WHO RAN A STORED AI RUN — "Claude Opus 5.5", "Codex · GPT-6.1 Sol" — beside the run's other facts
 * (when, which commit). The ONE wording is packages/shared `aiRunLabel`; an older row with no provider
 * reads from its model id. Renders nothing when the run names no model (an older server).
 */
export function AiRunLabel({
  provider,
  model,
  className = 'text-meta',
}: {
  provider: AiProviderId | null | undefined;
  model: string | null | undefined;
  className?: string;
}): JSX.Element | null {
  if (model == null || model === '') return null;
  return <span className={`whitespace-nowrap text-ai-muted ${className}`}>{aiRunLabel(provider, model)}</span>;
}
