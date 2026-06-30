import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFeedDigest, useRefreshFeedDigest } from '../../hooks/useFeedDigest.js';
import { useOpenPrTab } from '../../hooks/useOpenPrTab.js';
import { relativeTime } from '../../lib/ui.js';
import { DigestMarkdown } from './DigestMarkdown.js';

// Friendly model label ('claude-haiku-4-5' → 'Haiku'); falls back to the raw id.
function modelLabel(model: string | undefined): string {
  if (!model) return 'Haiku';
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('opus')) return 'Opus';
  return model;
}

// The cross-all-repos AI digest atop the Inbox "Feed" entry — the ONLY Pro/flagged
// surface in the Feed (the consolidated list below it is core). Renders nothing unless
// pro.inboxDigest is true (no greyed stub). One bulleted change-report per watched
// repo, with clickable "#N" PR refs that open the PR as a new tab.
export function FeedDigestPanel(): JSX.Element | null {
  const { inboxDigest } = useProCapabilities();
  const { data, isLoading } = useFeedDigest(inboxDigest);
  const refresh = useRefreshFeedDigest();
  const openPr = useOpenPrTab();

  // Absent Pro → render nothing. This is the load-bearing gate.
  if (!inboxDigest) return null;

  const digest = data?.digest ?? null;
  const sections = digest?.sections ?? [];

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          <span aria-hidden="true">✨</span>
          Across all repos
        </span>
        <span className="rounded bg-violet-500/15 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-gray-400">
          {digest != null && (
            <span title={digest.model}>
              {modelLabel(digest.model)}
              {' · '}
              {relativeTime(digest.generatedAt)}
              {digest.stale ? ' · stale' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
            title="Regenerate the cross-repo digest (runs the cheap-tier model; unchanged repos are free)"
          >
            <span aria-hidden="true">↻</span>
            {refresh.isPending ? 'Regenerating…' : 'Regenerate'}
          </button>
        </span>
      </div>
      <div className={refresh.isPending ? 'opacity-50 transition-opacity' : ''}>
        {isLoading ? (
          <div className="space-y-1.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-violet-200/60 dark:bg-violet-900/40" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-violet-200/60 dark:bg-violet-900/40" />
          </div>
        ) : sections.length > 0 ? (
          <div className="space-y-2.5">
            {sections.map((s) => (
              <div key={s.repoId}>
                <div className="mb-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-200">
                  {s.repoFullName}
                </div>
                <DigestMarkdown markdown={s.markdown} prRefs={s.prRefs} onOpenPr={openPr} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400">
            No digest yet — click Regenerate to summarise activity across all your repos.
          </p>
        )}
      </div>
    </div>
  );
}
