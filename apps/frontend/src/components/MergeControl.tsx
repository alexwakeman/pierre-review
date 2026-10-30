import { useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { MergeBlockFacts, MergeMethod, MergeQueueEntryState } from '@pierre-review/shared';
import {
  mergeQueueMutationKey,
  useDequeueMergeQueue,
  useEnqueueMergeQueue,
  useMergeOptions,
  useMergePr,
  useUpdatePrBranch,
} from '../hooks/usePrWrites.js';
import { useDisarmAutoMerge } from '../hooks/useAutoMerge.js';
import { useQueueDisagreementRepair } from '../hooks/useMergeQueueStatus.js';
import { mergeQueueStatus, type MergeQueueStatus } from './Activity/pendingLabels.js';
import { dateTime, MERGE_TONE_CLASS, mergeVerdict, relativeTime, toMergeStateStatus } from '../lib/ui.js';
import { ApiError } from '../api/client.js';
import { CaretIcon, ExternalLinkIcon, MergeIcon, WarningIcon } from './Icons.js';
import { ResolveConflictsButton } from './conflicts/ResolveConflictsButton.js';
import { Button, Select } from './ui/index.js';
import type { ResolverTarget } from '../store/conflictResolver.js';

// Merge control for the Overview tab (CORE / free tier), rendered next to Approve when the
// viewer has push access and the PR is open + not a draft. Collapsed it's a single "Merge ▾"
// button; expanding fetches the repo's allowed merge methods + GitHub's live mergeability
// (lazily, so the hot PR-detail path stays fast).
//
// It resolves FOUR ways, in this order — they are mutually exclusive by construction:
//
//   0. GITHUB'S MERGE QUEUE HOLDS THE PR  → the queue's status line ("In the merge queue ·
//      position 2 · running checks · ~12 min") and "Remove from queue", and NOTHING ELSE — no
//      "Merge ▾" trigger, no method picker, open or not. This used to exist only inside the
//      expanded panel, whose `open` is per-mount state, so the moment the reader navigated away
//      and came back the control remounted collapsed and offered "Merge ▾" for a PR GitHub was
//      already landing. Membership comes from the NEWER of the caller's synced facts and the live
//      answer (`mergeQueueStatus`), so the row survives a remount and needs no fetch to say it.
//   1. the base branch has a MERGE QUEUE  → "Add to merge queue" replaces Merge entirely.
//      GitHub won't accept a direct merge on a queued branch, so offering one would only
//      produce a confusing 405.
//   2. it can merge now                   → merge / squash / rebase (whichever the repo allows).
//   3. it can't merge YET                 → the verdict line says why. ARMING lives in the
//      sibling MergeWhenReadyControl (the ONE way to arm — it also covers clean-but-behind,
//      which this control's !canMerge gate could never see). The armed panel + its cancel
//      still render here: they carry richer detail (method, reason, expiry) than the button.
//
// Everything that says "can this land?" comes from the ONE `mergeVerdict` resolver in lib/ui,
// so this control, the open-PR rows and the timeline tooltip can never disagree.

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

const METHOD_VERB: Record<MergeMethod, string> = {
  merge: 'Merge',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

export function MergeControl({
  prId,
  githubUrl,
  label = 'Merge',
  blockFacts,
  resolverTarget,
  inMergeQueue,
  mergeQueueEntryState,
  syncedAt,
  showQueuePosition = true,
  queueLine = true,
}: {
  prId: number;
  githubUrl: string;
  /**
   * The PR facts that let a `blocked` verdict say WHY (threads, CI rollup, outstanding review
   * requests). Supplied by PrDetail's Overview, which holds the freshly-walked PR row; ABSENT
   * on the Pending board.
   *
   * ⚠ THE REASON IS THE THREAD COUNTS, NOT REVIEW STATUS. A card now carries GitHub's
   * `reviewDecision` and our own folded standing, so the old wording here ("cards carry no review
   * status") is wrong; what a card still does not carry is this PR's unresolved-thread counts, and
   * NOTHING ON THE BOARD MAY FETCH TO FIND OUT. Without the facts the verdict falls back to its
   * generic sentence, exactly as before.
   */
  blockFacts?: MergeBlockFacts;
  /**
   * The COLLAPSED trigger's verb. Defaults to "Merge" (PrDetail's Actions row).
   *
   * The Pending board passes "Update branch" on an `update_branch` card: the panel this expands
   * into is the same one either way — its Update-branch button already lives in it — but the verb
   * on the button the reader clicks has to match what the card is about. "Merge" on a PR
   * `mergeStateStatus === 'behind'` is exactly the 405 `mergeVerdict` exists to prevent, promised
   * before the fetch that would have said so.
   */
  label?: string;
  /**
   * The pull request this control is about, for the "Resolve conflicts" button in the conflict
   * box below. OPTIONAL, and absent on the Pending board — a conflicts card never mounts this
   * control at all (it has nothing to merge), so plumbing the fields there would be a prop that
   * can never be read.
   */
  resolverTarget?: ResolverTarget;
  /**
   * GitHub's merge-queue MEMBERSHIP as the caller's synced row has it — `PrDetail.inMergeQueue`
   * on the PR pane, the card's own field on the Pending board. Three-state: `null` is "not
   * observed" and claims nothing. This is what lets the queued row render with the control
   * COLLAPSED, which is the only state a remount can produce — and on the board it must, because
   * nothing there may fetch on mount.
   */
  inMergeQueue?: boolean | null;
  /** The entry's state, for the status line's words (same synced row). */
  mergeQueueEntryState?: MergeQueueEntryState | null;
  /** When that row was read — its query's `dataUpdatedAt` (epoch ms). The live merge-options
   *  answer wins only when it is NEWER; without this a merge-options answer cached minutes ago
   *  would outvote a card that has since been stamped. */
  syncedAt?: number;
  /**
   * Put the queue POSITION and time in the queued row. The PR pane does (its merge-options query
   * is kept live beside this control). The Pending board passes false: nothing there refetches the
   * answer, so a cached position is an old one printed as current, and the row's words would
   * depend on whether one happened to be cached. See `mergeQueueStatus`.
   */
  showQueuePosition?: boolean;
  /**
   * Print the queue's status line beside "Remove from queue". The Pending board passes false: its
   * card HEADING is that line (from the same newer-wins answer), so the row keeps only the verb.
   */
  queueLine?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // ⚠ STILL `open`-GATED. A disabled query returns whatever is CACHED — which is why the board
  // turns the position off (`showQueuePosition`): there it would be an earlier click's answer.
  // The membership and entry state it carries still count, newer-wins, and nothing is fetched.
  const {
    data: options,
    isLoading,
    isError,
    dataUpdatedAt: optionsAt,
  } = useMergeOptions(prId, open);
  const merge = useMergePr(prId);
  const update = useUpdatePrBranch(prId);
  const enqueue = useEnqueueMergeQueue(prId);
  const dequeue = useDequeueMergeQueue(prId);
  const disarm = useDisarmAutoMerge(prId);
  // The queue verbs' in-flight state off the SHARED key, never the per-mount `isPending`: the PR
  // pane and a Pending card can both mount this control, and a card re-keys when its kind changes.
  const queueBusy = useIsMutating({ mutationKey: mergeQueueMutationKey(prId) }) > 0;
  const removing = useIsMutating({ mutationKey: mergeQueueMutationKey(prId, 'dequeue') }) > 0;
  const queueing = useIsMutating({ mutationKey: mergeQueueMutationKey(prId, 'enqueue') }) > 0;

  const queueStatus = mergeQueueStatus(
    { inMergeQueue, mergeQueueEntryState, observedAt: syncedAt ?? 0 },
    { info: options?.mergeQueue, observedAt: optionsAt },
    { withPosition: showQueuePosition },
  );
  // A newer live answer that says something else: the server has already stamped it, so re-read
  // the synced side (the PR row, the board) — once per answer.
  useQueueDisagreementRepair(prId, inMergeQueue, syncedAt ?? 0, options?.mergeQueue, optionsAt);

  // The chosen method — default to the repo's first allowed once options load.
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [updateStrategy, setUpdateStrategy] = useState<'rebase' | 'merge'>('rebase');
  const effectiveMethod: MergeMethod =
    method && options?.allowedMethods.includes(method)
      ? method
      : (options?.defaultMethod ?? 'merge');

  const errText = (e: unknown, fallback: string): string | null =>
    e instanceof ApiError ? e.message : e ? fallback : null;
  const mergeError = errText(merge.error, 'Failed to merge the PR.');
  const updateError = errText(update.error, 'Failed to update the branch.');
  const queueError = errText(enqueue.error ?? dequeue.error, 'Merge-queue action failed.');
  const armError = errText(disarm.error, 'Failed to change auto-merge.');

  const behindLabel = useMemo(() => {
    if (options == null || !options.behind) return null;
    const n = options.behindBy;
    return `${n > 0 ? n : 'Some'} commit${n === 1 ? '' : 's'} behind ${options.baseRef}`;
  }, [options]);

  // 0. GitHub's queue holds it — open or not, this is the whole control.
  const queued = queueStatus != null;
  if (queueStatus != null) {
    return (
      <QueuedRow
        status={queueStatus}
        showLine={queueLine}
        busy={queueBusy}
        removing={removing}
        error={queueError}
        onRemove={() => dequeue.mutate()}
      />
    );
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} icon={<MergeIcon />}>
        {label}
        <CaretIcon />
      </Button>
    );
  }

  if (isLoading) {
    return <div className="text-meta text-ui-faint">Checking merge status…</div>;
  }
  if (isError || options == null) {
    return (
      <div className="flex items-center gap-2 text-meta text-ui-danger">
        Couldn’t load merge status.
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    );
  }

  const queue = options.mergeQueue;
  const armed = options.autoMerge.armed;
  const isArmed = armed?.state === 'armed';

  // The one verdict, fed the live merge-options values (not the synced PR row).
  //
  // `autoMergeArmed` is deliberately NOT passed here even though the resolver accepts it: an
  // 'armed' verdict reports canMerge:true (arming doesn't take the manual merge away), which
  // on THIS surface would enable a Merge button for a PR that is still blocked. The armed
  // state gets its own panel below; this verdict stays a pure statement of mergeability, so
  // the button it gates can't lie. (Other surfaces, which render the verdict but offer no
  // button, do want the 'armed' collapse.)
  const verdict = mergeVerdict({
    mergeable: options.conflicts
      ? 'conflicting'
      : options.mergeable === true
        ? 'mergeable'
        : 'unknown',
    mergeStateStatus: toMergeStateStatus(options.mergeStateStatus),
    // The RESOLVED membership (synced vs live, newer wins) — never `queue?.inQueue` alone, which
    // is whatever this cache entry said when it was fetched. The queue branch runs FIRST in
    // `mergeVerdict`; a queued PR has already returned above, so here it is always false.
    inMergeQueue: queued,
    queuePosition: queue?.position ?? null,
    behindBy: options.behindBy,
    // The blocked-reason facts. This panel used to build its verdict from the live merge state
    // ALONE, so on a blocked PR it rendered the generic "required checks or reviews aren't
    // satisfied" DIRECTLY BELOW the Overview line that already knew better — the merge button's
    // own explanation was the worst one on the screen.
    //
    // The live decision from THIS fetch wins over the caller's synced one where the probe
    // supplied it (the queue probe is issued on every merge-options call, queue or no queue),
    // and `undefined` means the probe FAILED — it must not overwrite a known value with silence.
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

  const hasMethods = options.allowedMethods.length > 0;
  const canMergeNow = verdict.canMerge && hasMethods;
  const busy = merge.isPending || queueBusy;

  return (
    <div className="w-full space-y-2">
      {/* The verdict, always first — "why can't I merge this?" answered in one line. */}
      <div className={`text-meta font-medium ${MERGE_TONE_CLASS[verdict.tone]}`}>
        {(verdict.tone === 'bad' || verdict.tone === 'warn') && (
          <WarningIcon size={12} className="mr-1 inline-block align-[-0.1em]" />
        )}
        {verdict.label}
        {verdict.detail && (
          <span className="ml-1 font-normal text-ui-mute">
            — {verdict.detail}
          </span>
        )}
      </div>

      {/* Conflicts. THIS PANEL IS THE ONE SURFACE THAT CAN NAME THE BRANCH, because it is the one
          that already paid for the live merge-options fetch — the pane's Conflicts row says the
          same thing without it.

          ⚠ THE BOX IS GATED ON `options.conflicts`; THE BUTTON IS NOT. `ResolveConflictsButton`
          decides from the RESOLVED verdict, `viewerCanPush` and `/api/me` — never from this
          payload, because the same button also mounts on the Pending board, where nothing may
          fetch. Two gates on one screen is fine here: this box exists because the fetch happened,
          and the button exists because the four synced facts say so. */}
      {options.conflicts && (
        <div className="rounded-ui bg-ui-raise px-3 py-2 text-meta text-ui-ink">
          <WarningIcon size={12} className="mr-1 inline-block align-[-0.1em] text-ui-danger" />
          This PR conflicts with <span className="font-mono">{options.baseRef}</span>.
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {resolverTarget != null && (
              <ResolveConflictsButton
                // ⚠ `state` IS A LITERAL HERE BECAUSE THE MOUNT ALREADY DECIDED IT. Both call
                // sites gate on `pr.state === 'open'` before this control exists at all, and the
                // panel offers merge buttons — which would be nonsense on a landed PR. The prop
                // stays on the button so the OTHER two mounts must state it rather than assume.
                state="open"
                verdict={verdict.verdict}
                // ⚠ A LITERAL FOR THE SAME REASON `state` IS. This control is mounted only behind
                // `pr.viewerCanPush` (PrDetail's Actions row) — it offers merge buttons, which
                // nobody without write access may press. `PrMergeOptions` carries no such field,
                // and it must not grow one: `repos.viewerPermission` is the synced fact and this
                // fetch is not where it lives.
                viewerCanPush
                target={resolverTarget}
              />
            )}
            <a
              href={githubUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="hit inline-flex items-center gap-1 rounded-ui font-medium text-ui-mute underline-offset-2 hover:text-ui-ink hover:underline touch:min-h-10"
            >
              Resolve on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
            </a>
          </div>
        </div>
      )}

      {/* Behind trunk — offer an update (rebase locally / merge). Hidden on conflicts. */}
      {options.canUpdateBranch && (
        <div className="flex flex-wrap items-center gap-2 text-meta">
          <span className="text-ui-mute">{behindLabel}.</span>
          {options.canRebaseUpdate && (
            <Select<'rebase' | 'merge'>
              label="How to bring in the base branch"
              size="sm"
              value={updateStrategy}
              onChange={setUpdateStrategy}
              disabled={update.isPending}
              options={[
                { value: 'rebase', label: `Rebase onto ${options.baseRef}` },
                { value: 'merge', label: `Merge ${options.baseRef} in` },
              ]}
            />
          )}
          <Button
            size="sm"
            onClick={() =>
              update.mutate(
                options.canRebaseUpdate ? { strategy: updateStrategy } : { strategy: 'merge' },
              )
            }
            disabled={update.isPending}
            title="Bring in the latest base-branch changes before merging"
          >
            {update.isPending ? 'Updating…' : 'Update branch'}
          </Button>
          {updateError && <span className="text-ui-danger">{updateError}</span>}
        </div>
      )}

      {/* An armed intent — what it will do, and how to call it off. */}
      {isArmed && armed != null && (
        <div className="rounded-ui bg-ui-raise px-3 py-2 text-meta text-ui-ink">
          <div className="font-medium">
            {/* On a queue intent the METHOD verb would mislead — the queue's own configured
                method wins, not the intent's. Say what actually lands it instead. */}
            Auto-merge armed · {armed.viaMergeQueue ? 'via the merge queue' : METHOD_VERB[armed.mergeMethod]} · armed{' '}
            {relativeTime(armed.armedAt)}
          </div>
          <div className="mt-0.5 text-ui-mute">
            {armed.lastReason ?? 'Waiting for the blockers to clear.'}
          </div>
          {/* Honest about the mechanism: this is a watcher in THIS server, not a GitHub setting. */}
          <div className="mt-0.5 text-meta text-ui-faint">
            {armed.viaMergeQueue
              ? 'Limn adds it to the merge queue while the app is running; GitHub lands it from there.'
              : 'Limn merges it while the app is running.'}{' '}
            A new commit on the branch disarms it — you re-arm to merge the new code. Expires{' '}
            {dateTime(armed.expiresAt)}.
          </div>
          <Button size="sm" variant="secondary" className="mt-1.5" onClick={() => disarm.mutate()} disabled={disarm.isPending}>
            {disarm.isPending ? 'Cancelling…' : 'Cancel auto-merge'}
          </Button>
        </div>
      )}

      {/* Action row. A merge queue REPLACES the merge button (GitHub won't take a direct merge).
          A PR already IN the queue never reaches here — the queued row above is the whole
          control — so the only queue verb left is adding it. */}
      <div className="flex flex-wrap items-center gap-2">
        {queue?.enabled ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => enqueue.mutate(effectiveMethod)}
            disabled={busy}
            title="This branch uses a merge queue — GitHub merges it in turn"
          >
            {queueing ? 'Queueing…' : 'Add to merge queue'}
          </Button>
        ) : (
          <>
            {options.allowedMethods.length > 1 && (
              <Select<MergeMethod>
                label="Merge method"
                value={effectiveMethod}
                onChange={setMethod}
                disabled={busy || !canMergeNow}
                options={options.allowedMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
              />
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={() => merge.mutate(effectiveMethod)}
              disabled={!canMergeNow || busy}
              title={canMergeNow ? 'Merge this PR' : verdict.detail ?? 'This PR can’t be merged right now'}
            >
              {merge.isPending ? 'Merging…' : METHOD_VERB[effectiveMethod]}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            merge.reset();
            update.reset();
            enqueue.reset();
            dequeue.reset();
            disarm.reset();
          }}
          disabled={busy}
        >
          Cancel
        </Button>
        {mergeError && <span className="text-meta text-ui-danger">{mergeError}</span>}
        {queueError && <span className="text-meta text-ui-danger">{queueError}</span>}
        {armError && <span className="text-meta text-ui-danger">{armError}</span>}
      </div>
    </div>
  );
}

/**
 * THE QUEUED ROW — what the merge control IS while GitHub's merge queue holds the PR: the status
 * line and the one verb still worth offering. The same words the expanded panel showed right after
 * an enqueue, now on every mount, collapsed or not.
 *
 * ⚠ NO MERGE TRIGGER, NO METHOD PICKER, NO CANCEL. There is nothing to merge (GitHub lands it) and
 * nothing to collapse. Only a reader who can push ever gets here — both mounts gate the whole
 * control on push access (HIDE, never disable) — so "Remove from queue" needs no gate of its own.
 */
function QueuedRow({
  status,
  showLine = true,
  busy,
  removing,
  error,
  onRemove,
}: {
  status: MergeQueueStatus;
  showLine?: boolean;
  busy: boolean;
  removing: boolean;
  error: string | null;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {showLine && (
      <span
        className={`text-meta ${status.tone === 'bad' ? 'text-ui-danger' : 'text-ui-mute'}`}
        title={status.title}
      >
        {/* Only the ejection earns a mark — it is the one state that needs the reader. */}
        {status.tone === 'bad' && (
          <WarningIcon size={12} className="mr-1 inline-block align-[-0.1em]" />
        )}
        {status.line}
      </span>
      )}
      <Button size="sm" onClick={onRemove} disabled={busy} title={showLine ? undefined : status.title}>
        {removing ? 'Removing…' : 'Remove from queue'}
      </Button>
      {error && <span className="text-meta text-ui-danger">{error}</span>}
    </div>
  );
}
