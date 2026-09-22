import { useState } from 'react';
import type { MyTurnDismissedItem } from '@pierre-review/shared';
import { useRestoreMyTurn } from '../../hooks/useMyTurnDismiss.js';
import { dateTime, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { ChevronIcon, ExternalLinkIcon } from '../Icons.js';
import { MY_TURN_REASON_LABEL } from './pendingLabels.js';

// ── WHAT THE READER DISMISSED FROM MY TURN ───────────────────────────────────────────────────
//
// Under the My turn tab, shut by default. The server's list (`AttentionCardsResponse.myTurnDismissed`):
// subjects still on the reader's plate with nothing new since they were dismissed. A subject that
// had something new happen is back in the tab, and one that left the plate on its own is gone —
// neither is listed, so every row here is exactly one "Bring back" from the tab.
//
// ⚠ COUNTED NOWHERE ELSE. No tab badge, chip or lens includes these, and this list's own count is
// its length — the population a click opens.
export function MyTurnDismissedList({ items }: { items: MyTurnDismissedItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const restore = useRestoreMyTurn();
  const busy = (i: MyTurnDismissedItem): boolean =>
    restore.isPending &&
    restore.variables?.kind === i.target.kind &&
    restore.variables.id === i.target.id;

  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-900/60"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={11} className="text-gray-500 dark:text-gray-400" />
        Dismissed <span className="tabular-nums text-gray-500 dark:text-gray-400">{items.length}</span>
      </button>
      {open && (
        <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-800">
          <p className="mb-2 text-[12px] text-gray-500 dark:text-gray-400">
            Each comes back by itself when something new happens on it.
          </p>
          <ul className="space-y-1.5">
            {items.map((i) => {
              const href = safeExternalUrl(i.githubUrl);
              const name =
                i.prNumber != null ? `${i.repoFullName} #${i.prNumber}` : i.repoFullName;
              return (
                <li
                  key={`${i.target.kind}:${i.target.id}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]"
                >
                  <span className="min-w-0 text-gray-800 dark:text-gray-100">
                    <span className="text-gray-500 dark:text-gray-400">{name}</span>
                    {i.title != null && <> {i.title}</>}
                  </span>
                  {href !== undefined && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="Open on GitHub"
                      aria-label={`Open ${name} on GitHub`}
                      className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      <ExternalLinkIcon size={11} />
                    </a>
                  )}
                  <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                    {MY_TURN_REASON_LABEL[i.reason]}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400" title={dateTime(i.dismissedAt)}>
                    dismissed {relativeTime(i.dismissedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => restore.mutate(i.target)}
                    disabled={busy(i)}
                    className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-[12px] text-gray-800 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
                  >
                    {busy(i) ? 'Bringing it back…' : 'Bring back'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
