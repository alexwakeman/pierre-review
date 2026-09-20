import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictRegionEdit } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { regionKey } from '../../store/conflictResolver.js';

// ── EDITING ONE REGION'S RESULT BY HAND ──────────────────────────────────────────────────────
//
// The resolver's one text box, and the one place in the app that sends file content to the
// server. CORE, free, both modes — there is no tier here and no gate beyond the write permission
// the whole resolver already requires.
//
// ⚠ WHY IT EXISTS. Hunk-level accept/ignore answers "which of these two" and cannot answer "both,
// but without the duplicated import" or "yours, minus the trailing comma". Those are the edits
// that used to send somebody to their terminal in the middle of a resolve, and the deciding
// argument is that the alternative is not "no typing" — it is typing somewhere this screen cannot
// see.
//
// ⚠ IT IS SCOPED TO DECIDABLE REGIONS AND THE SERVER ENFORCES THAT. An `unchanged` region is
// context — what the edit sits BETWEEN — and refuses with `not_editable`. Keeping context
// read-only is what let this ship WITHOUT bumping `CONFLICT_MODEL_VERSION`, which would have
// thrown away every live session's decisions.
//
// ⚠ NOTHING IS DECIDED BY SAVING ALONE. A save mints a handle; the caller then writes
// `{decision:'edited', editId}` into the store, exactly as accepting a suggestion does. That is
// why `save` RESOLVES with the edit rather than applying it — the store write belongs to the one
// place that owns the undo stack.
//
// ⚠ AND THAT IS WHY THE SAVED LINES OUTLIVE THIS HOOK'S MOUNT. `ResolverPanes` unmounts the moment
// the reader presses the toolbar's "Commit and push" — the landing step replaces it inside the
// same overlay, and that button is the entry to the press rather than the press itself — so
// component state alone loses them on `Back`, and `slotFor` would then render an edited region as
// undecided WHILE THE COMMIT STILL CARRIED ITS HANDLE. The counter would say decided, the pane
// would say "Needs a decision", and the push would land text the reader could no longer see. So
// the lines live in a module map keyed by SERVER SESSION, pruned to the live one on every mount.
// `useHunkSuggestion` keeps its accepted suggestions the same way and for the same reason.

/** What one region's editor is doing. Keyed `${fileIndex}:${regionId}`; ABSENT means closed. */
export type RegionEditState =
  | { status: 'editing' }
  | { status: 'saving' }
  /** The server's own sentence, rendered verbatim above the still-open box. A refusal keeps the
   *  reader's text where it is — it is theirs, and it is what they have to fix. */
  | { status: 'refused'; message: string };

export interface RegionEdits {
  /** `${fileIndex}:${regionId}` → that region's editor state. Absent ⇒ no panel. */
  states: Readonly<Record<string, RegionEditState>>;
  /** `editId` → the SERVER's split of the stored text, for the centre pane to render. */
  editLines: Readonly<Record<string, string[]>>;
  /** The half-typed text for one region, or undefined when there is none.
   *  ⚠ IT LIVES HERE BECAUSE THE PANEL UNMOUNTS ON A FILE SWITCH. `states` is keyed by region and
   *  survives one — nothing closes an editor when the reader looks at another file — but only the
   *  ACTIVE file's rows render, so the box came back open, in place, with the seed in it and the
   *  reader's sentence gone. No message, no confirm, nothing on screen changed. */
  draftFor: (fileIndex: number, regionId: number) => string | undefined;
  /** Record what is in the box, without re-rendering anything. ⚠ A REF WRITE, DELIBERATELY: a
   *  keystroke may not re-render the file's other regions, which is the reason the draft lived in
   *  the component in the first place. */
  noteDraft: (fileIndex: number, regionId: number, text: string) => void;
  open: (fileIndex: number, regionId: number) => void;
  /** Close without saving. Called by Cancel, and by any other decision on that region — an
   *  editor left open under a region the reader has moved past is a box offering to replace
   *  something that is no longer there. */
  close: (fileIndex: number, regionId: number) => void;
  /** Send the text. Resolves with the minted edit, or null when the server refused (the sentence
   *  is already in `states`). ⚠ IT DOES NOT DECIDE THE REGION — see the header. */
  save: (args: {
    fileIndex: number;
    regionId: number;
    fingerprint: string;
    text: string;
  }) => Promise<ConflictRegionEdit | null>;
}

/** The session ended under the request, or the network did. Both mean "we do not know whether
 *  this was stored", and the honest answer is to keep the box open and say nothing about it. */
const NO_ANSWER = 'That didn’t save. Try again.';

/** `sessionId` → (`editId` → lines). See the last ⚠ in the module header: this survives
 *  `ResolverPanes` unmounting for the landing step, and nothing else. */
const EDITS_BY_SESSION = new Map<string, Record<string, string[]>>();

/** Drop every session's lines but this one's. A handle is only ever redeemable inside the server
 *  session that minted it, so the others are dead weight the moment the id changes. */
function pruneTo(sessionId: string): Record<string, string[]> {
  for (const key of [...EDITS_BY_SESSION.keys()]) {
    if (key !== sessionId) EDITS_BY_SESSION.delete(key);
  }
  return EDITS_BY_SESSION.get(sessionId) ?? {};
}

export function useRegionEdit(prId: number, sessionId: string | null): RegionEdits {
  const [states, setStates] = useState<Record<string, RegionEditState>>({});
  const [editLines, setEditLines] = useState<Record<string, string[]>>(() =>
    sessionId == null ? {} : pruneTo(sessionId),
  );
  // In-flight keys live in a ref, not in `states`, so `save` does not have to depend on the state
  // it writes — a callback whose identity changed on every answer would re-render every region
  // strip in the file.
  const saving = useRef<Set<string>>(new Set());
  // Half-typed text per region. A REF, so a keystroke costs no render; see `draftFor`.
  const drafts = useRef<Record<string, string>>({});

  // A different server session is a different set of handles. Re-seed rather than carry.
  useEffect(() => {
    if (sessionId == null) return;
    setEditLines(pruneTo(sessionId));
  }, [sessionId]);

  const draftFor = useCallback(
    (fileIndex: number, regionId: number): string | undefined =>
      drafts.current[regionKey(fileIndex, regionId)],
    [],
  );

  const noteDraft = useCallback((fileIndex: number, regionId: number, text: string) => {
    drafts.current[regionKey(fileIndex, regionId)] = text;
  }, []);

  const open = useCallback((fileIndex: number, regionId: number) => {
    setStates((prev) => ({ ...prev, [regionKey(fileIndex, regionId)]: { status: 'editing' } }));
  }, []);

  const close = useCallback((fileIndex: number, regionId: number) => {
    const key = regionKey(fileIndex, regionId);
    saving.current.delete(key);
    // Closing is the end of the draft — by Cancel, by a save landing, or by any other decision
    // on this region. Reopening starts from what is on screen, which is the whole contract.
    delete drafts.current[key];
    setStates((prev) => {
      if (prev[key] === undefined) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const save = useCallback(
    async (args: {
      fileIndex: number;
      regionId: number;
      fingerprint: string;
      text: string;
    }): Promise<ConflictRegionEdit | null> => {
      if (sessionId == null) return null;
      const key = regionKey(args.fileIndex, args.regionId);
      // One save per region at a time. Two in flight would mint two handles and the second
      // answer would win a race against the store write of the first.
      if (saving.current.has(key)) return null;
      saving.current.add(key);
      setStates((prev) => ({ ...prev, [key]: { status: 'saving' } }));
      const settle = (state: RegionEditState): void => {
        saving.current.delete(key);
        setStates((prev) => (prev[key] === undefined ? prev : { ...prev, [key]: state }));
      };
      try {
        const res = await api.editConflictRegion(prId, { sessionId, ...args });
        if (!res.ok) {
          settle({ status: 'refused', message: res.message });
          return null;
        }
        // ⚠ DID THE READER MOVE ON WHILE THIS WAS IN FLIGHT? `settle` asks the same question and
        // `useHunkSuggestion` asks it of an Ask answer, and this path did not: pressing Save and
        // then the gutter arrow on the same region ran `close` (which clears this key), stored
        // `'ours'`, and then let the late answer overwrite it with `'edited'` — silently undoing
        // the side the reader had just taken, and filing an undo entry built from a `decisions`
        // snapshot that predated it, so Ctrl+Z cleared the region instead of returning it.
        // `close` deletes the key, so its absence IS the test.
        if (!saving.current.has(key)) return null;
        // ⚠ THE MODULE MAP FIRST. Component state alone is lost when `ResolverPanes` unmounts for
        // the landing step; see the last ⚠ in the module header.
        const held = EDITS_BY_SESSION.get(sessionId) ?? {};
        held[res.edit.editId] = res.edit.lines;
        EDITS_BY_SESSION.set(sessionId, held);
        setEditLines((prev) => ({ ...prev, [res.edit.editId]: res.edit.lines }));
        close(args.fileIndex, args.regionId);
        return res.edit;
      } catch (err) {
        // A 409 carries the server's own sentence (`handle` puts it on the error); anything else
        // gets ours. Either way the box stays open with the reader's text in it.
        settle({
          status: 'refused',
          message: err instanceof Error && err.message !== '' ? err.message : NO_ANSWER,
        });
        return null;
      }
    },
    [close, prId, sessionId],
  );

  return { states, editLines, draftFor, noteDraft, open, close, save };
}
