import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { cx } from './cx.js';

// THE PAGE HEADER (docs/redesign/DESIGN.md § 1, § 4): every destination opens on ONE slim header —
// the title (the page's one `text-display`), what sits beside it (an ⓘ, a count), an optional line
// under it, the page's actions at the end of the title row, then the page's tabs / toolbar.
//
// ⚠ ONE HORIZONTAL GUTTER, `PAGE_GUTTER`, so every page title starts at the same x. A page whose
// body is padded by the same token (the Activity pane, the story tab) passes `inset={false}` and the
// title still lands on the gutter; nothing else may pad a page header horizontally.
//
// ⚠ THE TOAST SEAT. At ≥ lg with no pinned tabs the top bar collapses and the ONE header toast strip
// (HeaderToasts.tsx, mounted once in App.tsx) is PORTALLED into the end of the title row of the page
// header on screen (`usePageToastSlot`). It is the same strip moved, never a second one. Below lg (or
// with tabs open) the slot stays empty and the strip lives in the top bar, where a SidePanel sheet
// measures it (`[data-shell-topbar]`).

/** The one horizontal padding of a page: a phone's 16px, 28px from md. */
export const PAGE_GUTTER = 'px-4 md:px-7';

// The mounted page headers' toast slots, in mount order. The newest wins: a full-main overlay
// mounts its header after the board underneath it, and unmounting it hands the strip back.
// ⚠ A slot scrolled OUT OF VIEW is not a seat: on a page that scrolls as a whole the header leaves
// the screen, and a toast raised then would be painted where nobody can see it. While the newest
// slot is off screen the hook answers null, so the strip goes back to the top bar (which shows).
const useSlots = create<{ slots: HTMLElement[]; hidden: ReadonlySet<HTMLElement> }>(() => ({
  slots: [],
  hidden: new Set(),
}));

/** The toast slot of the page header on screen, or null when none is mounted and in view. */
export function usePageToastSlot(): HTMLElement | null {
  return useSlots((s) => {
    const el = s.slots[s.slots.length - 1];
    return el != null && !s.hidden.has(el) ? el : null;
  });
}

function setHidden(el: HTMLElement, hide: boolean): void {
  useSlots.setState((s) => {
    if (s.hidden.has(el) === hide) return s;
    const next = new Set(s.hidden);
    if (hide) next.add(el);
    else next.delete(el);
    return { hidden: next };
  });
}

function PageToastSlot(): JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (el == null) return;
    useSlots.setState((s) => ({ slots: [...s.slots, el] }));
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            for (const e of entries) setHidden(el, !e.isIntersecting);
          })
        : null;
    io?.observe(el);
    return () => {
      io?.disconnect();
      useSlots.setState((s) => {
        const hidden = new Set(s.hidden);
        hidden.delete(el);
        return { slots: s.slots.filter((x) => x !== el), hidden };
      });
    };
  }, [el]);
  // Desktop only: below lg the strip stays in the top bar. Empty, it takes no room.
  return <div ref={setEl} data-page-toasts className="hidden min-w-0 max-w-[min(34rem,45%)] shrink justify-end self-start lg:flex" />;
}

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
    <header data-testid={testId} className={cx('shrink-0 pt-5 max-md:pt-3', !flushBottom && 'pb-3', inset && PAGE_GUTTER, className)}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 basis-full md:basis-0 md:flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 id={titleId} className="min-w-0 break-words text-display text-ui-ink">
              {title}
            </h2>
            {info}
          </div>
          {typeof sub === 'string' ? <p className="mt-0.5 text-body text-ui-mute">{sub}</p> : sub}
        </div>
        {actions != null && actions !== false && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        <PageToastSlot />
      </div>
      {children}
    </header>
  );
}
