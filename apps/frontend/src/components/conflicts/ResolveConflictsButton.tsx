import { useEffect, useRef, useState } from 'react';
import type { MergeVerdict, PrState } from '@pierre-review/shared';
import { conflictResolverEntryVisible, type ConflictResolverEntry } from '../../lib/ui.js';
import { useMe } from '../../hooks/useTriage.js';
import { openConflictResolver, type ResolverTarget } from '../../store/conflictResolver.js';
import { CaretIcon, ConflictIcon, SparkleIcon } from '../Icons.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import {
  cancelConflictAiRun,
  conflictAiPhaseLabel,
  conflictAiRunActive,
  startConflictAiRun,
  useConflictAiRun,
} from '../../hooks/useConflictAiResolve.js';
import { AiRunGate } from '../AiSetup.js';
import { RegenProgressBar } from '../Activity/RegenProgressBar.js';

/**
 * THE GATE, with the one fact that is not on the caller's payload supplied.
 *
 * ⚠ `useMe` IS THE App-ROOT `['me']` CACHE, NOT A FETCH. It is mounted before any board paints, so
 * fifty of these on a Pending board issue zero requests.
 *
 * ⚠ `?? false` — while `['me']` is still loading the answer is "we do not know", and an undefined
 * capability must not render a button that 404s on the first click.
 *
 * Exported so a caller that needs to know whether the button will render ANYTHING — a row whose
 * only other content is optional, and which would otherwise be an empty box of padding — can ask
 * the SAME resolver rather than growing a second, disagreeing copy of the rule.
 */
export function useConflictResolverEntry(
  e: Omit<ConflictResolverEntry, 'resolverAvailable'>,
): boolean {
  const { data: me } = useMe();
  return conflictResolverEntryVisible({ ...e, resolverAvailable: me?.conflictResolver ?? false });
}

/**
 * THE ONE ENTRY INTO THE MERGE-CONFLICT RESOLVER. Three surfaces mount this component and none of
 * them re-implements the gate: the PR pane's Conflicts row, MergeControl's expanded conflict box,
 * and the Pending board's conflicts card.
 *
 * ⚠ IT FETCHES NOTHING. The gate is four synced facts (`conflictResolverEntryVisible` in lib/ui
 * carries the argument for each): the PR is open, the ONE merge resolver says `conflicts`, the
 * viewer can push, and `/api/me` says the resolver exists here. `useMe` is the App-root `['me']`
 * cache — already mounted before any board paints, so fifty of these on a board issue zero
 * requests. Everything expensive happens on the CLICK.
 *
 * ⚠ HIDE, NEVER DISABLE. A reader without push access sees the surrounding sentence and its
 * GitHub link, exactly as before this button existed. A disabled button would be an offer the app
 * cannot honour, on a row whose whole job is to say what to do next.
 */
export function ResolveConflictsButton({
  state,
  verdict,
  viewerCanPush,
  target,
  className,
  buttonClass,
}: {
  state: PrState;
  /** The RESOLVED verdict from `mergeVerdict`, never a re-reading of the raw columns. */
  verdict: MergeVerdict;
  viewerCanPush: boolean;
  /** Everything the overlay needs to name this pull request — all of it already on the payload
   *  that mounted this button. */
  target: ResolverTarget;
  className?: string;
  /** REPLACES the default button style (a host with its own button scale, e.g. the Pending card's
   *  primary). `className` is appended to the default instead. */
  buttonClass?: string;
}): JSX.Element | null {
  const show = useConflictResolverEntry({ state, verdict, viewerCanPush });
  const ai = useAiCapabilities();
  if (!show) return null;
  const cls =
    buttonClass ??
    `inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800 ${className ?? ''}`;
  // ⚠ WITHOUT THE AGENTIC FEATURES (cloud, LIMN_AI_DISABLED) THERE IS ONE WAY TO RESOLVE, SO THERE
  // IS NO MENU: the plain button, exactly as before.
  if (!ai.enabled) {
    return (
      <button
        type="button"
        onClick={() => openConflictResolver(target)}
        className={cls}
        title={`Resolve the conflicts in ${target.repoFullName} #${target.prNumber}`}
      >
        <ConflictIcon size={12} />
        Resolve conflicts
      </button>
    );
  }
  return <ResolveConflictsMenu target={target} buttonClass={cls} />;
}

/**
 * The split entry: "Resolve manually" or "Resolve with Claude". ⚠ STILL FETCHES NOTHING ON MOUNT —
 * the run store is module state and a PR with no run issues no request; everything happens on the
 * click. Choosing Claude starts the run, shows its progress here, then opens the resolver with
 * Claude's decisions filled in (`useClaudePrefill`). A missing AI runtime or credential is the ONE
 * `AiRunGate`, in place of the Claude item.
 */
function ResolveConflictsMenu({
  target,
  buttonClass,
}: {
  target: ResolverTarget;
  buttonClass: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const run = useConflictAiRun(target.prId);
  const active = conflictAiRunActive(run);
  const ai = useAiCapabilities();
  const aiReady = ai.ready;
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (active && run != null) {
    return (
      <div className="inline-flex min-w-[14rem] flex-col gap-1">
        <div className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
          <SparkleIcon size={12} className="text-ai-signal" />
          <span>{conflictAiPhaseLabel(run.phase)}</span>
          <button
            type="button"
            onClick={() => cancelConflictAiRun(target.prId)}
            className="ml-auto text-[11px] text-gray-600 underline underline-offset-2 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
          >
            Cancel
          </button>
        </div>
        <RegenProgressBar active label="Resolving conflicts with Claude" timeConstantSec={60} />
      </div>
    );
  }

  const item =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800';
  return (
    <div ref={rootRef} className="relative inline-flex flex-col items-start gap-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={buttonClass}
        title={`Resolve the conflicts in ${target.repoFullName} #${target.prNumber}`}
      >
        <ConflictIcon size={12} />
        Resolve conflicts
        <CaretIcon dir="down" className="shrink-0 opacity-70" />
      </button>
      {run?.phase === 'failed' && run.error != null && (
        <span className="text-[12px] text-red-600 dark:text-red-400">{run.error}</span>
      )}
      {open && (
        <div
          role="menu"
          aria-label="Resolve conflicts"
          className="absolute left-0 top-full z-[55] mt-1 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              openConflictResolver(target);
            }}
          >
            <ConflictIcon size={13} />
            Resolve manually
          </button>
          {/* ⚠ THE ONE GATE. No runtime or no credential: its own line (or "Set up AI") in place
              of the item, never a hidden feature and never a second copy of that rule. */}
          {aiReady ? (
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                startConflictAiRun(target);
              }}
            >
              <SparkleIcon size={13} />
              Resolve with Claude
            </button>
          ) : (
            <div className="px-3 py-1.5">
              <AiRunGate>
                <span />
              </AiRunGate>
            </div>
          )}
          <p className="px-3 pb-1 pt-0.5 text-[11px] text-gray-600 dark:text-gray-300">
            You check Claude’s choices before anything is pushed.
          </p>
        </div>
      )}
    </div>
  );
}
