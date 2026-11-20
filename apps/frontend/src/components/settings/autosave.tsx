import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { HeaderToast } from '../HeaderToasts.js';
import { GearIcon } from '../Icons.js';
import { useSettingsModal } from '../../store/settingsModal.js';

// SETTINGS SAVE AS YOU GO. There is NO Save button anywhere in Settings: a change is written as
// soon as the reader makes it.
//
//  • A toggle, select or radio writes AT ONCE (`autosave.now()` beside the state change).
//  • A text or number field writes after a short pause in typing, and at once on blur / Enter
//    (`autosave.flush()`). An INVALID value is never written: the section says why, inline.
//  • A SECRET (a tracker token, the SonarCloud token, a Slack webhook) never autosaves on a
//    keystroke. It is written on an explicit commit — blur or Enter — of a NON-EMPTY value, and the
//    field clears after; the value is never echoed back. Those sections call their mutation
//    directly from `onBlur` / `onKeyDown` rather than through this hook.
//  • Anything destructive or costly (delete, sign out, a download, Remove a token) keeps its own
//    confirm button. That is not a Save button.
//
// The quiet state ("Saving…" / "Saved" / why it was not saved) sits beside the field
// (`SaveState`). A FAILED write also puts ONE card in the ONE toast cluster (`SettingsSaveToast`,
// mounted in App.tsx's `HeaderToastStrip`) — never a second cluster, never a toast for success.

/**
 * Debounced, single-flight autosave for a section's draft.
 *
 * `key` is the draft serialised: every change of it (while `ready`) schedules ONE `run` after
 * `delayMs`. `ready` = dirty AND valid. While `busy` (a write in flight) the timer waits and
 * re-arms, so two writes of the same section never race; the same draft is never sent twice. A pending write is flushed on unmount,
 * so closing the modal straight after typing loses nothing.
 */
export function useAutoSave({
  key,
  ready,
  busy,
  run,
  delayMs = 700,
}: {
  key: string;
  ready: boolean;
  busy: boolean;
  run: () => void;
  delayMs?: number;
}): { now: () => void; flush: () => void } {
  const runRef = useRef(run);
  runRef.current = run;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const urgent = useRef(false);
  // Something is scheduled and has not run yet.
  const owed = useRef(false);
  // The draft last written. The same draft is never sent twice (between a write settling and the
  // refetch that makes the section clean, `ready` is still true).
  const lastSent = useRef<string | null>(null);

  const fire = useRef((): void => {
    timer.current = null;
    if (!owed.current || !readyRef.current || lastSent.current === keyRef.current) {
      owed.current = false;
      return;
    }
    if (busyRef.current) {
      // A write of this section is in flight: wait for it, never race it.
      timer.current = setTimeout(fire, 150);
      return;
    }
    owed.current = false;
    lastSent.current = keyRef.current;
    runRef.current();
  }).current;

  useEffect(() => {
    if (!ready) {
      owed.current = false;
      // Clean again (the write landed, or the reader typed the stored value back): a later return
      // to this same draft is a new change.
      lastSent.current = null;
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    owed.current = true;
    if (timer.current != null) clearTimeout(timer.current);
    const wait = urgent.current ? 0 : delayMs;
    urgent.current = false;
    timer.current = setTimeout(fire, wait);
  }, [key, ready, delayMs, fire]);

  // Flush on unmount: the modal closed (or the tab changed) mid-pause.
  //
  // ⚠ DEFERRED, AND ONLY IF STILL UNMOUNTED. A section seeds its draft from the stored value in an
  // effect, so its FIRST render with data holds an unseeded draft that reads as a change (a tracker
  // provider of '' against a stored 'jira' — a patch of `provider: null`). The next render clears
  // that. But React's StrictMode unmounts and remounts every component right after its first
  // commit, and a synchronous flush here wrote the unseeded draft: opening Settings switched the
  // workspace's tracker off. A remount sets `mounted` again before the deferred check runs.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = null;
      setTimeout(() => {
        if (mounted.current) return;
        if (owed.current && readyRef.current && lastSent.current !== keyRef.current) {
          owed.current = false;
          lastSent.current = keyRef.current;
          runRef.current();
        }
      }, 0);
    };
  }, []);

  return {
    /** Call beside a toggle / select / radio's state change: the NEXT draft change writes at once. */
    now: () => {
      urgent.current = true;
    },
    /** Blur / Enter on a text field: write a pending change now. */
    flush: () => {
      if (timer.current != null) {
        clearTimeout(timer.current);
        fire();
      }
    },
  };
}

/** The subset of a TanStack mutation `SaveState` reads. */
export interface SaveMutationLike {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return 'Something went wrong.';
}

/**
 * The quiet save state beside a section's fields: why a value is not saved (`invalid`), the write
 * failing, "Saving…", or "Saved". Renders nothing before the first change. A failure is ALSO
 * reported to the toast cluster, once per error, under `section`.
 */
export function SaveState({
  section,
  mutation,
  dirty,
  invalid,
  className = '',
}: {
  /** The section's heading, for the failure toast ("Sprint not saved"). */
  section: string;
  mutation: SaveMutationLike;
  /** The draft differs from what is stored. */
  dirty: boolean;
  /** Why the current draft is not saved, or null when it is valid. */
  invalid?: string | null;
  className?: string;
}): JSX.Element | null {
  const { error, isError } = mutation;
  useEffect(() => {
    if (isError && error != null) reportSettingsSaveFailure(section, errorText(error));
  }, [isError, error, section]);

  let body: JSX.Element | null = null;
  if (invalid != null && invalid !== '') {
    body = <span className="text-ui-danger">Not saved: {invalid}</span>;
  } else if (mutation.isPending) {
    body = <span className="text-ui-mute">Saving…</span>;
  } else if (isError && dirty) {
    body = <span className="text-ui-danger">Not saved: {errorText(error)}</span>;
  } else if (dirty) {
    body = <span className="text-ui-mute">Saving…</span>;
  } else if (mutation.isSuccess) {
    body = <span className="text-ui-mute">Saved</span>;
  }
  if (body == null) return null;
  return (
    <p role="status" aria-live="polite" className={`text-meta ${className}`} data-testid="settings-save-state">
      {body}
    </p>
  );
}

// ── The ONE failure card ──────────────────────────────────────────────────────────────────────

interface SaveFailure {
  section: string;
  message: string;
  at: number;
}

const useSaveFailures = create<{ failure: SaveFailure | null; clear: () => void }>((set) => ({
  failure: null,
  clear: () => set({ failure: null }),
}));

export function reportSettingsSaveFailure(section: string, message: string): void {
  useSaveFailures.setState({ failure: { section, message, at: Date.now() } });
}

/** A settings write failed. A circle in the ONE toast cluster (App.tsx), never one of its own. */
export function SettingsSaveToast(): JSX.Element | null {
  const failure = useSaveFailures((s) => s.failure);
  const clear = useSaveFailures((s) => s.clear);
  const open = useSettingsModal((s) => s.open);
  if (failure == null) return null;
  return (
    <HeaderToast
      testId="settings-save-toast"
      alert
      icon={<GearIcon size={13} />}
      label={`${failure.section} not saved`}
      summary={open ? failure.message : `${failure.message} Open Settings to try again.`}
      onDismiss={clear}
    />
  );
}

/**
 * THE ECHO GUARD, for a section that re-seeds its WHOLE draft whenever the stored value changes.
 * A write's own reply changes the stored value, and a re-seed then would throw away an edit the
 * reader made while that write was in flight (tick A, tick B at once: B was lost). Call `markSent()`
 * as the write is sent; in the re-seed effect, `if (guard.keepDraft()) return;` first.
 *
 * `keepDraft()` is true only while the draft has moved on from what was sent — that newer draft is
 * then written next, and its own reply re-seeds. A change of `scope` (the workspace) always re-seeds.
 */
export function useEchoGuard(draftKey: string, scope: unknown): { markSent: () => void; keepDraft: () => boolean } {
  const draftRef = useRef(draftKey);
  draftRef.current = draftKey;
  const sent = useRef<string | null>(null);
  const lastScope = useRef(scope);
  return {
    markSent: () => {
      sent.current = draftRef.current;
    },
    keepDraft: () => {
      if (!Object.is(lastScope.current, scope)) {
        lastScope.current = scope;
        sent.current = null;
        return false;
      }
      if (sent.current != null && draftRef.current !== sent.current) return true;
      sent.current = null;
      return false;
    },
  };
}
