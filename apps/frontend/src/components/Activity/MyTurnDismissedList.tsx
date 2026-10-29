import { useState } from 'react';
import type { MyTurnDismissedItem } from '@pierre-review/shared';
import { useRestoreMyTurn } from '../../hooks/useMyTurnDismiss.js';
import { dateTime, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { ChevronIcon, ExternalLinkIcon } from '../Icons.js';
import { MY_TURN_REASON_LABEL } from './pendingLabels.js';
import { Button } from '../ui/index.js';

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
    <section className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-ui px-3 text-left text-meta font-medium text-ui-mute outline-none hover:bg-ui-hover hover:text-ui-ink focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={11} className="text-ui-faint" />
        Dismissed <span className="tabular-nums text-ui-faint">{items.length}</span>
      </button>
      {open && (
        <div className="pt-1">
          <p className="px-3 pb-1 text-meta text-ui-faint">Each comes back by itself when something new happens on it.</p>
          <ul className="m-0 list-none p-0">
            {items.map((i) => {
              const href = safeExternalUrl(i.githubUrl);
              const name = i.prNumber != null ? `${i.repoFullName} #${i.prNumber}` : i.repoFullName;
              return (
                <li
                  key={`${i.target.kind}:${i.target.id}`}
                  className="flex h-row items-center gap-3 rounded-ui px-3 text-body hover:bg-ui-hover touch:h-row-touch"
                >
                  <span className="w-[8.5rem] shrink-0 truncate text-ui-mute max-md:hidden">{MY_TURN_REASON_LABEL[i.reason]}</span>
                  <span className="min-w-0 flex-1 truncate text-ui-ink" title={i.title != null ? `${name} ${i.title}` : name}>
                    {i.title ?? name}
                    {i.title != null && <span className="ml-2 text-ui-faint max-sm:hidden">{name}</span>}
                  </span>
                  <span className="shrink-0 text-meta tabular-nums text-ui-faint max-sm:hidden" title={dateTime(i.dismissedAt)}>
                    dismissed {relativeTime(i.dismissedAt)}
                  </span>
                  {href !== undefined && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="Open on GitHub"
                      aria-label={`Open ${name} on GitHub`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ui text-ui-faint hover:bg-ui-raise hover:text-ui-ink touch:h-10 touch:w-10"
                    >
                      <ExternalLinkIcon size={12} />
                    </a>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => restore.mutate(i.target)} disabled={busy(i)}>
                    {busy(i) ? 'Bringing it back…' : 'Bring back'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
