import { useEffect, useState } from 'react';
import type { TicketAutoCheck } from '@pierre-review/shared';
import { ticketAutoCheckWords } from '../lib/ticketReview.js';

// THE AUTOMATIC STORY CHECK, ONE LINE — when it starts or why it will not. Shown by the PR pane's AI
// Review tab (TicketCoverage.tsx) and the Ticket / story view (Activity/OpenPrsCards.tsx), from the
// server's `autoCheck` (the sweeper's own rule). It never fetches: the countdown ticks locally, once
// a second only while a start time is less than an hour away; the pane's poll refreshes the state.

const TICK_MS = 1000;
const TICK_WITHIN_MS = 60 * 60 * 1000;

export function TicketAutoCheckLine({
  autoCheck,
  labelOf,
  className = '',
}: {
  autoCheck: TicketAutoCheck | null | undefined;
  labelOf: (prId: number) => string | null;
  className?: string;
}): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  const startsMs = autoCheck?.startsAt != null ? Date.parse(autoCheck.startsAt) : null;
  const ticking = autoCheck?.status === 'waiting' && startsMs != null && startsMs - now < TICK_WITHIN_MS && startsMs > now;
  useEffect(() => {
    if (!ticking) return;
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(t);
  }, [ticking]);
  const words = ticketAutoCheckWords(autoCheck, labelOf, now);
  if (words == null) return null;
  return (
    <span className={`text-meta text-ui-mute ${className}`} title={words.title} data-testid="ticket-auto-check">
      {words.label}
    </span>
  );
}
