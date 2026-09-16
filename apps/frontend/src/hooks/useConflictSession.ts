import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConflictFileContent,
  ConflictSession,
  ConflictSessionEvent,
} from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { sseStream } from '../api/sse.js';

// ── ONE SERVER SESSION, DRIVEN BY ONE STREAM ─────────────────────────────────────────────────
//
// The overlay mounts, this opens a session, and everything after that arrives on the ONE SSE
// stream: prepare progress, `ready`, `failed`, and later the commit's own phases. There is no
// second channel — the manifest poll below is the SAME channel after the stream has been cut, not
// a second one running beside it.
//
// ⚠ THE OPEN IS CLICK-GATED BY CONSTRUCTION. This hook runs only inside the overlay, and the
// overlay mounts only when the reader presses "Resolve conflicts" — `App.tsx` renders it on
// `target != null`. It costs a clone plus two fetches plus a merge-tree, minutes cold on a large
// repository, so nothing may mount it speculatively: no prefetch, no hover, no "warm it while the
// pane is open". If this ever needs to run from somewhere else, that somewhere else is a click
// too.
//
// ⚠ THE SESSION IS NOT AUTHORISATION. Ownership is re-checked on every route (`getPrWriteContext`
// → 404, then write permission → 403). `sessionId` is a CONCURRENCY token: a commit whose id no
// longer matches is `SessionExpired`, so a second tab, a server restart or a re-open cannot land
// decisions taken against a model that no longer exists.
//
// ⚠ REGIONS ARRIVE PER FILE. The session payload is a MANIFEST — counts and pins, no regions —
// and `loadFile` fetches one file's regions on selection. A manifest carrying them inline is
// multiple megabytes on a thirty-file conflict.
//
// ── WHEN THE STREAM DIES ─────────────────────────────────────────────────────────────────────
//
// ⚠ A PROXY WILL CUT IT, AND THE SESSION OUTLIVES THE CUT. Railway ends every HTTP request at 15
// minutes; a resolver session lives 30, pushed out on every touch. So a reader who takes their
// time gets: the stream cut at minute 15, "Commit" pressed at minute 16, the server answers 202
// and PUSHES, and not one phase frame comes back. The overlay sat on "Starting…" forever while
// the commit may well have LANDED — the exact state this repo's `visible` copy contract exists to
// prevent.
//
// So the stream ending is not the end of the session. The manifest GET already returns the whole
// commit state (`sessionView`'s `commit`), it is a Map lookup on the `read` tier, and reading it
// `touch()`es the session — so polling it is both the cheapest recovery available and the one that
// keeps an in-use session alive. No new route, no new field, no wire change.
//
// ⚠ IT IS NOT A RECONNECT. Re-running the OPEN would spend another clone; re-subscribing to the
// stream would be cut again at the same 15 minutes. The poll is the channel from then on.

// ── WHO CLOSES THE SESSION ───────────────────────────────────────────────────────────────────
//
// ⚠ THE SERVER RE-ATTACHES. `claimSession` returns the LIVE session for a second open without
// `restart` (conflict/session.ts), which is right for a second tab and lethal for a remount: the
// old mount's cleanup then DELETEs the session the new mount is holding, every later read 404s,
// and the overlay sits on "Reading …" forever. React 18 StrictMode remounts every effect in dev,
// so this fired on the FIRST open of every resolver; in production it is a fast close-and-reopen.
//
// So the close is refcounted per PR and DEFERRED: the last detach schedules it, and an attach
// arriving inside the grace window cancels it. The grace only has to outlive a synchronous
// remount, so it is short — a session nobody re-attaches to is dropped a beat later, exactly as
// before, and the server's TTL is still the backstop.
const CLOSE_GRACE_MS = 400;

interface Attachment {
  mounts: number;
  sessionId: string | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
}
const ATTACHMENTS = new Map<number, Attachment>();

function attachSession(prId: number): Attachment {
  const found = ATTACHMENTS.get(prId);
  const rec: Attachment = found ?? { mounts: 0, sessionId: null, closeTimer: null };
  rec.mounts += 1;
  if (rec.closeTimer != null) {
    clearTimeout(rec.closeTimer);
    rec.closeTimer = null;
  }
  ATTACHMENTS.set(prId, rec);
  return rec;
}

function detachSession(prId: number): void {
  const rec = ATTACHMENTS.get(prId);
  if (!rec) return;
  rec.mounts -= 1;
  if (rec.mounts > 0) return;
  rec.closeTimer = setTimeout(() => {
    const still = ATTACHMENTS.get(prId);
    // Re-read rather than closing over `rec.sessionId`: a remount inside the grace window may have
    // re-attached and learned a different id.
    if (!still || still.mounts > 0) return;
    const id = still.sessionId;
    ATTACHMENTS.delete(prId);
    if (id != null) void api.closeConflictSession(prId, id).catch(() => {});
  }, CLOSE_GRACE_MS);
  ATTACHMENTS.set(prId, rec);
}

/**
 * How this session's updates are arriving.
 *
 *   `live`    — the SSE stream is open. The normal case.
 *   `polling` — the stream ended (a proxy's request cap, a dropped socket) and the manifest GET
 *               is standing in. Everything still works; nothing on screen needs to say so.
 *   `lost`    — the server no longer has this session, so nothing more will ever be known about
 *               it HERE. ⚠ That is not the same as the work failing, and the copy must not say it
 *               is: a commit may have pushed.
 */
export type ConflictConnection = 'live' | 'polling' | 'lost';

/** Poll cadences. Fast while something is actually running, slow while the reader reads. */
const POLL_BUSY_MS = 2_000;
const POLL_IDLE_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the overlay renders from. `session` is null until the open route answers. */
export interface ConflictSessionState {
  session: ConflictSession | null;
  /** See `ConflictConnection`. The overlay reads it ONLY to pick honest words for a commit whose
   *  outcome it can no longer learn; nothing else on screen changes. */
  connection: ConflictConnection;
  /** The open itself was refused — a real status code, not a session `error`. Its message is the
   *  server's own sentence and is rendered verbatim. */
  openError: string | null;
  /** Regions per file index, populated by `loadFile`. */
  files: Record<number, ConflictFileContent>;
  /** File indexes whose regions are in flight, so a selection cannot fire two fetches. */
  loadingFiles: ReadonlySet<number>;
  /** The server's sentence for a file whose regions could not be read, by index.
   *  ⚠ A FAILED READ IS REMEMBERED, AND THAT IS WHAT STOPS THE LOOP. `loadFile`'s effect keys on
   *  "no regions yet", so swallowing the failure left that condition true and the effect re-fired
   *  the instant `loadingFiles` cleared — MEASURED at 655 requests against one 429'd endpoint,
   *  with the reader watching a permanent "Reading …". Only an explicit retry clears an entry. */
  fileErrors: Readonly<Record<number, string>>;
  /** Fetch (and cache) one file's regions. Resolves to null when the fetch failed. */
  loadFile: (index: number) => Promise<ConflictFileContent | null>;
  /** Forget one file's recorded failure and read it again. The reader's explicit retry. */
  retryFile: (index: number) => void;
  /** Throw the model away and build a fresh one against the CURRENT shas. */
  restart: () => void;
}

export function useConflictSession(prId: number | null): ConflictSessionState {
  const [session, setSession] = useState<ConflictSession | null>(null);
  const [connection, setConnection] = useState<ConflictConnection>('live');
  const [openError, setOpenError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<number, ConflictFileContent>>({});
  const [loadingFiles, setLoadingFiles] = useState<ReadonlySet<number>>(() => new Set());
  const [fileErrors, setFileErrors] = useState<Record<number, string>>({});
  // Bumping this re-runs the open effect. `restart` is the only writer.
  const [attempt, setAttempt] = useState(0);
  // The live session id, read by `loadFile` without making it a dependency of every callback.
  const sessionIdRef = useRef<string | null>(null);
  // The per-file region cache. See the ⚠ in `loadFile`.
  const filesRef = useRef<Record<number, ConflictFileContent>>({});

  useEffect(() => {
    if (prId == null) return;
    const ac = new AbortController();
    const attachment = attachSession(prId);
    setSession(null);
    setConnection('live');
    setOpenError(null);
    filesRef.current = {};
    setFiles({});
    setLoadingFiles(new Set());
    setFileErrors({});
    sessionIdRef.current = null;

    void (async () => {
      let opened: ConflictSession;
      try {
        // `restart` on every attempt after the first: attempt 0 is happy to re-attach to a live
        // session (a reopen after an accidental close costs nothing), while an explicit restart is
        // the reader asking for a model built against the shas as they are NOW.
        opened = await api.openConflictSession(prId, attempt > 0 ? { restart: true } : {});
      } catch (e) {
        if (ac.signal.aborted) return;
        setOpenError(
          e instanceof ApiError ? e.message : 'Couldn’t start resolving this pull request.',
        );
        return;
      }
      // Record the id even when this run has been aborted: a remount inside the grace window is
      // holding the SAME session (the server re-attached), and the deferred closer reads this.
      attachment.sessionId = opened.sessionId;
      if (ac.signal.aborted) {
        // The overlay closed while the open was in flight. `detachSession` has already run and
        // scheduled — or skipped — the close; it now has an id to close.
        return;
      }
      sessionIdRef.current = opened.sessionId;
      setSession(opened);

      // ⚠ SUBSCRIBE, THEN LET THE STREAM SNAPSHOT. The server's first frame is a `snapshot`, so
      // a terminal frame cannot slip through the gap between the POST answering 202 and this
      // subscribe — which is why the manifest is never fetched separately here.
      await sseStream<ConflictSessionEvent>(
        `/api/prs/${prId}/conflicts/stream?session=${encodeURIComponent(opened.sessionId)}`,
        {
          signal: ac.signal,
          onEvent: (e) => {
            if (e.type === 'done') return;
            setSession(e.session);
          },
        },
      ).catch(() => {
        /* the stream dropped, or the overlay closed. Either way the poll below decides — the
           session state already on screen stays put. */
      });

      // The overlay is gone: nothing to recover for.
      if (ac.signal.aborted) return;
      // The stream is over and the reader is still here. See the header: the session outlives it.
      setConnection('polling');
      let wait = POLL_BUSY_MS;
      while (!ac.signal.aborted) {
        await sleep(wait);
        if (ac.signal.aborted) return;
        try {
          const latest = await api.conflictSession(prId, opened.sessionId);
          setSession(latest);
          wait =
            latest.status === 'preparing' || latest.commit?.status === 'running'
              ? POLL_BUSY_MS
              : POLL_IDLE_MS;
        } catch (e) {
          // ⚠ ONLY A DEFINITIVE REFUSAL IS TERMINAL — 409 (this session is no longer open), 404
          // (the pull request is no longer this account's) and 403 (push access is gone). Every
          // other failure is a blip: offline, a 429, a 502 from the same proxy that cut the
          // stream. Treating one of those as terminal tells a reader their work is unknowable
          // because their wifi hiccuped.
          if (e instanceof ApiError && [409, 404, 403].includes(e.status)) {
            setConnection('lost');
            return;
          }
          wait = POLL_IDLE_MS;
        }
      }
    })();

    return () => {
      ac.abort();
      // Closing the overlay drops the SERVER session. The reader's DECISIONS survive in
      // `store/conflictResolver.ts` under the pinned key, so reopening onto the same merge is
      // free of them being lost — but the server's model is rebuilt, which is the honest thing to
      // do: it may no longer be true.
      detachSession(prId);
    };
  }, [prId, attempt]);

  const loadFile = useCallback(
    async (index: number): Promise<ConflictFileContent | null> => {
      const sessionId = sessionIdRef.current;
      if (prId == null || sessionId == null) return null;
      // ⚠ THE CACHE IS THE REF, NOT THE STATE. A caller navigating across files with ▲/▼ awaits
      // this, and reading the answer out of `files` would read whatever React had rendered by
      // then — one keystroke behind, so the same file refetches.
      const cached = filesRef.current[index];
      if (cached) return cached;
      setLoadingFiles((prev) => new Set(prev).add(index));
      try {
        const content = await api.conflictFile(prId, sessionId, index);
        filesRef.current = { ...filesRef.current, [index]: content };
        setFiles(filesRef.current);
        setFileErrors((prev) => {
          if (prev[index] == null) return prev;
          const next = { ...prev };
          delete next[index];
          return next;
        });
        return content;
      } catch (e) {
        // ⚠ RECORD IT. See `fileErrors` — a swallowed failure here is an unbounded retry loop,
        // because the effect that calls this keys on the absence of regions.
        setFileErrors((prev) => ({
          ...prev,
          [index]:
            e instanceof ApiError ? e.message : 'Couldn’t read this file’s conflicts.',
        }));
        return null;
      } finally {
        setLoadingFiles((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    },
    [prId],
  );

  const retryFile = useCallback((index: number) => {
    setFileErrors((prev) => {
      if (prev[index] == null) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  const restart = useCallback(() => setAttempt((a) => a + 1), []);

  return {
    session,
    connection,
    openError,
    files,
    loadingFiles,
    fileErrors,
    loadFile,
    retryFile,
    restart,
  };
}
