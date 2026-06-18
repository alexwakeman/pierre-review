import { WATCHED_TITLE } from '../lib/ui.js';

// A small eye glyph marking a repo as "watched": new open PRs by others here flow
// into your My Turn inbox (the per-repo Watch toggle). Rendered next to the repo
// name wherever it appears. Mirrors the timeline label's watchedGlyphHtml — keep
// the SVG in sync with lib/ui.ts.
export function WatchedBadge({
  size = 12,
  className = '',
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center text-sky-500 ${className}`}
      title={WATCHED_TITLE}
      aria-label="Watched repo"
    >
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
        <path
          d="M8 4C4.6 4 1.9 6.2 1 8c.9 1.8 3.6 4 7 4s6.1-2.2 7-4c-.9-1.8-3.6-4-7-4Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <circle cx="8" cy="8" r="1.9" fill="currentColor" />
      </svg>
    </span>
  );
}
