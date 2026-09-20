import { useEffect, useState } from 'react';
import type {
  ConflictCommitBody,
  ConflictCommitTarget,
  ConflictDecision,
  ConflictFileContent,
  ConflictLandStrategy,
  ConflictSession,
} from '@pierre-review/shared';
import {
  buildCommitBody,
  commitBlockedReason,
  landingTargets,
  type CommitPlan,
  type LandingFileRow,
} from '../../lib/conflictCommit.js';
import { checkBranchName, branchNameMessage } from '../../lib/branchName.js';
import { useResolverSession } from '../../store/conflictResolver.js';
import { BranchIcon, MergeIcon, RebaseIcon, WarningIcon } from '../Icons.js';
import {
  AUTO_MERGE_ARMED,
  CLOSE_RESOLVER,
  COMMIT_AND_PUSH,
  COMMIT_SENTENCE,
  COMMIT_UNCONFIRMED,
  HEAD_MOVED,
  HOW_TO_LAND,
  LANDING_BACK,
  NEW_BRANCH,
  NEW_BRANCH_FIELD,
  NOTHING_PUSHED,
  OPEN_PR_FOR_BRANCH,
  PARTIAL_COMMIT_NOTE,
  REBASE_AND_FORCE_PUSH,
  START_AGAIN,
  STAYS_CONFLICTED,
  STILL_CONFLICTED,
  STILL_TO_DECIDE,
  STRATEGY_MERGE,
  STRATEGY_MERGE_FULL,
  STRATEGY_MERGE_PARTIAL,
  STRATEGY_REBASE,
  WHAT_GOES_IN,
  WHERE_TO_PUT_IT,
  commitPressName,
  filesResolved,
  jumpToFileLabel,
  pinnedOn,
  pushToBranch,
  strategyRebaseDetail,
  toDecide,
} from './copy.js';

// ── THE LANDING STEP ─────────────────────────────────────────────────────────────────────────
//
// The second view inside the SAME overlay, not a nested modal: `Back` returns to the panes with
// every decision intact, because the decisions live in the store and this component holds none of
// them.
//
// ⚠ IT BRINGS ITS OWN SCROLLER. The overlay body is `flex min-h-0 flex-1 flex-col` and is NOT one
// — the panes nest theirs inside it, and so does this. A second scroller wrapped around either is
// what unsticks the pane headers.
//
// Three questions in the order a reader asks them: what is going in, how it lands, where it goes.
// Everything the server will refuse is refused here first, so nobody spends a clone finding out.

export function LandingStep({
  session,
  sessionKey,
  files,
  plan,
  headMoved,
  autoMergeArmed,
  commitError,
  connectionLost,
  onBack,
  onJumpToFile,
  onCommit,
  onRestart,
  onClose,
}: {
  session: ConflictSession;
  sessionKey: string;
  files: Record<number, ConflictFileContent>;
  /** ⚠ THE ONE GATE, FOLDED ONCE IN THE SHELL. This screen asks it what is going in, what is
   *  still outstanding and whether the commit may go at all; the button and the list under it
   *  cannot disagree because there is only one fold. */
  plan: CommitPlan;
  /** The PR's head moved on GitHub since the model was pinned. Disables the commit. */
  headMoved: boolean;
  /** `usePrArmedIntent(prId) != null` — a live "merge when ready" row, not a local flag. */
  autoMergeArmed: boolean;
  /** The commit route refused SYNCHRONOUSLY — a real status code, before the 202. Its own sentence,
   *  rendered verbatim. ⚠ Without this the button sticks: a synchronous refusal never reaches
   *  `session.commit`, so the stream has nothing to say and the progress row would sit there. */
  commitError: string | null;
  /** The server no longer has this session, so the commit's outcome can no longer be read back.
   *  ⚠ NOT a failure — see the `running` branch below and `COMMIT_UNCONFIRMED`. */
  connectionLost: boolean;
  onBack: () => void;
  /** Go back to the panes with the cursor on that file's first unanswered region. */
  onJumpToFile: (index: number) => void;
  onCommit: (body: ConflictCommitBody) => void;
  onRestart: () => void;
  /**
   * ⚠ THE ARGUMENT IS "WAS A COMMIT IN FLIGHT WHEN WE LOST THE SESSION" — NOT "IS THE SESSION
   * GONE". `true` files the close as `committed`, which SUPPRESSES the reopen toast; that is
   * right only where the outcome is genuinely unknowable, which is the `running && connectionLost`
   * branch and nothing else. Every other close from here — the refusal that said "Nothing was
   * pushed", or simply leaving the landing step — must file as `user`, or the toast offering the
   * reader their kept decisions back never appears and there is no other route to them.
   */
  onClose: (outcomeUnknown: boolean) => void;
}): JSX.Element {
  const stored = useResolverSession(sessionKey);
  const decisions = stored?.decisions ?? EMPTY_DECISIONS;
  const suggestionIds = stored?.suggestionIds ?? EMPTY_HANDLES;
  // ⚠ THE HANDLES, FROM THE STORE, WHICH IS WHY THIS STEP NEEDS NOTHING FROM THE PANES IT JUST
  // REPLACED. `ResolverPanes` is unmounted by now and its hooks' line maps went with it; the
  // commit carries ids, so the text never has to be here at all.
  const editIds = stored?.editIds ?? EMPTY_HANDLES;

  const rebaseOffered = session.strategies.includes('rebase');
  const [strategy, setStrategy] = useState<ConflictLandStrategy>('merge');
  // ⚠ THE RADIO'S STATE IS THE READER'S CHOICE; `targets.toNewBranch` IS WHERE THE COMMIT GOES.
  // A fork pull request without maintainer edits has no PR-branch option on screen at all, so the
  // choice is made for them — see `landingTargets`, which is the one fold, and which is where the
  // "hide, never disable" rule lives.
  const [newBranchChosen, setNewBranchChosen] = useState(false);
  const targets = landingTargets(session, newBranchChosen);
  const toNewBranch = targets.toNewBranch;
  const [branch, setBranch] = useState('');
  const [openPr, setOpenPr] = useState(true);
  // ⚠ LOCAL, AND CLEARED BY THE STREAM. The commit route answers 202 and the push runs behind the
  // session stream, so the mutation resolving is NOT the push landing: without this the button
  // flashes back for the gap between the 202 and the first `commit_progress` frame, and a second
  // press in that gap is a second push.
  const [submitted, setSubmitted] = useState(false);

  // The 202 handshake is over the moment the route refuses, whichever way it refused.
  useEffect(() => {
    if (commitError != null) setSubmitted(false);
  }, [commitError]);

  const commit = session.commit;
  const failed = commit?.status === 'failed' || commitError != null;
  const running = !failed && (submitted || commit?.status === 'running');

  const refusal = toNewBranch
    ? checkBranchName(branch, {
        headRef: session.headRef,
        baseRef: session.baseRef,
        reserved: session.reservedBranchNames,
      })
    : null;
  const branchProblem =
    refusal == null
      ? null
      : branchNameMessage(refusal, {
          headRef: session.headRef,
          baseRef: session.baseRef,
          reserved: session.reservedBranchNames,
        });

  /** ONE sentence for why the button will not go, rendered above it AND given to `title`. A bare
   *  disabled button used to be the whole explanation on three of its four reasons.
   *
   *  ⚠ FOLDED IN `lib/conflictCommit.ts`, NOT HERE, SINCE THE TOOLBAR'S BUTTON STARTED SHARING THE
   *  LOCK. That button is the entry to this screen; if this screen composed the sentence, a reader
   *  shut out at the toolbar would meet one explanation and a reader who got here would meet
   *  another for the same three facts. */
  const blockedReason = commitBlockedReason(plan, headMoved);

  // ⚠ THE HARD GATE. `blockedReason != null` IS `headMoved || !plan.canCommit` — `canCommit` is
  // false while any supported file still holds an unanswered region, which is the whole point:
  // a half-decided file used to be dropped from the commit silently and listed as "Still
  // conflicted". The two clauses beside it are this screen's alone — the branch-name field and a
  // push already in flight are facts the toolbar has no way of knowing about.
  const blocked = blockedReason != null || branchProblem != null || running;

  // ⚠ EVERY FILE THIS COMMIT WILL NOT CARRY, MINUS THE ONES ALREADY NAMED ABOVE — folded in
  // `conflictCommit.ts` beside the gate, not narrowed here. See `CommitPlan.notCarried`: it is
  // deliberately NOT "the unsupported ones", because a supported file with nothing decidable in it
  // is also dropped from the commit and also has to be seen.
  const cantFinishHere = plan.notCarried;

  function submit(): void {
    if (blocked) return;
    const target: ConflictCommitTarget = toNewBranch
      ? { kind: 'new_branch', branch: branch.trim(), openPr }
      : { kind: 'pr_branch' };
    setSubmitted(true);
    onCommit(
      buildCommitBody({
        session,
        plan,
        loaded: files,
        decisions,
        suggestionIds,
        editIds,
        strategy,
        target,
      }),
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
        {headMoved && (
          <p className="flex items-start gap-1.5 text-[12px] text-gray-800 dark:text-gray-100">
            <WarningIcon size={13} className="mt-px shrink-0" />
            <span>{HEAD_MOVED}</span>
          </p>
        )}

        <section>
          <SectionHeading>{WHAT_GOES_IN}</SectionHeading>
          <p className="text-[12px] text-gray-800 dark:text-gray-100">
            {filesResolved(plan.resolved.length, plan.totalFiles)}
          </p>
          <PathList rows={plan.resolved} />
          {/* ⚠ THE BLOCKING LIST, ABOVE THE INFORMATIONAL ONE. These are files the reader can
              finish; "Still conflicted" below is files GitHub has to finish. Each row is a real
              <button> — it navigates, so it needs the keyboard. */}
          {plan.outstanding.length > 0 && (
            <>
              <p className="mt-2 text-[12px] text-gray-800 dark:text-gray-100">
                {STILL_TO_DECIDE}
              </p>
              <ul className="mt-0.5">
                {plan.outstanding.map((row) => (
                  <li key={row.index}>
                    <button
                      type="button"
                      onClick={() => onJumpToFile(row.index)}
                      // ⚠ IT REPEATS BOTH VISIBLE SPANS. An `aria-label` replaces the whole
                      // subtree, so a name of "Go to <path>" alone would drop the per-file
                      // remainder out of the accessible name — and that remainder appears nowhere
                      // else for a screen-reader user.
                      aria-label={jumpToFileLabel(row.path, row.remaining)}
                      className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      <span className="font-mono text-gray-800 dark:text-gray-100">{row.path}</span>
                      <span className="text-gray-600 dark:text-gray-300">
                        {toDecide(row.remaining)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {cantFinishHere.length > 0 && (
            <>
              <p className="mt-2 text-[12px] text-gray-800 dark:text-gray-100">
                {STILL_CONFLICTED}
              </p>
              <PathList rows={cantFinishHere} withLabel />
              <p className="mt-1 text-[12px] text-gray-700 dark:text-gray-200">
                {STAYS_CONFLICTED}
              </p>
              {/* The one sentence that needs more words, not fewer — see copy.ts. */}
              <p className="mt-2 text-[12px] text-gray-700 dark:text-gray-200">
                {PARTIAL_COMMIT_NOTE}
              </p>
            </>
          )}
        </section>

        <section>
          <SectionHeading>{HOW_TO_LAND}</SectionHeading>
          <div className="flex flex-col gap-2">
            <RadioCard
              name="conflict-strategy"
              checked={strategy === 'merge'}
              onSelect={() => setStrategy('merge')}
              icon={<MergeIcon size={13} />}
              title={STRATEGY_MERGE}
              /* ⚠ CONDITIONAL. A partial commit is not a merge commit, and the default card must
                 not promise one the common path does not produce. */
              detail={session.fullyResolvable ? STRATEGY_MERGE_FULL : STRATEGY_MERGE_PARTIAL}
            />
            <RadioCard
              name="conflict-strategy"
              checked={strategy === 'rebase'}
              onSelect={() => setStrategy('rebase')}
              disabled={!rebaseOffered}
              icon={<RebaseIcon size={13} />}
              title={STRATEGY_REBASE}
              detail={
                rebaseOffered
                  ? strategyRebaseDetail(session.baseRef)
                  : // The server's own sentence, verbatim: it knows why (commit count, a fork, a
                    // merge already in the history) and this screen does not.
                    (session.rebaseUnavailableReason ?? strategyRebaseDetail(session.baseRef))
              }
            />
          </div>
        </section>

        <section>
          <SectionHeading>{WHERE_TO_PUT_IT}</SectionHeading>
          {/* The server's sentence, verbatim and once. It names the fact; the missing option is
              the consequence, and a second sentence from us restating it is verbiage. */}
          {targets.prBranchNote != null && (
            <p className="mb-1.5 text-[12px] text-gray-800 dark:text-gray-100">
              {targets.prBranchNote}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {targets.offerPrBranch && (
              <RadioCard
                name="conflict-target"
                checked={!toNewBranch}
                onSelect={() => setNewBranchChosen(false)}
                icon={<BranchIcon size={13} />}
                title={pushToBranch(session.headRef)}
              />
            )}
            <RadioCard
              name="conflict-target"
              checked={toNewBranch}
              onSelect={() => setNewBranchChosen(true)}
              icon={<BranchIcon size={13} />}
              title={NEW_BRANCH}
            />
          </div>
          {toNewBranch && (
            <div className="mt-2">
              <label
                htmlFor="conflict-branch-name"
                className="block text-[11px] text-gray-600 dark:text-gray-300"
              >
                {NEW_BRANCH_FIELD}
              </label>
              {/* ⚠ NO WINDOW KEY LISTENER IS NEEDED FOR THIS FIELD. Only `Escape` lives on
                  `window`; every other binding is `onKeyDown` on the panes' container, which is
                  not mounted while this view is. */}
              <input
                id="conflict-branch-name"
                type="text"
                value={branch}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setBranch(e.target.value)}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              {branchProblem != null && branch.trim() !== '' && (
                <p className="mt-1 text-[12px] text-gray-800 dark:text-gray-100">{branchProblem}</p>
              )}
              <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={openPr}
                  onChange={(e) => setOpenPr(e.target.checked)}
                />
                {OPEN_PR_FOR_BRANCH}
              </label>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <p className="text-[11px] text-gray-600 dark:text-gray-300">
            {pinnedOn(session.headSha, session.baseSha)}
          </p>
          {autoMergeArmed && (
            <p className="text-[12px] text-gray-800 dark:text-gray-100">{AUTO_MERGE_ARMED}</p>
          )}

          {failed ? (
            // ⚠ THE DECISIONS ARE UNTOUCHED. A refusal is the server declining to write anything,
            // so `Back` still returns to the panes with every choice in place. The server's own
            // sentence renders verbatim beside ours — it names the fact (`ModelStale`, `HeadMoved`,
            // `BranchExists`) and this screen cannot.
            <div className="flex flex-col gap-2">
              <p className="text-[12px] text-gray-800 dark:text-gray-100">
                {NOTHING_PUSHED} {commit?.error?.message ?? commitError ?? ''}
              </p>
              <div className="flex items-center gap-2">
                <SecondaryButton onClick={onBack}>{LANDING_BACK}</SecondaryButton>
                <SecondaryButton onClick={onRestart}>{START_AGAIN}</SecondaryButton>
                {/* The server refused and said so: nothing was pushed, so the reopen toast is
                    true and must still be offered. */}
                <SecondaryButton onClick={() => onClose(false)}>{CLOSE_RESOLVER}</SecondaryButton>
              </div>
            </div>
          ) : running && connectionLost ? (
            // ⚠ THE PUSH MAY HAVE LANDED. The route answered 202 and ran; what we lost is the
            // channel that would have said how it went — the SSE stream cut at the proxy's
            // fifteen-minute request cap, and the manifest poll behind it came back "no longer
            // open". So: state that it was sent, name where the answer is, and stop. NO retry
            // button, on any path from here, because a retry is a SECOND PUSH. Close is the only
            // control, and it closes as "committed" so the reopen toast cannot say "nothing
            // pushed".
            <div className="flex flex-col gap-2">
              <p
                className="text-[12px] text-gray-800 dark:text-gray-100"
                aria-live="polite"
                role="status"
              >
                {COMMIT_UNCONFIRMED}
              </p>
              <div className="flex items-center gap-2">
                {/* THE ONE CLOSE THAT FILES AS "COMMITTED" — a push is in flight on a session we
                    can no longer read, so "nothing pushed" is the one sentence nobody may say. */}
                <SecondaryButton onClick={() => onClose(true)}>{CLOSE_RESOLVER}</SecondaryButton>
              </div>
            </div>
          ) : running ? (
            <div
              className="text-[12px] text-gray-700 dark:text-gray-200"
              aria-live="polite"
              role="status"
            >
              {commit?.phase != null ? COMMIT_SENTENCE[commit.phase] : 'Starting…'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {/* The reason sits ABOVE the button and is its description — a disabled control
                  whose reason lives nowhere is the defect this replaces. */}
              {blockedReason != null && (
                <p id={BLOCKED_REASON_ID} className="text-[12px] text-gray-800 dark:text-gray-100">
                  {blockedReason}
                </p>
              )}
              <div className="flex items-center gap-2">
                <SecondaryButton onClick={onBack}>{LANDING_BACK}</SecondaryButton>
                <button
                  type="button"
                  onClick={submit}
                  disabled={blocked}
                  title={blockedReason ?? undefined}
                  // ⚠ THE NAME SAYS WHICH BUTTON THIS IS. The toolbar's says the same two words
                  // and opens this screen; this one pushes. A screen reader meeting "Commit and
                  // push, button" in both places has nothing to tell them apart — see
                  // `commitPressName`, and note it still OPENS with the visible label.
                  aria-label={commitPressName(
                    strategy === 'rebase' ? REBASE_AND_FORCE_PUSH : COMMIT_AND_PUSH,
                  )}
                  aria-describedby={blockedReason != null ? BLOCKED_REASON_ID : undefined}
                  className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900"
                >
                  {strategy === 'rebase' ? REBASE_AND_FORCE_PUSH : COMMIT_AND_PUSH}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h2 className="mb-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">{children}</h2>
  );
}

/** The paths, one per line, monospace. `withLabel` is the "Still conflicted" list, where each row
 *  carries WHY — the server's noun phrase for a file the model cannot represent, ours ("Nothing to
 *  decide") for a supported one it found nothing decidable in. */
function PathList({
  rows,
  withLabel = false,
}: {
  rows: readonly LandingFileRow[];
  withLabel?: boolean;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ul className="mt-0.5">
      {rows.map((row) => (
        <li key={row.index} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
          <span className="font-mono text-gray-800 dark:text-gray-100">{row.path}</span>
          {withLabel && <span className="text-gray-600 dark:text-gray-300">{row.label}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A radio and its two lines. A disabled card still renders its reason — an option that vanished
 *  and an option that is refused are different facts, and only one of them needs explaining. */
function RadioCard({
  name,
  checked,
  onSelect,
  disabled = false,
  icon,
  title,
  detail,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  icon: JSX.Element;
  title: string;
  detail?: string;
}): JSX.Element {
  return (
    <label
      className={`flex items-start gap-2 rounded border px-2.5 py-1.5 ${
        checked
          ? 'border-gray-400 dark:border-gray-500'
          : 'border-gray-200 dark:border-gray-800'
      } ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-900 dark:text-gray-100">
          {icon}
          {title}
        </span>
        {detail != null && (
          <span className="mt-0.5 block text-[12px] text-gray-600 dark:text-gray-300">
            {detail}
          </span>
        )}
      </span>
    </label>
  );
}

function SecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-800 hover:border-gray-400 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
    >
      {children}
    </button>
  );
}

/** The commit button's `aria-describedby` target. One view, one button, so one id. */
const BLOCKED_REASON_ID = 'conflict-commit-blocked-reason';

const EMPTY_DECISIONS: Readonly<Record<string, ConflictDecision>> = Object.freeze({});
/** The empty map for EITHER handle set — suggestion ids or edit ids. ⚠ FROZEN AND
 *  MODULE-LEVEL, not a `{}` literal at the call site: a fresh object every render would break
 *  every memo that depends on it. */
const EMPTY_HANDLES: Readonly<Record<string, string>> = Object.freeze({});
