import type { ConflictFileEntry, ConflictRegion } from '@pierre-review/shared';
import type { OutstandingFile } from '../../lib/conflictCommit.js';
import type { FileTally, WholeFileSide } from '../../lib/mergeResolver.js';
import { AcceptLeftIcon, AcceptRightIcon, ChevronIcon, UndoIcon, WandIcon } from '../Icons.js';
import { BasePopover } from './BasePopover.js';
import { FileMenu } from './FileMenu.js';
import { OutstandingPopover } from './OutstandingPopover.js';
import {
  COMMIT_AND_PUSH,
  COMMIT_ENTRY_NAME,
  COMMIT_ENTRY_TITLE,
  FILE_NEXT,
  FILE_PREV,
  NEXT_OUTSTANDING,
  NEXT_OUTSTANDING_LABEL,
  TAKE_FILE_OURS,
  UNDO_LAST,
  WAND_BUTTON,
  WAND_BUTTON_TITLE,
  fileChangesLeft,
  takeFileOursTitle,
  takeFileTheirs,
  takeFileTheirsTitle,
} from './copy.js';

// ── THE TOOLBAR ──────────────────────────────────────────────────────────────────────────────
//
// The file the reader is in, the two file steps, the wand, the undo stack, the merge-base popup,
// the countdown and the way out. Everything here has a single-key binding on the panes container as
// well — the toolbar is where the verbs are NAMED, not the only place they are reachable.
//
// ⚠ THREE CONTROLS MOVE BETWEEN FILES AND THEY ARE NOT THE SAME CONTROL. The chevrons page the
// MANIFEST, in order, conflict-blind, and they say so ("Next file in the list"). "Next" goes to the
// next file that still needs decisions (`nextOutstandingFile`) and disappears once none does. The
// keys `n`/`p` walk REGIONS inside the file the reader is in, and `[`/`]` are the chevrons. Two
// controls announcing as "Next …" is the duplicate-verb problem the gutter arrows cost us, so the
// chevrons were re-worded rather than the new button being given a quieter name.
//
// ⚠ THE TWO WHOLE-FILE TAKES ARE THE ONE EXCEPTION TO "every verb has a key", AND DELIBERATELY.
// "Take your file" / "Take main's file" rewrite every decision in the file at once, including a
// hand-typed edit, and `←`/`→` — the obvious keys — already mean "take this side" for ONE change.
// A reflex keystroke that overwrites a whole file is not a shortcut worth having; the press is one
// undo step either way. They are NOT the gutter arrows at a larger size: those remain the one
// per-CHANGE route to a side, and these say "file" in their names so the two never announce alike.
//
// ⚠ THE COUNTS ON THE RIGHT ARE ONE FOLD. "This file: N of M changes left" is the file's row of the
// shell's `CommitPlan` and "All files: …" is its total — the population the commit button is held
// shut by. The file menu's trigger no longer repeats the file's count: "2 of 6 decided" beside
// "4 of 6 changes left" was one fact printed twice, inches apart.

export function ResolverToolbar({
  files,
  activeIndex,
  tallies,
  fileMenuOpen,
  onFileMenuOpen,
  onSelectFile,
  onStepFile,
  canStepBack,
  canStepForward,
  baseRef,
  onTakeFile,
  takeFileDisabled,
  onWand,
  wandDisabled,
  onUndo,
  undoDepth,
  activeRegion,
  language,
  baseOpen,
  onBaseOpen,
  fileDecided,
  fileDecidable,
  decided,
  total,
  outstanding,
  outstandingOpen,
  onOutstandingOpen,
  onJumpToFile,
  nextOutstanding,
  onNextOutstanding,
  blockedReason,
  onLand,
}: {
  files: ConflictFileEntry[];
  activeIndex: number;
  tallies: Readonly<Record<number, FileTally>>;
  fileMenuOpen: boolean;
  onFileMenuOpen: (open: boolean) => void;
  onSelectFile: (index: number) => void;
  onStepFile: (delta: -1 | 1) => void;
  canStepBack: boolean;
  canStepForward: boolean;
  /** The base branch's name, for the "Take main's file" button. */
  baseRef: string;
  /** Make the whole file one side's version (`wholeFilePlan`). */
  onTakeFile: (side: WholeFileSide) => void;
  /** True for a side whose press would change nothing — the file already reads as that side, or
   *  its regions have not arrived. Disabled like the wand, for the same reason. */
  takeFileDisabled: Readonly<Record<WholeFileSide, boolean>>;
  onWand: () => void;
  wandDisabled: boolean;
  onUndo: () => void;
  undoDepth: number;
  activeRegion: ConflictRegion | null;
  language: string | null;
  baseOpen: boolean;
  onBaseOpen: (open: boolean) => void;
  /** The file on screen's row of the same `CommitPlan` — its decidable regions and how many are
   *  answered. Null while there is no file (a pull request with nothing resolvable). */
  fileDecided: number | null;
  fileDecidable: number | null;
  /** The countdown, off the shell's ONE `CommitPlan` — every DECIDABLE region, which is the
   *  population the commit gate holds out for. Never re-folded here. */
  decided: number;
  total: number;
  /** Every supported file still holding an unanswered region, off the same `CommitPlan`. The
   *  counter's popover names them; the commit gate holds out for them. */
  outstanding: readonly OutstandingFile[];
  outstandingOpen: boolean;
  onOutstandingOpen: (open: boolean) => void;
  /** Go to that file's first unanswered region. */
  onJumpToFile: (index: number) => void;
  /** `nextOutstandingFile(outstanding, activeIndex)`. Null ⇒ no "Next" button at all: either
   *  everything is decided or the only outstanding file is the one the reader is already in. */
  nextOutstanding: number | null;
  onNextOutstanding: () => void;
  /** `commitBlockedReason(plan, headMoved)` — the ONE sentence for why the commit cannot go, and
   *  the gate itself: non-null disables the button below. Null ⇒ nothing is in the way. */
  blockedReason: string | null;
  /** The landing step. Absent ⇒ no button — the toolbar never assumes there is somewhere to go.
   *  `Enter` on the panes container is the same door, and it is gated on the SAME
   *  `blockedReason` — two doors with different locks is how one of them comes to be the way
   *  round the other. */
  onLand?: () => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-1.5 dark:border-gray-800">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => onStepFile(-1)}
          disabled={!canStepBack}
          title={FILE_PREV}
          aria-label={FILE_PREV}
          className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ChevronIcon dir="left" size={13} />
        </button>
        <button
          type="button"
          onClick={() => onStepFile(1)}
          disabled={!canStepForward}
          title={FILE_NEXT}
          aria-label={FILE_NEXT}
          className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ChevronIcon dir="right" size={13} />
        </button>
      </div>

      <FileMenu
        files={files}
        activeIndex={activeIndex}
        tallies={tallies}
        open={fileMenuOpen}
        onOpenChange={onFileMenuOpen}
        onSelect={onSelectFile}
      />

      {/* One-branch-wins, for this file only. The icons are the gutter arrows' own — the same
          verb — and the words carry the grain. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onTakeFile('ours')}
          disabled={takeFileDisabled.ours}
          title={takeFileOursTitle(baseRef)}
          className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
        >
          <AcceptLeftIcon size={13} />
          {TAKE_FILE_OURS}
        </button>
        <button
          type="button"
          onClick={() => onTakeFile('theirs')}
          disabled={takeFileDisabled.theirs}
          title={takeFileTheirsTitle(baseRef)}
          className="flex min-w-0 max-w-[16rem] items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
        >
          <span className="truncate">{takeFileTheirs(baseRef)}</span>
          <AcceptRightIcon size={13} className="shrink-0" />
        </button>
      </div>

      <button
        type="button"
        onClick={onWand}
        disabled={wandDisabled}
        title={WAND_BUTTON_TITLE}
        className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
      >
        <WandIcon size={13} />
        {WAND_BUTTON}
      </button>

      <button
        type="button"
        onClick={onUndo}
        disabled={undoDepth === 0}
        title="Undo the last decision"
        className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
      >
        <UndoIcon size={13} />
        {UNDO_LAST}
      </button>

      <BasePopover
        region={activeRegion}
        language={language}
        open={baseOpen}
        onOpenChange={onBaseOpen}
      />

      <div className="ml-auto flex items-center gap-2">
        {/* ⚠ ABSENT, NEVER DISABLED. `nextOutstanding` is null exactly when there is nowhere to
            jump — nothing outstanding, or nothing outstanding but this file — and a "Next" that
            lands the reader where they already are reads as a broken control. */}
        {nextOutstanding != null && (
          <button
            type="button"
            onClick={onNextOutstanding}
            title={NEXT_OUTSTANDING_LABEL}
            aria-label={NEXT_OUTSTANDING_LABEL}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:border-gray-400 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
          >
            {NEXT_OUTSTANDING}
          </button>
        )}

        {fileDecidable != null && fileDecided != null && (
          <span className="text-[11px] text-gray-600 dark:text-gray-300">
            {fileChangesLeft(fileDecidable - fileDecided, fileDecidable)}
          </span>
        )}

        <OutstandingPopover
          decided={decided}
          total={total}
          outstanding={outstanding}
          blockedReason={blockedReason}
          open={outstandingOpen}
          onOpenChange={onOutstandingOpen}
          onJumpToFile={onJumpToFile}
        />

        {onLand != null && (
          <>
            {/* ⚠ THE REASON IS NOT VISIBLE HERE AND IT IS NOT NOWHERE EITHER. The toolbar is one
                line; the sentence is on the button's tooltip, in the counter's popover beside it
                (which also names the files, with a click that goes to each) and in the button's
                accessible description, which is what a screen reader reads out when it announces
                the button as dimmed. The landing step keeps its visible paragraph. */}
            {blockedReason != null && (
              <span id={BLOCKED_REASON_ID} className="sr-only">
                {blockedReason}
              </span>
            )}
            <button
              type="button"
              onClick={onLand}
              disabled={blockedReason != null}
              title={blockedReason ?? COMMIT_ENTRY_TITLE}
              aria-label={COMMIT_ENTRY_NAME}
              aria-describedby={blockedReason != null ? BLOCKED_REASON_ID : undefined}
              className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-900 disabled:opacity-40 hover:border-gray-400 dark:border-gray-600 dark:text-gray-100 dark:hover:border-gray-500"
            >
              {COMMIT_AND_PUSH}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The toolbar button's `aria-describedby` target. One toolbar, one button, so one id — and it is
 *  deliberately NOT the landing step's (`conflict-commit-blocked-reason`): the two views never
 *  mount together, but two elements that could ever share an id is not a fact worth betting a
 *  screen reader's description on. */
const BLOCKED_REASON_ID = 'conflict-toolbar-blocked-reason';
