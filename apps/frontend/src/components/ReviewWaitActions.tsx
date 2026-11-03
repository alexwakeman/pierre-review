import { useState } from 'react';
import type { RequestReviewersBody, ReviewTargetOver, ReviewWait } from '@pierre-review/shared';
import { useRequestReviewers, useReviewerRequestState } from '../hooks/usePrWrites.js';
import { useReviewerCandidate } from '../hooks/usePr.js';
import { CheckIcon, PendingStalledIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import {
  askSomeoneElseOffered,
  holderName,
  nudgeOffered,
  overTargetText,
  workHoursLong,
} from '../lib/reviewWaits.js';

// THE REVIEW TARGET AND ITS TWO ACTIONS — shared by the Pending board's "Waiting on others" card and
// the PR pane's "Requested" row (docs/FRONTEND.md § Waiting on others).
//
// ⚠ ONLY THE READER'S CLICK ACTS. "Nudge" re-requests the same person through the existing
// `POST /api/prs/:id/request-reviewers` (GitHub notifies them); "Ask someone else" FETCHES its one
// candidate only when pressed (it reads CODEOWNERS — nothing here fetches on mount), names them,
// and asks only on the reader's confirm. Both hide (never disable) without request rights.

type NameOf = (id: number | null | undefined) => string | null;

const SMALL_BUTTON =
  'inline-flex h-6 items-center justify-center gap-1 rounded-ui bg-ui-raise px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:opacity-50 touch:h-10 touch:px-3';
const QUIET_BUTTON =
  'inline-flex h-6 items-center rounded-ui px-2 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10';

/** "Over the 4h review target — waiting 9 working hours", with the target explained behind an ⓘ. */
export function ReviewTargetNote({ over }: { over: ReviewTargetOver }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-meta text-ui-warn" data-testid="review-target-note" data-noactivate>
      <PendingStalledIcon size={12} />
      <span>{overTargetText(over)}</span>
      <InfoButton title="The review target">
        <p>
          The review target is the first-look budget set for this workspace in Settings → Workspace →
          Working hours and budgets. It counts working hours only, in the workspace’s own days and
          hours.
        </p>
        <p className="mt-2">
          The wait runs from the newest request to this reviewer. Bots are never counted as reviewers.
        </p>
      </InfoButton>
    </div>
  );
}

/** "Nudge": ask the same person again on GitHub. One person per button, its state off the shared
 *  mutation key so a remount (a tab switch) keeps "Nudged". */
export function NudgeButton({
  prId,
  userId,
  name,
}: {
  prId: number;
  userId: number;
  name: string;
}): JSX.Element {
  const key = `nudge:${userId}`;
  const request = useRequestReviewers(prId, key);
  const state = useReviewerRequestState(prId, key);
  if (state.status === 'success') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-meta font-medium text-ui-success">
        <CheckIcon size={11} /> Nudged
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          request.mutate({ userIds: [userId] });
        }}
        disabled={state.status === 'pending'}
        title={`Ask ${name} for a review again on GitHub. GitHub notifies them.`}
        aria-label={`Nudge ${name}`}
        className={SMALL_BUTTON}
      >
        {state.status === 'pending' ? 'Nudging…' : 'Nudge'}
      </button>
      {state.status === 'error' && (
        <span role="alert" className="text-meta text-ui-danger">
          {state.error}
        </span>
      )}
    </span>
  );
}

/** "Ask someone else": on the click, look up the least-loaded suggested reviewer who is not already
 *  asked, NAME them, and ask only when the reader confirms. Asking adds a reviewer; it removes nobody. */
export function AskSomeoneElse({ prId }: { prId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useReviewerCandidate(prId, open);
  const candidate = data?.candidate ?? null;
  const key = candidate != null ? `ask:${candidate.login.toLowerCase()}` : 'ask:';
  const request = useRequestReviewers(prId, key);
  const state = useReviewerRequestState(prId, key);
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();

  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          setOpen(true);
        }}
        className={SMALL_BUTTON}
        title="Find the least-busy suggested reviewer who has not been asked"
      >
        Ask someone else
      </button>
    );
  }
  if (isLoading) return <span className="text-meta text-ui-mute">Finding someone…</span>;
  if (isError) return <span className="text-meta text-ui-danger">Couldn’t find someone to ask.</span>;
  if (candidate == null) return <span className="text-meta text-ui-mute">No one else to suggest.</span>;
  const who = `@${candidate.login}`;
  if (state.status === 'success') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-meta font-medium text-ui-success">
        <CheckIcon size={11} /> Asked {who}
      </span>
    );
  }
  const body: RequestReviewersBody =
    candidate.userId != null ? { userIds: [candidate.userId] } : { logins: [candidate.login] };
  const load =
    candidate.pendingReviews == null
      ? null
      : candidate.pendingReviews === 0
        ? 'no reviews waiting on them'
        : `${candidate.pendingReviews} review${candidate.pendingReviews === 1 ? '' : 's'} waiting on them`;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-meta text-ui-mute" data-testid="ask-someone-else">
      <span>
        Ask <span className="font-medium text-ui-ink">{who}</span>?{' '}
        {[candidate.reason, load].filter(Boolean).join(' · ')}
      </span>
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          request.mutate(body);
        }}
        disabled={state.status === 'pending'}
        className={SMALL_BUTTON}
      >
        {state.status === 'pending' ? 'Asking…' : `Ask ${who}`}
      </button>
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          setOpen(false);
        }}
        className={QUIET_BUTTON}
      >
        Cancel
      </button>
      {state.status === 'error' && (
        <span role="alert" className="basis-full text-meta text-ui-danger">
          {state.error}
        </span>
      )}
    </span>
  );
}

/** Each outstanding request with its wait, and Nudge beside a person over the target; "Ask someone
 *  else" once, under them. The waiting card's body. */
export function ReviewWaitList({
  prId,
  waits,
  targetHours,
  viewerCanRequest,
  nameOf,
}: {
  prId: number;
  waits: readonly ReviewWait[];
  targetHours: number;
  viewerCanRequest: boolean;
  nameOf: NameOf;
}): JSX.Element {
  return (
    // data-noactivate: a click that just misses a button must not open the PR mid-request.
    <div className="space-y-1" data-noactivate>
      <ul className="space-y-1">
        {waits.map((w) => {
          const name = holderName(w, nameOf);
          const over = w.workHours > targetHours;
          return (
            <li
              key={w.userId != null ? `u${w.userId}` : `t${w.teamName ?? ''}`}
              className="flex flex-wrap items-center gap-1.5 text-meta text-ui-mute"
            >
              <span className="font-medium text-ui-ink">{name}</span>
              <span className={over ? 'text-ui-warn' : undefined}>
                {workHoursLong(w.workHours)}
                {over ? ' — over the target' : ''}
              </span>
              {nudgeOffered(w, targetHours, viewerCanRequest) && w.userId != null && (
                <NudgeButton prId={prId} userId={w.userId} name={name} />
              )}
            </li>
          );
        })}
      </ul>
      {askSomeoneElseOffered(waits, targetHours, viewerCanRequest) && <AskSomeoneElse prId={prId} />}
    </div>
  );
}
