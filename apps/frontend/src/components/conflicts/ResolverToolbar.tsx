import type { ConflictFileEntry, ConflictRegion } from '@pierre-review/shared';
import type { FileTally } from '../../lib/mergeResolver.js';
import { ChevronIcon, UndoIcon, WandIcon } from '../Icons.js';
import { BasePopover } from './BasePopover.js';
import { FileMenu } from './FileMenu.js';
import {
  CONTINUE_TO_COMMIT,
  UNDO_LAST,
  WAND_BUTTON,
  WAND_BUTTON_TITLE,
  decisionsDecided,
} from './copy.js';

// ── THE TOOLBAR ──────────────────────────────────────────────────────────────────────────────
//
// The file the reader is in, the two file steps, the wand, the undo stack, the merge-base popup,
// and the countdown. Everything here has a single-key binding on the panes container as well —
// the toolbar is where the verbs are NAMED, not the only place they are reachable.

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
  onWand,
  wandDisabled,
  onUndo,
  undoDepth,
  activeRegion,
  language,
  baseOpen,
  onBaseOpen,
  decided,
  total,
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
  onWand: () => void;
  wandDisabled: boolean;
  onUndo: () => void;
  undoDepth: number;
  activeRegion: ConflictRegion | null;
  language: string | null;
  baseOpen: boolean;
  onBaseOpen: (open: boolean) => void;
  /** The countdown, off the shell's ONE `CommitPlan` — every DECIDABLE region, which is the
   *  population the commit gate holds out for. Never re-folded here. */
  decided: number;
  total: number;
  /** The landing step. Absent ⇒ no button — the toolbar never assumes there is somewhere to go.
   *  `Enter` on the panes container is the same door. */
  onLand?: () => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-1.5 dark:border-gray-800">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => onStepFile(-1)}
          disabled={!canStepBack}
          title="Previous file"
          aria-label="Previous file"
          className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ChevronIcon dir="left" size={13} />
        </button>
        <button
          type="button"
          onClick={() => onStepFile(1)}
          disabled={!canStepForward}
          title="Next file"
          aria-label="Next file"
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
        <span className="text-[11px] text-gray-600 dark:text-gray-300">
          {decisionsDecided(decided, total)}
        </span>
        {onLand != null && (
          <button
            type="button"
            onClick={onLand}
            title="Review what gets committed"
            className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-900 hover:border-gray-400 dark:border-gray-600 dark:text-gray-100 dark:hover:border-gray-500"
          >
            {CONTINUE_TO_COMMIT}
          </button>
        )}
      </div>
    </div>
  );
}
