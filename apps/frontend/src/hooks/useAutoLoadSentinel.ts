import { useEffect, useRef, type RefObject } from 'react';
import { nearestScrollParent } from '../lib/scrollParent.js';

// Infinite scroll for a list that lives inside its OWN scroll pane rather than the page viewport
// (see lib/scrollParent.ts). Render an empty row carrying `sentinelRef` AFTER the list — below any
// bottom spacer, so the sentinel sits at the TRUE bottom — and only while `showSentinel` is true;
// an IntersectionObserver rooted on that pane then fires ~a screenful early (rootMargin) so the
// next page is fetching before the user reaches the bottom.
//
// ⚠ `FeedView.tsx` keeps its own inline copy of this block ON PURPOSE — it is the one instance with
// real mileage and is deliberately not refactored onto this hook. A fix here belongs there too.
export function useAutoLoadSentinel(opts: {
  hasMore: boolean;
  isFetchingMore: boolean;
  itemCount: number;
  loadMore: () => void;
}): { sentinelRef: RefObject<HTMLDivElement>; showSentinel: boolean } {
  const { hasMore, isFetchingMore, itemCount, loadMore } = opts;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sentinelVisibleRef = useRef(false);
  // `loadNextRef` holds the latest guard so the observer callback stays stable (the effect below
  // keeps its deps down to `showSentinel`) yet always sees fresh state. Reading `hasMore` /
  // `isFetchingMore` straight from the closure instead would pin them to the render that built the
  // observer, so it would keep re-requesting a page that is already in flight.
  const loadNextRef = useRef<() => void>(() => {});
  loadNextRef.current = () => {
    if (hasMore && !isFetchingMore && itemCount > 0) loadMore();
  };
  // Mount/unmount the observer with the sentinel (rendered only when there's more to load).
  const showSentinel = hasMore && itemCount > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        sentinelVisibleRef.current = entries[0]?.isIntersecting ?? false;
        if (sentinelVisibleRef.current) loadNextRef.current();
      },
      // Root = the list's own scroll pane; prefetch a screenful before the bottom.
      { root: nearestScrollParent(el), rootMargin: '0px 0px 600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // showSentinel gates the sentinel's existence; re-run when it flips so the observer
    // attaches once the node mounts (the ref is null on the initial, list-empty render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSentinel]);
  // If a settled page leaves the sentinel STILL within range (tall viewport / short page), keep
  // pulling until it scrolls out or nothing remains — the observer alone won't re-fire while
  // `isIntersecting` stays true, which is the classic "stops loading after page 2 on a big screen"
  // bug. The loadNext guard blocks re-entry while a fetch is outstanding.
  useEffect(() => {
    if (!isFetchingMore && sentinelVisibleRef.current) loadNextRef.current();
  }, [isFetchingMore, itemCount, hasMore]);

  return { sentinelRef, showSentinel };
}
