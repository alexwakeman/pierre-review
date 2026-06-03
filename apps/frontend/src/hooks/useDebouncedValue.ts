import { useEffect, useState } from 'react';

// Returns `value` delayed by `delayMs`, collapsing rapid changes into a single
// trailing update — used to throttle search-on-keypress into one request per
// settle. The pending timer is cleared on every change (and on unmount).
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
