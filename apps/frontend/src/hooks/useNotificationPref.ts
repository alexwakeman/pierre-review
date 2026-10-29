import { useCallback, useEffect, useState } from 'react';

// The opt-in browser-notifications preference, shared across components (the header
// bell toggle AND the Claude-review banner both read it). localStorage-backed, with
// a same-tab custom event + cross-tab `storage` event so a toggle in the header is
// seen immediately by the banner. Value is '1'/'0'.
const KEY = 'pierre:notifications';
const EVT = 'pierre:notif-pref';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function useNotificationPref(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(read);

  useEffect(() => {
    const sync = (): void => setEnabled(read());
    window.addEventListener(EVT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = useCallback((v: boolean): void => {
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* quota / private-mode — non-fatal */
    }
    setEnabled(v);
    window.dispatchEvent(new Event(EVT)); // notify other components same-tab
  }, []);

  return [enabled, set];
}

/** Browser notifications exist here at all (the bell is hidden where they do not). */
export const notificationsSupported = (): boolean =>
  typeof window !== 'undefined' && 'Notification' in window;

/**
 * The My Turn bell's toggle (it lived in App.tsx; the sidebar foot and ⌘K share it now). The first
 * enable asks the browser for permission; a denied permission means it cannot turn on.
 */
export function useNotificationToggle(): { supported: boolean; enabled: boolean; toggle: () => void } {
  const [enabled, setEnabled] = useNotificationPref();
  const supported = notificationsSupported();
  const toggle = useCallback((): void => {
    if (!notificationsSupported()) return;
    if (enabled) {
      setEnabled(false);
      return;
    }
    if (Notification.permission === 'granted') setEnabled(true);
    else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => setEnabled(p === 'granted'));
    }
  }, [enabled, setEnabled]);
  return { supported, enabled, toggle };
}
