import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ArmedMergeRequest, ArmedMergeState } from '@pierre-review/shared';
import { useArmedMerges } from '../hooks/useAutoMerge.js';

// Bottom-right toast stack for auto-merge outcomes, in the same shape as ClaudeReviewBanner:
// a plain card column rendered inside App.tsx's ONE shared fixed bottom-right toast column
// (which owns position/width/z and pointer-events-none; cards re-enable pointer events).
// Driven by polling GET /api/auto-merge and DIFFING the state of each intent: the
// watcher runs server-side, so a transition out of 'armed' is the only signal the client
// gets that something happened.
//
// Only transitions raise a toast — never the current state. A page load that finds a merged
// intent from two hours ago must stay silent, so the FIRST poll seeds the baseline.

const TERMINAL_LABEL: Partial<Record<ArmedMergeState, string>> = {
  merged: 'merged automatically',
  disarmed_head_moved: 'auto-merge disarmed — the branch moved',
  disarmed_blocked: 'auto-merge stopped',
  expired: 'auto-merge expired',
  failed: 'auto-merge failed',
};

interface Toast {
  prId: number;
  state: ArmedMergeState;
  label: string;
  reason: string | null;
}

export function AutoMergeBanner(): JSX.Element | null {
  const { data } = useArmedMerges();
  const qc = useQueryClient();
  // prId → last observed state. `null` until the first response, which is what makes the
  // first poll a silent baseline rather than a burst of stale toasts.
  const seen = useRef<Map<number, ArmedMergeState> | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const requests: ArmedMergeRequest[] | undefined = data?.requests;

  useEffect(() => {
    if (!requests) return;
    const prev = seen.current;
    const next = new Map<number, ArmedMergeState>();
    for (const r of requests) next.set(r.prId, r.state);

    if (prev == null) {
      seen.current = next;
      return;
    }

    const fresh: Toast[] = [];
    let landed = false;
    for (const r of requests) {
      const before = prev.get(r.prId);
      // A transition INTO a terminal state, from a state we previously saw as armed. An
      // intent we've never seen before (armed and resolved between two polls) is skipped
      // deliberately: without a prior 'armed' observation we can't tell it apart from a row
      // that was already resolved when this tab loaded.
      if (before === 'armed' && r.state !== 'armed') {
        const label = TERMINAL_LABEL[r.state];
        if (label) {
          fresh.push({ prId: r.prId, state: r.state, label, reason: r.lastReason });
          if (r.state === 'merged') landed = true;
        }
      }
    }
    seen.current = next;
    if (fresh.length > 0) setToasts((t) => [...fresh, ...t].slice(0, 5));
    if (landed) {
      // The PR really did change state on GitHub — refresh every surface that shows open-PR
      // state, exactly as the interactive merge mutation does.
      for (const key of [
        ['timeline'],
        ['open-prs'],
        ['activity'],
        ['consolidated-feed'],
        ['my-turn'],
        ['me'],
      ]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    }
  }, [requests, qc]);

  if (toasts.length === 0) return null;

  const dismiss = (prId: number): void =>
    setToasts((t) => t.filter((x) => x.prId !== prId));

  return (
    <div className="flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={`${t.prId}:${t.state}`}
          className="pointer-events-auto rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">
              {t.state === 'merged' ? '✓ ' : '⚠ '}
              Pull request {t.label}
            </span>
            <button
              type="button"
              onClick={() => dismiss(t.prId)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          {t.reason && (
            <div className="mt-1 text-gray-500 dark:text-gray-400">{t.reason}</div>
          )}
          {t.state === 'merged' && (
            <div className="mt-1 text-[11px] text-gray-400">
              Auto-merge only runs while Limn is running.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
