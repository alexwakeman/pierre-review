import type { ReactNode } from 'react';
import { cx, FOCUS_RING } from '../ui/index.js';

// The Reports + Bots Monitoring chrome (docs/redesign/DESIGN.md): ONE page header per page, quiet
// section headings, callouts on a tone (never a coloured box), and the table look the two screens
// share. Screen-local on purpose — the shared primitives live in `components/ui/`.

/** The page header: the title (the page's one `text-display`), an optional sentence, the tabs. */
export function PageHeader({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** The page's tab strip. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <header className="space-y-3">
      <div className="min-w-0">
        <h2 className="text-display text-ui-ink">{title}</h2>
        {sub != null && <p className="mt-0.5 text-body text-ui-mute">{sub}</p>}
      </div>
      {children}
    </header>
  );
}

/** A section heading: words in ink at title size, the ⓘ beside them, a meta caption after. */
export function SectionHeading({
  title,
  info,
  caption,
  aside,
  as: Tag = 'h3',
  className,
}: {
  title: ReactNode;
  info?: ReactNode;
  caption?: ReactNode;
  aside?: ReactNode;
  as?: 'h3' | 'h4';
  className?: string;
}): JSX.Element {
  return (
    <div className={cx('flex flex-wrap items-baseline gap-x-3 gap-y-1', className)}>
      <div className="flex min-w-0 items-center gap-1">
        <Tag className="text-title text-ui-ink">{title}</Tag>
        {info}
      </div>
      {caption != null && <span className="min-w-0 text-meta text-ui-mute">{caption}</span>}
      {aside != null && <div className="ml-auto flex items-center gap-2">{aside}</div>}
    </div>
  );
}

export type CalloutTone = 'warn' | 'info' | 'neutral';

const CALLOUT_ICON_TONE: Record<CalloutTone, string> = {
  warn: 'text-ui-warn',
  info: 'text-ui-accent',
  neutral: 'text-ui-faint',
};

/**
 * A banner as a quiet callout: a tone ground, a tinted icon, ink words. When `onClick` is set the
 * whole callout is one button and `action` names where it goes ("Show list").
 */
export function Callout({
  tone = 'neutral',
  icon,
  children,
  action,
  onClick,
  title,
  testId,
  className,
}: {
  tone?: CalloutTone;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  title?: string;
  testId?: string;
  className?: string;
}): JSX.Element {
  const body = (
    <>
      {icon != null && <span className={cx('mt-0.5 flex shrink-0', CALLOUT_ICON_TONE[tone])}>{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {action != null && (
        <span className="shrink-0 self-center whitespace-nowrap text-body font-medium text-ui-accent">{action}</span>
      )}
    </>
  );
  const base = cx(
    'flex w-full items-start gap-2.5 rounded-ui bg-ui-surface px-3 py-2.5 text-left text-body text-ui-ink',
    className,
  );
  if (!onClick) {
    return (
      <div className={base} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={cx(base, 'hover:bg-ui-hover motion-safe:transition-colors motion-safe:duration-ui-fast touch:min-h-11', FOCUS_RING)}
    >
      {body}
    </button>
  );
}

/**
 * Segmented choice (a window picker, a grain switch): one tone ground, the chosen segment on
 * `sel`. Real buttons with `aria-pressed`, so tests and screen readers read the choice.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: readonly { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  testId?: string;
}): JSX.Element {
  return (
    <div role="group" aria-label={label} data-testid={testId} className="inline-flex shrink-0 rounded-ui bg-ui-surface p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'h-7 rounded-ui px-2.5 text-body tabular-nums touch:h-10 touch:min-w-10 touch:px-3',
              on ? 'bg-ui-sel text-ui-ink' : 'text-ui-mute hover:text-ui-ink',
              FOCUS_RING,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Tables ────────────────────────────────────────────────────────────────────────────────────
// Tone, not borders: the header row sits on nothing, rows hover on `hover`, the first column is
// sticky inside the table's OWN scroll box (`TABLE_SCROLL`) so a wide table never widens the page.
export const TABLE_SCROLL = 'max-w-full overflow-x-auto overscroll-x-contain rounded-ui bg-ui-surface';
export const TABLE = 'w-full border-separate border-spacing-0 text-body tabular-nums';
export const TH = 'whitespace-nowrap px-2 py-2 text-left text-meta font-normal text-ui-mute';
export const TD = 'px-2 py-1.5';
export const TR_HOVER = 'hover:bg-ui-hover motion-safe:transition-colors motion-safe:duration-ui-fast';
/** The sticky first column (header and body cells): same ground as the table box. */
export const STICKY_COL = 'sticky left-0 z-[1] bg-ui-surface';

/**
 * A plain table's scroll box with the FIRST column pinned (on a page-ground table): on a phone the
 * title column stays put and narrows to ~55% of the screen while the figures scroll beside it.
 */
export const TABLE_BOX_STICKY_FIRST =
  'max-w-full overflow-x-auto overscroll-x-contain' +
  ' [&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[1] [&_tr>*:first-child]:bg-ui-bg' +
  ' [&_tr:hover>*:first-child]:bg-ui-hover max-sm:[&_tr>*:first-child]:max-w-[55vw] max-sm:[&_tr>*:first-child]:min-w-[40vw]';
