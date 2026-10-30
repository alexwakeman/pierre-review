import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { TICKET_STATUS_NO_PERMISSION } from '@pierre-review/shared';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useSetTicketStatus, useTicketTransitions } from '../../hooks/useTicketPrs.js';
import { useFilters } from '../../store/filters.js';
import { CaretIcon } from '../Icons.js';

// THE STORY VIEW'S STATUS PICKER (docs/TRACKERS.md § The status change) — Jira only; every other
// tracker shows the status chip as before. The chip IS the trigger. Opening it asks Jira which
// transitions it allows now (`GET /api/ticket-status/transitions`, never on mount); picking one
// changes the ticket AT ONCE (`POST /api/ticket-status`) — no confirm step, the reader chose the
// status by name. A refusal stays as one line beside the chip until the next pick.
//
// Mounted by the story view's ONE stack header (OpenPrsCards `TicketStack`, `single`), so the story
// tab and This Sprint's story tray get the same picker.

export function TicketStatusPicker({
  ident,
  status,
  chipClassName,
}: {
  ident: string;
  /** The status as shown now. */
  status: string;
  /** The chip's own classes (its category tone). */
  chipClassName: string;
}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const list = useTicketTransitions(workspaceId, ident, open);
  const change = useSetTicketStatus(workspaceId, ident);
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // Focus the first choice once the list arrives, so arrows / Tab start there.
  useEffect(() => {
    if (!open || list.data == null) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open, list.data]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  // A transition that keeps the current status changes nothing the reader can see.
  const choices = (list.data?.transitions ?? []).filter((t) => t.to.name !== status);
  // Two transitions into one status are told apart by their own names.
  const dupes = new Set(choices.map((t) => t.to.name).filter((n, i, all) => all.indexOf(n) !== i));
  const pending = change.isPending;

  return (
    <div ref={rootRef} className="relative inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={pending || workspaceId == null}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Status: ${status}. Change status`}
        title="Change status in Jira"
        className={`${chipClassName} inline-flex items-center gap-1 touch:min-h-10 touch:px-3 hover:ring-1 hover:ring-ui-line focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-60`}
      >
        {pending ? 'Saving…' : status}
        <CaretIcon dir="down" />
      </button>
      {change.isError && (
        <span role="alert" className="text-meta text-ui-danger">
          {change.error.message}
        </span>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Change status"
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-[60] mt-1 w-56 rounded-ui bg-ui-surface p-1 shadow-lg"
        >
          {list.isLoading ? (
            <p aria-busy="true" className="px-2 py-1 text-meta text-ui-mute">
              Asking Jira…
            </p>
          ) : list.isError ? (
            <p className="px-2 py-1 text-meta text-ui-danger">{list.error.message}</p>
          ) : choices.length === 0 ? (
            <p className="px-2 py-1 text-meta text-ui-mute">
              {list.data?.canTransition === false ? TICKET_STATUS_NO_PERMISSION : 'Jira offers no other status from here.'}
            </p>
          ) : (
            choices.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  change.mutate(t.id);
                }}
                className="flex w-full flex-col rounded-ui px-2 py-1 text-left text-meta text-ui-ink touch:min-h-10 touch:justify-center hover:bg-ui-hover focus:bg-ui-hover focus:outline-none"
              >
                <span>{t.to.name}</span>
                {dupes.has(t.to.name) && t.name !== t.to.name && (
                  <span className="text-meta text-ui-mute">{t.name}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
