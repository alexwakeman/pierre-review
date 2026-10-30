import type { CSSProperties } from 'react';

// Shared visual language for first-load placeholders. Mirrors the Activity console's
// structural skeleton (an `animate-pulse` block on a theme-aware surface) so every
// loading surface reads as one system. Dependency-free — pure Tailwind classes.

// The card/panel silhouette used by the Activity console: a pulsing bordered surface.
// Callers size it via `className` (e.g. "h-24", "h-3 w-1/2"); the pulse + theme-aware
// border/background come baked in.
const SURFACE =
  'animate-pulse rounded-ui bg-ui-surface';

// A structural block placeholder — a bordered card/bar silhouette. Pass sizing (and any
// positional offsets) via `className` / `style`.
export function SkeletonBlock({
  className = '',
  style,
}: {
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return <div className={`${SURFACE} ${className}`} style={style} aria-hidden="true" />;
}

// A single text-line placeholder — a filled (border-less) bar, for header/label rows.
// `className` supplies height + width (default `h-3 w-full`); `style` allows precise
// offsets (e.g. a timeline bar's left inset).
export function SkeletonLine({
  className = 'h-3 w-full',
  style,
}: {
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div
      className={`animate-pulse rounded-ui bg-ui-hover ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}
