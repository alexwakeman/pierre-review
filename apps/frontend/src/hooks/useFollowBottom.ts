import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { isScrolledToBottom } from '../lib/agentActivityLog.js';

// FOLLOW THE BOTTOM of a scroll box whose content arrives over time (the workspace session's
// conversation: new rows, a tool's output landing in an existing row, the agent's words streaming,
// Markdown reflowing). A dependency list cannot see all of that, so this watches the CONTENT itself:
// a ResizeObserver on the box's children (any height change) and a MutationObserver on the subtree
// (new rows, new text). While the reader is at the bottom every change scrolls to the end; once they
// scroll up nothing moves; back at the bottom, following resumes. `away` is true while they are up
// and something new has arrived (the "Jump to latest" button).

/** How near the end still counts as "at the bottom" (a trackpad rarely lands on the exact pixel). */
const SLACK_PX = 24;

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface FollowBottom<T extends HTMLElement> {
  /** The scroll box's ref (a callback ref, so a remount re-attaches the observers). */
  ref: (el: T | null) => void;
  onScroll: (e: UIEvent<T>) => void;
  /** The reader scrolled up and newer content arrived below. */
  away: boolean;
  /** Scroll to the end and follow again. */
  jump: () => void;
}

export function useFollowBottom<T extends HTMLElement>(): FollowBottom<T> {
  const [el, setEl] = useState<T | null>(null);
  const following = useRef(true);
  // Where Limn last put the box. A scroll event that is not BELOW it is ours (or the reader going
  // down), so content that grew between the scroll and its event never reads as "scrolled up".
  const placedAt = useRef(0);
  const [away, setAway] = useState(false);

  const toEnd = useCallback((box: T) => {
    box.scrollTop = box.scrollHeight;
    placedAt.current = box.scrollTop;
  }, []);

  useIsoLayoutEffect(() => {
    if (el == null) return;
    const onChange = (): void => {
      if (following.current) toEnd(el);
      else setAway(true);
    };
    toEnd(el);
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return;
    const ro = new ResizeObserver(onChange);
    const observeChildren = (): void => {
      for (const c of Array.from(el.children)) ro.observe(c);
    };
    ro.observe(el);
    observeChildren();
    const mo = new MutationObserver(() => {
      observeChildren();
      onChange();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [el, toEnd]);

  const onScroll = useCallback((e: UIEvent<T>) => {
    const box = e.currentTarget;
    const atEnd = isScrolledToBottom(box.scrollTop, box.clientHeight, box.scrollHeight, SLACK_PX);
    const movedUp = box.scrollTop < placedAt.current - 1;
    following.current = atEnd || (following.current && !movedUp);
    placedAt.current = box.scrollTop;
    if (following.current) setAway(false);
  }, []);

  const jump = useCallback(() => {
    following.current = true;
    setAway(false);
    if (el != null) toEnd(el);
  }, [el, toEnd]);

  return { ref: setEl, onScroll, away, jump };
}
