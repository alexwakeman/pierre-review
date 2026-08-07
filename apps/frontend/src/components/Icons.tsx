// Shared inline SVG icons (the app deliberately ships no icon library — every icon is a
// hand-written Feather/Lucide-style path). Keep these tiny and presentational.

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

// Magnifying glass — the app's universal "reveal / focus on the timeline" affordance:
// the PR-detail Focus link, the pr-focus tab chip, and the per-thread / per-comment
// "Show" links all use it (each opens an isolated PR-focus timeline).
export function MagnifierIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

// Timeline — a small gantt of stacked bars, the "show this PR on the main timeline"
// affordance (centre + glow on the shared board, distinct from Focus Mode's isolated
// tab). Reads as a horizontal timeline of lanes.
export function TimelineIcon({ size = 15, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <line x1="4" y1="7" x2="14" y2="7" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="12" y2="17" />
    </svg>
  );
}

// GitHub mark (Octocat) — opens the entity on GitHub in a new tab. A filled glyph
// (not a stroke) so it reads as the familiar mark at small sizes.
export function OctocatIcon({ size = 15, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
    </svg>
  );
}

// External-link (arrow out of a box) — opens the entity on GitHub in a new tab.
// "Open in its own tab" — a tabbed panel (window + tab strip), distinct from the
// ExternalLinkIcon's ↗ (which means "open on GitHub"). Mirrors the app's PinnedTabsBar.
export function NewTabIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="8" y1="4" x2="8" y2="9" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// Refresh — two chasing arrows (Feather refresh-cw), the PR-detail header's "re-read this
// PR from GitHub now" button. Spun via className while a refresh is in flight.
export function RefreshIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

// Feed — stacked dot-and-line rows, the "show this PR in the Activity feed (isolated to it)"
// affordance in the PR-detail header.
export function FeedIcon({ size = 15, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      <circle cx="5" cy="6" r="1" />
      <line x1="9" y1="6" x2="20" y2="6" />
      <circle cx="5" cy="12" r="1" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <circle cx="5" cy="18" r="1" />
      <line x1="9" y1="18" x2="20" y2="18" />
    </svg>
  );
}
