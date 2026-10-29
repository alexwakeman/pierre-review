import type { ReactNode } from 'react';
import { cx } from './cx.js';

// STATUS = ICON + WORDS, AND COLOUR ONLY BY RULE (docs/redesign/DESIGN.md § Colour).
//
// The colour is not chosen per call site — it follows from what the status MEANS:
//   blocked → danger (red):  conflicts, failing CI, changes requested, a security alert, an error
//   ready   → success (green): can land now, approved, passing where passing is the news
//   active  → accent: the selection's own state, a run in progress the reader started
//   neutral → mute ink: everything else (waiting, queued, draft, reviewed, unknown)
//   quiet   → faint ink: a fact that is background (resolved, closed, n/a)
// The words always say the same thing as the colour, so colour is never the only signal.

export type StatusTone = 'blocked' | 'ready' | 'active' | 'neutral' | 'quiet';

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  blocked: 'text-ui-danger',
  ready: 'text-ui-success',
  active: 'text-ui-accent',
  neutral: 'text-ui-mute',
  quiet: 'text-ui-faint',
};

/**
 * One status: `<StatusIcon tone="blocked" icon={<ConflictIcon />} label="Conflicts" />`.
 * `iconOnly` hides the words visually (they stay for screen readers and as the tooltip) — for a
 * dense row whose column header already names the status.
 */
export function StatusIcon({
  tone,
  icon,
  label,
  iconOnly = false,
  /** Colour only the icon, words stay mute (a row's lead icon). */
  tintIconOnly = false,
  className,
  title,
}: {
  tone: StatusTone;
  icon: ReactNode;
  label: ReactNode;
  iconOnly?: boolean;
  tintIconOnly?: boolean;
  className?: string;
  title?: string;
}): JSX.Element {
  const toneCls = STATUS_TONE_CLASS[tone];
  return (
    <span
      className={cx('inline-flex min-w-0 items-center gap-1.5', !tintIconOnly && toneCls, className)}
      title={title ?? (iconOnly && typeof label === 'string' ? label : undefined)}
    >
      <span className={cx('flex shrink-0 items-center', tintIconOnly && toneCls)} aria-hidden>
        {icon}
      </span>
      <span className={cx(iconOnly ? 'sr-only' : 'truncate', tintIconOnly && 'text-ui-mute')}>{label}</span>
    </span>
  );
}
