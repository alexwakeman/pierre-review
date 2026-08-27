import type { ReactNode } from 'react';

// Shared inline SVG icons (the app deliberately ships no icon library — every icon is a
// hand-written Feather/Lucide/octicon-style path). Keep these tiny and presentational.
//
// ── WHY THIS MODULE EXISTS AT THE SIZE IT DOES ───────────────────────────────────────────────
// The SPA used to draw most of its iconography with literal Unicode: 🤖 for a bot, ✨ for a
// generated panel, ✕ for close, ▾ for a disclosure, ⚠ for a warning. Three things are wrong
// with a glyph in a text node, and all three had shipped:
//
//  1. AN EMOJI PAINTS ITS OWN COLOUR. 🙂 stayed a yellow face on both themes, could not be
//     dimmed with the button around it, and ignored every hover and disabled state. The same
//     was true of 🤖, 💬, ✨, 🎉 and the rest. `currentColor` is the entire point of an icon.
//  2. A GLYPH IS A FONT LOOKUP, so its advance width, baseline and weight are whatever the
//     user's platform decided. ✕ and ✓ land on different baselines from each other; ▾ and ▸
//     have visibly different optical sizes; ⚠ and ✅ silently become full-colour EMOJI on
//     several platforms because of the variation-selector default.
//  3. IT CANNOT BE SIZED. Everything here takes `size` in px and inherits colour, so a 13px
//     inline mark and a 15px header mark are the same drawing.
//
// So: every RENDERED pictograph is an icon from this file. What deliberately stayed a character
// is documented at the bottom of this comment, because "finish the migration" is a plausible
// and wrong instinct.
//
// ── THE CONTRACT ─────────────────────────────────────────────────────────────────────────────
// Every icon: a 24×24 viewBox, `currentColor`, a `size` prop in px, an optional `className`,
// and an optional `title`. `title` is the a11y switch — ABSENT means the icon is decorative
// (`aria-hidden`, the label is the adjacent text); PRESENT makes it `role="img"` with a
// `<title>`, for the icon-only buttons that have no adjacent text. That single rule is why the
// shell below exists rather than 30 hand-copied `<svg>` openings that drift.
//
// ── WHAT IS DELIBERATELY *NOT* AN ICON ───────────────────────────────────────────────────────
//  • Glyphs inside `title=` / `aria-label=` STRINGS. An attribute value is text; an SVG cannot
//    live there. Those were reworded, not converted.
//  • Typographic arrows inside prose and chart labels ("open → 1st review"). That is a
//    sentence, not a control.
//  • ▲ / ▼ inside the period-report MARKDOWN export (`periodReportMarkdown.ts`). The export is
//    a text artifact people paste elsewhere; it has no DOM.
//  • The backend CLI's ● / · / ↩ (`apps/backend/src/status.ts`) — a terminal, not a browser.
//  • ⚠️ 🛠️ 🧹 💡 ✅ inside REGEXES and test fixtures (`sync/review-fingerprint.ts`,
//    `sync/bot-resolution-markers.ts`, the bot-theme classifiers). Those match emoji that
//    CodeRabbit and friends write into their own comment bodies. Changing them silently breaks
//    bot classification, and no test of ours would fail in an obvious way.
//  • The landing arcade's ← → key legend, which names physical keys.

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

/**
 * The one `<svg>` shell every icon draws into, so the a11y contract and the stroke defaults
 * live in exactly one place.
 *
 * `variant: 'solid'` swaps stroke for fill — used by the marks that read as a blob when a
 * ~2px stroke is applied to a ~4px shape (the GitHub mark, the dropdown carets, the dot).
 */
function IconShell({
  size,
  className,
  title,
  children,
  strokeWidth = 2,
  variant = 'stroke',
}: IconProps & {
  children: ReactNode;
  strokeWidth?: number;
  variant?: 'stroke' | 'solid';
}): JSX.Element {
  const solid = variant === 'solid';
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={solid ? 'currentColor' : 'none'}
      stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={solid ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title == null ? true : undefined}
      role={title != null ? 'img' : undefined}
    >
      {title != null && <title>{title}</title>}
      {children}
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Navigation & chrome
   ───────────────────────────────────────────────────────────────────────────────────────── */

// Magnifying glass — the app's universal "reveal / focus on the timeline" affordance:
// the PR-detail Focus link, the pr-focus tab chip, and the per-thread / per-comment
// "Show" links all use it (each opens an isolated PR-focus timeline). Also the plain
// "search" mark wherever a search box or a search result needs one.
export function MagnifierIcon({ size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </IconShell>
  );
}

// Timeline — a small gantt of stacked bars, the "show this PR on the main timeline"
// affordance (centre + glow on the shared board, distinct from Focus Mode's isolated
// tab). Reads as a horizontal timeline of lanes.
export function TimelineIcon({ size = 15, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <line x1="4" y1="7" x2="14" y2="7" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="12" y2="17" />
    </IconShell>
  );
}

// GitHub mark (Octocat) — opens the entity on GitHub in a new tab. A filled glyph
// (not a stroke) so it reads as the familiar mark at small sizes.
export function OctocatIcon({ size = 15, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} variant="solid" {...rest}>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
    </IconShell>
  );
}

// "Open in its own tab" — a tabbed panel (window + tab strip), distinct from the
// ExternalLinkIcon's arrow (which means "open on GitHub"). Mirrors the app's PinnedTabsBar.
export function NewTabIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="8" y1="4" x2="8" y2="9" />
    </IconShell>
  );
}

// External-link (arrow out of a box) — "open this on github.com". Replaces the bare ↗.
export function ExternalLinkIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </IconShell>
  );
}

type Dir = 'up' | 'down' | 'left' | 'right';

const CHEVRON: Record<Dir, string> = {
  up: '6 15 12 9 18 15',
  down: '6 9 12 15 18 9',
  left: '15 6 9 12 15 18',
  right: '9 6 15 12 9 18',
};

/**
 * Chevron — EXPAND / COLLAPSE and pagination. Replaces ▾ ▸ ⌃ ⌄ ◀ ▶ and the ← / → in
 * "← Prev" / "Next →".
 *
 * ⚠ Not the same control as {@link CaretIcon}. A chevron says "this section opens"; a caret
 * says "this button has a menu". They were the same character (▾) before, which is why the two
 * roles were indistinguishable. Pick by what the click does, not by which way it points.
 */
export function ChevronIcon({
  dir = 'down',
  size = 12,
  ...rest
}: IconProps & { dir?: Dir }): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.5} {...rest}>
      <polyline points={CHEVRON[dir]} />
    </IconShell>
  );
}

const CARET: Record<Dir, string> = {
  down: 'M5 8.5h14L12 17.5z',
  up: 'M5 15.5h14L12 6.5z',
  right: 'M8.5 5v14L17.5 12z',
  left: 'M15.5 5v14L6.5 12z',
};

/**
 * Caret — a SOLID triangle, for a control that opens a MENU (the Workspace selector, the user
 * menu, every FilterBar select panel) and for the ▲/▼ delta markers in metric tables, where a
 * filled triangle beside a number is the conventional reading.
 */
export function CaretIcon({
  dir = 'down',
  size = 10,
  ...rest
}: IconProps & { dir?: Dir }): JSX.Element {
  return (
    <IconShell size={size} variant="solid" {...rest}>
      <path d={CARET[dir]} />
    </IconShell>
  );
}

const ARROW: Record<Dir, ReactNode> = {
  up: (
    <>
      <line x1="12" y1="20" x2="12" y2="5" />
      <polyline points="5.5 11.5 12 5 18.5 11.5" />
    </>
  ),
  down: (
    <>
      <line x1="12" y1="4" x2="12" y2="19" />
      <polyline points="5.5 12.5 12 19 18.5 12.5" />
    </>
  ),
  left: (
    <>
      <line x1="20" y1="12" x2="5" y2="12" />
      <polyline points="11.5 5.5 5 12 11.5 18.5" />
    </>
  ),
  right: (
    <>
      <line x1="4" y1="12" x2="19" y2="12" />
      <polyline points="12.5 5.5 19 12 12.5 18.5" />
    </>
  ),
};

/** A plain directional arrow — token in/out, over/under-call, "newer/older". */
export function ArrowIcon({
  dir = 'right',
  size = 12,
  ...rest
}: IconProps & { dir?: Dir }): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      {ARROW[dir]}
    </IconShell>
  );
}

// Close / dismiss / clear — every ✕ in the app, and the ✗ that marks a failed check.
export function CloseIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.2} {...rest}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </IconShell>
  );
}

// Funnel — "this view is NARROWED". The isolation banners on the Feed and the attention board.
// (It replaces ☰, which drew a list and therefore said nothing about the narrowing.)
export function FilterIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <path d="M3.5 5h17l-6.6 7.7v5.8l-3.8 2.4v-8.2z" />
    </IconShell>
  );
}

// The Workspace mark — the app's ONE scope. A faceted diamond, kept close to the ◈ it replaces
// because that glyph is referred to by shape in the help text.
export function WorkspaceIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.8} {...rest}>
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" />
      <path d="M12 8.4 15.6 12 12 15.6 8.4 12z" />
    </IconShell>
  );
}

// Cog — Settings.
export function GearIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.8} {...rest}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.1 14.4a1.5 1.5 0 0 0 .3 1.66l.05.05a1.9 1.9 0 1 1-2.68 2.68l-.05-.05a1.5 1.5 0 0 0-2.56 1.06v.15a1.9 1.9 0 1 1-3.8 0v-.08a1.5 1.5 0 0 0-2.6-1.02l-.05.05a1.9 1.9 0 1 1-2.68-2.68l.05-.05A1.5 1.5 0 0 0 4 12.05h-.15a1.9 1.9 0 1 1 0-3.8h.08A1.5 1.5 0 0 0 4.95 5.7l-.05-.05A1.9 1.9 0 1 1 7.58 2.97l.05.05a1.5 1.5 0 0 0 1.66.3h.07A1.5 1.5 0 0 0 10.28 1.9v-.15a1.9 1.9 0 1 1 3.8 0v.08a1.5 1.5 0 0 0 2.56 1.06l.05-.05a1.9 1.9 0 1 1 2.68 2.68l-.05.05a1.5 1.5 0 0 0-.3 1.66v.07a1.5 1.5 0 0 0 1.38.92h.15a1.9 1.9 0 1 1 0 3.8h-.08a1.5 1.5 0 0 0-1.37.92z" />
    </IconShell>
  );
}

// Theme toggle.
export function SunIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.4v2.3M12 19.3v2.3M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.4 12h2.3M19.3 12h2.3M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
    </IconShell>
  );
}

export function MoonIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M20.6 14.4A8.7 8.7 0 0 1 9.6 3.4a8.7 8.7 0 1 0 11 11z" />
    </IconShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Status & verdicts
   ───────────────────────────────────────────────────────────────────────────────────────── */

// A bare tick — the transient "copied" confirmation, an approved review, a done step.
export function CheckIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.5} {...rest}>
      <polyline points="20 6 9 17 4 12" />
    </IconShell>
  );
}

// Tick in a circle — "this is settled": an approving review, a green check suite, and the
// all-clear empty states that used to end in 🎉.
export function CheckCircleIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8.2 12.2 10.9 14.9 15.9 9.4" />
    </IconShell>
  );
}

// Triangle + bang — a warning. Replaces ⚠, which renders as a FULL-COLOUR EMOJI on several
// platforms (the variation-selector default), making it the loudest thing on the screen.
export function WarningIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <path d="M10.7 3.9 2.4 18.6a1.5 1.5 0 0 0 1.3 2.2h16.6a1.5 1.5 0 0 0 1.3-2.2L13.3 3.9a1.5 1.5 0 0 0-2.6 0z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <circle cx="12" cy="17.3" r="1.05" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

// Circled i — an inline footnote/explanation marker.
export function InfoIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11.2" x2="12" y2="16.6" />
      <circle cx="12" cy="7.7" r="1.05" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

// A stopwatch — "waiting on a clock": auto-merge armed, a stalled PR, a time-to-first-review
// figure.
export function TimerIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="13.6" r="7.4" />
      <path d="M12 9.8v3.8l2.4 1.8" />
      <path d="M9.6 2.6h4.8" />
      <path d="M18.7 6.5 20.2 5" />
    </IconShell>
  );
}

// A hollow ring — the anomaly marker on the bot charts (a point that sits outside its own
// baseline). Deliberately just an outline: it annotates a datum, it is not a status.
export function RingIcon({ size = 10, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.4} {...rest}>
      <circle cx="12" cy="12" r="7.5" />
    </IconShell>
  );
}

// A quarter-filled circle — PARTIAL COVERAGE. The period reports' marker for a window that was
// only partly tracked, so a comparison across it mixes memberships.
export function PartialCircleIcon({ size = 11, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 3.6A8.4 8.4 0 0 1 20.4 12H12z" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

// A small hollow triangle — THIN SAMPLE. "The figure is real but rests on few items."
export function ThinSampleIcon({ size = 10, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.2} {...rest}>
      <path d="M12 5.5 19.6 18.6H4.4z" />
    </IconShell>
  );
}

// Scales — a comparison of two populations against each other (the severity-agreement matrix,
// the bot-vs-ours panels).
export function ScalesIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.8} {...rest}>
      <line x1="12" y1="4.2" x2="12" y2="20.4" />
      <line x1="7.4" y1="20.4" x2="16.6" y2="20.4" />
      <line x1="4" y1="7.4" x2="20" y2="7.4" />
      <path d="M7 7.6 4.2 13.6h5.6z" />
      <path d="M17 7.6 14.2 13.6h5.6z" />
    </IconShell>
  );
}

// A filled dot — a status bullet where a CSS circle would not inherit the icon's sizing rules.
export function DotIcon({ size = 8, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} variant="solid" {...rest}>
      <circle cx="12" cy="12" r="6" />
    </IconShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Git objects
   ───────────────────────────────────────────────────────────────────────────────────────── */

// Octicon git-pull-request — a PR, wherever one needs a mark of its own.
export function PullRequestIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="6.5" cy="6" r="2.4" />
      <circle cx="6.5" cy="18" r="2.4" />
      <line x1="6.5" y1="8.4" x2="6.5" y2="15.6" />
      <circle cx="17.5" cy="18" r="2.4" />
      <path d="M17.5 15.6V8a2 2 0 0 0-2-2h-2.6" />
      <polyline points="15.2 3.6 12.7 6 15.2 8.4" />
    </IconShell>
  );
}

// Octicon git-merge — the Merge control.
export function MergeIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="7" cy="6" r="2.4" />
      <circle cx="7" cy="18" r="2.4" />
      <circle cx="17" cy="11.5" r="2.4" />
      <line x1="7" y1="8.4" x2="7" y2="15.6" />
      <path d="M14.6 11.5H12A5 5 0 0 1 7 6.5" />
    </IconShell>
  );
}

// Octicon git-commit — a commit, and the Feed's "Commits" lens.
export function CommitIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="12" r="3.4" />
      <line x1="2.6" y1="12" x2="8.6" y2="12" />
      <line x1="15.4" y1="12" x2="21.4" y2="12" />
    </IconShell>
  );
}

// Two chasing arrows (Feather refresh-cw) — "re-read this from GitHub now", and every
// "Regenerate" affordance. Spun via className while a refresh is in flight.
export function RefreshIcon({ size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </IconShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   People, bots & conversation
   ───────────────────────────────────────────────────────────────────────────────────────── */

// A robot's head — automation. THE most-repeated emoji in the app before this module
// (31 rendered sites), and the one whose fixed colour was most visible: a bot chip could never
// be dimmed, hovered or themed.
export function BotIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <rect x="3.6" y="8" width="16.8" height="12.4" rx="3" />
      <path d="M12 8V5.2" />
      <circle cx="12" cy="3.6" r="1.5" />
      <circle cx="8.8" cy="13.4" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.2" cy="13.4" r="1.3" fill="currentColor" stroke="none" />
      <path d="M9.6 17.2h4.8" />
    </IconShell>
  );
}

// Head and shoulders — one person.
export function PersonIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20.4a7.2 7.2 0 0 1 14.4 0" />
    </IconShell>
  );
}

// Two overlapping figures — a group of people (the People report, the members picker).
export function PeopleIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.8} {...rest}>
      <circle cx="9.4" cy="8.4" r="3.3" />
      <path d="M3.2 20.2a6.2 6.2 0 0 1 12.4 0" />
      <path d="M16.4 5.5a3.3 3.3 0 0 1 0 5.8" />
      <path d="M17.4 14.3a6.2 6.2 0 0 1 3.4 5.9" />
    </IconShell>
  );
}

// A speech bubble — a comment.
export function CommentIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M21 15a2 2 0 0 1-2 2H7.5L3 21V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </IconShell>
  );
}

// A speech bubble with content — a review THREAD (a conversation, not a single remark).
export function ThreadsIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M21 15a2 2 0 0 1-2 2H7.5L3 21V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="7.2" y1="8.2" x2="16.8" y2="8.2" />
      <line x1="7.2" y1="12" x2="13" y2="12" />
    </IconShell>
  );
}

// A speech bubble with a tick — RESOLVING a conversation. Replaces the 🧹 on "Resolve bot
// threads" and on the likely-addressed counts: the action is closing threads, not tidying, and
// a broom at 13px reads as noise.
export function ResolveIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M21 14.6a2 2 0 0 1-2 2H7.6L3.4 20.6V5.4a2 2 0 0 1 2-2h13.6a2 2 0 0 1 2 2z" />
      <polyline points="8.4 9.8 10.8 12.2 15.6 7.4" />
    </IconShell>
  );
}

// A document with a tick — a submitted REVIEW (as opposed to a loose comment).
export function ReviewIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.8} {...rest}>
      <path d="M6.5 3h7.2L19 8.3V20a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <polyline points="13.4 3.2 13.4 8.4 18.8 8.4" />
      <polyline points="8.6 14.6 10.6 16.6 14.8 12.2" />
    </IconShell>
  );
}

// An open eye — "what this looks like" / a watched summary.
export function EyeIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="3" />
    </IconShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Generated content, data & pinning
   ───────────────────────────────────────────────────────────────────────────────────────── */

// Two stars — GENERATED BY A MODEL. The one mark that must be unmistakable, because it is the
// app's only signal that a panel's prose came from an LLM rather than from a query. Pair it
// with the `--ai-*` tokens (`text-ai-signal`), never with a neutral grey.
export function SparkleIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.7} {...rest}>
      <path d="M10.6 3.2 12.3 8.3 17.4 10 12.3 11.7 10.6 16.8 8.9 11.7 3.8 10 8.9 8.3z" />
      <path d="M17.8 14.2 18.7 16.7 21.2 17.6 18.7 18.5 17.8 21 16.9 18.5 14.4 17.6 16.9 16.7z" />
    </IconShell>
  );
}

// Bars — charts / analytics.
export function ChartIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.1} {...rest}>
      <line x1="6" y1="20" x2="6" y2="13.5" />
      <line x1="12" y1="20" x2="12" y2="4.5" />
      <line x1="18" y1="20" x2="18" y2="9.5" />
    </IconShell>
  );
}

// A drawing pin — pinning a prompt or a panel.
export function PinIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M9.4 3h5.2l-.9 5.6 3.7 3v1.8H6.6v-1.8l3.7-3z" />
      <line x1="12" y1="13.4" x2="12" y2="21" />
    </IconShell>
  );
}

// A star — "on my plate": the Feed's My Turn lens, and a repo's stargazer count.
export function StarIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.8} {...rest}>
      <path d="M12 3.4 14.7 8.9l6 .9-4.35 4.24 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.8l6-.9z" />
    </IconShell>
  );
}

// Smiley — the "add a reaction" affordance, deliberately shaped like GitHub's own octicon so
// the control reads as the same thing it is on github.com. Simplified to outline + two dots +
// a curve rather than tracing the octicon path, which keeps it legible at 13px.
//
// It was the FIRST glyph converted, and its reasoning generalised into this whole module: the
// emoji it replaced (🙂) painted its own fixed colour, so it stayed a yellow face on both themes
// and could not be dimmed with the rest of the button. Inheriting the colour is what makes the
// light/dark and hover states work at all. The eyes are filled — an r≈1 circle stroked at
// width 2 is a blob.
export function SmileyIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <circle cx="12" cy="12" r="9" />
      {/* Quadratic, not an elliptical arc: the sweep-flag of `a4.5 4.5 0 0 0 8 0` is easy to
          get backwards and yields a frown with no error anywhere. */}
      <path d="M8 14 Q12 17.4 16 14" />
      <circle cx="9" cy="9.8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9.8" r="1.15" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

// Feed — stacked dot-and-line rows, the "show this PR in the Activity feed (isolated to it)"
// affordance in the PR-detail header.
export function FeedIcon({ size = 15, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <circle cx="5" cy="6" r="1" />
      <line x1="9" y1="6" x2="20" y2="6" />
      <circle cx="5" cy="12" r="1" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <circle cx="5" cy="18" r="1" />
      <line x1="9" y1="18" x2="20" y2="18" />
    </IconShell>
  );
}

// Two overlapping sheets — the universal "copy to clipboard" affordance.
export function CopyIcon({ size = 13, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} {...rest}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </IconShell>
  );
}

// Six dots in two columns — a DRAG GRIP. It replaced a braille glyph (⠿), which is the worst
// case of the font-lookup problem: the AI-Fix comment picker reasons about that handle as a
// "~11×12px" box when deciding its 4px drag threshold, and a braille cell's actual advance width
// is whatever the platform's fallback font says. An explicit `size` makes that box real.
export function GripIcon({ size = 11, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} variant="solid" {...rest}>
      <circle cx="9" cy="6" r="1.7" />
      <circle cx="15" cy="6" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="18" r="1.7" />
      <circle cx="15" cy="18" r="1.7" />
    </IconShell>
  );
}

// A bare rule — a NEUTRAL check outcome ("it ran, it decided nothing").
export function MinusIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={2.2} {...rest}>
      <line x1="6" y1="12" x2="18" y2="12" />
    </IconShell>
  );
}

// A struck-through circle — a SKIPPED check. Deliberately not an X: skipped is "never ran",
// which is a different fact from failed, and the two sit in the same column.
export function SkipIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="12" r="8.6" />
      <line x1="6.4" y1="6.4" x2="17.6" y2="17.6" />
    </IconShell>
  );
}

// A circled query — an UNKNOWN check state. It is a real answer ("GitHub told us nothing"),
// which is why it gets a mark of its own rather than being drawn as a failure.
export function QuestionIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.4 9.6a2.7 2.7 0 1 1 3.5 2.6c-.75.28-1.1.85-1.1 1.6v.5" />
      <circle cx="11.8" cy="17" r="1" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

// A pencil — edit in place (renaming a Workspace, editing a saved prompt).
export function PencilIcon({ size = 12, ...rest }: IconProps): JSX.Element {
  return (
    <IconShell size={size} strokeWidth={1.9} {...rest}>
      <path d="M16.4 3.6a2.3 2.3 0 0 1 3.3 3.3L8.2 18.4l-4.3 1 1-4.3z" />
      <line x1="14.6" y1="5.4" x2="17.9" y2="8.7" />
    </IconShell>
  );
}
