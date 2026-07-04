import type { PrDetail } from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { usePrSummary, useRefreshSummary } from '../hooks/useAiFix.js';
import { Markdown } from './Markdown.js';

// The Pro AI-generated PR summary (Haiku), gated on the `aiAnalysis` capability.
// Rendered on BOTH the Overview tab and the AI Analysis and Fix tab — the shared
// React-Query key (`['ai-fix-summary', prId]`) means generating in one place shows
// the result in the other with no extra wiring. Titled "AI summary" to disambiguate
// from the Overview's human-written PR description "Summary".
export function AiSummary({ pr }: { pr: PrDetail }): JSX.Element | null {
  const { aiAnalysis } = useProCapabilities();
  const { data } = usePrSummary(pr.id, aiAnalysis);
  const refresh = useRefreshSummary(pr.id);
  const stale = data?.headSha != null && data.headSha !== pr.headSha;

  if (!aiAnalysis) return null;

  return (
    <div>
      <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        AI summary
      </div>
      <div className="px-4 pb-3">
        {data?.summary ? (
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <Markdown>{data.summary}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            Generate a plain-language overview of what this PR does.
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending
              ? 'Generating…'
              : data?.summary
                ? 'Regenerate'
                : 'Generate summary'}
          </button>
          {stale && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              PR has changed since this was generated
            </span>
          )}
          {refresh.isError && (
            <span className="text-[11px] text-red-500">
              {refresh.error instanceof ApiError || refresh.error instanceof Error
                ? refresh.error.message
                : 'Something went wrong'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
