import { useEffect, useRef, useState } from 'react';
import type { ClaudeReviewPhase } from '@pierre-review/shared';
import { useActiveClaudeReviews } from '../hooks/useClaudeReview.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useNotificationPref } from '../hooks/useNotificationPref.js';
import { useFilters } from '../store/filters.js';
import { playReviewComplete } from '../lib/sound.js';

interface CompletedCoord {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
}

// Fire a browser notification when one or more Claude reviews finish (gated on the
// shared notifications pref + permission). Mirrors the My Turn notification style.
function notifyReviewsComplete(done: CompletedCoord[]): void {
  if (
    done.length === 0 ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }
  const title =
    done.length === 1
      ? 'Claude review ready'
      : `${done.length} Claude reviews ready`;
  const body =
    done.length === 1
      ? `${done[0]!.repoFullName} #${done[0]!.prNumber}`
      : done
          .slice(0, 3)
          .map((d) => `${d.repoFullName} #${d.prNumber}`)
          .join(' · ');
  try {
    const n = new Notification(title, { body, tag: 'pierre-claude-review' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* construction can throw on some platforms — non-fatal */
  }
}

// A tracked review for the banner. We keep finished runs around (done:true) until
// the user dismisses them, so a review that completes while you're elsewhere is
// still visible with a link to its result.
interface BannerEntry {
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  phase: ClaudeReviewPhase | null;
  done: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  cloning: 'Cloning',
  fetching_diff: 'Fetching diff',
  deciding: 'Deciding scope',
  reviewing: 'Reviewing',
  persisting: 'Saving findings',
};

// Floating, global progress banner for in-flight Claude reviews. Polls the active
// list, keeps a local record (so completed runs linger until dismissed), and lets
// you jump straight to a review's Claude Review tab. Renders nothing when there's
// nothing to show.
export function ClaudeReviewBanner(): JSX.Element | null {
  const enabled = useProCapabilities().claudeReview;
  const kickoff = useFilters((s) => s.claudeReviewKickoff);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const [notifEnabled] = useNotificationPref();
  // Read inside the poll effect without widening its deps (the effect keys off the
  // active set, not the pref).
  const notifEnabledRef = useRef(notifEnabled);
  notifEnabledRef.current = notifEnabled;

  // Only poll while a run is known to be in flight: start when the user kicks one
  // off (kickoff bump), stop as soon as a poll comes back with no active runs.
  const [polling, setPolling] = useState(false);
  useEffect(() => {
    if (kickoff > 0) setPolling(true);
  }, [kickoff]);

  const { data, dataUpdatedAt } = useActiveClaudeReviews(enabled && polling);

  useEffect(() => {
    if (polling && (data?.reviews.length ?? 0) === 0) setPolling(false);
    // dataUpdatedAt is the per-poll trigger; `data`/`polling` are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  const [tracked, setTracked] = useState<Record<number, BannerEntry>>({});
  const [dismissed, setDismissed] = useState<Record<number, true>>({});

  // Previously-active reviews (id → PR coords), to detect a running → gone
  // transition (a run completed) so we can chime + notify globally — even if the
  // user navigated away from the Claude Review tab. Seeded on the first poll so an
  // already-running review on mount doesn't immediately "complete".
  const prevActiveRef = useRef<Map<number, CompletedCoord> | null>(null);

  // A content key so the merge effect only runs when the active set / phases
  // actually change (not on every poll tick).
  const activeKey = (data?.reviews ?? [])
    .map((r) => `${r.reviewId}:${r.phase ?? ''}`)
    .join(',');

  useEffect(() => {
    const active = data?.reviews ?? [];
    const activeIdSet = new Set(active.map((r) => r.reviewId));

    // Completion: any review active last poll but gone now has finished. Skip the
    // very first poll (prevActiveRef null) so a run already in flight on mount
    // doesn't chime/notify spuriously. A QUEUED review going active is NOT a
    // completion (it's still tracked), so only the gone-entirely transition counts.
    const prev = prevActiveRef.current;
    if (prev != null) {
      const done: CompletedCoord[] = [];
      for (const [id, coord] of prev) {
        if (!activeIdSet.has(id)) done.push(coord);
      }
      if (done.length > 0) {
        playReviewComplete();
        if (notifEnabledRef.current) notifyReviewsComplete(done);
      }
    }
    prevActiveRef.current = new Map(
      active.map((r) => [
        r.reviewId,
        { repoFullName: r.repoFullName, prNumber: r.prNumber, prTitle: r.prTitle },
      ]),
    );

    setTracked((prev) => {
      const next: Record<number, BannerEntry> = { ...prev };
      for (const r of active) {
        next[r.reviewId] = {
          reviewId: r.reviewId,
          prId: r.prId,
          repoFullName: r.repoFullName,
          prNumber: r.prNumber,
          prTitle: r.prTitle,
          phase: r.phase,
          done: false,
        };
      }
      // A tracked review that's no longer active has finished.
      for (const e of Object.values(next)) {
        if (!activeIdSet.has(e.reviewId) && !e.done) {
          next[e.reviewId] = { ...e, done: true };
        }
      }
      return next;
    });
    // activeKey is the intentional trigger; `data` ref is covered by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const visible = Object.values(tracked).filter((e) => !dismissed[e.reviewId]);
  if (!enabled || visible.length === 0) return null;

  const running = visible.filter((e) => !e.done);
  const allDone = running.length === 0;

  const dismissAll = (): void => {
    setDismissed((prev) => {
      const next = { ...prev };
      for (const e of visible) next[e.reviewId] = true;
      return next;
    });
  };
  const dismissOne = (reviewId: number): void =>
    setDismissed((prev) => ({ ...prev, [reviewId]: true }));

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div className="pointer-events-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
          <span className="text-xs font-semibold">
            Claude reviews
            {running.length > 0 && (
              <span className="ml-1 font-normal text-gray-400">
                · {running.length} running
              </span>
            )}
          </span>
          {allDone && (
            <button
              type="button"
              onClick={dismissAll}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              Dismiss all
            </button>
          )}
        </div>
        <ul className="max-h-64 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
          {visible.map((e) => (
            <li key={e.reviewId} className="px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => openClaudeReview(e.prId)}
                className="block w-full text-left"
                title="Open this review"
              >
                <div className="flex items-center gap-1.5">
                  {e.done ? (
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500" />
                  ) : (
                    <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                  )}
                  <span className="truncate font-medium text-blue-600 hover:underline dark:text-blue-400">
                    {e.repoFullName} #{e.prNumber}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-gray-500">{e.prTitle}</div>
                <div className="mt-0.5 text-gray-400">
                  {e.done
                    ? 'Ready — click to view'
                    : `${
                        e.phase != null
                          ? (PHASE_LABEL[e.phase] ?? e.phase)
                          : 'Starting'
                      }…`}
                </div>
              </button>
              {e.done && (
                <div className="mt-1 text-right">
                  <button
                    type="button"
                    onClick={() => dismissOne(e.reviewId)}
                    className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    dismiss
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
