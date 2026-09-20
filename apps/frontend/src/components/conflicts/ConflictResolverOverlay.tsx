import { useEffect, useMemo, useState } from 'react';
import type {
  ConflictCommitBody,
  ConflictDecision,
  ConflictFileContent,
  ConflictPreparePhase,
  ConflictSession,
} from '@pierre-review/shared';
import { useConflictSession } from '../../hooks/useConflictSession.js';
import {
  useConflictCommit,
  useConflictCommitInvalidation,
} from '../../hooks/useConflictCommit.js';
import { usePr } from '../../hooks/usePr.js';
import { usePrArmedIntent } from '../../hooks/useAutoMerge.js';
import {
  resolverSessionKey,
  useConflictResolverStore,
  useResolverSession,
  useResolverTarget,
  type ResolverTarget,
} from '../../store/conflictResolver.js';
import { CloseIcon, ExternalLinkIcon } from '../Icons.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { commitPlan, type CommitPlan } from '../../lib/conflictCommit.js';
import { ResolverPanes } from './ResolverPanes.js';
import { LandingStep } from './LandingStep.js';
import { CommitResultPanel } from './CommitResultPanel.js';
import { CloseResolverConfirm } from './CloseResolverConfirm.js';
import {
  BRANCH_MOVED_RESTART,
  DECISIONS_KEPT,
  READING_FILES,
  SESSION_GONE,
  START_AGAIN,
  decisionsDecided,
} from './copy.js';

// ── THE RESOLVER SHELL ───────────────────────────────────────────────────────────────────────
//
// Mounted from `App.tsx` beside HelpModal/SettingsModal, NOT from inside PrDetail: it opens from
// three places and must not unmount when the pane behind it closes.
//
// ⚠ IT IS OPAQUE, NOT A SCRIM. `z-[60]` sits above the one bottom-right toast column's `z-50`,
// and the ground is the page's own. A three-pane merge tool needs the whole viewport, and a
// translucent backdrop over a live timeline is unreadable at 12px.
//
// ⚠ THERE IS NO URL KEY, NO HISTORY ENTRY AND NO `PrDetailTab` MEMBER, DELIBERATELY. A
// `?prTab=conflicts` would make Back a way to lose work — a `popstate` cannot be cancelled, and
// the only guard available (a corrective push) is the documented permanent-no-op trap in
// `useUrlState.ts`. It would also make the resolver DEEP-LINKABLE, and every address-bar visit to
// that link would spend a clone. So: `popstate` CLOSES and pushes nothing; the decisions survive
// in `store/conflictResolver.ts` under the pinned key, and the reopen toast is the way back.
//
// ⚠ THE FIVE WAYS OUT ARE NOT ONE RULE. The header's Close button closes outright (a deliberate
// press on a control labelled "Close" is not an accident); `Escape` raises the confirm bar once
// there is work to lose, because it is the keystroke that means "get me out of whatever I am in";
// `popstate` closes because it cannot be cancelled; a click on the overlay's own chrome is ignored
// entirely; and a reload is caught by `beforeunload`, which is the ONE gesture the store cannot
// survive.

/** Wire vocabulary → one short sentence. The wire carries phases, never copy. */
const PREPARE_SENTENCE: Record<ConflictPreparePhase, string> = {
  cloning: 'Getting a copy of the repository…',
  fetching: 'Fetching both branches…',
  merging: 'Working out what conflicts…',
  reading: READING_FILES,
};

export function ConflictResolverOverlay(): JSX.Element | null {
  const target = useResolverTarget();
  if (target == null) return null;
  // Keyed on the pull request so switching targets rebuilds the session rather than reusing one
  // pinned to a different merge.
  return <ResolverShell key={target.prId} target={target} />;
}

function ResolverShell({ target }: { target: ResolverTarget }): JSX.Element {
  const close = useConflictResolverStore((s) => s.closeConflictResolver);
  const seedSession = useConflictResolverStore((s) => s.seedSession);
  const confirming = useConflictResolverStore((s) => s.confirming);
  const setConfirming = useConflictResolverStore((s) => s.setConfirming);
  const sessions = useConflictResolverStore((s) => s.sessions);
  const {
    session,
    connection,
    openError,
    files,
    loadingFiles,
    fileErrors,
    loadFile,
    retryFile,
    restart,
  } = useConflictSession(target.prId);
  // The server no longer has this session, so nothing more about it will ever be learned HERE.
  // ⚠ NOT "it failed" — see `COMMIT_UNCONFIRMED`. The one thing it changes on screen is the words
  // used for a commit already in flight, and the one thing it must never do is offer a retry.
  const connectionLost = connection === 'lost';
  const [view, setView] = useState<'panes' | 'landing'>('panes');
  // A one-shot: the landing step's "Still to decide" row sends the reader back to a FILE, and the
  // panes put the cursor on that file's first unanswered region. ⚠ A FILE INDEX, NOT A REGION —
  // the landing step does not hold that file's regions and must not fetch them to name one.
  const [jumpTo, setJumpTo] = useState<number | null>(null);

  const key =
    session != null && session.status === 'ready'
      ? resolverSessionKey(target.prId, session.headSha, session.baseSha, session.modelHash)
      : null;
  const stored = useResolverSession(key);

  // Seed (or re-attach to) this pinned model's decision set the moment the model is ready. The
  // store keeps existing decisions under the same key, so a reopen onto the SAME merge finds the
  // reader's work where they left it — and a different merge is a different key.
  useEffect(() => {
    if (key == null || session == null) return;
    seedSession({
      key,
      // ⚠ THE SERVER SESSION, NOT THE PIN KEY. A reopen onto the same two shas mints the same
      // key and a DIFFERENT server session; `seedSession` uses this to drop the accepted
      // suggestions, whose handles only that process's session could redeem.
      sessionId: session.sessionId,
      conflictCount: session.files.reduce((n, f) => n + f.conflictCount, 0),
    });
  }, [key, session, seedSession]);

  const decisions = stored?.decisions ?? EMPTY_DECISIONS;

  // ⚠ ONE FOLD, ONE NUMBER. The footer, the toolbar's countdown, the close confirm, the landing
  // step's gate and the result panel all read THIS object. Three separate predicates used to
  // answer "can we commit?" and two separate folds answered "how much is done", which is how a
  // button and the list under it come to disagree. It costs what the panes' own tally already
  // pays on every decision.
  const plan = useMemo<CommitPlan | null>(
    () =>
      session == null || session.status !== 'ready' ? null : commitPlan(session, files, decisions),
    [session, files, decisions],
  );

  // ── The commit ──────────────────────────────────────────────────────────────────────────────
  const commitMutation = useConflictCommit(target.prId);
  const commit = session?.commit ?? null;
  // The three-key refetch, fired once when the STREAM says the push finished — never at the 202.
  useConflictCommitInvalidation(target.prId, commit);
  const committed = commit?.status === 'done' && commit.result != null;

  // ⚠ THE ONLY OTHER READ OF "HAS THIS MOVED?". `usePrLiveRefresh` already re-reads the PR every
  // ~5s while its pane is open, and `PrDetail.headSha` is what it writes; the pin is on the
  // session. A second, independent comparison is how two surfaces come to disagree about the same
  // fact.
  const { data: pr } = usePr(target.prId);
  const headMoved = useHeadMoved(session?.headSha ?? null, pr?.headSha);

  // A live "merge when ready" row, off the account-wide list the app already polls — zero new
  // requests. The landing step says out loud that the push will disarm it, BEFORE the button.
  const armed = usePrArmedIntent(target.prId) != null;

  // ⚠ THE WORK AT RISK IS EVERY DECISION THE READER MADE. It used to be CONTESTED regions only,
  // because an auto-apply pass wrote a decision per one-sided region the moment a file's regions
  // arrived and gating on that would have put a confirm bar in front of somebody who opened a
  // file and looked at it. Nothing seeds a decision any more, so that reason is gone — and the
  // narrow count UNDER-fires: a reader who answered fifteen one-sided changes and no conflicts
  // had `decided === 0`, so Escape closed outright and `beforeunload` (the ONE gesture the store
  // cannot survive) never registered.
  const atRisk = plan != null && plan.decidedTotal > 0 && !committed;

  // Escape. ⚠ CAPTURE PHASE + `stopImmediatePropagation`, the HelpModal precedent: the global
  // `useKeyboard` hook treats Escape as "leave the current tab → the board", so without this the
  // one keypress would close the resolver AND navigate the app underneath it. ONE key on
  // `window` — every other binding belongs to the panes container, so `←`/`→` cannot fight a
  // text caret or the file list.
  //
  // ⚠ A SECOND ESCAPE PICKS "KEEP WORKING". Escape is what raised the question, so pressing it
  // again has to be the harmless answer — anything else makes the reflex destructive.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (confirming) {
        setConfirming(false);
        return;
      }
      if (atRisk) {
        setConfirming(true);
        return;
      }
      close({ reason: 'user' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, confirming, setConfirming, atRisk]);

  // Back / Forward. ⚠ CLOSES AND PUSHES NOTHING — see the ⚠ in the module header. A pop cannot be
  // cancelled, so the honest behaviour is to get out of the way and leave the decisions in the
  // store for the reopen toast.
  useEffect(() => {
    const onPop = (): void => close({ reason: 'navigated' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [close]);

  // ⚠ RELOAD IS THE ONE GESTURE THE STORE CANNOT SURVIVE. Every other way out keeps the decisions
  // (which is why the footer says so); a reload takes the module store with it, so this is the
  // only place a browser-level warning is warranted. Nothing custom is said — browsers ignore the
  // string and render their own sentence.
  useEffect(() => {
    if (!atRisk) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [atRisk]);

  // ⚠ SAID ONCE, AND DERIVED — no handshake with the toast. Decisions are filed under
  // `${prId}:${headSha}:${baseSha}:${modelHash}`, so a reopen onto a branch that has since moved
  // mints a DIFFERENT key and simply does not find the reader's work. Holding a set of decisions
  // for this pull request under some other key is exactly that fact, and it is the only honest
  // moment to say so: they are never migrated onto a merge the reader did not see.
  const stranded = useMemo(() => {
    if (key == null) return false;
    return Object.values(sessions).some(
      (s) => s.key !== key && s.key.startsWith(`${target.prId}:`) && s.decidedCount > 0,
    );
  }, [sessions, key, target.prId]);

  const githubUrl = safeExternalUrl(target.githubUrl);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-white dark:bg-gray-950"
      role="dialog"
      aria-modal="true"
      aria-label={`Resolve conflicts in ${target.repoFullName} #${target.prNumber}`}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {target.prTitle}
          </div>
          <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">
            {target.repoFullName} #{target.prNumber}
            {session != null && session.status !== 'preparing' && (
              <>
                {' · merging '}
                <span className="font-mono">{session.baseRef}</span>
                {' into '}
                <span className="font-mono">{session.headRef}</span>
              </>
            )}
          </div>
        </div>
        {githubUrl !== undefined && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Open on GitHub
            <ExternalLinkIcon size={11} className="ml-0.5 inline-block align-[-0.1em]" />
          </a>
        )}
        {/* ⚠ CLOSES OUTRIGHT, NO CONFIRM. A deliberate press on a control labelled "Close" is not
            an accident; the reopen toast is the way back from it. */}
        <button
          type="button"
          onClick={() => close({ reason: 'user' })}
          className="flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          title="Close"
          aria-label="Close"
        >
          <CloseIcon size={16} />
        </button>
      </header>

      {stranded && (
        <div className="shrink-0 border-b border-gray-200 px-4 py-1.5 text-[12px] text-gray-700 dark:border-gray-800 dark:text-gray-200">
          {BRANCH_MOVED_RESTART}
        </div>
      )}

      {/* ⚠ `min-h-0` is load-bearing: without it the flex child refuses to shrink and the grid
          overflows the viewport instead of scrolling. The panes bring their OWN scroller, and so
          do the landing step and the result panel — this box must not be one, because two nested
          scrollers is how the sticky pane headers stop sticking. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ResolverBody
          openError={openError}
          session={session}
          connectionLost={connectionLost}
          sessionKey={key}
          files={files}
          plan={plan}
          loadingFiles={loadingFiles}
          fileErrors={fileErrors}
          loadFile={loadFile}
          onRetryFile={retryFile}
          onRestart={restart}
          view={view}
          onView={setView}
          jumpTo={jumpTo}
          onJumpTo={setJumpTo}
          headMoved={headMoved}
          autoMergeArmed={armed}
          commitError={commitMutation.error?.message ?? null}
          onCommit={(body: ConflictCommitBody) => commitMutation.mutate(body)}
          onResetCommit={() => commitMutation.reset()}
          onClose={(committedNow: boolean) =>
            close({ reason: committedNow ? 'committed' : 'user' })
          }
        />
      </div>

      {confirming && (
        <CloseResolverConfirm
          decided={plan?.decidedTotal ?? 0}
          total={plan?.decidableTotal ?? 0}
          onKeep={() => setConfirming(false)}
          onClose={() => close({ reason: 'user' })}
        />
      )}

      {/* ⚠ THE COUNTDOWN IS THE COMMIT GATE'S OWN POPULATION — every region that takes a
          decision, across every supported file, with the denominator off the MANIFEST so a file
          nobody opened is still counted. It used to count contested regions only, which was
          honest while one-sided changes were applied for you and is not now: it could read
          "3 of 3 conflicts decided" beside a Commit button held shut by four one-sided changes.
          It is the SAME `plan` object the landing step gates on, so the two cannot disagree.

          The second line replaces the old "nothing here is saved": decisions ARE kept, under the
          pinned key, and that is precisely what makes an accidental Escape survivable. */}
      <footer className="flex shrink-0 flex-wrap items-baseline gap-x-3 border-t border-gray-200 px-4 py-1.5 text-[11px] text-gray-600 dark:border-gray-800 dark:text-gray-300">
        <span>
          {/* ⚠ THE FALLBACK IS "still reading", NOT "nothing to decide". `plan` is null until
              the session is ready, and `decisionsDecided(0, 0)` already owns the sentence that
              says this pull request has nothing to decide — asserting that here, a second before
              it flips to "12 of 12 changes decided", is a claim nobody has established. */}
          {plan != null ? decisionsDecided(plan.decidedTotal, plan.decidableTotal) : READING_FILES}
        </span>
        <span>{DECISIONS_KEPT}</span>
      </footer>
    </div>
  );
}

/**
 * Has the pull request's head moved on GitHub since this model was pinned?
 *
 * ⚠ THE PREDICATE IS "MOVED SINCE", NOT "DIFFERS FROM". The local `pull_requests.head_sha` can
 * simply be behind — the resolver reads its refs straight from GitHub while the row waits on a
 * sync — and a bare inequality would put "the PR moved while you were here" on screen the instant
 * the overlay opened, disabling the commit for a branch nobody had touched. So the local sha
 * observed when the model was pinned is the anchor, and the warning fires only once the local
 * record has MOVED off it AND disagrees with the pin.
 */
function useHeadMoved(sessionHead: string | null, localHead: string | null | undefined): boolean {
  const [anchor, setAnchor] = useState<{ pin: string; head: string } | null>(null);
  useEffect(() => {
    if (sessionHead == null || localHead == null) return;
    setAnchor((prev) => (prev != null && prev.pin === sessionHead ? prev : { pin: sessionHead, head: localHead }));
  }, [sessionHead, localHead]);
  if (sessionHead == null || localHead == null) return false;
  if (anchor == null || anchor.pin !== sessionHead) return false;
  return localHead !== sessionHead && localHead !== anchor.head;
}

/** The shell's states. `ready` is the three panes, the landing step, or the terminal result panel;
 *  the other three are one sentence each. */
function ResolverBody({
  openError,
  session,
  connectionLost,
  sessionKey,
  files,
  plan,
  loadingFiles,
  fileErrors,
  loadFile,
  onRetryFile,
  onRestart,
  view,
  onView,
  jumpTo,
  onJumpTo,
  headMoved,
  autoMergeArmed,
  commitError,
  onCommit,
  onResetCommit,
  onClose,
}: {
  openError: string | null;
  session: ConflictSession | null;
  /** The server no longer has this session. ⚠ NOT a failure — it only changes the WORDS used for
   *  a commit whose outcome can no longer be read back. */
  connectionLost: boolean;
  sessionKey: string | null;
  files: Record<number, ConflictFileContent>;
  /** ⚠ THE ONE GATE AND THE ONE COUNTER, folded once in the shell. Null until the model is
   *  `ready`, which is also every branch below that renders a sentence rather than the panes. */
  plan: CommitPlan | null;
  loadingFiles: ReadonlySet<number>;
  fileErrors: Readonly<Record<number, string>>;
  loadFile: (index: number) => Promise<ConflictFileContent | null>;
  onRetryFile: (index: number) => void;
  onRestart: () => void;
  view: 'panes' | 'landing';
  onView: (v: 'panes' | 'landing') => void;
  /** The landing step's one-shot "finish this file" target, consumed by the panes. */
  jumpTo: number | null;
  onJumpTo: (index: number | null) => void;
  headMoved: boolean;
  autoMergeArmed: boolean;
  commitError: string | null;
  onCommit: (body: ConflictCommitBody) => void;
  /** Clear a synchronous refusal so leaving the landing step does not carry it back. */
  onResetCommit: () => void;
  onClose: (committed: boolean) => void;
}): JSX.Element {
  if (openError != null) {
    // The server's own sentence, verbatim. It already names the fact and stops.
    return <Notice text={openError} onRetry={onRestart} />;
  }
  if (session == null) return <Notice text="Starting…" />;
  if (session.status === 'failed') {
    return (
      <Notice
        text={session.error?.message ?? 'Couldn’t work out the conflicts in this pull request.'}
        onRetry={onRestart}
      />
    );
  }
  if (session.status === 'preparing') {
    // ⚠ NOTHING HAS BEEN PUSHED AT THIS STAGE, so "start again" is the whole answer and offering
    // it is safe. Without this branch a session lost mid-build (a restart, a redeploy) leaves the
    // overlay reading "Reading the conflicting files…" for as long as the reader is willing to
    // watch it.
    if (connectionLost) return <Notice text={SESSION_GONE} onRetry={onRestart} />;
    return <Notice text={session.phase != null ? PREPARE_SENTENCE[session.phase] : 'Starting…'} />;
  }
  if (session.status === 'clean') {
    return <Notice text={`This pull request no longer conflicts with ${session.baseRef}.`} />;
  }
  // `ready` ⇒ both of these are here. The guard is what tells the compiler so, and it renders the
  // same sentence as the line above it because it is the same moment.
  if (sessionKey == null || plan == null) return <Notice text={READING_FILES} />;

  const result = session.commit?.status === 'done' ? session.commit.result : null;
  if (result != null) {
    // ⚠ TERMINAL, AND IT DOES NOT AUTO-CLOSE: this is the only place the per-file refusals are
    // stated. The plan is the shell's ONE fold, handed down — the panel stays a renderer.
    return (
      <CommitResultPanel
        session={session}
        result={result}
        plan={plan}
        onClose={() => onClose(true)}
      />
    );
  }

  if (view === 'landing') {
    return (
      <LandingStep
        session={session}
        sessionKey={sessionKey}
        files={files}
        plan={plan}
        headMoved={headMoved}
        autoMergeArmed={autoMergeArmed}
        commitError={commitError}
        connectionLost={connectionLost}
        onBack={() => {
          onResetCommit();
          onView('panes');
        }}
        onJumpToFile={(index) => {
          onResetCommit();
          onJumpTo(index);
          onView('panes');
        }}
        onCommit={onCommit}
        onRestart={() => {
          onResetCommit();
          onRestart();
        }}
        // ⚠ THE FLAG IS "THE OUTCOME IS UNKNOWN", AND ONLY THE LANDING STEP KNOWS THAT. `true`
        // suppresses the reopen toast, whose sentence ends "nothing pushed" — a claim nobody can
        // make while a commit is in flight on a session we have lost. But a LOST SESSION IS NOT A
        // COMMIT: on the landing step with nothing submitted, or after a refusal that said
        // "Nothing was pushed" in so many words, the outcome is known, the toast is true, and it
        // is the only route back to the reader's decisions. So the flag is decided in the branch
        // that knows — LandingStep's own `running && connectionLost` arm passes `true` and its
        // `failed` arm passes `false` — never guessed here from `connectionLost` alone.
        onClose={onClose}
      />
    );
  }

  return (
    <ResolverPanes
      session={session}
      sessionKey={sessionKey}
      files={files}
      loadingFiles={loadingFiles}
      fileErrors={fileErrors}
      loadFile={loadFile}
      onRetryFile={onRetryFile}
      decidedTotal={plan.decidedTotal}
      decidableTotal={plan.decidableTotal}
      jumpToFile={jumpTo}
      onJumpConsumed={() => onJumpTo(null)}
      onLand={() => onView('landing')}
    />
  );
}

const EMPTY_DECISIONS: Readonly<Record<string, ConflictDecision>> = Object.freeze({});

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-4 py-3 text-xs text-gray-600 dark:text-gray-300">
      <span>{text}</span>
      {onRetry != null && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-gray-300 px-1.5 py-0.5 font-medium text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200"
        >
          {/* Every `onRetry` here is `onRestart` — it opens a new session, it does not re-send
              anything — so the button says what it does, in the same words the landing step uses
              for the same action. The sentences beside it no longer repeat it. */}
          {START_AGAIN}
        </button>
      )}
    </div>
  );
}
