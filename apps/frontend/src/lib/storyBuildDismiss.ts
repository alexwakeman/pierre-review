import type { StoryBuildActivity } from '@pierre-review/shared';

// THE BUILDS TOAST's dismissals (components/StoryBuild/StoryBuildsToast.tsx; docs/STORY-BUILD.md § The builds
// toast). A FAILED build stays on `GET /api/story-builds/active` until it is discarded, so without a dismissal
// its row (and the alert circle) stayed forever. The reader's X hides that one failed build: keyed by the build
// row's id (every new attempt of a story is a new row, so a later failure shows), kept in this browser only.
// Only `failed` rows are dismissable; the other gates wait for a real action.

export const STORY_BUILD_DISMISS_STORAGE_KEY = 'limn:story-build-failed-dismissed';
/** The stored list never grows past this many ids (the oldest go first). */
export const STORY_BUILD_DISMISS_MAX = 200;

type Row = Pick<StoryBuildActivity, 'id' | 'gate'>;

/** A failed build the reader dismissed is not listed. Every other row is. */
export function visibleStoryBuilds<T extends Row>(builds: readonly T[], dismissed: readonly number[]): T[] {
  if (dismissed.length === 0) return [...builds];
  const hidden = new Set(dismissed);
  return builds.filter((b) => !(b.gate === 'failed' && hidden.has(b.id)));
}

/** Drop a dismissal whose build is listed again NOT failed (it moved on: should it fail again, it shows),
 *  then keep the newest `STORY_BUILD_DISMISS_MAX`. An id not listed is kept (the list is capped server side). */
export function pruneStoryBuildDismissals(dismissed: readonly number[], builds: readonly Row[]): number[] {
  const movedOn = new Set(builds.filter((b) => b.gate !== 'failed').map((b) => b.id));
  const kept = dismissed.filter((id) => !movedOn.has(id));
  return kept.slice(Math.max(0, kept.length - STORY_BUILD_DISMISS_MAX));
}

/** Add one dismissal (no duplicates). */
export function addStoryBuildDismissal(dismissed: readonly number[], id: number): number[] {
  const next = dismissed.filter((d) => d !== id);
  next.push(id);
  return next.slice(Math.max(0, next.length - STORY_BUILD_DISMISS_MAX));
}

export function readStoryBuildDismissals(): number[] {
  try {
    const raw = window.localStorage.getItem(STORY_BUILD_DISMISS_STORAGE_KEY);
    const parsed: unknown = raw != null ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function writeStoryBuildDismissals(ids: readonly number[]): void {
  try {
    window.localStorage.setItem(STORY_BUILD_DISMISS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // A blocked store: the dismissal lasts this page load only.
  }
}
