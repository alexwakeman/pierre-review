import { create } from 'zustand';
import type { ConflictDecision } from '@pierre-review/shared';

// ── THE MERGE-CONFLICT RESOLVER'S CLIENT STATE ───────────────────────────────────────────────
//
// A module-level store, following the ARM DRAFT precedent (`hooks/useAutoMerge.ts`): one reader,
// one writer, never the URL, never persisted.
//
// ⚠ IT IS NOT A SLICE OF `store/filters.ts`, AND THAT IS NOT A PLACEMENT PREFERENCE. That store
// is persisted behind `FILTER_STORAGE_VERSION` **and** mirrored to the URL. Half-finished
// decisions about somebody else's source code are neither a filter nor consent that survives a
// reload: a resolution left open yesterday is not a resolution today, and a `?…` key for it would
// spend a clone on every address-bar visit. `workspaceId` is kept out of `FilterDefaults` for the
// same family of reason — persistence and reset share one list.
//
// ⚠ IT HOLDS CHOICES ONLY. No file text, no regions, no suggestion's lines — and, since the
// centre pane became editable, no EDIT's lines either. The resolved bytes live in the server's
// in-memory session and in the read-only payloads it sends down; what lives here is the opaque
// handle that addresses them. That split is why the commit body can carry nothing but indexes,
// ids and enum members even though one route now accepts typed text.
//
// ⚠ A HANDLE'S LINES THEREFORE LIVE SOMEWHERE ELSE, AND "somewhere else" MUST OUTLIVE A
// COMPONENT. `useHunkSuggestion` and `useRegionEdit` each keep a module-level map keyed by SERVER
// session, because `ResolverPanes` unmounts the moment the reader presses Continue — see those
// files' headers for what breaks when the handle survives and the lines do not.
//
// ⚠ THE PINS ARE PART OF THE KEY. A session is consent to ONE three-way merge, so decisions are
// filed under `${prId}:${headSha}:${baseSha}:${modelHash}`. Somebody pushing to the branch, or
// the base moving, mints a different key and the old decisions are simply not found — they are
// never migrated onto a merge the reader did not see. This is the same reasoning as the
// auto-merge intent's `expectedHeadOid`: consent to merge THE CODE THE USER SAW.

/** The pull request the overlay is open on. Everything here is already on the payload that
 *  mounted the button — the overlay itself fetches none of it. */
export interface ResolverTarget {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  githubUrl: string;
}

/** One reader's decisions for one PINNED model. */
export interface ResolverSession {
  /** `${prId}:${headSha}:${baseSha}:${modelHash}` — see the ⚠ in the module header. */
  key: string;
  /** `${fileIndex}:${regionId}` → the decision. A region the reader has not decided is simply
   *  ABSENT: `undecided` is the absence of an entry, never a member of the enum. */
  decisions: Record<string, ConflictDecision>;
  /** `${fileIndex}:${regionId}` → the accepted Pro suggestion's opaque handle. Kept apart from
   *  `decisions` because a `'suggestion'` decision is worthless without it, and the commit body
   *  carries the two as separate fields. */
  suggestionIds: Record<string, string>;
  /** `${fileIndex}:${regionId}` → a saved manual edit's opaque handle, for an `'edited'`
   *  decision. ⚠ A SECOND MAP, NOT A SHARED "handles" ONE. The two address two different server
   *  stores with two different provenances and two different refusal sentences; one map would
   *  let a `'suggestion'` decision redeem an `editId` and be told "that suggestion has expired.
   *  Ask Claude again." about text the reader typed themselves. */
  editIds: Record<string, string>;
  /** The SERVER session these handles were minted in. ⚠ A handle addresses a Map in one server
   *  process's memory, so it dies with that session even when the pins — and therefore this
   *  record's `key` — are identical. See `seedSession`. */
  sessionId: string;
  /** Derived at WRITE time so opening the overlay is O(1) rather than a fold over every file's
   *  regions — the counter is read on every keystroke of the region strip. */
  decidedCount: number;
  /** How many CONTESTED regions this model has, as the manifest reported them. The header counts
   *  down against it. */
  conflictCount: number;
}

/** Why the overlay closed. The reopen toast offers a way back for the first two ONLY — after a
 *  commit there is nothing left to reopen onto, because the pins have moved. */
export type ResolverCloseReason = 'user' | 'navigated' | 'committed';

/** What the reopen toast needs. Held apart from `target` so closing genuinely clears the
 *  overlay's own state rather than leaving it half-open. */
export interface ClosedResolver {
  target: ResolverTarget;
  reason: ResolverCloseReason;
  /** How many decisions were still on the table. 0 ⇒ nothing to come back to. */
  decidedCount: number;
}

/** ⚠ FOUR, AND SMALL ON PURPOSE. Each entry is a set of decisions about one pinned merge; a
 *  reader juggling five conflicting pull requests at once is not a case worth holding memory
 *  for, and an unbounded map would keep every model a `pnpm dev` session ever opened. */
export const RESOLVER_SESSION_LIMIT = 4;

/** THE key builder. One spelling, so a write and a read can never file under two. */
export function resolverSessionKey(
  prId: number,
  headSha: string,
  baseSha: string,
  modelHash: string,
): string {
  return `${prId}:${headSha}:${baseSha}:${modelHash}`;
}

/** THE region key. `${fileIndex}:${regionId}` — a region id is stable only WITHIN its file. */
export function regionKey(fileIndex: number, regionId: number): string {
  return `${fileIndex}:${regionId}`;
}

/**
 * Drop the least-recently-touched sessions until at most `RESOLVER_SESSION_LIMIT` remain.
 *
 * ⚠ `keep` IS MOST-RECENT-FIRST and the caller has already moved the session it just touched to
 * the front. Pure, and exported, because "the LRU quietly evicted the session you are looking at"
 * is a bug with no visible symptom until a commit refuses.
 */
export function pruneResolverSessions(
  order: readonly string[],
  sessions: Readonly<Record<string, ResolverSession>>,
): { order: string[]; sessions: Record<string, ResolverSession> } {
  const kept = order.slice(0, RESOLVER_SESSION_LIMIT);
  const next: Record<string, ResolverSession> = {};
  for (const key of kept) {
    const s = sessions[key];
    if (s) next[key] = s;
  }
  return { order: kept, sessions: next };
}

interface ConflictResolverState {
  /** The open overlay's pull request, or null when it is closed. */
  target: ResolverTarget | null;
  /** Decisions per pinned model, keyed by `resolverSessionKey`. */
  sessions: Record<string, ResolverSession>;
  /** Session keys, most-recently-touched first. The LRU order. */
  order: string[];
  /** The last overlay to close with decisions still on it — the reopen toast's whole input. */
  lastClosed: ClosedResolver | null;
  /** The reader is on the "close and lose these decisions?" step. Not a modal of its own: the
   *  overlay renders the question in place, so this is one flag rather than a second dialog. */
  confirming: boolean;

  openConflictResolver: (target: ResolverTarget) => void;
  closeConflictResolver: (opts: { reason: ResolverCloseReason }) => void;
  setConfirming: (confirming: boolean) => void;
  dismissClosedResolver: () => void;

  /** Seed (or re-seed) the session for a pinned model. Existing decisions under the SAME key
   *  survive — reopening onto the same merge must not throw the reader's work away. `sessionId`
   *  is the SERVER session; see the ⚠ in the implementation for what a change in it drops. */
  seedSession: (args: {
    key: string;
    sessionId: string;
    conflictCount: number;
    defaults?: Record<string, ConflictDecision>;
  }) => void;
  /** Record ONE region's decision. `null` clears it back to undecided. */
  decideRegion: (args: {
    key: string;
    fileIndex: number;
    regionId: number;
    decision: ConflictDecision | null;
    suggestionId?: string | null;
    editId?: string | null;
  }) => void;
  /** Record MANY at once — the wand's whole run is one write, so the counter cannot be seen
   *  half-updated. */
  decideRegions: (args: {
    key: string;
    decisions: ReadonlyArray<{
      fileIndex: number;
      regionId: number;
      decision: ConflictDecision;
      suggestionId?: string | null;
      editId?: string | null;
    }>;
  }) => void;
}

/** Move `key` to the front of the LRU order without duplicating it. */
function touch(order: readonly string[], key: string): string[] {
  return [key, ...order.filter((k) => k !== key)];
}

/** ⚠ DERIVED AT WRITE TIME (see `ResolverSession.decidedCount`). One place, so the counter and
 *  the map cannot disagree. */
function countDecided(decisions: Readonly<Record<string, ConflictDecision>>): number {
  return Object.keys(decisions).length;
}

/**
 * Every decision EXCEPT the two that address text a SERVER SESSION holds. Exported for the test
 * that pins it; called only from `seedSession`, where the ⚠ explains why.
 *
 * ⚠ BOTH MEMBERS, NOT JUST `'suggestion'`. `'edited'` is the identical bug verbatim: the handle
 * points into a Map in one server process, a re-seed means a new server session, and a decision
 * carried across would make the file menu read "Resolved" (the counter sees an entry) while the
 * centre pane renders it undecided (`slotFor` will not draw lines it does not hold) — and then
 * the commit refuses the WHOLE request with `UnknownEdit`.
 */
export function dropServerHeldDecisions(session: ResolverSession): {
  decisions: Record<string, ConflictDecision>;
  suggestionIds: Record<string, string>;
  editIds: Record<string, string>;
} {
  const decisions: Record<string, ConflictDecision> = {};
  for (const [rk, d] of Object.entries(session.decisions)) {
    if (d !== 'suggestion' && d !== 'edited') decisions[rk] = d;
  }
  return { decisions, suggestionIds: {}, editIds: {} };
}

export const useConflictResolverStore = create<ConflictResolverState>((set) => ({
  target: null,
  sessions: {},
  order: [],
  lastClosed: null,
  confirming: false,

  openConflictResolver: (target) => set({ target, confirming: false, lastClosed: null }),

  closeConflictResolver: ({ reason }) =>
    set((s) => {
      if (s.target == null) return { confirming: false };
      // The reopen toast needs a count, and the count belongs to the MOST RECENT session for this
      // pull request — which, because `seedSession` touches the LRU, is the front of the order.
      const key = s.order[0];
      const live = key != null ? s.sessions[key] : undefined;
      const decidedCount = live && live.key.startsWith(`${s.target.prId}:`) ? live.decidedCount : 0;
      return {
        target: null,
        confirming: false,
        // ⚠ A COMMITTED RESOLUTION HAS NOWHERE TO GO BACK TO. Its pins have moved, so reopening
        // would build a different model and the offer would be a lie. Post-commit messaging is
        // the commit result's own, not this toast's.
        lastClosed:
          reason === 'committed' || decidedCount === 0
            ? null
            : { target: s.target, reason, decidedCount },
      };
    }),

  setConfirming: (confirming) => set({ confirming }),

  dismissClosedResolver: () => set({ lastClosed: null }),

  seedSession: ({ key, sessionId, conflictCount, defaults }) =>
    set((s) => {
      const existing = s.sessions[key];
      // ⚠ EXISTING DECISIONS WIN. `defaults` is the model's auto-apply pass, which is the same
      // every time it is computed; re-applying it over a reader's own choices on a reopen would
      // silently undo them. A DIFFERENT merge is a different key and lands in the `existing ==
      // null` arm on its own.
      //
      // ⚠ EXCEPT THE TWO HANDLE-BEARING DECISIONS, AND ONLY WHEN THE SERVER SESSION ACTUALLY
      // CHANGED. Every other member of `ConflictDecision` is a self-describing enum the server
      // can honour from the model alone; `'suggestion'` and `'edited'` are handles into the
      // SERVER session's in-memory maps, so a re-seed under a DIFFERENT `sessionId` is a re-seed
      // onto handles that no longer resolve. Carried across, the region reads "Resolved" in the
      // file menu (the counter sees a decision) while the centre pane renders it undecided
      // (`slotFor` refuses to draw lines it does not hold) — and then the commit refuses the
      // WHOLE request with `UnknownSuggestion` / `UnknownEdit`. Dropping them back to undecided
      // is the honest state: the reader is asked again, on a region they can see is unanswered.
      //
      // ⚠ THE `sessionId` COMPARISON IS THE WHOLE FIX, AND IT WAS MISSING. This function is not
      // called once per opening — it is called on EVERY frame `useConflictSession` produces, and
      // that hook emits a fresh object per SSE frame (including the commit's own
      // `commit_progress`) and again every `POLL_IDLE_MS` once the server ends the stream at ten
      // minutes. Dropping unconditionally therefore wiped every hand-typed region and every
      // accepted suggestion, silently, within eight seconds of minute ten — and again the moment
      // the reader pressed Commit. Same server session ⇒ the handles are still live ⇒ carry
      // everything untouched.
      const carried =
        existing == null
          ? null
          : existing.sessionId === sessionId
            ? {
                decisions: existing.decisions,
                suggestionIds: existing.suggestionIds,
                editIds: existing.editIds,
              }
            : dropServerHeldDecisions(existing);
      const decisions = carried?.decisions ?? { ...(defaults ?? {}) };
      const session: ResolverSession = {
        key,
        sessionId,
        decisions,
        suggestionIds: carried?.suggestionIds ?? {},
        editIds: carried?.editIds ?? {},
        decidedCount: countDecided(decisions),
        conflictCount,
      };
      return pruneResolverSessions(touch(s.order, key), { ...s.sessions, [key]: session });
    }),

  decideRegion: ({ key, fileIndex, regionId, decision, suggestionId, editId }) =>
    set((s) => {
      const existing = s.sessions[key];
      if (existing == null) return {};
      const rk = regionKey(fileIndex, regionId);
      const decisions = { ...existing.decisions };
      const suggestionIds = { ...existing.suggestionIds };
      const editIds = { ...existing.editIds };
      if (decision == null) {
        delete decisions[rk];
        delete suggestionIds[rk];
        // Undo clears an edit's handle exactly as it clears any other decision. The lines stay
        // in the hook's module map until the session ends, which costs nothing and is what lets
        // a redo-by-hand start from what was there.
        delete editIds[rk];
      } else {
        decisions[rk] = decision;
        // ⚠ EACH HANDLE IS CLEARED WHENEVER THE DECISION IS NOT ITS OWN MEMBER. A stale
        // suggestionId or editId left under a region the reader has since taken a side on would
        // be sent to a commit route that answers `UnknownSuggestion` / `UnknownEdit` — an error
        // about something the reader has already changed their mind about.
        if (decision === 'suggestion' && suggestionId != null) suggestionIds[rk] = suggestionId;
        else delete suggestionIds[rk];
        if (decision === 'edited' && editId != null) editIds[rk] = editId;
        else delete editIds[rk];
      }
      const session: ResolverSession = {
        ...existing,
        decisions,
        suggestionIds,
        editIds,
        decidedCount: countDecided(decisions),
      };
      return { sessions: { ...s.sessions, [key]: session }, order: touch(s.order, key) };
    }),

  decideRegions: ({ key, decisions: incoming }) =>
    set((s) => {
      const existing = s.sessions[key];
      if (existing == null) return {};
      const decisions = { ...existing.decisions };
      const suggestionIds = { ...existing.suggestionIds };
      const editIds = { ...existing.editIds };
      for (const d of incoming) {
        const rk = regionKey(d.fileIndex, d.regionId);
        decisions[rk] = d.decision;
        if (d.decision === 'suggestion' && d.suggestionId != null) suggestionIds[rk] = d.suggestionId;
        else delete suggestionIds[rk];
        if (d.decision === 'edited' && d.editId != null) editIds[rk] = d.editId;
        else delete editIds[rk];
      }
      const session: ResolverSession = {
        ...existing,
        decisions,
        suggestionIds,
        editIds,
        decidedCount: countDecided(decisions),
      };
      return { sessions: { ...s.sessions, [key]: session }, order: touch(s.order, key) };
    }),
}));

/** The open pull request, or null. A selector so a component re-renders on the target alone. */
export function useResolverTarget(): ResolverTarget | null {
  return useConflictResolverStore((s) => s.target);
}

/** One pinned model's decisions, or null when nothing has been seeded under that key yet. */
export function useResolverSession(key: string | null): ResolverSession | null {
  return useConflictResolverStore((s) => (key == null ? null : (s.sessions[key] ?? null)));
}

/** Open the overlay from anywhere — the three entry buttons all call this and nothing else. */
export function openConflictResolver(target: ResolverTarget): void {
  useConflictResolverStore.getState().openConflictResolver(target);
}
