import type { MergeVerdict, PrState } from '@pierre-review/shared';
import { conflictResolverEntryVisible, type ConflictResolverEntry } from '../../lib/ui.js';
import { useMe } from '../../hooks/useTriage.js';
import { openConflictResolver, type ResolverTarget } from '../../store/conflictResolver.js';
import { ConflictIcon } from '../Icons.js';

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
}: {
  state: PrState;
  /** The RESOLVED verdict from `mergeVerdict`, never a re-reading of the raw columns. */
  verdict: MergeVerdict;
  viewerCanPush: boolean;
  /** Everything the overlay needs to name this pull request — all of it already on the payload
   *  that mounted this button. */
  target: ResolverTarget;
  className?: string;
}): JSX.Element | null {
  const show = useConflictResolverEntry({ state, verdict, viewerCanPush });
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={() => openConflictResolver(target)}
      className={`inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800 ${className ?? ''}`}
      title={`Resolve the conflicts in ${target.repoFullName} #${target.prNumber}`}
    >
      <ConflictIcon size={12} />
      Resolve conflicts
    </button>
  );
}
