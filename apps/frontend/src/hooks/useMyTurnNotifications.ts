import { useEffect, useRef } from 'react';
import { useMyTurn } from './useTriage.js';

// Fire a browser notification when a NEW item enters your My Turn inbox (a review
// requested, a thread awaiting you, or your PR getting fresh activity). Watches the
// My Turn query — which refetches when a sync lands — and diffs the item id set
// across changes. The first data load only seeds the baseline (never fires), so you
// aren't notified about the backlog that was already there when you opened the tab.
// No-op unless enabled AND permission was granted. Notifications only fire while a
// tab is open (that's where the polling happens).
export function useMyTurnNotifications(enabled: boolean): void {
  const { data } = useMyTurn();
  const prevRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!data) return;
    const ids = new Set<string>();
    for (const r of data.awaitingReview) ids.add(`r:${r.prId}`);
    for (const p of data.yourPrs) ids.add(`p:${p.prId}`);
    for (const a of data.approvedPrs ?? []) ids.add(`a:${a.prId}`);
    for (const t of data.threadsAwaiting) ids.add(`t:${t.threadId}`);
    for (const w of data.watchedRepoPrs) ids.add(`w:${w.prId}`);

    const prev = prevRef.current;
    prevRef.current = ids; // always advance the baseline, even while disabled

    if (prev == null) return; // first load → baseline only, don't fire
    if (!enabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const added = [...ids].filter((id) => !prev.has(id));
    if (added.length === 0) return;

    const reviews = added.filter((id) => id.startsWith('r:')).length;
    const threads = added.filter((id) => id.startsWith('t:')).length;
    const yours = added.filter((id) => id.startsWith('p:')).length;
    const approved = added.filter((id) => id.startsWith('a:')).length;
    const watched = added.filter((id) => id.startsWith('w:')).length;
    const bits: string[] = [];
    if (reviews) bits.push(`${reviews} review${reviews === 1 ? '' : 's'} requested`);
    if (threads) bits.push(`${threads} thread${threads === 1 ? '' : 's'} awaiting you`);
    if (yours) bits.push(`${yours} of your PRs active`);
    if (approved) bits.push(`${approved} of your PRs approved`);
    if (watched) bits.push(`${watched} new in watched repos`);

    try {
      const n = new Notification(`Limn — ${added.length} new in My Turn`, {
        body: bits.join(' · '),
        tag: 'pierre-my-turn', // collapse so repeats replace rather than stack
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* construction can throw on some platforms — non-fatal */
    }
  }, [data, enabled]);
}
