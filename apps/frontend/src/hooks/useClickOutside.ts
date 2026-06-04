import { useEffect, useRef, type RefObject } from 'react';

// Close a panel when the user mousedowns anywhere outside `ref`. Uses a callback
// ref for `onOutside` so the document listener is NOT re-subscribed every render —
// only `enabled`/`ref` changes re-bind it. Pass the component's existing root ref
// (which must wrap BOTH the trigger and the dropdown panel) and its open-state
// condition as `enabled` so the listener is only live while the panel is shown.
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  enabled = true,
): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!enabled) return;
    function handle(e: MouseEvent): void {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) cb.current();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [ref, enabled]);
}
