import { useEffect, useMemo, useRef } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { ConflictFileEntry } from '@pierre-review/shared';
import { fileRowState, type FileTally } from '../../lib/mergeResolver.js';
import { CaretIcon, CheckIcon, ConflictIcon, MinusIcon } from '../Icons.js';
import { INK_CLASS, fileCount, unsupportedHeadline } from './copy.js';

// ── THE FILE LIST ────────────────────────────────────────────────────────────────────────────
//
// ⚠ AN UNSUPPORTED FILE IS LISTED AND DISABLED, NEVER HIDDEN. A file the resolver cannot
// represent — a binary, a submodule, a rename/rename — is exactly why the pull request stays
// conflicted after a commit, and hiding it leaves nothing on screen to explain that. The panel
// says "N files need resolving on GitHub." once, above the list, and each row carries the
// server's own noun phrase for its reason.
//
// ⚠ NO "PARTLY DECIDED" RING. `PartialCircleIcon` is pinned by its own comment to period-report
// coverage; borrowing it here is the collision `BlastRadiusIcon`'s header records as the reason
// marks get purpose-built. A part-decided file says `1 of 3 decided` in words instead — which is
// also the only form that carries the denominator.

/** Keep the tail of a long path and mark the cut. The full path is in `title`. */
export function truncateLeft(path: string, max: number): string {
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

const ROW_STATE_INK = {
  resolved: INK_CLASS.applied,
  partial: INK_CLASS.change,
  conflicts: INK_CLASS.conflict,
  unsupported: INK_CLASS.ignored,
} as const;

export function FileMenu({
  files,
  activeIndex,
  tallies,
  open,
  onOpenChange,
  onSelect,
}: {
  files: ConflictFileEntry[];
  activeIndex: number;
  /** Only LOADED files have one; an unopened file's row says how many conflicts it holds. */
  tallies: Readonly<Record<number, FileTally>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (index: number) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(4), flip({ fallbackPlacements: ['top-start'] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-mr-file-active="true"]')?.focus();
  }, [open]);

  const active = files.find((f) => f.index === activeIndex) ?? files[0];
  const resolvedFiles = useMemo(
    () =>
      files.filter((f) => {
        const t = tallies[f.index];
        return f.unsupported == null && t != null && t.decided >= t.decidable;
      }).length,
    [files, tallies],
  );
  const unsupportedCount = files.filter((f) => f.unsupported != null).length;
  const activeConflicts = active == null ? 0 : (tallies[active.index]?.conflicts ?? active.conflictCount);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 hover:border-gray-400 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
      >
        <span className="truncate font-mono" title={active?.path}>
          {active == null ? 'No files' : truncateLeft(active.path, 44)}
        </span>
        {active != null && (
          <span className="shrink-0 text-gray-500 dark:text-gray-400">
            · {activeConflicts} conflict{activeConflicts === 1 ? '' : 's'}
          </span>
        )}
        <CaretIcon size={11} className="shrink-0 text-gray-500 dark:text-gray-400" />
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[70] w-[26rem] max-w-[92vw] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900"
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-600 dark:border-gray-800 dark:text-gray-300">
              <span>{fileCount(resolvedFiles, files.length)}</span>
              {unsupportedCount > 0 && <span>{unsupportedHeadline(unsupportedCount)}</span>}
            </div>
            <div ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
              {files.map((entry) => {
                const row = fileRowState(entry, tallies[entry.index] ?? null);
                const disabled = row.state === 'unsupported';
                const isActive = entry.index === activeIndex;
                const Mark =
                  row.state === 'resolved'
                    ? CheckIcon
                    : row.state === 'unsupported'
                      ? MinusIcon
                      : row.state === 'conflicts'
                        ? ConflictIcon
                        : null;
                return (
                  <div
                    key={entry.index}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={disabled || undefined}
                    data-mr-file-active={isActive ? 'true' : undefined}
                    tabIndex={disabled ? -1 : 0}
                    // ⚠ NO CLICK HANDLER ON A DISABLED ROW, not a handler that returns early. A
                    // row that visibly responds and then does nothing reads as a broken app.
                    onClick={
                      disabled
                        ? undefined
                        : () => {
                            onSelect(entry.index);
                            onOpenChange(false);
                          }
                    }
                    onKeyDown={
                      disabled
                        ? undefined
                        : (e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            onSelect(entry.index);
                            onOpenChange(false);
                          }
                    }
                    className={`flex items-center gap-2 px-2.5 py-1 text-xs ${
                      disabled ? 'cursor-default' : 'cursor-pointer'
                    } ${
                      disabled
                        ? // Dimmer, still legible. A disabled row still SAYS something — the
                          // reason the file has to be resolved on GitHub — so it clears AA like
                          // any other sentence; the disabled-ness is carried by the mark, the
                          // words and `aria-disabled`, not by making it hard to read.
                          'text-gray-500 dark:text-gray-400'
                        : 'text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800'
                    } ${isActive ? 'bg-gray-100 dark:bg-gray-800' : ''}`}
                  >
                    <span className={`shrink-0 ${ROW_STATE_INK[row.state]}`}>
                      {Mark != null ? <Mark size={12} /> : <PartialSpacer />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={entry.path}>
                      {truncateLeft(entry.path, 40)}
                    </span>
                    <span className={`shrink-0 text-[11px] ${ROW_STATE_INK[row.state]}`}>
                      {row.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** A part-decided row carries no mark — the words `1 of 3 decided` are the state. This holds the
 *  column so the paths still line up. See the ⚠ about `PartialCircleIcon` in the header. */
function PartialSpacer(): JSX.Element {
  return <span className="inline-block h-3 w-3" />;
}
