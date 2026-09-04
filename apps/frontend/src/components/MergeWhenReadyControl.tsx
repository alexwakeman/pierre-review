import { useState } from 'react';
import type { MergeBlockFacts } from '@pierre-review/shared';
import { useMergeOptions } from '../hooks/usePrWrites.js';
import { useArmAutoMerge, useDisarmAutoMerge, usePrArmedIntent } from '../hooks/useAutoMerge.js';
import { mergeVerdict, mergeWhenReadyEligible, toMergeStateStatus } from '../lib/ui.js';
import { ApiError } from '../api/client.js';
import { TimerIcon } from './Icons.js';

// The dedicated "Merge when ready" control — THE one place auto-merge is ARMED (MergeControl
// keeps its richer armed panel + cancel, but no arm button). Mounted beside Merge/Close in the
// Overview Actions row for an open, non-draft PR the viewer can push to; whether it SHOWS is
// `mergeWhenReadyEligible` over the live merge-options: a self-clearing blocker (blocked /
// behind / unknown) or clean-but-behind (mergeable now, behindBy > 0 — arm = update from
// trunk, then land). A fully clean up-to-date PR gets no button (that's just Merge), and
// neither do conflicts (the fix-push disarms, so the wait could only end by cancelling itself).
//
// On a merge-QUEUE repo the same arm exists with a different landing verb: the watcher adds
// the PR to the queue (instead of a direct merge GitHub would refuse) once required reviews
// are in — the copy says so, and a PR already IN the queue gets no button (its 'queued'
// verdict fails eligibility; it is already landing).
//
// merge-options is fetched EAGERLY by default (unlike MergeControl's click-gated fetch):
// eligibility needs the LIVE behindBy, and the user is looking at this exact PR — 3 GitHub calls
// per viewed eligible PR is the accepted cost. The query KEY is shared with MergeControl (30s
// staleTime), so one fetch serves both controls.
//
// ⚠ AND THAT COST IS WHY `eager` EXISTS. This is the ONE component that arms, so a LIST surface
// (the Pending board, up to 50 rows) has to be able to mount it without each row paying that
// fetch on mount — 50 × ~3 GitHub calls to PAINT a board. `eager={false}` makes the fetch
// click-gated instead: the control renders a compact trigger, and only a click asks GitHub.
// Forking the component for the board was the alternative, and it would have put a second arm
// path in the codebase.
export function MergeWhenReadyControl({
  prId,
  eager = true,
  blockFacts,
}: {
  prId: number;
  /**
   * The PR facts that let a `blocked` verdict say WHY — supplied by PrDetail's Overview, absent
   * on the Pending board (whose cards carry no review status by construction). This is the
   * button that exists BECAUSE the PR is blocked, so it names what it will be waiting out;
   * without the facts it says nothing rather than guessing.
   */
  blockFacts?: MergeBlockFacts;
  /** false ⇒ never fetch merge-options on mount; render a trigger and fetch on the click.
   *  The ARMED state still renders for free either way — it is a selector over the account-wide
   *  list the app already polls, and cancelling must always be possible. */
  eager?: boolean;
}): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  // ⚠ THE ONLY GATE ON THE GITHUB CALL. `asked` is one-way (a click), so a board row that has
  // been opened keeps its answer for the rest of the mount, exactly as MergeControl's `open` does.
  const [asked, setAsked] = useState(false);
  const { data: options } = useMergeOptions(prId, eager || asked);
  const armedIntent = usePrArmedIntent(prId);
  const arm = useArmAutoMerge(prId);
  const disarm = useDisarmAutoMerge(prId);

  const errText = (e: unknown, fallback: string): string | null =>
    e instanceof ApiError ? e.message : e ? fallback : null;
  const armError = errText(arm.error, 'Failed to arm auto-merge.');
  const disarmError = errText(disarm.error, 'Failed to cancel auto-merge.');

  // Armed renders regardless of eligibility — cancelling must always be possible. The polled
  // list is the instant own-tab source; the lazily-fetched options cover a cross-tab arm the
  // 45s poll hasn't caught yet.
  const armed = armedIntent ?? (options?.autoMerge.armed?.state === 'armed' ? options.autoMerge.armed : null);
  if (armed != null) {
    // Three phases, not two: a queue intent that the watcher has already enqueued is past
    // "waiting for conditions" — the queue is landing it, and cancelling now also removes
    // the queue entry (the server does both).
    const inQueue = armed.enqueuedAt != null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50/60 px-2 py-0.5 text-sm font-medium text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/20 dark:text-violet-300"
          title={
            inQueue
              ? 'Limn added this PR to the merge queue — GitHub lands it from here. Cancelling also removes it from the queue.'
              : armed.viaMergeQueue
                ? 'Limn updates it from trunk if needed and adds it to the merge queue when required reviews are in — while the app is running. A new commit on the branch disarms it.'
                : 'Limn updates it from trunk if needed and merges when checks pass — while the app is running. A new commit on the branch disarms it.'
          }
        >
          <TimerIcon />
          {inQueue
            ? 'In the merge queue'
            : armed.viaMergeQueue
              ? 'Armed — queueing when ready'
              : 'Armed — merging when ready'}
        </span>
        <button
          type="button"
          onClick={() => disarm.mutate()}
          disabled={disarm.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          {disarm.isPending ? 'Cancelling…' : inQueue ? 'Cancel & dequeue' : 'Cancel auto-merge'}
        </button>
        {disarmError && <span className="text-xs text-red-500">{disarmError}</span>}
      </div>
    );
  }

  // No button until eligibility is KNOWN — a guess from the synced row would either flash a
  // button that vanishes or (worse) gate on behindBy facts the lean row doesn't carry.
  //
  // Under `eager` that means rendering NOTHING while the fetch is in flight (PrDetail's
  // behaviour, unchanged). Un-eager, the same ignorance is the reason for the trigger: the
  // reader asks, THEN we ask GitHub. Note `options` can already be non-null here without any
  // click — MergeControl shares the query key, so opening it warms this control for free.
  if (options == null) {
    if (eager) return null;
    if (!asked) {
      return (
        <button
          type="button"
          onClick={() => setAsked(true)}
          className="inline-flex items-center gap-1 rounded border border-violet-400 px-2 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/30"
          title="Check whether Limn's watcher can land this for you — it asks GitHub for the live merge state"
        >
          <TimerIcon size={11} />
          Merge when ready
        </button>
      );
    }
    return <span className="text-[11px] text-gray-400">Checking merge state…</span>;
  }

  const queue = options.mergeQueue;
  // Same construction as MergeControl's, and like there `autoMergeArmed` is deliberately NOT
  // passed — 'armed' reports canMerge:true, which would read as the clean-but-behind case.
  const verdict = mergeVerdict({
    mergeable: options.conflicts
      ? 'conflicting'
      : options.mergeable === true
        ? 'mergeable'
        : 'unknown',
    mergeStateStatus: toMergeStateStatus(options.mergeStateStatus),
    inMergeQueue: queue?.inQueue ?? false,
    queuePosition: queue?.position ?? null,
    behindBy: options.behindBy,
    // Same composition as MergeControl's, and for the same reason — the two controls sit side
    // by side in the Actions row and must not describe one PR two ways. Eligibility reads only
    // `verdict.verdict`, which none of this moves; what it buys is the wait's NAME below.
    //
    // ⚠ THE STANDALONE TRIGGER IS `!= null`, NOT `!== undefined`, AND THE DIFFERENCE IS A FALSE
    // SENTENCE. This route ALWAYS emits the key now, and GitHub answers `reviewDecision: null` for
    // every repository that requires no review — so `!== undefined` was true of every PR, and on a
    // facts-less surface (the Pending board mounts both controls WITHOUT `blockFacts`, deliberately:
    // nothing on the board may fetch) it manufactured `{reviewDecision: null}` out of silence. With
    // no ciStatus and no thread count to reason from, `deriveMergeBlockers` then fell through to
    // "nothing we can see explains it" — on 261 of 573 open blocked PRs here that is simply untrue
    // (172 have a red rollup, 89 an unresolved thread), and it contradicted the PR pane's own line
    // for the same PR. `!= null` keeps the win where the answer is NAMED ('changes_requested',
    // 'review_required' — each a PROVEN row) and falls back to the generic sentence otherwise.
    ...(blockFacts || options.reviewDecision != null
      ? {
          blockFacts: {
            ...blockFacts,
            ...(options.reviewDecision !== undefined
              ? { reviewDecision: options.reviewDecision }
              : {}),
          },
        }
      : {}),
  });
  const queueEnabled = queue?.enabled ?? false;
  const eligible = mergeWhenReadyEligible({
    allowedByRepo: options.autoMerge.allowedByRepo,
    methodCount: options.allowedMethods.length,
    alreadyArmed: false, // the armed early-return above already covered it
    verdict,
    behindBy: options.behindBy,
  });
  // ⚠ AN INELIGIBLE PR RENDERS NOTHING WHEN EAGER (PrDetail: the button simply never appeared) but
  // must SAY SO once the reader has clicked — a trigger that answers a question by vanishing reads
  // as a broken button, and gets clicked again on the next render.
  if (!eligible) {
    if (eager || !asked) return null;
    return (
      <span
        className="text-[11px] text-gray-400"
        title="Arming only helps while something is blocking the merge. There is nothing here for the watcher to wait out — or this repo won’t let this account merge."
      >
        Nothing to arm.
      </span>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {/* The honest contract in one line: what it does AND that it's this server's watcher,
            not a GitHub setting. On a clean-but-behind PR this is a ≤2-min delayed merge, so
            the confirm step is deliberate, not decoration. */}
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {queueEnabled
            ? 'Updates from trunk if needed and adds it to the merge queue when required reviews are in — while Limn is running.'
            : 'Updates from trunk if needed and merges when checks pass — while Limn is running.'}
        </span>
        <button
          type="button"
          onClick={() =>
            arm.mutate(
              {
                mergeMethod: options.defaultMethod,
                // ALWAYS a real strategy — 'none' left a PR that fell behind AFTER arming
                // waiting forever on an up-to-date-required repo. Rebase is local-only
                // (config.canRebaseUpdate); cloud falls back to a merge-in.
                updateStrategy: options.canRebaseUpdate ? 'rebase' : 'merge',
              },
              { onSuccess: () => setConfirming(false) },
            )
          }
          disabled={arm.isPending}
          className="whitespace-nowrap rounded border border-violet-500 px-2 py-0.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
        >
          {arm.isPending ? 'Arming…' : 'Arm auto-merge'}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            arm.reset();
          }}
          disabled={arm.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          Cancel
        </button>
        {armError && <span className="text-xs text-red-500">{armError}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1 rounded border border-violet-400 px-2 py-0.5 text-sm font-medium text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/30"
      title={
        (queueEnabled
          ? "Arm Limn's watcher: it updates from trunk if needed and adds the PR to the merge queue when required reviews are in — while the app is running"
          : "Arm Limn's watcher: it updates from trunk if needed and merges when checks pass — while the app is running") +
        // What it will be waiting out, in the SAME words the Overview's Blocked row uses. Only
        // for `blocked` — 'behind' and 'unknown' already say everything in their own label, and
        // the verdict carries a blocker list for nothing else.
        (verdict.blockers?.[0] ? `. Right now: ${verdict.blockers[0].text}` : '')
      }
    >
      <TimerIcon />
      {queueEnabled ? 'Queue when ready' : 'Merge when ready'}
    </button>
  );
}
