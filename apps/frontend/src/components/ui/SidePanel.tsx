import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon, CloseIcon } from '../Icons.js';
import { IconButton } from './Button.js';
import { cx } from './cx.js';
import { escapeBelongsToLayer } from './keys.js';
import { useIsDesktop, useIsPhone } from './media.js';

// THE SIDE PANEL (docs/redesign/DESIGN.md § Side panel).
//
// A row's detail lives here. Its STRUCTURE follows the width:
//   ≥ lg (1024): DOCKED — an <aside> column the parent lays out beside the list (grid/flex). The
//                list stays usable: j/k keep moving and the panel follows the selection.
//   md – lg:     a SHEET from the right (440px), over a scrim, modal.
//   < md:        a FULL-SCREEN sheet, modal, with a Back button (top-left) instead of ×.
// Escape closes it (capture phase, so the app's global Esc never also fires) unless an open
// control or popover inside owns the key. As a sheet it traps Tab and returns focus to the opener.
// `footer` is the action bar: pinned to the bottom, where a thumb reaches it on a phone.
// ⚠ AS A SHEET IT STARTS BELOW THE TOP BAR (`[data-shell-topbar]`, measured at open), never over
// it: the ONE header toast strip lives there, and an action taken in the sheet (Dismiss, Approve,
// Merge) raises its Undo card in that strip. A sheet over the strip hid the only way back.

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  headerActions,
  footer,
  children,
  closeLabel = 'Close',
  className,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Icon buttons beside the close button (open on GitHub, copy link). */
  headerActions?: ReactNode;
  /** The action bar. Put the ONE primary Button first. */
  footer?: ReactNode;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  testId?: string;
}): JSX.Element | null {
  const docked = useIsDesktop();
  const phone = useIsPhone();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes this layer (both modes).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!escapeBelongsToLayer(e)) return;
      // A modal opened OVER a docked panel (Settings, the palette) owns its own Escape.
      if (docked && document.querySelector('[aria-modal="true"]')) return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, docked]);

  // As a sheet: take focus, trap Tab, give focus back on close.
  useEffect(() => {
    if (!open || docked) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !panel) return;
      const f = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      opener?.focus?.();
    };
  }, [open, docked]);

  // The top bar's bottom edge, so the sheet (and its scrim) start under the toast strip.
  const [topInset, setTopInset] = useState(0);
  useLayoutEffect(() => {
    if (!open || docked) return;
    const measure = (): void => {
      const bar = document.querySelector<HTMLElement>('[data-shell-topbar]');
      setTopInset(bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, docked]);

  if (!open) return null;

  const header = (
    <header className="flex shrink-0 items-start gap-2 px-5 pb-3 pt-4 max-md:px-3 max-md:pt-2">
      {!docked && phone && (
        <IconButton label="Back" icon={<ChevronIcon dir="left" size={16} />} onClick={onClose} className="-ml-1" />
      )}
      <div className="min-w-0 flex-1 max-md:pt-2">
        <h2 id={titleId} className="text-title text-ui-ink">
          {title}
        </h2>
        {subtitle != null && <p className="mt-0.5 truncate text-meta text-ui-faint">{subtitle}</p>}
      </div>
      {headerActions != null && <div className="flex shrink-0 items-center gap-0.5">{headerActions}</div>}
      {!(phone && !docked) && (
        <IconButton label={closeLabel} icon={<CloseIcon size={14} />} onClick={onClose} size="sm" />
      )}
    </header>
  );

  const body = (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 text-body text-ui-ink max-md:px-4">
        {children}
      </div>
      {footer != null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 bg-ui-surface px-5 py-3 max-md:px-4 max-md:pb-[max(12px,env(safe-area-inset-bottom))]">
          {footer}
        </div>
      )}
    </>
  );

  if (docked) {
    return (
      <aside
        ref={panelRef as React.RefObject<HTMLElement>}
        aria-labelledby={titleId}
        data-testid={testId}
        className={cx(
          'flex h-full min-h-0 w-panel shrink-0 flex-col bg-ui-surface motion-safe:animate-ui-slide-in',
          className,
        )}
      >
        {body}
      </aside>
    );
  }

  return createPortal(
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-end" style={{ top: topInset }}>
      <div className="absolute inset-0 bg-ui-scrim/40 motion-safe:animate-ui-fade" onClick={onClose} aria-hidden />
      <section
        ref={panelRef as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={cx(
          'relative flex h-full min-h-0 flex-col bg-ui-surface outline-none',
          phone
            ? cx('w-full motion-safe:animate-ui-sheet-up', topInset === 0 && 'pt-[env(safe-area-inset-top)]')
            : 'w-[440px] max-w-full motion-safe:animate-ui-slide-in',
          className,
        )}
      >
        {body}
      </section>
    </div>,
    document.body,
  );
}
