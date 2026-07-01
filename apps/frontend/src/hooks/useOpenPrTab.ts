import { usePinnedTabs } from '../store/pinnedTabs.js';
import type { DigestPrRef } from '@pierre-review/shared';

// Open a digest's referenced PR as a full-screen pr-detail tab. Author chrome
// backfills when PrDetail loads and calls syncMeta. A no-op for an unresolved ref
// (prId == null). Digest refs are clicked from the Activity, so opening from there
// arms Back → Activity (item 4); `fromActivity: true` makes that explicit.
export function useOpenPrTab(): (ref: DigestPrRef) => void {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  return (ref: DigestPrRef) => {
    if (ref.prId == null) return;
    openPrDetailTab(
      {
        id: ref.prId,
        number: ref.prNumber,
        title: ref.title ?? `#${ref.prNumber}`,
        repoFullName: ref.repoFullName,
        authorLogin: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      },
      { fromActivity: true },
    );
  };
}
