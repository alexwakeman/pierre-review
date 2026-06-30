import { usePinnedTabs } from '../store/pinnedTabs.js';
import type { DigestPrRef } from '@pierre-review/shared';

// Open a digest's referenced PR as a new pinned tab: pin its lightweight meta, then
// switch to it (the full-screen PR overlay). Author chrome backfills when PrDetail
// loads and calls syncMeta. A no-op for an unresolved ref (prId == null).
export function useOpenPrTab(): (ref: DigestPrRef) => void {
  const pin = usePinnedTabs((s) => s.pin);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  return (ref: DigestPrRef) => {
    if (ref.prId == null) return;
    pin({
      id: ref.prId,
      number: ref.prNumber,
      title: ref.title ?? `#${ref.prNumber}`,
      repoFullName: ref.repoFullName,
      authorLogin: null,
      authorDisplayName: null,
      authorAvatarUrl: null,
    });
    setActiveTab(ref.prId);
  };
}
