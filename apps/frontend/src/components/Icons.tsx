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

// External-link (arrow out of a box) — opens the entity on GitHub in a new tab.
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
