import type { DigestPrRef, RepoDigest } from '@pierre-review/shared';
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

// One repo's Pro digest, rendered as a COLLAPSIBLE amethyst card. Presentational only —
// the caller owns the data (single-repo `useRepoDigest` or the Feed collection's
// `useRepoDigests`) and the collapse state (persisted per repo via useDigestCollapse). The
// title is "Digest" in a repo's own console and the repo's full name in the cross-repo
// collection, so the reader can tell the cards apart.
export function RepoDigestCard({
  digest,
  isLoading,
  title,
  collapsed,
  onToggle,
  onRegenerate,
  regenerating = false,
  onOpenPr,
  showProBadge = true,
}: {
  digest: RepoDigest | undefined;
  isLoading: boolean;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
  onOpenPr: (ref: DigestPrRef) => void;
  // The "Pro" chip on the card. Hidden in the Feed collection (which shows one shared
  // "Pro" marker at the top); shown on a standalone single-repo card (its own top).
  showProBadge?: boolean;
}): JSX.Element {
  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 dark:border-violet-900/50 dark:bg-violet-950/20">
      {/* The whole header row toggles collapse (so a collapsed card expands from
          anywhere on it, and the top collapses it again). The inner controls stop
          propagation: the title stays a focusable button for keyboard, Regenerate
          runs without also toggling. */}
      <div
        onClick={onToggle}
        className="-mx-1 flex cursor-pointer select-none items-center gap-2 rounded px-1 hover:bg-violet-500/5"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200"
          title={collapsed ? 'Expand digest' : 'Collapse digest'}
        >
          <span aria-hidden="true" className="text-[9px]">
            {collapsed ? '▸' : '▾'}
          </span>
          <span aria-hidden="true">✨</span>
          <span className="truncate normal-case">{title}</span>
        </button>
        {showProBadge && (
          <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
            Pro
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-gray-400">
          {digest != null && (
            <span title={digest.model}>
              {modelLabel(digest.model)}
              {' · '}
              {relativeTime(digest.generatedAt)}
              {digest.stale ? ' · stale' : ''}
            </span>
          )}
          {onRegenerate != null && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRegenerate?.();
              }}
              disabled={regenerating}
              className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
              title="Regenerate this repo's digest (runs the cheap-tier model)"
            >
              <span aria-hidden="true">↻</span>
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
          )}
        </span>
      </div>
      {!collapsed && (
        <div className="mt-1">
          {regenerating ? (
            // Refreshing: drop the old text, show a skeleton "shine swipe". The card
            // un-dims (skeleton → fresh content) the instant its digest streams in
            // and `regenerating` flips false.
            <DigestSkeleton />
          ) : isLoading ? (
            <div className="h-3 w-2/3 animate-pulse rounded bg-violet-200/60 dark:bg-violet-900/40" />
          ) : digest != null && digest.summary.trim() !== '' ? (
            // Keyed by generatedAt so `digest-fade-in` replays on each new summary.
            <div key={digest.generatedAt} className="digest-fade-in">
              <DigestMarkdown
                markdown={digest.summary}
                prRefs={digest.prRefs}
                onOpenPr={onOpenPr}
              />
            </div>
          ) : (
            <p className="text-xs text-gray-400">
              No digest yet — click Regenerate to summarise this repo's recent activity.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Placeholder lines with a sweeping shine, shown in place of the summary while it
// regenerates (widths vary to mimic a bulleted change-report). Purely decorative.
function DigestSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 py-0.5" aria-hidden="true">
      {['92%', '80%', '66%', '74%'].map((w, i) => (
        <div key={i} className="digest-skeleton-line h-3" style={{ width: w }} />
      ))}
    </div>
  );
}
