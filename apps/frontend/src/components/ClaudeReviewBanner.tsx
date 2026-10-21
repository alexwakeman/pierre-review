import { useEffect, useRef, useState } from 'react';
import type { ActiveReview, ClaudeReviewPhase } from '@pierre-review/shared';
import { useActiveClaudeReviews } from '../hooks/useClaudeReview.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useNotificationPref } from '../hooks/useNotificationPref.js';
import { useFilters } from '../store/filters.js';
import { playReviewComplete } from '../lib/sound.js';
import { dateTime } from '../lib/ui.js';
import { HeaderToast, ToastList, ToastRow } from './HeaderToasts.js';
import { CheckIcon, CloseIcon, ReviewIcon } from './Icons.js';

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
  // Completion is DETECTED here, not reported: `ActiveReview` carries no finish time, so the run
  // is "done" the first poll it stops appearing (≤2.5s late — invisible at minute resolution).
  // Absolute, never relative, for the same reason the My Turn stamp is: this text outlives its
  // banner in the OS notification centre. It LEADS on its own line so truncation can't eat it.
  const stamp = dateTime(new Date().toISOString());
  try {
    const n = new Notification(title, {
      body: `${stamp}\n${body}`,
      tag: 'pierre-claude-review',
    });
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

// The global progress card for in-flight Claude reviews (in the header toast strip). Polls the active
// list, keeps a local record (so completed runs linger until dismissed), and lets
// you jump straight to a review's Claude Review tab. Renders nothing when there's
// nothing to show.
export function ClaudeReviewBanner(): JSX.Element | null {
  const enabled = useAiCapabilities().enabled;
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

  const { data: raw, dataUpdatedAt } = useActiveClaudeReviews(enabled && polling);
  // Runs a person started only. An AUTO run (Settings → Workspace) was asked for by nobody, so it
  // gets no banner, chime or notification — its result waits on the PR's Claude Review tab.
  // (A waiting auto item is the only entry with no reviewId; the filter drops it with the rest.)
  const data = raw && {
    ...raw,
    reviews: raw.reviews.filter(
      (r): r is ActiveReview & { reviewId: number } => r.trigger !== 'auto' && r.reviewId != null,
    ),
  };

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

  // A card in the ONE header toast strip (HeaderToasts.tsx): one line ("2 running" / "1 ready"),
  // the reviews in the expanded panel, and the X once nothing is still running (a running review
  // keeps its card).
  const ready = visible.length - running.length;
  return (
    <HeaderToast
      testId="claude-review-toast"
      tone="ai"
      label="Claude reviews"
      icon={<ReviewIcon size={13} />}
      summary={running.length > 0 ? `${running.length} running` : `${ready} ready`}
      onDismiss={allDone ? dismissAll : undefined}
      dismissLabel="Dismiss the Claude reviews card"
    >
      <ToastList>
        {visible.map((e) => (
          <ToastRow key={e.reviewId}>
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() =>
                openClaudeReview({
                  id: e.prId,
                  number: e.prNumber,
                  title: e.prTitle,
                  repoFullName: e.repoFullName,
                  authorLogin: null,
                  authorDisplayName: null,
                  authorAvatarUrl: null,
                })
              }
              className="block min-w-0 flex-1 text-left"
              title="Open this review"
            >
              <span className="flex items-center gap-1.5">
                {e.done ? (
                  <CheckIcon size={11} className="shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                )}
                <span className="truncate font-medium text-blue-600 hover:underline dark:text-blue-400">
                  {e.repoFullName} #{e.prNumber}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-gray-600 dark:text-gray-300">{e.prTitle}</span>
              <span className="mt-0.5 block text-gray-600 dark:text-gray-300">
                {e.done ? 'Ready — open it' : `${e.phase != null ? (PHASE_LABEL[e.phase] ?? e.phase) : 'Starting'}…`}
              </span>
            </button>
            {e.done && (
              <button
                type="button"
                onClick={() => dismissOne(e.reviewId)}
                aria-label={`Dismiss ${e.repoFullName} #${e.prNumber}`}
                className="shrink-0 rounded p-0.5 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
              >
                <CloseIcon size={10} />
              </button>
            )}
          </div>
          </ToastRow>
        ))}
      </ToastList>
    </HeaderToast>
  );
}
