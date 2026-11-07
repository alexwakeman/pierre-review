import type { PrPushSummary } from '@pierre-review/shared';
import { SparkleIcon } from './Icons.js';

/**
 * ONE PUSH SUMMARY (docs/FRONTEND.md § Push summaries): what a full Limn review said the pushes since
 * the previous review changed. Sits on the push it covers — the PR Activity tab's head commit, the
 * Feed's commit run. ⚠ Model text about untrusted code: PLAIN TEXT only (React escapes it); lines
 * that start with '- ' read as a list. Callers gate on `me.ai.enabled`.
 */
export function PushSummary({
  summary,
  commitCount,
}: {
  summary: PrPushSummary;
  /** The commits the range covers; null/undefined = unknown, so no count is shown. */
  commitCount?: number | null;
}): JSX.Element {
  const lines = summary.text.split('\n').filter((l) => l.trim() !== '');
  const bullets = lines.length > 0 && lines.every((l) => l.startsWith('- '));
  const scope = summary.fromSha == null ? 'Since the pull request opened' : 'Since the last review';
  return (
    <div
      className="mt-1 rounded-ui border border-ai-border bg-ai-surface px-2.5 py-1.5"
      data-testid="push-summary"
    >
      <div className="mb-0.5 flex items-center gap-1 text-meta text-ai-signal">
        <SparkleIcon size={12} />
        <span className="font-medium">{scope}</span>
        {commitCount != null && commitCount > 0 && (
          <span className="text-ui-mute">
            · {commitCount} {commitCount === 1 ? 'commit' : 'commits'}
          </span>
        )}
      </div>
      {bullets ? (
        <ul className="list-disc space-y-0.5 pl-4 text-body text-ui-ink">
          {lines.map((l, i) => (
            <li key={i}>{l.slice(2)}</li>
          ))}
        </ul>
      ) : (
        <p className="whitespace-pre-line text-body text-ui-ink">{lines.join('\n')}</p>
      )}
    </div>
  );
}
