import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConflictDecision,
  ConflictFileContent,
  ConflictRegion,
  ConflictSession,
} from '@pierre-review/shared';
import {
  slotFor,
  tallyFile,
  wandPlan,
  wandSentence,
  type FileTally,
} from '../../lib/mergeResolver.js';
import { nextOutstandingFile, type CommitPlan } from '../../lib/conflictCommit.js';
import { languageForPath } from '../../lib/hljsLines.js';
import { regionKey, useConflictResolverStore, useResolverSession } from '../../store/conflictResolver.js';
import { RegionRibbons } from './RegionRibbons.js';
import { ResolverToolbar } from './ResolverToolbar.js';
import { SlotRow } from './SlotRow.js';
import { useHunkSuggestion } from './useHunkSuggestion.js';
import { useRegionEdit } from './useRegionEdit.js';
import {
  NARROW_PANES,
  PANE_OURS,
  PANE_RESULT,
  RENAME_DETECTION_OFF,
  STAYS_CONFLICTED,
  STILL_CONFLICTED,
  paneTheirs,
  truncatedNotice,
} from './copy.js';

// ── THE THREE PANES ──────────────────────────────────────────────────────────────────────────
//
// LEFT is the pull request's branch, RIGHT is the base branch, CENTRE is the result. The merge
// base is not a pane — it is a popup (`BasePopover`), because it is the thing the other two are
// both changes TO rather than a fourth option.
//
// ⚠ ONE SCROLLER, ONE GRID, FIVE TRACKS. `minmax(0,1fr) 1.75rem minmax(0,1fr) 1.75rem
// minmax(0,1fr)`, and every region emits its five cells straight into it through
// `display: contents`. That is what makes the panes line up: a row's height is its tallest cell
// and the browser stretches the rest, so a three-line hunk beside a seven-line hunk needs no
// spacer, no measurement and NO SCROLL-SYNC DRIVER. Three scrollers kept in step by scroll
// handlers is the design this replaces, and it drifts on every wrapped line.
//
// ⚠ `min-h-0` ON THE SCROLLER IS LOAD-BEARING. Without it the flex child refuses to shrink below
// its content, and the grid overflows the viewport instead of scrolling inside it.
//
// ⚠ KEYBOARD SCOPE. Only `Escape` is on `window` (owned by the overlay shell). Everything here is
// `onKeyDown` on this `tabIndex={-1}` container, so `←`/`→` cannot fight a text caret in the
// branch-name field or the file list's own `↑↓`. That is the `HelpModal` precedent: one key
// globally, never a scheme.

/** Below this the three columns stop being readable at 12px, so they stack. Measured live, so
 *  widening the window brings them straight back — every decision lives above this component. */
const NARROW_PX = 1100;
const UNDO_STACK_LIMIT = 50;
const WAND_MESSAGE_MS = 8000;

/** One reversible step. The wand's whole run is ONE entry, so undoing it is one press. */
type UndoEntry = Array<{
  fileIndex: number;
  regionId: number;
  previous: ConflictDecision | null;
  previousSuggestionId: string | null;
  /** ⚠ CARRIED LIKE THE SUGGESTION'S. Undo restores the DECISION and its handle together, or
   *  undoing back onto an edit would leave `'edited'` with no id — a region reading "Your text"
   *  whose text the pane cannot draw. */
  previousEditId: string | null;
}>;

export function ResolverPanes({
  session,
  sessionKey,
  files,
  loadingFiles,
  fileErrors,
  loadFile,
  onRetryFile,
  suggestionLines,
  plan,
  landBlockedReason,
  jumpToFile,
  onJumpConsumed,
  onLand,
}: {
  session: ConflictSession;
  /** `resolverSessionKey(prId, headSha, baseSha, modelHash)` — the pinned model's store key. */
  sessionKey: string;
  files: Record<number, ConflictFileContent>;
  loadingFiles: ReadonlySet<number>;
  /** The server's sentence for a file whose regions could not be read. Rendered as a refusal with
   *  a retry, never as a spinner: this is the state that used to sit on "Reading …" forever. */
  fileErrors: Readonly<Record<number, string>>;
  loadFile: (index: number) => Promise<ConflictFileContent | null>;
  onRetryFile: (index: number) => void;
  /** `suggestionId` → the accepted Pro suggestion's lines, for READING. The store holds only the
   *  opaque handle (the text lives in the server's session), so the centre pane needs them handed
   *  in; a `'suggestion'` decision whose lines are not to hand renders as undecided rather than as
   *  something else's text. Absent until the per-hunk suggestion ships. */
  suggestionLines?: Readonly<Record<string, string[]>>;
  /** The shell's ONE `CommitPlan`. ⚠ HANDED IN, NEVER RE-FOLDED HERE: the toolbar's countdown, the
   *  overlay footer, the close confirm and the landing step's gate all read this object, and a
   *  second fold is how they come to disagree. The panes take the whole plan rather than two
   *  numbers off it because the toolbar now also names the OUTSTANDING FILES and jumps between
   *  them — the same rows the landing step lists. */
  plan: CommitPlan;
  /** `commitBlockedReason(plan, headMoved)`, folded in the shell because `headMoved` is a fact
   *  about GitHub that the plan deliberately knows nothing about. Non-null shuts the toolbar's
   *  "Commit and push" AND the `Enter` binding below, and is the sentence both of them wear. */
  landBlockedReason: string | null;
  /** The landing step sent the reader back to finish a file. A file INDEX only — the landing step
   *  does not hold that file's regions and must not fetch them to name a region. */
  jumpToFile?: number | null;
  /** Clears the one-shot above, so a second press of the same row jumps again. */
  onJumpConsumed?: () => void;
  /** The landing step, owned by the commit view. Absent ⇒ `Enter` does nothing and no continue
   *  button renders — the panes never assume there is somewhere to go. */
  onLand?: () => void;
}): JSX.Element {
  const stored = useResolverSession(sessionKey);
  // "Ask Claude" — the one PAID control on this screen, and ABSENT rather than locked when the
  // reader is not entitled. It owns its own pending state: nothing reaches `decisions` until the
  // reader presses "Use this".
  const claude = useHunkSuggestion(session.prId, session.sessionId);
  // The resolver's one text box — CORE, free, both modes, no tier check anywhere near it. Like
  // the Ask above, it owns its own pending state: nothing reaches `decisions` until a save comes
  // back with a handle.
  const edits = useRegionEdit(session.prId, session.sessionId);
  const decideRegion = useConflictResolverStore((s) => s.decideRegion);
  const decisions = stored?.decisions ?? EMPTY_DECISIONS;
  const suggestionIds = stored?.suggestionIds ?? EMPTY_HANDLES;
  const editIds = stored?.editIds ?? EMPTY_HANDLES;

  const resolvable = useMemo(() => session.files.filter((f) => f.unsupported == null), [session.files]);
  const [activeIndex, setActiveIndex] = useState<number>(() => resolvable[0]?.index ?? -1);
  const [activeRegionId, setActiveRegionId] = useState<number | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [baseOpen, setBaseOpen] = useState(false);
  const [outstandingOpen, setOutstandingOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [wandMessage, setWandMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const undoStack = useRef<UndoEntry[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  // Set by the keyboard paths only: a click already moved focus, and stealing it back on every
  // activation would fight the reader's pointer.
  const focusOnActivate = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const activeFile = files[activeIndex] ?? null;
  const activeEntry = session.files.find((f) => f.index === activeIndex) ?? null;
  const language = activeEntry == null ? null : languageForPath(activeEntry.path);

  // The width branch. `ResizeObserver` rather than a media query so the threshold is about THIS
  // element's width — the overlay is full-viewport today, but a media query would be a fact about
  // the window rather than about the space the panes actually have.
  useEffect(() => {
    const el = wrapRef.current;
    if (el == null) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setNarrow(w < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch the selected file's regions. ⚠ THE SESSION PAYLOAD IS A MANIFEST — counts and pins, no
  // regions — so this is where the bytes arrive, one file at a time.
  useEffect(() => {
    if (activeIndex < 0 || files[activeIndex] != null || loadingFiles.has(activeIndex)) return;
    // ⚠ A RECORDED FAILURE STOPS THIS. Without the guard the effect re-fires the moment
    // `loadingFiles` clears, forever — MEASURED at 655 requests against one 429'd endpoint, with
    // nothing on screen but "Reading …". Only `onRetryFile` clears the entry.
    if (fileErrors[activeIndex] != null) return;
    void loadFile(activeIndex);
  }, [activeIndex, files, loadingFiles, fileErrors, loadFile]);

  // ⚠ NOTHING SEEDS A DECISION HERE ANY MORE. An auto-apply pass used to write every one-sided
  // region's own side into the store the moment a file's regions arrived, so the centre pane
  // opened already green over changes nobody had looked at. The session now opens with
  // `autoApply: false` and the reader's first press is the first decision — see the retired
  // `autoApplyMoves` block in `lib/mergeResolver.ts`.

  // A different pinned model is a different set of files; its undo history is not this one's.
  useEffect(() => {
    undoStack.current = [];
    setUndoDepth(0);
  }, [sessionKey]);

  // ── THE LANDING STEP'S JUMP ────────────────────────────────────────────────────────────────
  //
  // "Still to decide" names a file and this lands the cursor on its first unanswered region.
  // Two steps, because the regions may not be here yet: seed the file, then wait for its content.
  //
  // ⚠ NOT IN THE STORE. `store/conflictResolver.ts` holds CHOICES only; a UI cursor there is the
  // derived-state trap. And nothing new writes `scrollTop` or calls `focus()` — `focusOnActivate`
  // hands the reveal to the one effect that already owns it.
  const pendingJump = useRef<number | null>(null);
  useEffect(() => {
    if (jumpToFile == null) return;
    pendingJump.current = jumpToFile;
    focusOnActivate.current = true;
    setActiveIndex(jumpToFile);
    setActiveRegionId(null);
    onJumpConsumed?.();
  }, [jumpToFile, onJumpConsumed]);

  // The second half is further down — it has to run AFTER the "land on the first decidable
  // region" effect, or that effect's write (taken from a render where `activeRegionId` was still
  // null) lands last and the jump silently arrives at region 1 instead.

  const tallies = useMemo(() => {
    const out: Record<number, FileTally> = {};
    for (const [key, content] of Object.entries(files)) {
      out[Number(key)] = tallyFile(content.regions, content.index, decisions);
    }
    return out;
  }, [files, decisions]);

  /** Regions that take a decision, in file order, with their 1-based position. */
  const decidable = useMemo(() => {
    if (activeFile == null) return [];
    return activeFile.regions.filter((r) => r.kind !== 'unchanged');
  }, [activeFile]);

  const activeRegion = useMemo(
    () => decidable.find((r) => r.id === activeRegionId) ?? null,
    [decidable, activeRegionId],
  );

  // ⚠ MEMOISED, AND NOT AS AN OPTIMISATION HABIT. `slotFor` recomputes the deterministic word
  // merge for every region sitting on `disjoint_merge`, and `centreLines` folds every region;
  // recreating the slot objects on every render would redo both on every keystroke AND break
  // `SlotRow`'s own memos, which key on the slot's identity.
  // The lines an ACCEPTED suggestion renders with. The store holds only the opaque handle (the
  // text lives in the server's session), so the centre pane reads them from the Ask hook — plus
  // anything the caller handed in, which nothing does today and which is kept so a second source
  // of accepted lines cannot silently win over this one.
  const acceptedLines = useMemo(
    () => ({ ...suggestionLines, ...claude.acceptedLines }),
    [suggestionLines, claude.acceptedLines],
  );

  const held = useMemo(
    () => ({
      suggestionIds,
      suggestionLines: acceptedLines,
      editIds,
      // The SERVER's split of what the reader typed, out of the hook's module map — which is why
      // it survives the landing step unmounting these panes.
      editLines: edits.editLines,
    }),
    [suggestionIds, acceptedLines, editIds, edits.editLines],
  );

  const slots = useMemo(() => {
    const out = new Map<number, ReturnType<typeof slotFor>>();
    if (activeFile == null) return out;
    for (const region of activeFile.regions) {
      out.set(region.id, slotFor(region, activeFile.index, decisions, held));
    }
    return out;
  }, [activeFile, decisions, held]);

  // ── DECIDING ───────────────────────────────────────────────────────────────────────────────

  const apply = useCallback(
    (
      moves: Array<{
        fileIndex: number;
        regionId: number;
        decision: ConflictDecision | null;
        suggestionId?: string | null;
        editId?: string | null;
      }>,
    ) => {
      if (moves.length === 0) return;
      const entry: UndoEntry = moves.map((m) => {
        const rk = regionKey(m.fileIndex, m.regionId);
        return {
          fileIndex: m.fileIndex,
          regionId: m.regionId,
          previous: decisions[rk] ?? null,
          previousSuggestionId: suggestionIds[rk] ?? null,
          previousEditId: editIds[rk] ?? null,
        };
      });
      undoStack.current = [...undoStack.current, entry].slice(-UNDO_STACK_LIMIT);
      setUndoDepth(undoStack.current.length);
      for (const m of moves) {
        // ⚠ ANY OTHER CONTROL ON A REGION DISCARDS ITS PENDING SUGGESTION AND CLOSES ITS TEXT
        // BOX. Neither may sit under the cell still offering to replace something the decision
        // beneath them has already changed. Closing the box drops an unsaved draft, which is the
        // right trade: the reader just pressed a different answer for this very region.
        if (m.decision !== 'suggestion') claude.clear(m.fileIndex, m.regionId);
        if (m.decision !== 'edited') edits.close(m.fileIndex, m.regionId);
        decideRegion({
          key: sessionKey,
          fileIndex: m.fileIndex,
          regionId: m.regionId,
          decision: m.decision,
          suggestionId: m.suggestionId ?? null,
          editId: m.editId ?? null,
        });
      }
    },
    // `claude.clear` and `edits.close` are stable `useCallback`s; depending on either whole hook
    // object would rebuild this callback (and the three that close over it) on every Ask or save
    // state change.
    [decisions, suggestionIds, editIds, decideRegion, sessionKey, claude.clear, edits.close],
  );

  const decideActive = useCallback(
    (decision: ConflictDecision | null) => {
      if (activeRegion == null) return;
      if (decision != null && !activeRegion.allowed.includes(decision)) return;
      apply([{ fileIndex: activeIndex, regionId: activeRegion.id, decision }]);
      setAnnouncement(
        decision == null ? 'Decision cleared.' : `${DECISION_SAID[decision]} on this change.`,
      );
    },
    [activeRegion, activeIndex, apply],
  );

  const undoLast = useCallback(() => {
    const entry = undoStack.current[undoStack.current.length - 1];
    if (entry == null) return;
    undoStack.current = undoStack.current.slice(0, -1);
    setUndoDepth(undoStack.current.length);
    for (const step of entry) {
      decideRegion({
        key: sessionKey,
        fileIndex: step.fileIndex,
        regionId: step.regionId,
        decision: step.previous,
        suggestionId: step.previousSuggestionId,
        editId: step.previousEditId,
      });
    }
    setAnnouncement('Undone.');
  }, [decideRegion, sessionKey]);

  const runWand = useCallback(() => {
    if (activeFile == null) return;
    const plan = wandPlan(activeFile.regions, activeFile.index, decisions);
    apply(plan.moves.map((m) => ({ ...m, suggestionId: null })));
    const sentence = wandSentence(plan);
    setWandMessage(sentence);
    setAnnouncement(sentence);
  }, [activeFile, decisions, apply]);

  useEffect(() => {
    if (wandMessage == null) return;
    const t = window.setTimeout(() => setWandMessage(null), WAND_MESSAGE_MS);
    return () => window.clearTimeout(t);
  }, [wandMessage]);

  // ── NAVIGATING ─────────────────────────────────────────────────────────────────────────────

  const undecided = useCallback(
    (region: ConflictRegion, fileIndex: number): boolean =>
      decisions[regionKey(fileIndex, region.id)] == null,
    [decisions],
  );

  /**
   * Move to the next (or previous) region needing attention.
   *
   * ⚠ ACROSS FILES IT SWITCHES FILE FIRST, AWAITS THE FETCH, AND ONLY THEN PICKS A REGION. The
   * naive version reads `files[next]` out of state, finds nothing there, and silently skips every
   * file it has not already opened — which on a twelve-file conflict means the reader can walk
   * `n` to the end having seen two of them.
   */
  const step = useCallback(
    async (dir: 1 | -1, conflictsOnly: boolean) => {
      const matches = (r: ConflictRegion, fi: number): boolean =>
        (conflictsOnly ? r.kind === 'conflict' : true) && undecided(r, fi);

      if (activeFile != null) {
        const pool = activeFile.regions.filter((r) => r.kind !== 'unchanged');
        const at = pool.findIndex((r) => r.id === activeRegionId);
        const ordered = dir === 1 ? pool.slice(at + 1) : pool.slice(0, Math.max(at, 0)).reverse();
        const hit = ordered.find((r) => matches(r, activeFile.index));
        if (hit != null) {
          focusOnActivate.current = true;
          setActiveRegionId(hit.id);
          return;
        }
      }

      const order = dir === 1 ? resolvable : [...resolvable].reverse();
      const from = order.findIndex((f) => f.index === activeIndex);
      for (const entry of order.slice(from + 1)) {
        const content = files[entry.index] ?? (await loadFile(entry.index));
        if (content == null) continue;
        const pool = content.regions.filter((r) => r.kind !== 'unchanged');
        const ordered = dir === 1 ? pool : [...pool].reverse();
        const hit = ordered.find((r) => matches(r, entry.index));
        if (hit == null) continue;
        focusOnActivate.current = true;
        setActiveIndex(entry.index);
        setActiveRegionId(hit.id);
        setAnnouncement(`Moved to ${entry.path}.`);
        return;
      }
      setAnnouncement(conflictsOnly ? 'No conflicts left.' : 'Nothing left to decide.');
    },
    [activeFile, activeRegionId, activeIndex, resolvable, files, loadFile, undecided],
  );

  const stepFile = useCallback(
    (delta: -1 | 1) => {
      const at = resolvable.findIndex((f) => f.index === activeIndex);
      const next = resolvable[at + delta];
      if (next == null) return;
      focusOnActivate.current = true;
      setActiveIndex(next.index);
      setActiveRegionId(null);
    },
    [resolvable, activeIndex],
  );

  /**
   * Go to a named file's first UNANSWERED region — the toolbar's "Next" and the counter popover's
   * rows, which are the same motion the landing step's "Still to decide" rows make.
   *
   * ⚠ IT GOES THROUGH `pendingJump`, NOT STRAIGHT TO A REGION. The regions may not be here yet:
   * seed the file, let the fetch effect run, and the jump's second half picks the first region
   * still needing an answer. Landing on region 1 of a file whose first four are decided is the
   * defect that effect exists to prevent, and a second path that reached past it would reopen it.
   */
  const goToFile = useCallback(
    (index: number) => {
      // ⚠ THE FILE THE READER IS ALREADY IN PICKS ITS REGION HERE. `pendingJump`'s second half is
      // keyed on `activeIndex` CHANGING, so a jump to the file already on screen never re-runs it
      // and the "land on the first decidable region" effect wins with region 1 — which on a file
      // whose first four are answered is the row they just finished. "Next" can never ask for this
      // (it excludes the current file), the counter's popover can: it lists every outstanding file.
      if (index === activeIndex) {
        const first = files[index]?.regions.find(
          (r) => r.kind !== 'unchanged' && decisions[regionKey(index, r.id)] == null,
        );
        if (first == null) return;
        focusOnActivate.current = true;
        setActiveRegionId(first.id);
        return;
      }
      pendingJump.current = index;
      focusOnActivate.current = true;
      setActiveIndex(index);
      setActiveRegionId(null);
      const path = session.files.find((f) => f.index === index)?.path;
      if (path != null) setAnnouncement(`Moved to ${path}.`);
    },
    [activeIndex, files, decisions, session.files],
  );

  // ⚠ FILES, NOT REGIONS. `n`/`p` walk the regions inside the file the reader is in; this is the
  // toolbar's "Next", which goes to the next FILE that still needs decisions and wraps. Null means
  // there is nowhere to jump — everything is decided, or the only file left is this one — and the
  // button is then absent rather than disabled. See `nextOutstandingFile`.
  const nextOutstanding = nextOutstandingFile(plan.outstanding, activeIndex);

  // Land on the first decidable region whenever the file changes, so `←`/`→` always have a target.
  useEffect(() => {
    if (activeRegionId != null && decidable.some((r) => r.id === activeRegionId)) return;
    setActiveRegionId(decidable[0]?.id ?? null);
  }, [decidable, activeRegionId]);

  // The jump's second half. ⚠ DECLARED AFTER THE EFFECT ABOVE ON PURPOSE — both run in the same
  // commit off a render where `activeRegionId` is null, so whichever is declared last is the one
  // whose write survives. The landing effect wants region 1; the jump wants the first region
  // still needing an answer, which is the whole point of the row that was clicked.
  useEffect(() => {
    const idx = pendingJump.current;
    if (idx == null || activeIndex !== idx) return;
    // ⚠ A RECORDED FAILURE CLEARS IT, or the jump waits forever on a file that will never load.
    if (fileErrors[idx] != null) {
      pendingJump.current = null;
      return;
    }
    // The fetch effect further up is already on it.
    const content = files[idx];
    if (content == null) return;
    pendingJump.current = null;
    const first = content.regions.find(
      (r) => r.kind !== 'unchanged' && decisions[regionKey(idx, r.id)] == null,
    );
    // Nothing left here after all — the effect above has already landed on region 1.
    if (first == null) return;
    focusOnActivate.current = true;
    setActiveRegionId(first.id);
  }, [activeIndex, files, fileErrors, decisions]);

  // Reveal + focus the active region. Focus only when a KEY put us here — see `focusOnActivate`.
  //
  // ⚠ IT AIMS AT THE AFFIRMATIVE TAKE, NOT AT "THE FIRST BUTTON IN THE STRIP". It used to be
  // `el.querySelector('button')` — fine while the strip led with "Take your version", and a live
  // hazard the moment the strip gave the two side verbs up to the gutter: on every one-sided change
  // the strip's first button is now "Ignore this change and keep the ancestor", so walking a file
  // with `n` parked focus on Ignore and one reflex Space discarded the change. The gutter arrows
  // carry `data-mr-take` for exactly this, and they live in their own grid cells, two columns from
  // `[data-mr-region]` — so the lookup is by the region's own key against the scroller, left
  // before right (a `theirs_only` region has no left arrow), falling back to the strip when a
  // region offers no side at all.
  //
  // ⚠ AN ARROW ALSO GOES AWAY ONCE ITS SIDE IS IN THE RESULT, AND THAT IS SAFE ONLY BECAUSE OF
  // `step`'s filter. Every path that arms `focusOnActivate` lands on a region that is
  // `kind !== 'unchanged'` AND undecided, so at least one arrow is always rendered there and the
  // strip fallback stays unreachable from the keyboard. Widen `step` to walk decided regions and
  // the fallback comes alive again — landing focus on Ignore, which is the bug this lookup exists
  // to prevent.
  useEffect(() => {
    if (activeRegionId == null) return;
    const scroller = scrollerRef.current;
    const el = scroller?.querySelector<HTMLElement>(
      `[data-mr-region="${activeIndex}:${activeRegionId}"]`,
    );
    if (el == null || scroller == null) return;
    el.scrollIntoView({ block: 'nearest' });
    if (focusOnActivate.current) {
      focusOnActivate.current = false;
      const take =
        scroller.querySelector<HTMLElement>(
          `[data-mr-take="${activeIndex}:${activeRegionId}:left"]`,
        ) ??
        scroller.querySelector<HTMLElement>(
          `[data-mr-take="${activeIndex}:${activeRegionId}:right"]`,
        );
      (take ?? el.querySelector<HTMLElement>('button'))?.focus();
    }
  }, [activeIndex, activeRegionId]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement | null;
      // ⚠ NEVER STEAL A KEY FROM A FIELD, AND THIS IS NOW LOAD-BEARING RATHER THAN DEFENSIVE.
      // It used to guard only the landing step's branch-name input, which lives inside the same
      // overlay; `RegionEditPanel`'s textarea sits INSIDE THIS SCROLLER, so every keystroke in it
      // bubbles here. Without this line typing `b` in the box would take both sides of the
      // region being edited, `x` would ignore it, and Enter would leave for the commit step —
      // all while the caret sat in the text those keys were changing. `resolverControls.test.ts`
      // pins that this guard runs BEFORE the single-key verbs and before the Enter arm.
      if (t?.closest('input, textarea, select, [contenteditable="true"]') != null) return;
      // ⚠ NEVER STEAL `Enter` FROM A CONTROL EITHER. A `<button>` fires its click on Enter DOWN, so
      // `preventDefault()` here cancels the press — and the gutter arrow became focusable in the
      // same change that made it the only pointer route to "take this side", so Tab-to-arrow-then-
      // Enter went to the commit step and took no side, silently, while Space still worked. The
      // two keys that activate a button have to agree.
      if (e.key === 'Enter' && t?.closest('button, a[href], [role="button"]') != null) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoLast();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'n':
          e.preventDefault();
          void step(1, false);
          return;
        case 'p':
          e.preventDefault();
          void step(-1, false);
          return;
        case 'N':
          e.preventDefault();
          void step(1, true);
          return;
        case 'P':
          e.preventDefault();
          void step(-1, true);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          decideActive('ours');
          return;
        case 'ArrowRight':
          e.preventDefault();
          decideActive('theirs');
          return;
        case 'b':
          e.preventDefault();
          decideActive('both_ours_first');
          return;
        case 'B':
          e.preventDefault();
          decideActive('both_theirs_first');
          return;
        case 'x':
          e.preventDefault();
          decideActive('base');
          return;
        case 'u':
          e.preventDefault();
          decideActive(null);
          return;
        case 'w':
          e.preventDefault();
          runWand();
          return;
        case 'f':
          e.preventDefault();
          setFileMenuOpen(true);
          return;
        case '[':
          e.preventDefault();
          stepFile(-1);
          return;
        case ']':
          e.preventDefault();
          stepFile(1);
          return;
        case 'Enter':
          if (onLand == null) return;
          e.preventDefault();
          // ⚠ THE SAME LOCK AS THE TOOLBAR BUTTON, OFF THE SAME `commitBlockedReason`. Enter here
          // is the toolbar's own door — the two used to differ only in that this one had no way of
          // being disabled, which is exactly how a gated button comes to have a keyboard bypass.
          // A shut door says why: the button wears the sentence as its description, so the key
          // speaks it.
          if (landBlockedReason != null) {
            setAnnouncement(landBlockedReason);
            return;
          }
          onLand();
          return;
        default:
      }
    },
    [decideActive, runWand, step, stepFile, undoLast, onLand, landBlockedReason],
  );

  const at = resolvable.findIndex((f) => f.index === activeIndex);
  const wandDisabled =
    activeFile == null || wandPlan(activeFile.regions, activeFile.index, decisions).moves.length === 0;

  return (
    <div ref={wrapRef} className="flex min-h-0 flex-1 flex-col">
      <ResolverToolbar
        files={session.files}
        activeIndex={activeIndex}
        tallies={tallies}
        fileMenuOpen={fileMenuOpen}
        onFileMenuOpen={setFileMenuOpen}
        onSelectFile={(i) => {
          setActiveIndex(i);
          setActiveRegionId(null);
        }}
        onStepFile={stepFile}
        canStepBack={at > 0}
        canStepForward={at >= 0 && at < resolvable.length - 1}
        onWand={runWand}
        wandDisabled={wandDisabled}
        onUndo={undoLast}
        undoDepth={undoDepth}
        activeRegion={activeRegion}
        language={language}
        baseOpen={baseOpen}
        onBaseOpen={setBaseOpen}
        decided={plan.decidedTotal}
        total={plan.decidableTotal}
        outstanding={plan.outstanding}
        outstandingOpen={outstandingOpen}
        onOutstandingOpen={setOutstandingOpen}
        onJumpToFile={goToFile}
        nextOutstanding={nextOutstanding}
        onNextOutstanding={() => {
          if (nextOutstanding != null) goToFile(nextOutstanding);
        }}
        blockedReason={landBlockedReason}
        onLand={onLand}
      />

      <Banners
        session={session}
        narrow={narrow}
        wandMessage={wandMessage}
      />

      {/* ⚠ THE ONE POSITIONING ANCESTOR, AND IT EXISTS SO NOTHING HAS TO MEASURE THE TOOLBAR. This
          wrapper's box IS the scroller's box, so the ribbon overlay is `left:0; right:0` with no
          offset to recompute when `Banners` appears or disappears (it returns null most of the
          time). `relative` with z-index AUTO: it must NOT become a stacking context, or the sticky
          pane headers stop painting over the ribbons. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollerRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
        >
          {activeFile == null ? (
            <div className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">
              {activeEntry == null ? (
                // ⚠ THIS IS THE ONLY SCREEN A PULL REQUEST WITH NOTHING RESOLVABLE EVER REACHES,
                // so it has to carry the refusal. A binary-only conflict produces a `ready`
                // session with no resolvable file: "Next" is absent, the commit button is shut,
                // and every other sentence on screen ("Nothing to resolve here.", "Nothing to
                // decide in this pull request.") reads as "there are no conflicts" while the pull
                // request is in fact still conflicted and has to be finished on GitHub. The
                // sentence that says so used to be reachable only by pressing the button this
                // gate disabled.
                <div className="flex flex-col gap-2">
                  <div>{landBlockedReason ?? 'Nothing to resolve here.'}</div>
                  {plan.notCarried.length > 0 && (
                    <div>
                      <div className="font-medium text-gray-700 dark:text-gray-200">
                        {STILL_CONFLICTED}
                      </div>
                      <ul className="mt-0.5">
                        {plan.notCarried.map((row) => (
                          <li key={row.index} className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-mono text-gray-800 dark:text-gray-100">
                              {row.path}
                            </span>
                            <span>{row.label}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-1">{STAYS_CONFLICTED}</div>
                    </div>
                  )}
                </div>
              ) : fileErrors[activeIndex] != null ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{fileErrors[activeIndex]}</span>
                  <button
                    type="button"
                    onClick={() => onRetryFile(activeIndex)}
                    className="rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800"
                  >
                    Try again
                  </button>
                </span>
              ) : (
                `Reading ${activeEntry.path}…`
              )}
            </div>
          ) : (
            <div
              // The ribbon overlay's `ResizeObserver` target: every row height that can change
              // without a prop change — a wrapped line, an unchanged region unfolding, a suggestion
              // panel mounting — changes THIS element's height.
              data-mr-grid
              className="grid items-stretch"
              style={{
                gridTemplateColumns: narrow
                  ? 'minmax(0,1fr)'
                  : 'minmax(0,1fr) 1.75rem minmax(0,1fr) 1.75rem minmax(0,1fr)',
              }}
            >
              {!narrow && (
                <div className="contents">
                  <PaneHeader>{PANE_OURS}</PaneHeader>
                  <PaneHeader />
                  <PaneHeader>{PANE_RESULT}</PaneHeader>
                  <PaneHeader />
                  <PaneHeader>{paneTheirs(session.baseRef)}</PaneHeader>
                </div>
              )}
              {activeFile.regions.map((region) => {
                const ordinal = decidable.findIndex((r) => r.id === region.id) + 1;
                return (
                  <SlotRow
                    // ⚠ THE FILE INDEX IS PART OF THE KEY, AND THAT IS NOT TIDINESS. Region ids
                    // restart at 1 in every file (`model.ts`), and this grid is the SAME element
                    // across a file switch — so React reconciled file A's row 3 with file B's row
                    // 3 instead of remounting it, and every piece of local state in that subtree
                    // came along: the unchanged-lines fold, and (worse) `RegionEditPanel`'s draft,
                    // which sits at a fixed child slot. Typing in file B's region 3 and switching
                    // back put file B's text in file A's box, under file A's fingerprint, one
                    // press from the commit.
                    key={`${activeFile.index}:${region.id}`}
                    region={region}
                    slot={slots.get(region.id) ?? UNAPPLIED}
                    fileIndex={activeFile.index}
                    path={activeFile.path}
                    baseRef={session.baseRef}
                    ordinal={ordinal}
                    total={decidable.length}
                    language={language}
                    narrow={narrow}
                    active={region.id === activeRegionId}
                    ask={claude.states[regionKey(activeFile.index, region.id)]}
                    onAskClaude={
                      claude.enabled
                        ? () =>
                            claude.ask({
                              fileIndex: activeFile.index,
                              regionId: region.id,
                              // The CONTENT pin beside the id's ADDRESS: the server refuses if the
                              // region's bytes moved under the id it was asked about.
                              fingerprint: region.fingerprint,
                            })
                        : undefined
                    }
                    onUseSuggestion={(suggestion) => {
                      setActiveRegionId(region.id);
                      claude.accept(activeFile.index, region.id, suggestion);
                      // ⚠ THE HANDLE, NEVER THE TEXT. The lines the commit splices are the ones the
                      // server holds; the store keeps the id and the panes keep the lines to read.
                      apply([
                        {
                          fileIndex: activeFile.index,
                          regionId: region.id,
                          decision: 'suggestion',
                          suggestionId: suggestion.suggestionId,
                        },
                      ]);
                      setAnnouncement('Took Claude’s suggestion.');
                    }}
                    onDiscardSuggestion={() => claude.clear(activeFile.index, region.id)}
                    edit={edits.states[regionKey(activeFile.index, region.id)]}
                    editDraft={edits.draftFor(activeFile.index, region.id)}
                    onEditDraft={(text) => edits.noteDraft(activeFile.index, region.id, text)}
                    // ⚠ OFFERED ON EVERY DECIDABLE REGION AND ON NO `unchanged` ONE. Context is
                    // read-only — the server refuses it with `not_editable`, and this is the
                    // affordance saying so before anybody presses it.
                    onOpenEdit={
                      region.kind === 'unchanged'
                        ? undefined
                        : () => {
                            setActiveRegionId(region.id);
                            // A pending suggestion under the same cell is something the reader
                            // has just moved past, exactly as `apply` treats it.
                            claude.clear(activeFile.index, region.id);
                            edits.open(activeFile.index, region.id);
                          }
                    }
                    onCancelEdit={() => edits.close(activeFile.index, region.id)}
                    onSaveEdit={(text) => {
                      setActiveRegionId(region.id);
                      void edits
                        .save({
                          fileIndex: activeFile.index,
                          regionId: region.id,
                          // The CONTENT pin beside the id's ADDRESS, the same one the Ask sends:
                          // the server refuses if this region's bytes moved under its id while
                          // the box was open.
                          fingerprint: region.fingerprint,
                          text,
                        })
                        .then((saved) => {
                          // A refusal has already put the server's sentence above the box; there
                          // is nothing to decide and nothing to announce that is not on screen.
                          if (saved == null) return;
                          // ⚠ THE HANDLE, NEVER THE TEXT. The lines the commit splices are the
                          // ones the server holds; the store keeps the id and the hook keeps the
                          // lines to read.
                          apply([
                            {
                              fileIndex: activeFile.index,
                              regionId: region.id,
                              decision: 'edited',
                              editId: saved.editId,
                            },
                          ]);
                          setAnnouncement('Saved your text for this change.');
                        });
                    }}
                    onActivate={() => setActiveRegionId(region.id)}
                    onDecide={(d) => {
                      setActiveRegionId(region.id);
                      if (d != null && !region.allowed.includes(d)) return;
                      apply([{ fileIndex: activeFile.index, regionId: region.id, decision: d }]);
                      // ⚠ THE SAME LINE `decideActive` WRITES, AND IT WAS MISSING HERE. This is the
                      // path every BUTTON takes — the strip's verbs and the gutter arrows — so a
                      // reader pressing Space on the arrow got nothing from the control (an icon)
                      // and nothing from the live region either, while `←`/`→` announced. The wash
                      // and the strip's word both change on screen and neither reaches a screen
                      // reader.
                      setAnnouncement(
                        d == null ? 'Decision cleared.' : `${DECISION_SAID[d]} on this change.`,
                      );
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
        <RegionRibbons
          scrollerRef={scrollerRef}
          fileIndex={activeFile?.index ?? -1}
          regions={activeFile?.regions ?? EMPTY_REGIONS}
          slots={slots}
          narrow={narrow}
        />
      </div>

      {/* Every move writes a line here. Without it the keyboard path is silent: the wash changes
          and the strip's word changes, and a screen reader is told nothing at all. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}

function PaneHeader({ children }: { children?: React.ReactNode }): JSX.Element {
  return (
    // `data-mr-pane-header` is the ribbon overlay's height probe: the overlay starts below this
    // band so a ribbon can never appear behind a header. The `z-10` is the other half of that —
    // see `.mr-ribbons`' note on why the overlay carries no z-index at all.
    <div
      data-mr-pane-header
      className="sticky top-0 z-10 border-b border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300"
    >
      {children}
    </div>
  );
}

/** The banner slot: facts about the model, stated once, above the panes. */
function Banners({
  session,
  narrow,
  wandMessage,
}: {
  session: ConflictSession;
  narrow: boolean;
  wandMessage: string | null;
}): JSX.Element | null {
  const lines: string[] = [];
  if (session.renameDetection === 'off') lines.push(RENAME_DETECTION_OFF);
  if (session.truncated) lines.push(truncatedNotice(session.files.length, session.totalConflictedPaths));
  if (narrow) lines.push(NARROW_PANES);
  if (wandMessage != null) lines.push(wandMessage);
  if (lines.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-gray-200 px-4 py-1.5 dark:border-gray-800">
      {lines.map((line) => (
        <div key={line} className="text-[12px] text-gray-700 dark:text-gray-200">
          {line}
        </div>
      ))}
    </div>
  );
}

/** What a decision is called when it is announced. Not the button labels: those name the branch,
 *  and a live region repeating "Take the change from main" after the fact reads as an instruction
 *  rather than a confirmation. */
const DECISION_SAID: Record<ConflictDecision, string> = {
  ours: 'Took your version',
  theirs: 'Took the base branch’s version',
  both_ours_first: 'Took both, yours first',
  both_theirs_first: 'Took both, the base branch first',
  base: 'Ignored',
  disjoint_merge: 'Merged both edits',
  suggestion: 'Took the suggestion',
  // Reached only by Undo landing back on an edit — a save announces itself in its own words,
  // because "used your own text" after pressing Save says nothing the reader did not just do.
  edited: 'Used your own text',
};

const UNAPPLIED = Object.freeze({ kind: 'unapplied' } as const);
/** ⚠ FROZEN AND MODULE-LEVEL, not a `[]` literal in the prop: a fresh array every render would
 *  re-fire the ribbon overlay's measure effect on every keystroke. */
const EMPTY_REGIONS: readonly ConflictRegion[] = Object.freeze([]);
const EMPTY_DECISIONS: Readonly<Record<string, ConflictDecision>> = Object.freeze({});
/** The empty map for EITHER handle set — suggestion ids or edit ids. ⚠ FROZEN AND
 *  MODULE-LEVEL, not a `{}` literal at the call site: a fresh object every render would break
 *  every memo that depends on it. */
const EMPTY_HANDLES: Readonly<Record<string, string>> = Object.freeze({});
