// The scroll container an IntersectionObserver (or a programmatic scroll) must be rooted on.
//
// Every list that uses this lives inside its OWN `overflow-y-auto` pane — the Activity console's
// feed pane, and the drill-down overlays, which are `absolute inset-0 overflow-auto` — not the
// page viewport. So infinite-scroll must observe its sentinel against THAT scroll container: only
// then does the rootMargin prefetch fire before the true bottom (a viewport root is clipped by the
// pane and would only fire once the sentinel is actually visible). Walk up to the nearest
// scrollable ancestor; null falls back to the viewport for any other host.
export function nearestScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}
