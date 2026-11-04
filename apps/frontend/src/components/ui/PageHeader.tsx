import type { ReactNode } from 'react';
import { cx } from './cx.js';

// THE PAGE HEADER (docs/redesign/DESIGN.md § 1, § 4): every destination opens on ONE slim header —
// the title (the page's one `text-display`), what sits beside it (an ⓘ, a count), an optional line
// under it, the page's actions at the end of the title row, then the page's tabs / toolbar.
//
// ⚠ ONE HORIZONTAL GUTTER, `PAGE_GUTTER`, so every page title starts at the same x. A page whose
// body is padded by the same token (the Activity pane, the story tab) passes `inset={false}` and the
// title still lands on the gutter; nothing else may pad a page header horizontally.
//
// ⚠ ONE TOP DISTANCE, `PAGE_HEADER_TOP`, so every page title sits at the same height under the top
// of the main content (12px on a phone, 20px from md; below lg the slim top bar sits above it on every
// page alike). A view that cannot be a `PageHeader` (the full-screen PR detail) uses the same tokens
// and marks its title `data-page-title`; e2e/header-geometry.spec.ts measures every destination.
// Nothing else ever sits in the title row's top-right corner: the toasts are a bottom-right cluster
// out of the page flow (HeaderToasts.tsx), so a toast appearing never moves a page.

/** The one horizontal padding of a page: a phone's 16px, 28px from md. */
export const PAGE_GUTTER = 'px-4 md:px-7';

/** The one top padding of a page header: 12px on a phone, 20px from md. */
export const PAGE_HEADER_TOP = 'pt-5 max-md:pt-3';

export function PageHeader({
  title,
  titleId,
  info,
  sub,
  actions,
  children,
  inset = true,
  flushBottom = false,
  className,
  testId,
}: {
  title: ReactNode;
  titleId?: string;
  /** Beside the title: its ⓘ, a count, a quiet fact. */
  info?: ReactNode;
  /** Under the title: one sentence, or the page's few quiet lines. */
  sub?: ReactNode;
  /** The end of the title row (the page's one primary action and its quiet companions). Drops under
   *  the title on a phone. */
  actions?: ReactNode;
  /** The page's tabs / toolbar, under the title row. */
  children?: ReactNode;
  /** false when the page's own box already pads by `PAGE_GUTTER`. */
  inset?: boolean;
  /** No bottom padding: the page's own toolbar row follows straight on (the Timeline's filters). */
  flushBottom?: boolean;
  className?: string;
  testId?: string;
}): JSX.Element {
  return (
    <header data-testid={testId} className={cx('shrink-0', PAGE_HEADER_TOP, !flushBottom && 'pb-3', inset && PAGE_GUTTER, className)}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 max-w-full basis-full md:basis-auto md:flex-[1_0_auto]">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 id={titleId} data-page-title className="min-w-0 break-words text-display text-ui-ink">
              {title}
            </h2>
            {info}
          </div>
        </div>
        {actions != null && actions !== false && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {/* The line under the title takes the FULL width: inside the title's column it was squeezed
          to a sliver by the actions beside it. */}
      {typeof sub === 'string' ? <p className="mt-0.5 text-body text-ui-mute">{sub}</p> : sub}
      {children}
    </header>
  );
}
