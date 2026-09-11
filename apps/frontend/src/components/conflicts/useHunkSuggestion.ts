import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConflictHunkSuggestBody,
  ConflictHunkSuggestResponse,
  ConflictHunkSuggestion,
} from '@pierre-review/shared';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import { usePr } from '../../hooks/usePr.js';
import { regionKey } from '../../store/conflictResolver.js';

// ── "ASK CLAUDE" ON ONE CONFLICT REGION ──────────────────────────────────────────────────────
//
// The one paid control anywhere near the merge-conflict resolver, which is CORE, free and
// local-only in every other respect. One region in, one merged region out, for the reader to READ
// and then accept or discard.
//
// ⚠ ABSENT, NOT LOCKED, when the reader is not entitled. The six visible-but-locked surfaces are
// an ENUMERATED exception kept in `components/ProGate.tsx`, and a seventh needs its own written
// argument there. This is a control INSIDE a screen that is already doing its whole job for an
// unentitled reader — a lock here would advertise into a working feature. So no `ProBadge`, no
// `ProLockPanel`, nothing.
//
// ⚠ NOTHING ENTERS `decisions` UNTIL "Use this". A pending suggestion is a sixth state of the
// centre cell, compared against the two side panes already on screen and already aligned to it.
// Accepting writes `{decision:'suggestion', suggestionId}` — the OPAQUE HANDLE, never the text,
// because the lines the commit splices are the ones the server holds.
//
// ⚠ THE LINES ARE HELD HERE ONLY FOR READING. `store/conflictResolver.ts` keeps the handle and
// deliberately not the text; this map is what lets the centre pane render an accepted suggestion
// while the overlay is open. It dies with the SERVER SESSION, which is also when the handle dies.
//
// ⚠ AND THAT IS WHY THE ACCEPTED LINES OUTLIVE THIS HOOK'S MOUNT. `ResolverPanes` unmounts the
// moment the reader presses Continue — the landing step replaces it inside the same overlay — so
// component state alone loses them on `Back`, and `slotFor` would then render an ACCEPTED
// suggestion as undecided while the commit still carried its `suggestionId`. The counter would
// say decided, the pane would say "Needs a decision", and the push would land Claude's text: the
// exact what-you-saw-is-not-what-lands failure this screen exists to prevent. So the accepted
// lines live in a module map keyed by SERVER SESSION, pruned to the live one on every mount.

/** What one region's Ask is doing right now. Keyed `${fileIndex}:${regionId}`. */
export type HunkAskState =
  | { status: 'asking' }
  /** The server's own sentence, rendered verbatim. A refusal is a NORMAL outcome: no error
   *  styling, and no retry affordance beyond asking again. */
  | { status: 'refused'; message: string }
  | { status: 'ready'; suggestion: ConflictHunkSuggestion };

export interface HunkSuggestions {
  /** False ⇒ render no control at all. */
  enabled: boolean;
  /** `${fileIndex}:${regionId}` → what that region's Ask is doing. */
  states: Readonly<Record<string, HunkAskState>>;
  /** `suggestionId` → lines, for the centre pane to render an ACCEPTED suggestion. */
  acceptedLines: Readonly<Record<string, string[]>>;
  ask: (args: { fileIndex: number; regionId: number; fingerprint: string }) => void;
  /** Drop a pending suggestion. Called by "Discard" AND by any other decision on that region — a
   *  suggestion the reader has moved past must not sit there looking live. */
  clear: (fileIndex: number, regionId: number) => void;
  /** Remember an accepted suggestion's lines and drop the pending state in one write. */
  accept: (fileIndex: number, regionId: number, suggestion: ConflictHunkSuggestion) => void;
}

const NOT_AVAILABLE = 'Claude isn’t available here.';
const NO_ANSWER = 'Claude couldn’t answer just now.';

/**
 * ⚠ THE FETCH LIVES HERE RATHER THAN IN `api/client.ts`, and it is the one thing in this file that
 * is not where the codebase would normally put it. Fold it into `api.suggestConflictHunk` beside
 * the six resolver methods once the resolver's lanes have all landed; the shape is already the
 * client's (one method, a refusal read off the body, no retry).
 */
async function requestSuggestion(
  prId: number,
  body: ConflictHunkSuggestBody,
): Promise<ConflictHunkSuggestResponse> {
  const res = await fetch(`/api/pro/prs/${prId}/conflict-hunk/suggest`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The route answers 200 for every refusal — a refusal is an outcome, not an error. A 404 means
  // the tier is off, the plugin is absent, or the pull request is not this account's; all three
  // are "there is nothing here", which is what `{enabled:false}` says.
  if (!res.ok) return { enabled: false };
  return (await res.json()) as ConflictHunkSuggestResponse;
}

/** `sessionId` → (`suggestionId` → lines). See the third ⚠ in the module header: this survives
 *  `ResolverPanes` unmounting for the landing step, and nothing else. */
const ACCEPTED_BY_SESSION = new Map<string, Record<string, string[]>>();

export function useHunkSuggestion(prId: number, sessionId: string | null): HunkSuggestions {
  const { prSummary } = useProCapabilities();
  const { data: me } = useMe();
  const { data: pr } = usePr(prId);
  const [states, setStates] = useState<Record<string, HunkAskState>>({});
  // Seeded from the module map, so a mount that follows `Back` from the landing step finds the
  // accepted lines where it left them. A NEW server session starts empty and evicts every other
  // one — a handle only its own session can redeem.
  const [acceptedLines, setAcceptedLines] = useState<Record<string, string[]>>(() => {
    if (sessionId == null) return {};
    for (const key of [...ACCEPTED_BY_SESSION.keys()]) {
      if (key !== sessionId) ACCEPTED_BY_SESSION.delete(key);
    }
    return ACCEPTED_BY_SESSION.get(sessionId) ?? {};
  });
  // In-flight keys live in a ref, not in `states`, so `ask` does not have to depend on the state
  // it writes — a callback whose identity changed on every answer would re-render every region
  // strip in the file.
  const asking = useRef<Set<string>>(new Set());

  // ⚠ `?? false` ON EVERY LEG. While `['me']` or `['pr']` is loading the answer is "we do not
  // know", and an undefined capability must not paint a button whose first click 404s.
  const enabled = prSummary && (me?.conflictResolver ?? false) && (pr?.viewerCanPush ?? false);

  const clear = useCallback((fileIndex: number, regionId: number) => {
    const key = regionKey(fileIndex, regionId);
    asking.current.delete(key);
    setStates((prev) => {
      if (prev[key] === undefined) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // A different server session is a different set of handles. Re-seed rather than carry, and
  // drop what the old session held — the ids it minted are dead either way.
  useEffect(() => {
    if (sessionId == null) return;
    for (const key of [...ACCEPTED_BY_SESSION.keys()]) {
      if (key !== sessionId) ACCEPTED_BY_SESSION.delete(key);
    }
    setAcceptedLines(ACCEPTED_BY_SESSION.get(sessionId) ?? {});
  }, [sessionId]);

  const accept = useCallback(
    (fileIndex: number, regionId: number, suggestion: ConflictHunkSuggestion) => {
      // ⚠ THE MODULE MAP FIRST. Component state alone is lost when `ResolverPanes` unmounts for
      // the landing step; see the third ⚠ in the module header.
      if (sessionId != null) {
        const held = ACCEPTED_BY_SESSION.get(sessionId) ?? {};
        held[suggestion.suggestionId] = suggestion.lines;
        ACCEPTED_BY_SESSION.set(sessionId, held);
      }
      setAcceptedLines((prev) => ({ ...prev, [suggestion.suggestionId]: suggestion.lines }));
      clear(fileIndex, regionId);
    },
    [clear, sessionId],
  );

  const ask = useCallback(
    (args: { fileIndex: number; regionId: number; fingerprint: string }) => {
      if (!enabled || sessionId == null) return;
      const key = regionKey(args.fileIndex, args.regionId);
      // One Ask per region at a time. The server holds its own per-(account, PR) slot; this is
      // only about not painting two spinners on one cell.
      if (asking.current.has(key)) return;
      asking.current.add(key);
      setStates((prev) => ({ ...prev, [key]: { status: 'asking' } }));
      const settle = (state: HunkAskState): void => {
        asking.current.delete(key);
        setStates((prev) => (prev[key] === undefined ? prev : { ...prev, [key]: state }));
      };
      void requestSuggestion(prId, { sessionId, ...args })
        .then((res) => {
          settle(
            res.enabled === false
              ? { status: 'refused', message: NOT_AVAILABLE }
              : res.ok
                ? { status: 'ready', suggestion: res.suggestion }
                : { status: 'refused', message: res.message },
          );
        })
        .catch(() => settle({ status: 'refused', message: NO_ANSWER }));
    },
    [enabled, prId, sessionId],
  );

  return { enabled, states, acceptedLines, ask, clear, accept };
}
