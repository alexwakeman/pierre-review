import { useEffect, useRef } from 'react';
import { closeActivePopover } from '../../lib/activePopover.js';
import { CloseIcon } from '../Icons.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { Kbd, KbdGroup } from '../ui/Kbd.js';
import { modKeyLabel } from '../ui/keys.js';
import { DESTINATIONS } from './nav.js';

// THE KEY SHEET (`?`, the sidebar's keyboard button, ⌘K → "Keyboard shortcuts"). Every key the app
// answers, in the words of docs/redesign/DESIGN.md § 8. A modal: Escape (capture phase) and the
// backdrop close it, focus returns to whatever opened it. A bottom sheet on a phone.

type Line = readonly [keys: readonly string[], does: string];

function sections(): ReadonlyArray<readonly [string, readonly Line[]]> {
  const mod = modKeyLabel();
  return [
    [
      'Anywhere',
      [
        [[`${mod}K`], 'Search or jump: a page, a setting, a pull request, a ticket'],
        [['/'], 'The same'],
        [['?'], 'This list'],
        [['i'], 'Activity (where you were last)'],
        [['Esc'], 'Close the top layer; then leave a tab for the Timeline, or clear its selection'],
      ],
    ],
    ['Go to', DESTINATIONS.map((d): Line => [['g', d.goKey], d.label])],
    [
      'Lists',
      [
        [['j'], 'Next row'],
        [['k'], 'Previous row'],
        [['↵'], 'Open the selected row'],
        [['a'], 'Approve, where approving is allowed'],
        [['m'], 'Merge, when it can land'],
        [['e'], 'Done'],
        [['z'], 'Undo the last removal'],
        [['o'], 'Open on GitHub'],
        [['1–9'], "Switch the page's tabs"],
      ],
    ],
    ['Timeline', [[['j', 'k'], 'Move through the board’s pull requests']]],
  ];
}

export function ShortcutsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeActivePopover();
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== '?') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center md:items-center md:p-4" role="presentation">
      <div aria-hidden className="absolute inset-0 bg-ui-scrim/50 motion-safe:animate-ui-fade" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="shortcuts-sheet"
        className={cx(
          'relative flex max-h-[85vh] w-full flex-col overflow-hidden bg-ui-raise shadow-2xl shadow-black/40',
          'rounded-t-xl pb-[env(safe-area-inset-bottom)] motion-safe:animate-ui-sheet-up',
          'md:w-[34rem] md:rounded-[10px] md:pb-0 md:motion-safe:animate-ui-pop',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-4">
          <h2 className="min-w-0 flex-1 text-title text-ui-ink">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close (Esc)"
            className={cx('flex h-8 w-8 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover touch:h-10 touch:w-10', FOCUS_RING)}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          {sections().map(([title, lines]) => (
            <section key={title} className="mt-3 first:mt-0">
              <h3 className="mb-1 text-meta text-ui-faint">{title}</h3>
              <dl className="m-0">
                {lines.map(([keys, does]) => (
                  <div key={`${title}:${keys.join('+')}:${does}`} className="flex h-8 items-center gap-3">
                    <dt className="w-20 shrink-0">
                      {keys.length > 1 ? <KbdGroup keys={[...keys]} /> : <Kbd keep>{keys[0]}</Kbd>}
                    </dt>
                    <dd className="m-0 min-w-0 flex-1 truncate text-body text-ui-mute">{does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
