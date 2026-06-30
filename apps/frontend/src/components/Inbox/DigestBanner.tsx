import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepoDigest, useRefreshRepoDigests } from '../../hooks/useRepoDigest.js';
import { relativeTime } from '../../lib/ui.js';

// Friendly model label ('claude-haiku-4-5' → 'Haiku'); falls back to the raw id.
function modelLabel(model: string | undefined): string {
  if (!model) return 'Haiku';
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('opus')) return 'Opus';
  return model;
}

// The per-repo LLM "headlines" digest — the ONLY Pro/flagged surface inside Inbox.
// Rendered nothing-at-all unless pro.inboxDigest is true (no greyed stub, no layout
// shift, no in-card upsell). Lazily fetches its own per-repo query so a slow Haiku
// call never blocks the core grid. The amethyst sparkle + "Pro" tag matches the
// app's Claude/agentic accent (violet/purple).
export function DigestBanner({ repoId }: { repoId: number }): JSX.Element | null {
  const { inboxDigest } = useProCapabilities();
  // Hooks run unconditionally (rules of hooks); the query self-gates on `enabled`.
  const { data: digest, isLoading } = useRepoDigest(repoId, inboxDigest);
  const refresh = useRefreshRepoDigests();
  const regenerating = refresh.isPending && refresh.variables === repoId;

  // Absent Pro → render nothing. This is the load-bearing gate.
  if (!inboxDigest) return null;

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          <span aria-hidden="true">✨</span>
          Digest
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
            onClick={() => refresh.mutate(repoId)}
            disabled={regenerating}
            className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
            title="Regenerate this repo's digest (runs the cheap-tier model)"
          >
            <span aria-hidden="true">↻</span>
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
        </span>
      </div>
      <div className={regenerating ? 'opacity-50 transition-opacity' : ''}>
        {isLoading ? (
          <div className="h-3 w-2/3 animate-pulse rounded bg-violet-200/60 dark:bg-violet-900/40" />
        ) : digest != null && digest.summary.trim() !== '' ? (
          <p className="whitespace-pre-line text-xs leading-relaxed text-gray-700 dark:text-gray-200">
            {digest.summary}
          </p>
        ) : (
          <p className="text-xs text-gray-400">
            No digest yet — click Regenerate to summarise this repo's recent activity.
          </p>
        )}
      </div>
    </div>
  );
}
