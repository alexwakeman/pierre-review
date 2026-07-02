import { usePinnedTabs } from '../store/pinnedTabs.js';
import type { DigestPrRef } from '@pierre-review/shared';
import { useTimeline } from './useTimeline.js';

// TabMeta for a digest's referenced PR (author chrome backfills when PrDetail loads and
// calls syncMeta).
function metaFor(ref: DigestPrRef): {
  id: number;
  number: number;
  title: string;
  repoFullName: string;
  authorLogin: null;
  authorDisplayName: null;
  authorAvatarUrl: null;
} {
  return {
    id: ref.prId as number,
    number: ref.prNumber,
    title: ref.title ?? `#${ref.prNumber}`,
    repoFullName: ref.repoFullName,
    authorLogin: null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// Open a digest's referenced PR as a full-screen pr-detail tab. A no-op for an
// unresolved ref (prId == null). Digest refs are clicked from the Activity, so opening
// from there arms Back → Activity (item 4); `fromActivity: true` makes that explicit.
export function useOpenPrTab(): (ref: DigestPrRef) => void {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  return (ref: DigestPrRef) => {
    if (ref.prId == null) return;
    openPrDetailTab(metaFor(ref), { fromActivity: true });
  };
}

// Focus a digest's referenced PR in its OWN isolated timeline tab (Focus mode). Falls
// back to the PR-detail tab when the PR isn't on the current (filter/date-scoped) board,
// so a title click is never a dead-end (an off-board Focus would open an empty timeline).
export function useFocusPrTab(): (ref: DigestPrRef) => void {
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const timelinePrs = useTimeline().data?.prs;
  return (ref: DigestPrRef) => {
    if (ref.prId == null) return;
    const meta = metaFor(ref);
    // Optimistic while the board query is still loading (known === false).
    const known = timelinePrs != null;
    const onTimeline = timelinePrs?.some((p) => p.id === ref.prId) ?? false;
    if (!known || onTimeline) openPrFocusTab(meta, { fromActivity: true });
    else openPrDetailTab(meta, { fromActivity: true });
  };
}
